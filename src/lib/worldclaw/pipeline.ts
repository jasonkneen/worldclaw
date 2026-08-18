/**
 * WorldClaw end-to-end agentic pipeline (paper eq. 1–2)
 * P = F_plan(q) → T = F_terrain(P) → O = F_region(P, T) → S = Compose(T, O)
 *
 * Uses real xAI inference (grok-4.6 + Imagine) when available; falls back
 * to local templates only if the API is unavailable.
 */

import {
  generateLayoutTerrain,
  generateVisualReferenceContract,
  localVisualContract,
  mergeEnsembleEvidence,
  planSceneWithLlm,
  type BenchmarkGenerationContract,
} from "./inference";
import { attachBrowserAssets } from "./assets";
import {
  assertAssetResolutionPolicy,
  buildAssetVariantEvidence,
  summarizeAssetResolution,
  type AssetResolutionPolicy,
} from "./asset-evidence";
import {
  WORLD_OBJECT_FIT,
  calibrateScales,
  ensureRequiredObjectKinds,
  footprintsOverlapXZ,
  generateRegionalObjects,
  objectFootprintXZ,
  repairRegionalObjectCoverage,
  resolveObjectKind,
  type RequiredObjectPlacementTelemetry,
} from "./objects";
import { pickSeed } from "./noise";
import { planScene as planSceneLocal, analyzeIntent } from "./planning";
import { refineScene } from "./refine";
import {
  buildTerrainSpec,
  generateHeightField,
  hasCombatOpenWorldIntent,
  hasTropicalIntent,
  isOpenCombatRegion,
  normalizeNamedTerrainRegions,
  refineTerrainHeights,
  scatterTerrainAssets,
  heightFieldFromArrays,
} from "./terrain";
import type {
  AgentLogEntry,
  EnsembleEvidence,
  HeightField,
  ObjectKind,
  ObjectRequirement,
  PipelineStage,
  RegionSpec,
  ScenePlan,
  TerrainAssetDef,
  WorldScene,
} from "./types";

export type LogFn = (entry: Omit<AgentLogEntry, "id" | "t">) => void;
export type ProgressFn = (stage: PipelineStage, progress: number) => void;
export type EvidenceFn = (evidence: EnsembleEvidence) => void;

export type WorldClawPipelineOptions = AssetResolutionPolicy & {
  /** Hash-bound paper-suite requirements. Presence makes provider/image fallback fail closed. */
  readonly benchmarkContract?: BenchmarkGenerationContract;
};

export function visualReferenceFailureIsFatal(_options: WorldClawPipelineOptions): boolean {
  // Concept review controls certification, not whether the user gets a built world.
  // A rejected concept is retained as evidence and carried into the final deterministic
  // judgement, where strict benchmark runs still fail closed after captures are saved.
  return false;
}

export function visualReferenceCertificationFailures(
  plan: Pick<ScenePlan, "visualContract">,
): string[] {
  return plan.visualContract?.judgement?.passed === false
    ? [
        "Pre-build appearance contract was retained with review warnings; this world is viewable but not certification-eligible",
      ]
    : [];
}

type ObjectCoverageGateInput = Pick<
  NonNullable<NonNullable<WorldScene["inferenceMeta"]>["objectCoverage"]>,
  "satisfactionRatio" | "missingKinds" | "missingHeroKinds"
>;

/**
 * Quantity coverage is evidence, not permission to hide a generated world.
 * Missing required heroes still fail closed; optional/model-density shortfalls
 * are retained visibly for the final comparison and evidence UI.
 */
export function objectCoveragePipelineDecision(
  coverage: ObjectCoverageGateInput,
): "pass" | "retain-warning" | "block" {
  if (coverage.missingHeroKinds.length > 0) return "block";
  return coverage.satisfactionRatio >= 0.95 && coverage.missingKinds.length === 0
    ? "pass"
    : "retain-warning";
}

export function objectCoverageCertificationFailures(coverage: ObjectCoverageGateInput): string[] {
  return coverage.satisfactionRatio < 0.95
    ? [
        `Requested-object satisfaction is ${Math.round(coverage.satisfactionRatio * 100)}%; requires 95%`,
      ]
    : [];
}

export function shouldRunFinalModelReview(deterministicFailures: readonly string[]): boolean {
  return deterministicFailures.length === 0;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function elapsedSeconds(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;
}

let logId = 0;

const REFERENCE_SUMMARY_BUDGET = 3_000;

function referenceText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

/**
 * Produce a compact, complete-enough visual contract instead of forwarding the
 * planner's raw JSON. Appearance prose can be very large; allowing it to fill
 * the image prompt caused otherwise-valid real-provider runs to fail before
 * reference generation. Hero subjects and requested counts are deliberately
 * emitted before secondary spatial prose so they cannot be truncated away.
 */
export function sceneReferenceSummary(
  plan: ScenePlan,
  explicitCounts: ReadonlyMap<ObjectKind, number> = parseExplicitObjectCounts(plan.prompt),
): string {
  const lines: string[] = [];
  let used = 0;
  const append = (line: string): boolean => {
    const normalized = referenceText(line, 420);
    const additional = normalized.length + (lines.length > 0 ? 1 : 0);
    if (!normalized || used + additional > REFERENCE_SUMMARY_BUDGET) return false;
    lines.push(normalized);
    used += additional;
    return true;
  };

  append(`scene=${referenceText(plan.sceneType, 100)}`);
  append(`theme=${plan.theme}; style=${plan.visualStyle}`);
  append(`atmosphere=${referenceText(plan.atmosphere, 240)}`);
  for (const [kind, count] of [...explicitCounts].slice(0, 16)) {
    append(`hero subject=${kind} x${count}; count authority=user prompt exact`);
  }
  for (const object of plan.mainObjects.slice(0, 16)) {
    const conflictsWithPromptExact = MAIN_OBJECT_PATTERNS.some(
      ({ kind, pattern }) =>
        (explicitCounts.has(kind) || isSuppressedWatercraftSibling(kind, explicitCounts)) &&
        pattern.test(object),
    );
    if (!conflictsWithPromptExact) append(`hero subject=${referenceText(object, 120)}`);
  }

  for (const region of plan.regions.slice(0, 16)) {
    append(
      `region ${referenceText(region.name, 64)}: ${region.category}; uv=${region.center
        .map((value) => Number(value).toFixed(3))
        .join(
          ",",
        )}; radius=${Number(region.radius).toFixed(3)}; role=${referenceText(region.role, 120)}`,
    );
  }

  for (const region of plan.regions.slice(0, 16)) {
    for (const requirement of plan.objectRequirements[region.name] ?? []) {
      if (isSuppressedWatercraftSibling(resolveObjectKind(requirement.category), explicitCounts)) {
        continue;
      }
      if (
        !append(
          `objects ${referenceText(region.name, 48)}: ${requirement.category} x${Math.max(0, Math.round(requirement.count))}; appearance=${referenceText(requirement.appearance, 180)}`,
        )
      ) {
        return lines.join("\n");
      }
    }
  }

  for (const note of plan.spatialNotes.slice(0, 8)) {
    if (!append(`spatial=${referenceText(note, 180)}`)) break;
  }
  return lines.join("\n");
}

function applyVisualContractToHeightField(heightField: HeightField, plan: ScenePlan): void {
  const contract = plan.visualContract ?? localVisualContract(plan.theme);
  const waterCeiling = contract.waterLevelMeters - 0.38;
  for (let index = 0; index < heightField.data.length; index++) {
    const category = plan.regions[heightField.regionId[index] ?? 0]?.category;
    if (category === "ocean" || category === "river") {
      heightField.data[index] = Math.min(heightField.data[index] ?? waterCeiling, waterCeiling);
      continue;
    }
    const floor =
      contract.waterLevelMeters +
      (category === "beach" || category === "sand" || category === "ice" ? 0.08 : 0.16);
    const sourceHeight = Math.max(floor, heightField.data[index] ?? floor);
    const reliefScale =
      category === "mountain" ||
      category === "rock" ||
      category === "cliff" ||
      category === "canyon"
        ? Math.max(0.55, contract.terrainReliefScale)
        : contract.terrainReliefScale;
    heightField.data[index] = floor + (sourceHeight - floor) * reliefScale;
  }
}

function regionDistanceSquared(a: RegionSpec, b: RegionSpec): number {
  const dx = a.center[0] - b.center[0];
  const dy = a.center[1] - b.center[1];
  return dx * dx + dy * dy;
}

/**
 * Layout vision may rename or merge regions. Remap every authored object
 * requirement onto the new region graph so image classification can never
 * silently delete tanks, ships, landmarks, or construction requirements.
 */
export function remapObjectRequirements(
  originalPlan: ScenePlan,
  layoutRegions: RegionSpec[],
): Record<string, ObjectRequirement[]> {
  const remapped: Record<string, ObjectRequirement[]> = Object.fromEntries(
    layoutRegions.map((region) => [region.name, []]),
  );
  const normalizedName = (name: string) => name.trim().toLocaleLowerCase();

  for (const sourceRegion of originalPlan.regions) {
    const requirements = originalPlan.objectRequirements[sourceRegion.name] ?? [];
    if (requirements.length === 0 || layoutRegions.length === 0) continue;

    const exact = layoutRegions.find(
      (region) => normalizedName(region.name) === normalizedName(sourceRegion.name),
    );
    const sameCategory = layoutRegions
      .filter((region) => region.category === sourceRegion.category)
      .sort(
        (a, b) => regionDistanceSquared(sourceRegion, a) - regionDistanceSquared(sourceRegion, b),
      )[0];
    const nearest = [...layoutRegions].sort(
      (a, b) => regionDistanceSquared(sourceRegion, a) - regionDistanceSquared(sourceRegion, b),
    )[0];
    const target = exact ?? sameCategory ?? nearest;
    if (!target) continue;

    const targetRequirements = remapped[target.name] ?? [];
    for (const requirement of requirements) {
      const existing = targetRequirements.find(
        (candidate) =>
          candidate.category.toLocaleLowerCase() === requirement.category.toLocaleLowerCase() &&
          candidate.appearance === requirement.appearance &&
          candidate.scale === requirement.scale,
      );
      if (existing) {
        existing.count = Math.min(120, existing.count + requirement.count);
      } else {
        targetRequirements.push({ ...requirement });
      }
    }
    remapped[target.name] = targetRequirements;
  }

  return remapped;
}

const MAIN_OBJECT_PATTERNS: { kind: ObjectKind; pattern: RegExp }[] = [
  { kind: "tank", pattern: /\btanks?\b/i },
  { kind: "bunker", pattern: /\bbunkers?\b/i },
  { kind: "vehicle", pattern: /\b(?:vehicles?|trucks?|cars?|wrecks?)\b/i },
  { kind: "ship", pattern: /\bships?\b/i },
  { kind: "boat", pattern: /\bboats?\b/i },
  { kind: "dock", pattern: /\b(?:docks?|piers?|jett(?:y|ies))\b/i },
  { kind: "bridge", pattern: /\bbridges?\b/i },
  { kind: "watchtower", pattern: /\bwatchtowers?\b/i },
  { kind: "tower", pattern: /\btowers?\b/i },
  { kind: "pagoda", pattern: /\bpagodas?|\btemples?\b/i },
  { kind: "torii", pattern: /\btorii\b/i },
  { kind: "windmill", pattern: /\bwindmills?\b/i },
  { kind: "statue", pattern: /\b(?:statues?|monuments?|totems?)\b/i },
  { kind: "dragon", pattern: /\bdragons?\b/i },
  { kind: "mine", pattern: /\bmines?\b/i },
  { kind: "building", pattern: /\b(?:forts?|castles?|factories?)\b/i },
];

function mainObjectKinds(plan: ScenePlan): Map<ObjectKind, string> {
  const result = new Map<ObjectKind, string>();
  for (const description of plan.mainObjects) {
    for (const { kind, pattern } of MAIN_OBJECT_PATTERNS) {
      if (pattern.test(description) && !result.has(kind)) {
        result.set(kind, description);
      }
    }
  }
  return result;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const EXPLICIT_OBJECT_NOUNS: Record<string, ObjectKind> = {
  hut: "hut",
  huts: "hut",
  house: "house",
  houses: "house",
  tower: "tower",
  towers: "tower",
  dock: "dock",
  docks: "dock",
  pier: "dock",
  piers: "dock",
  jetty: "dock",
  jetties: "dock",
  ship: "ship",
  ships: "ship",
  boat: "boat",
  boats: "boat",
  tree: "tree",
  trees: "tree",
  palm: "palm",
  palms: "palm",
  pine: "pine",
  pines: "pine",
  rock: "rock",
  rocks: "rock",
  boulder: "boulder",
  boulders: "boulder",
  cactus: "cactus",
  cacti: "cactus",
  vehicle: "vehicle",
  vehicles: "vehicle",
  truck: "vehicle",
  trucks: "vehicle",
  car: "vehicle",
  cars: "vehicle",
  wreck: "vehicle",
  wrecks: "vehicle",
  tank: "tank",
  tanks: "tank",
  building: "building",
  buildings: "building",
  fort: "building",
  forts: "building",
  castle: "building",
  castles: "building",
  factory: "building",
  factories: "building",
  antenna: "antenna",
  antennas: "antenna",
  fence: "fence",
  fences: "fence",
  campfire: "campfire",
  campfires: "campfire",
  tent: "tent",
  tents: "tent",
  bridge: "bridge",
  bridges: "bridge",
  statue: "statue",
  statues: "statue",
  monument: "statue",
  monuments: "statue",
  totem: "statue",
  totems: "statue",
  crystal: "crystal",
  crystals: "crystal",
  mine: "mine",
  mines: "mine",
  dragon: "dragon",
  dragons: "dragon",
  windmill: "windmill",
  windmills: "windmill",
  well: "well",
  wells: "well",
  crate: "crate",
  crates: "crate",
  watchtower: "watchtower",
  watchtowers: "watchtower",
  satellite: "satellite",
  satellites: "satellite",
  bunker: "bunker",
  bunkers: "bunker",
  pagoda: "pagoda",
  pagodas: "pagoda",
  temple: "pagoda",
  temples: "pagoda",
  torii: "torii",
  barn: "barn",
  barns: "barn",
  market: "market",
  markets: "market",
};

const COUNT_SCAN_BOUNDARIES = new Set([
  "and",
  "alongside",
  "at",
  "city",
  "cities",
  "containing",
  "contains",
  "featuring",
  "for",
  "forest",
  "forests",
  "grove",
  "groves",
  "harbor",
  "harbors",
  "harbour",
  "harbours",
  "in",
  "including",
  "includes",
  "island",
  "islands",
  "near",
  "of",
  "on",
  "plus",
  "port",
  "ports",
  "region",
  "regions",
  "settlement",
  "settlements",
  "town",
  "towns",
  "village",
  "villages",
  "with",
]);

interface PromptToken {
  normalized: string;
  start: number;
  end: number;
}

function promptCount(token: string): number | undefined {
  if (/^\d{1,3}$/.test(token)) {
    const count = Number(token);
    return count > 0 ? count : undefined;
  }
  return NUMBER_WORDS[token];
}

/**
 * Parse only a count close to its object noun. This intentionally refuses to
 * carry counts across clauses or region nouns, so "two towns with ... four
 * boats" cannot turn into a two-boat or nine-boat hero contract.
 */
export function parseExplicitObjectCounts(description: string): Map<ObjectKind, number> {
  const tokens: PromptToken[] = [];
  for (const match of description.matchAll(/\b(?:\d{1,3}(?:-[a-z]+)?|[a-z]+(?:-[a-z]+)*)\b/gi)) {
    if (match.index === undefined) continue;
    const value = match[0];
    tokens.push({
      normalized: value.toLocaleLowerCase(),
      start: match.index,
      end: match.index + value.length,
    });
  }

  const result = new Map<ObjectKind, number>();
  for (let nounIndex = 0; nounIndex < tokens.length; nounIndex++) {
    const noun = tokens[nounIndex]!;
    const kind = EXPLICIT_OBJECT_NOUNS[noun.normalized];
    if (!kind) continue;
    let cursorStart = noun.start;
    for (let distance = 1; distance <= 6 && nounIndex - distance >= 0; distance++) {
      const candidate = tokens[nounIndex - distance]!;
      const separator = description.slice(candidate.end, cursorStart);
      if (/[,;:.!?]/.test(separator) || COUNT_SCAN_BOUNDARIES.has(candidate.normalized)) break;
      const count = promptCount(candidate.normalized);
      if (count !== undefined) {
        // A later explicit mention of the same kind is the user's final wording.
        result.set(kind, count);
        break;
      }
      if (EXPLICIT_OBJECT_NOUNS[candidate.normalized]) break;
      cursorStart = candidate.start;
    }
  }
  return result;
}

function explicitHeroCount(description: string, kind: ObjectKind): number {
  return parseExplicitObjectCounts(description).get(kind) ?? 1;
}

/**
 * Boat and ship are separate placement kinds for scale control, but they are
 * the same visible watercraft family to a user specifying an exact inventory.
 * If only one synonym receives a noun-adjacent exact count, model-authored
 * requirements for the other synonym are subordinate and must not inflate the
 * scene. Explicit counts for both kinds remain independent and authoritative.
 */
function isSuppressedWatercraftSibling(
  kind: ObjectKind,
  explicitCounts: ReadonlyMap<ObjectKind, number>,
): boolean {
  return (
    (kind === "ship" && explicitCounts.has("boat") && !explicitCounts.has("ship")) ||
    (kind === "boat" && explicitCounts.has("ship") && !explicitCounts.has("boat"))
  );
}

const HARBOR_REGION_PATTERN = /harbou?r|port|dock|cove|marina|berth|fishing/i;

function isHarborRegion(region: RegionSpec): boolean {
  return HARBOR_REGION_PATTERN.test(`${region.name} ${region.role}`);
}

function harborAnchorScore(region: RegionSpec): number {
  const name = region.name;
  const role = region.role;
  let score = 0;
  // A region actually named FishingHarbor/Port/Cove is the authored anchor.
  // Generic town prose such as "buildings beside a timber dock" is supporting
  // composition and must not steal exact boats from that named region.
  if (/fishing/i.test(name)) score += 24;
  if (/harbou?r/i.test(name)) score += 20;
  if (/\b(?:port|cove|marina|berths?)\b/i.test(name)) score += 16;
  if (/\bdocks?\b/i.test(name)) score += 8;
  if (/fishing/i.test(role)) score += 6;
  if (/harbou?r|\b(?:port|cove|marina|berths?)\b/i.test(role)) score += 5;
  if (/\bdocks?\b/i.test(role)) score += 1;
  if (region.category === "ocean" || region.category === "beach" || region.category === "river") {
    score += 2;
  }
  return score;
}

function isMaritimeRequirementKind(kind: ObjectKind): boolean {
  return kind === "ship" || kind === "boat" || kind === "dock";
}

function preferredRegionForKind(plan: ScenePlan, kind: ObjectKind): RegionSpec | undefined {
  if (isMaritimeRequirementKind(kind)) {
    // A named harbor/cove is a semantic anchor, not decorative prose. Prefer it
    // over the first broad ocean mask so exact boats cannot migrate to an
    // arbitrary low shoreline when the layout contains an authored harbor.
    const harbor = plan.regions
      .filter(isHarborRegion)
      .sort(
        (left, right) =>
          harborAnchorScore(right) - harborAnchorScore(left) || left.id.localeCompare(right.id),
      )[0];
    if (harbor) return harbor;
  }
  const preferredCategories =
    kind === "ship" || kind === "boat" || kind === "dock"
      ? ["ocean", "beach", "river"]
      : kind === "tank" || kind === "vehicle" || kind === "bunker"
        ? ["road", "settlement", "grass", "desert", "sand"]
        : kind === "pagoda" || kind === "torii" || kind === "building"
          ? ["settlement", "grass", "forest"]
          : ["settlement", "grass", "forest", "rock"];
  return (
    preferredCategories
      .map((category) => plan.regions.find((region) => region.category === category))
      .find(Boolean) ?? plan.regions[0]
  );
}

function replaceRequirementsForKind(
  plan: ScenePlan,
  kind: ObjectKind,
  count: number,
  target: RegionSpec | undefined,
  fallbackAppearance: string,
): void {
  const preferredTemplates: ObjectRequirement[] = [];
  const otherTemplates: ObjectRequirement[] = [];
  for (const region of plan.regions) {
    const next: ObjectRequirement[] = [];
    for (const requirement of plan.objectRequirements[region.name] ?? []) {
      if (resolveObjectKind(requirement.category) !== kind) {
        next.push(requirement);
        continue;
      }
      (region === target ? preferredTemplates : otherTemplates).push(requirement);
    }
    plan.objectRequirements[region.name] = next;
  }
  if (!target || count <= 0) return;
  const template = preferredTemplates[0] ?? otherTemplates[0];
  const requirements = plan.objectRequirements[target.name] ?? [];
  requirements.push({
    ...(template ?? {}),
    category: template?.category ?? kind,
    count,
    appearance: template?.appearance ?? fallbackAppearance,
  });
  plan.objectRequirements[target.name] = requirements;
}

export function reconcileExplicitObjectRequirements(
  plan: ScenePlan,
  explicitCounts: ReadonlyMap<ObjectKind, number> = parseExplicitObjectCounts(plan.prompt),
): void {
  for (const region of plan.regions) {
    plan.objectRequirements[region.name] = (plan.objectRequirements[region.name] ?? []).filter(
      (requirement) =>
        !isSuppressedWatercraftSibling(resolveObjectKind(requirement.category), explicitCounts),
    );
  }

  for (const [kind, rawExactCount] of explicitCounts) {
    const exactCount = Number.isFinite(rawExactCount) ? Math.max(0, Math.trunc(rawExactCount)) : 0;
    if (isMaritimeRequirementKind(kind)) {
      replaceRequirementsForKind(
        plan,
        kind,
        exactCount,
        preferredRegionForKind(plan, kind),
        `Explicit prompt requirement: ${kind}`,
      );
      continue;
    }
    let remaining = exactCount;
    let template: ObjectRequirement | undefined;
    let templateRegion: RegionSpec | undefined;

    for (const region of plan.regions) {
      const next: ObjectRequirement[] = [];
      for (const requirement of plan.objectRequirements[region.name] ?? []) {
        if (resolveObjectKind(requirement.category) !== kind) {
          next.push(requirement);
          continue;
        }
        template ??= requirement;
        templateRegion ??= region;
        const available = Number.isFinite(requirement.count)
          ? Math.max(0, Math.trunc(requirement.count))
          : 0;
        const allocated = Math.min(remaining, available);
        if (allocated > 0) next.push({ ...requirement, count: allocated });
        remaining -= allocated;
      }
      plan.objectRequirements[region.name] = next;
    }

    if (remaining > 0) {
      const region = templateRegion ?? preferredRegionForKind(plan, kind);
      if (!region) continue;
      const requirements = plan.objectRequirements[region.name] ?? [];
      requirements.push({
        ...(template ?? {}),
        category: template?.category ?? kind,
        count: remaining,
        appearance: template?.appearance ?? `Explicit prompt requirement: ${kind}`,
      });
      plan.objectRequirements[region.name] = requirements;
    }
  }

  // The planning committee records named dock/pier/jetty subjects as visible
  // hero objects. If the user did not supply a noun-adjacent dock count, that
  // hero contract is one instance. Model density and per-beach defaults may
  // describe the surrounding harbor, but they cannot multiply the hero itself.
  if (!explicitCounts.has("dock")) {
    const dockDescription = mainObjectKinds(plan).get("dock");
    if (dockDescription) {
      replaceRequirementsForKind(
        plan,
        "dock",
        explicitHeroCount(dockDescription, "dock"),
        preferredRegionForKind(plan, "dock"),
        `Required hero subject: ${dockDescription}`.slice(0, 240),
      );
    }
  }
}

function ensureMainObjectRequirements(
  plan: ScenePlan,
  explicitCounts: ReadonlyMap<ObjectKind, number>,
): void {
  const existingKinds = new Set(
    Object.values(plan.objectRequirements)
      .flat()
      .map((requirement) => resolveObjectKind(requirement.category)),
  );
  for (const [kind, description] of mainObjectKinds(plan)) {
    if (isSuppressedWatercraftSibling(kind, explicitCounts)) continue;
    if (existingKinds.has(kind)) continue;
    const region = preferredRegionForKind(plan, kind);
    if (!region) continue;
    const requirements = plan.objectRequirements[region.name] ?? [];
    requirements.push({
      category: kind,
      count: explicitCounts.get(kind) ?? explicitHeroCount(description, kind),
      appearance: `Required hero subject: ${description}`.slice(0, 240),
    });
    plan.objectRequirements[region.name] = requirements;
    existingKinds.add(kind);
  }
}

const CONSTRUCTED_SETTLEMENT_KINDS = new Set<ObjectKind>(["building", "house"]);

function promptRequestsJapaneseBuildings(prompt: string): boolean {
  const source = prompt.slice(0, 4_096);
  return (
    /\bjapanese\b/i.test(source) &&
    /\b(?:buildings?|houses?|homes?|towns?|settlements?|villages?|machiya)\b/i.test(source)
  );
}

const SETTLEMENT_PROGRAM_KINDS = new Set<ObjectKind>([
  "building",
  "house",
  "hut",
  "barn",
  "watchtower",
]);

function explicitSettlementCount(prompt: string): number | undefined {
  const match = new RegExp(
    String.raw`\b(${Object.keys(NUMBER_WORDS).join("|")}|\d{1,2})\b(?:\s+[a-z][a-z-]*){0,5}\s+(?:towns?|settlements?|villages?)\b`,
    "i",
  ).exec(prompt.slice(0, 4_096));
  if (!match) return undefined;
  const parsed = NUMBER_WORDS[match[1]!.toLocaleLowerCase()] ?? Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}

function hasSettlementProgram(plan: ScenePlan, region: RegionSpec): boolean {
  return (plan.objectRequirements[region.name] ?? []).some((requirement) =>
    SETTLEMENT_PROGRAM_KINDS.has(resolveObjectKind(requirement.category)),
  );
}

function isAuthoredTownRegion(region: RegionSpec): boolean {
  return /\b(?:town|village|settlement|community)\b/i.test(`${region.name} ${region.role}`);
}

/**
 * A standalone fishing harbor is infrastructure for the authored towns, not a
 * third settlement. When the prompt supplies an exact town count and that many
 * named town programs already exist, discard only the model-invented building
 * program from a bare harbor/cove. Boats, docks, and an explicitly requested
 * "harbor town" remain untouched.
 */
export function reconcileExplicitSettlementPrograms(plan: ScenePlan): void {
  const requestedTowns = explicitSettlementCount(plan.prompt);
  if (requestedTowns === undefined) return;
  if (/\b(?:harbou?r|port)\s+(?:town|village|settlement|community)\b/i.test(plan.prompt)) {
    return;
  }
  const authoredTownPrograms = plan.regions.filter(
    (region) => isAuthoredTownRegion(region) && hasSettlementProgram(plan, region),
  );
  if (authoredTownPrograms.length < requestedTowns) return;

  for (const region of plan.regions) {
    const bareHarborName = /\b(?:harbou?r|marina|cove)\b/i.test(region.name);
    const namedAsTown = /\b(?:town|village|settlement|community)\b/i.test(region.name);
    if (!bareHarborName || namedAsTown) continue;
    plan.objectRequirements[region.name] = (plan.objectRequirements[region.name] ?? []).filter(
      (requirement) => !SETTLEMENT_PROGRAM_KINDS.has(resolveObjectKind(requirement.category)),
    );
  }
}

/**
 * Generic island defaults are not authoritative architecture. When a Japanese
 * prompt asks for buildings or houses, substitute unrequested huts and
 * watchtowers with the compiled Japanese building kind before placement and
 * coverage accounting. Explicit user requests for either kind remain intact.
 */
export function canonicalizeSettlementStructureKinds(plan: ScenePlan): void {
  if (!promptRequestsJapaneseBuildings(plan.prompt)) return;
  const asksForHuts = /\bhuts?\b/i.test(plan.prompt);
  const asksForWatchtowers = /\bwatch[ -]?towers?\b/i.test(plan.prompt);
  for (const region of plan.regions) {
    const settlement =
      region.category === "settlement" ||
      /settlement|village|town|harbou?r community|port community/i.test(
        `${region.name} ${region.role}`,
      );
    if (!settlement) continue;
    plan.objectRequirements[region.name] = (plan.objectRequirements[region.name] ?? []).map(
      (requirement) => {
        const kind = resolveObjectKind(requirement.category);
        const convert =
          (kind === "hut" && !asksForHuts) || (kind === "watchtower" && !asksForWatchtowers);
        if (!convert) return requirement;
        return {
          ...requirement,
          category: "building",
          appearance: "Japanese coastal town building",
        };
      },
    );
  }
  if (!asksForWatchtowers) {
    plan.mainObjects = plan.mainObjects.filter(
      (description) => !/\bwatch[ -]?towers?\b/i.test(description),
    );
  }
}

function promptConstructionVocabulary(prompt: string): string[] {
  const source = prompt.slice(0, 4_096);
  const terms: string[] = [];
  const add = (term: string) => {
    if (!terms.includes(term)) terms.push(term);
  };

  if (/\bjapanese\b/i.test(source)) add("Japanese house");
  if (/\b(?:exposed\s+)?(?:dark\s+)?timber\s+(?:frames?|beams?|posts?)\b/i.test(source)) {
    add("exposed dark timber frame");
  }
  if (/\b(?:white\s+)?(?:lime\s+)?plaster(?:\s+infill)?\b/i.test(source)) {
    add("white lime plaster infill");
  }
  if (/\brecessed\s+(?:wooden|timber)\s+doors?\b/i.test(source)) {
    add("recessed wooden doors");
  }
  if (/\b(?:recessed\s+)?(?:wooden\s+|timber\s+|lattice\s+)?windows?\b/i.test(source)) {
    add("recessed lattice windows");
  }
  if (/\b(?:overlapping\s+)?(?:dark\s+)?(?:slate\s+)?(?:tile|tiled)\s+roofs?\b/i.test(source)) {
    add("overlapping dark charcoal roof tiles");
    add("deep eaves");
  } else if (/\bslate(?:-tiled)?\s+roofs?\b/i.test(source)) {
    add("slate roof");
  }
  if (/\b(?:thatched|thatch|straw|reed)\s+roofs?\b/i.test(source)) add("thatched roof");
  if (/\b(?:red|fired|weathered)?\s*brick\b/i.test(source)) add("red brick");
  if (/\b(?:stone|masonry)\s+(?:walls?|construction)\b/i.test(source)) add("stone masonry");
  return terms;
}

/**
 * Carry user-authored construction language into every building instance in a
 * named settlement. The vocabulary is deliberately canonicalized to the
 * compiled asset manifest's appearance terms so selection cannot collapse to
 * the generic default merely because one model emitted a terse requirement.
 */
export function propagateSettlementConstructionAppearance(plan: ScenePlan): void {
  const vocabulary = promptConstructionVocabulary(plan.prompt);
  if (vocabulary.length === 0) return;
  const authority = vocabulary.join(", ");
  for (const region of plan.regions) {
    const settlement =
      region.category === "settlement" ||
      /settlement|village|town|harbou?r community|port community/i.test(
        `${region.name} ${region.role}`,
      );
    if (!settlement) continue;
    plan.objectRequirements[region.name] = (plan.objectRequirements[region.name] ?? []).map(
      (requirement) => {
        const kind = resolveObjectKind(requirement.category);
        if (!CONSTRUCTED_SETTLEMENT_KINDS.has(kind)) return requirement;
        const existing = referenceText(requirement.appearance, 260);
        if (
          vocabulary.every((term) =>
            existing.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
          )
        ) {
          return requirement;
        }
        return {
          ...requirement,
          // Put the authoritative tokens first so later prompt budgets cannot
          // trim away or compete with the variant-selection vocabulary.
          appearance: authority.slice(0, 480),
        };
      },
    );
  }
}

export function requestedObjectCounts(
  plan: ScenePlan,
  explicitCounts: ReadonlyMap<ObjectKind, number> = parseExplicitObjectCounts(plan.prompt),
): Map<ObjectKind, number> {
  const requested = new Map<ObjectKind, number>();
  for (const requirement of Object.values(plan.objectRequirements).flat()) {
    const count = Number.isFinite(requirement.count)
      ? Math.max(0, Math.trunc(requirement.count))
      : 0;
    if (count === 0) continue;
    const kind = resolveObjectKind(requirement.category);
    if (isSuppressedWatercraftSibling(kind, explicitCounts)) continue;
    requested.set(kind, (requested.get(kind) ?? 0) + count);
  }
  for (const [kind, count] of explicitCounts) requested.set(kind, count);
  return requested;
}

export function heroRequiredCounts(
  plan: ScenePlan,
  explicitCounts: ReadonlyMap<ObjectKind, number> = parseExplicitObjectCounts(plan.prompt),
): Map<ObjectKind, number> {
  const required = new Map<ObjectKind, number>();
  for (const [kind, description] of mainObjectKinds(plan)) {
    if (isSuppressedWatercraftSibling(kind, explicitCounts)) continue;
    required.set(kind, explicitCounts.get(kind) ?? explicitHeroCount(description, kind));
  }
  for (const [kind, count] of explicitCounts) {
    if (count > 0) required.set(kind, count);
  }
  return required;
}

export function objectCoverage(
  plan: ScenePlan,
  objects: WorldScene["objects"],
  explicitCounts: ReadonlyMap<ObjectKind, number> = parseExplicitObjectCounts(plan.prompt),
) {
  const requested = requestedObjectCounts(plan, explicitCounts);
  const requestedByKind: Record<string, number> = Object.fromEntries(requested);
  const placedByKind: Record<string, number> = {};
  const heroRequired = heroRequiredCounts(plan, explicitCounts);
  const heroRequiredByKind: Record<string, number> = Object.fromEntries(heroRequired);
  for (const object of objects) {
    placedByKind[object.kind] = (placedByKind[object.kind] ?? 0) + 1;
  }
  const missingKinds = Object.keys(requestedByKind).filter(
    (kind) => requestedByKind[kind]! > 0 && (placedByKind[kind] ?? 0) === 0,
  );
  const missingHeroKinds = [...heroRequired.entries()]
    .filter(([kind, count]) => (placedByKind[kind] ?? 0) < count)
    .map(([kind]) => kind);
  const requestedTotal = Object.values(requestedByKind).reduce((sum, count) => sum + count, 0);
  const placedRequestedTotal = Object.entries(placedByKind).reduce(
    (sum, [kind, count]) => sum + Math.min(count, requestedByKind[kind] ?? 0),
    0,
  );
  return {
    requestedByKind,
    placedByKind,
    heroRequiredByKind,
    missingKinds,
    missingHeroKinds,
    satisfactionRatio: requestedTotal === 0 ? 1 : placedRequestedTotal / requestedTotal,
  };
}

/** Bounded aggregate repair; failed physical placements remain visible to the coverage gate. */
export function repairRequestedObjectCoverage(
  plan: ScenePlan,
  heightField: HeightField,
  seed: number,
  objects: WorldScene["objects"],
  explicitCounts: ReadonlyMap<ObjectKind, number> = parseExplicitObjectCounts(plan.prompt),
  telemetry?: RequiredObjectPlacementTelemetry[],
): WorldScene["objects"] {
  return ensureRequiredObjectKinds(
    plan,
    heightField,
    seed,
    objects,
    requestedObjectCounts(plan, explicitCounts),
    telemetry,
  );
}

export function formatRequiredPlacementTelemetry(
  entries: readonly RequiredObjectPlacementTelemetry[],
  kinds?: ReadonlySet<ObjectKind>,
): string {
  return entries
    .filter((entry) => !kinds || kinds.has(entry.kind))
    .slice(-8)
    .map((entry) => {
      const regions = entry.regions
        .slice(0, 4)
        .map((region) => {
          const rejected = region.rejected;
          const bearing = region.waterBearing === null ? "n/a" : region.waterBearing.toFixed(3);
          return `${region.regionName}[${region.regionId} ${region.category} c=${region.center[0].toFixed(3)},${region.center[1].toFixed(3)} r=${region.radius.toFixed(3)} bearing=${bearing}] attempts=${region.attempts} reject(world=${rejected.world},terrain=${rejected.terrain},region=${rejected.region},collision=${rejected.collision}) placed=${region.placed}`;
        })
        .join("; ");
      const authority =
        entry.locationAuthority ?? (entry.authoredRegionLock ? "authored" : "unassigned");
      const relocation = entry.relocated
        ? ` relocated=${entry.sourceRegionIds?.join(",") || "unknown"}->${entry.selectedRegionId ?? "unknown"} reason=${entry.relocationReason ?? "physical preflight"}`
        : "";
      return `${entry.kind} ${entry.placed}/${entry.required} (initial=${entry.initiallyPlaced}, authoredLock=${entry.authoredRegionLock}, locationAuthority=${authority}${relocation}) ${regions}`;
    })
    .join(" | ")
    .slice(0, 1_800);
}

/** Convert a terrain scatter prototype without treating every island as tropical. */
export function terrainScatterObjectKind(
  plan: ScenePlan,
  kind: TerrainAssetDef["kind"],
): ObjectKind {
  if (kind === "tree") {
    if (hasTropicalIntent(plan)) return "palm";
    return plan.theme === "snow" ? "pine" : "tree";
  }
  if (kind === "cactus") return "cactus";
  if (kind === "crystal") return "crystal";
  if (kind === "bush") return "tree";
  return "rock";
}

export async function runWorldClawPipeline(
  prompt: string,
  onLog: LogFn,
  onProgress: ProgressFn,
  signal?: { cancelled: boolean },
  requestSignal?: AbortSignal,
  onEvidence?: EvidenceFn,
  options: WorldClawPipelineOptions = {},
): Promise<WorldScene> {
  const log = (
    stage: PipelineStage,
    agent: string,
    message: string,
    level: AgentLogEntry["level"] = "info",
  ) => {
    onLog({ stage, agent, message, level });
  };

  const check = () => {
    if (signal?.cancelled || requestSignal?.aborted) {
      throw new Error("Generation cancelled");
    }
  };

  // Prompt-derived seed is stable; provider-authored plans may still vary.
  const seed = pickSeed(prompt);
  const explicitObjectCounts = parseExplicitObjectCounts(prompt);

  // ─── Stage 1: Intent Analysis & Planning (paper §2.1) ────────────
  onProgress("intent", 0.04);
  log(
    "intent",
    "IntentAnalysisAgent",
    `Parsing open-ended prompt with LLM planner (${prompt.length} chars)…`,
  );
  check();

  let plan: ScenePlan;
  let layoutPrompt = "";
  let planSource: "llm" | "template" = "template";
  let planProvider = "local templates";
  let templateFallbackAllowed = false;
  let ensembleEvidence: EnsembleEvidence | undefined;

  try {
    const planningStartedAt = Date.now();
    const result = await planSceneWithLlm({
      data: {
        prompt,
        ...(options.benchmarkContract ? { benchmarkContract: options.benchmarkContract } : {}),
      },
      signal: requestSignal,
    });
    log(
      "planning",
      "ModelCommittee",
      `Planning candidates + cross-judgement completed in ${elapsedSeconds(planningStartedAt)}`,
      "detail",
    );
    ensembleEvidence = mergeEnsembleEvidence(ensembleEvidence, result.ensemble);
    if (ensembleEvidence) onEvidence?.(ensembleEvidence);
    if (result.ok && result.plan) {
      plan = {
        ...result.plan,
        inferenceSource: "llm",
      };
      layoutPrompt = result.layoutPrompt;
      planSource = "llm";
      planProvider = result.provider ?? "LLM";
      log(
        "intent",
        "IntentAnalysisAgent",
        `Constraints extracted via ${result.provider ?? "LLM"} — completing P = (R, C_terrain, C_object)`,
        "success",
      );
      onProgress("planning", 0.12);
      log("planning", "ScenePlanningAgent", `LLM scene type: ${plan.sceneType}`, "success");
      log(
        "planning",
        "ScenePlanningAgent",
        `Theme=${plan.theme} · Style=${plan.visualStyle} · Regions=${plan.regions.length}`,
        "detail",
      );
      log(
        "planning",
        "ScenePlanningAgent",
        `Spatial: ${plan.spatialNotes.slice(0, 3).join("; ") || "—"}`,
        "detail",
      );
      log("planning", "ScenePlanningAgent", `Atmosphere: ${plan.atmosphere}`, "detail");
      log(
        "planning",
        "ScenePlanningAgent",
        `Main objects: ${plan.mainObjects.slice(0, 8).join(", ") || "—"}`,
        "detail",
      );
    } else {
      templateFallbackAllowed = /No inference key available/i.test(result.error ?? "");
      throw new Error(result.error || "LLM planning unavailable");
    }
  } catch (e) {
    check();
    const msg = e instanceof Error ? e.message : String(e);
    if (options.benchmarkContract) {
      log(
        "intent",
        "BenchmarkPlanningGate",
        `Bound benchmark planning failed closed (${msg.slice(0, 160)}).`,
        "warn",
      );
      throw new Error(`Bound benchmark planning failed: ${msg}`);
    }
    if (!templateFallbackAllowed) {
      log(
        "intent",
        "IntentAnalysisAgent",
        `Real planning failed (${msg.slice(0, 160)}). Template substitution is disabled while providers are configured.`,
        "warn",
      );
      throw new Error(`Real planning failed: ${msg}`);
    }
    log(
      "intent",
      "IntentAnalysisAgent",
      `LLM unavailable (${msg.slice(0, 100)}) — falling back to local intent templates`,
      "warn",
    );
    const intent = analyzeIntent(prompt);
    log(
      "intent",
      "IntentAnalysisAgent",
      `Template constraints: ${intent.explicitThemeHints.slice(0, 6).join(", ") || "generic"}`,
      "detail",
    );
    plan = { ...planSceneLocal(prompt), inferenceSource: "template" };
    layoutPrompt = `Top-down orthographic satellite map of ${plan.sceneType}, ${plan.atmosphere}, distinct terrain regions, no text`;
    planSource = "template";
    planProvider = "local templates";
    onProgress("planning", 0.12);
    log(
      "planning",
      "ScenePlanningAgent",
      `Template plan: ${plan.sceneType} · ${plan.regions.length} regions`,
      "success",
    );
  }

  canonicalizeSettlementStructureKinds(plan);
  reconcileExplicitSettlementPrograms(plan);
  normalizeNamedTerrainRegions(plan);
  reconcileExplicitObjectRequirements(plan, explicitObjectCounts);
  propagateSettlementConstructionAppearance(plan);
  if (explicitObjectCounts.size > 0) {
    log(
      "planning",
      "ScenePlanningAgent",
      `User-exact object contract: ${[...explicitObjectCounts]
        .map(([kind, count]) => `${kind}=${count}`)
        .join(", ")}`,
      "detail",
    );
  }
  check();

  // ─── Stage 2: Global Terrain Generation (paper §2.2) ─────────────
  onProgress("terrain_plan", 0.22);
  log(
    "terrain_plan",
    "TerrainPlanningAgent",
    "Building structured terrain spec P_terrain (layout, assets, materials, θ)…",
  );

  let heightField: HeightField;
  let terrainSource: "image_guided" | "procedural" = "procedural";
  let layoutImageUrl: string | undefined;
  let terrainProvider = "procedural";
  let perspectiveProvider: string | undefined;
  let visualAnalysisProvider: string | undefined;
  let layoutCompleted = false;
  let visualReferenceAccepted = false;
  let retainedLayoutHeightField: HeightField | undefined;

  onProgress("terrain_assets", 0.28);
  log(
    "terrain_assets",
    "TerrainAssetAgent",
    "Generating semantic layout map I_layout via Imagine (image prior)…",
  );
  check();

  try {
    const layoutStartedAt = Date.now();
    const layout = await generateLayoutTerrain({
      data: {
        prompt,
        layoutPrompt,
        theme: plan.theme,
        regions: plan.regions,
        quality: true,
      },
      signal: requestSignal,
    });
    log(
      "terrain_assets",
      "ModelCommittee",
      `Canonical-map candidates + judgement completed in ${elapsedSeconds(layoutStartedAt)}`,
      "detail",
    );
    ensembleEvidence = mergeEnsembleEvidence(ensembleEvidence, layout.ensemble);
    if (ensembleEvidence) onEvidence?.(ensembleEvidence);
    layoutCompleted = true;

    layoutImageUrl = layout.layoutImageUrl;
    terrainProvider = layout.provider;
    // Adopt image-derived region geometry without allowing it to delete the
    // authoritative plan's object requirements.
    const layoutRegions = layout.regions.length >= 3 ? layout.regions : plan.regions;
    const mergedReqs = remapObjectRequirements(plan, layoutRegions);

    plan = {
      ...plan,
      layoutImageUrl: layout.layoutImageUrl,
      layoutImageDataUrl: layout.layoutImageDataUrl,
      regions: layoutRegions,
      objectRequirements: mergedReqs,
    };
    normalizeNamedTerrainRegions(plan);
    retainedLayoutHeightField = heightFieldFromArrays(
      layout.resolution,
      layout.worldSize,
      layout.height,
      layout.regionId,
    );
    retainedLayoutHeightField.source = "image_guided";

    log(
      "terrain_assets",
      "VisualReferenceAgent",
      "Generating map-conditioned perspective, construction, and material concept variants…",
    );
    const appearanceStartedAt = Date.now();
    const reference = await generateVisualReferenceContract({
      data: {
        prompt,
        theme: plan.theme,
        visualStyle: plan.visualStyle,
        sceneSummary: sceneReferenceSummary(plan, explicitObjectCounts),
        layoutImageDataUrl: layout.layoutImageDataUrl,
      },
      signal: requestSignal,
    });
    log(
      "terrain_assets",
      "ModelCommittee",
      `Appearance concepts + visual contract completed in ${elapsedSeconds(appearanceStartedAt)}`,
      "detail",
    );
    ensembleEvidence = mergeEnsembleEvidence(ensembleEvidence, reference.ensemble);
    if (ensembleEvidence) onEvidence?.(ensembleEvidence);
    visualReferenceAccepted = reference.ok;
    perspectiveProvider = reference.perspectiveProvider ?? undefined;
    visualAnalysisProvider = reference.visualAnalysisProvider ?? undefined;
    plan = {
      ...plan,
      perspectiveImageUrl: reference.perspectiveImageDataUrl ?? undefined,
      perspectiveImageDataUrl: reference.perspectiveImageDataUrl ?? undefined,
      visualContract: reference.visualContract,
    };
    if (!reference.ok) {
      const warning =
        reference.error ?? "Pre-build appearance committee did not fully accept the concept";
      if (visualReferenceFailureIsFatal(options)) {
        throw new Error(warning);
      }
      log(
        "terrain_assets",
        "VisualReferenceJudge",
        `Best concept retained with warnings; interactive build continues (${warning.slice(0, 240)})`,
        "warn",
      );
    } else {
      log(
        "terrain_assets",
        "VisualReferenceJudge",
        `Grok/Gemini/GPT/Claude appearance committee passed at ${(
          (reference.visualContract.judgement?.agreementScore ?? 0) * 100
        ).toFixed(0)}%`,
        "success",
      );
    }

    heightField = retainedLayoutHeightField;
    heightField.source = "image_guided";
    applyVisualContractToHeightField(heightField, plan);
    terrainSource = "image_guided";

    log(
      "terrain_assets",
      "TerrainAssetAgent",
      `I_layout generated (${layout.sourcePixels} px) → semantic map + height field`,
      "success",
    );
    log(
      "terrain_assets",
      "TerrainAssetAgent",
      `Categories from layout: ${layout.categories.join(", ")}`,
      "detail",
    );
  } catch (e) {
    check();
    const msg = e instanceof Error ? e.message : String(e);
    if (layoutCompleted && (visualReferenceAccepted || visualReferenceFailureIsFatal(options))) {
      throw new Error(`Visual reference gate failed: ${msg}`);
    }
    if (layoutCompleted) {
      log(
        "terrain_assets",
        "VisualReferenceAgent",
        `Concept analysis became unavailable after the map was retained; interactive build continues from the canonical map (${msg.slice(0, 180)})`,
        "warn",
      );
      if (!plan.visualContract) plan.visualContract = localVisualContract(plan.theme);
      heightField = retainedLayoutHeightField ?? generateHeightField(plan, seed);
      heightField.source = retainedLayoutHeightField ? "image_guided" : "procedural";
      applyVisualContractToHeightField(heightField, plan);
      terrainSource = retainedLayoutHeightField ? "image_guided" : "procedural";
      terrainProvider = retainedLayoutHeightField
        ? `${terrainProvider} · concept warning retained`
        : "procedural after retained concept warning";
    } else {
      if (options.benchmarkContract) {
        throw new Error(`Bound benchmark layout gate failed: ${msg}`);
      }
      log(
        "terrain_assets",
        "TerrainAssetAgent",
        `Imagine layout failed (${msg.slice(0, 120)}) — procedural height field (eq. 6)`,
        "warn",
      );
      heightField = generateHeightField(plan, seed);
      heightField.source = "procedural";
    }
  }

  const terrainSpec = buildTerrainSpec(plan, seed);
  terrainSpec.source = terrainSource;

  onProgress("terrain_build", 0.42);
  log(
    "terrain_build",
    "TerrainGenerationAgent",
    terrainSource === "image_guided"
      ? "Image-guided height field H(x) from I_layout classification + residual detail…"
      : "Compositing height field H(x) = Σ m̃_r [h_r + noise + geomorphic]…",
  );
  check();

  const scattered = scatterTerrainAssets(
    plan,
    heightField,
    seed,
    plan.visualContract?.vegetationDensityScale ?? (terrainSource === "image_guided" ? 0.28 : 1),
  );
  log(
    "terrain_build",
    "TerrainGenerationAgent",
    `Height ${heightField.resolution}² · scattered ${scattered.length} terrain assets`,
    "success",
  );

  onProgress("terrain_refine", 0.52);
  log(
    "terrain_refine",
    "TerrainRefineAgent",
    "Render-inspect loop: boundary blend, landform transitions…",
  );
  // Both procedural and image-derived fields need the same named-region
  // construction pass. The canonical image owns land/water topology; this
  // bounded pass turns semantic bamboo terraces, settlement lots, and ridges
  // into actual geometry instead of leaving those concepts painted only.
  heightField = refineTerrainHeights(heightField, plan);
  log(
    "terrain_refine",
    "TerrainRefineAgent",
    "Terrain foundation T accepted — global spatial organization locked",
    "success",
  );
  check();

  // ─── Stage 3: Regional Object Generation & Placement (paper §2.3) ─
  onProgress("regional_plan", 0.6);
  log(
    "regional_plan",
    "RegionalPlanningAgent",
    "Selecting R+ regions with uninstantiated object requirements…",
  );

  ensureMainObjectRequirements(plan, explicitObjectCounts);
  ensureObjectRequirements(plan);
  canonicalizeSettlementStructureKinds(plan);
  reconcileExplicitSettlementPrograms(plan);
  // Defaults and model-authored totals are subordinate to noun-adjacent user counts.
  reconcileExplicitObjectRequirements(plan, explicitObjectCounts);
  propagateSettlementConstructionAppearance(plan);

  const activeRegions = plan.regions.filter(
    (r) => (plan.objectRequirements[r.name]?.length ?? 0) > 0,
  );
  log(
    "regional_plan",
    "RegionalPlanningAgent",
    `Developing ${activeRegions.length} regions: ${activeRegions.map((r) => r.name).join(", ") || "(density scatter)"}`,
    "success",
  );
  for (const r of activeRegions) {
    const n = plan.objectRequirements[r.name]?.reduce((s, o) => s + o.count, 0) ?? 0;
    log(
      "regional_plan",
      "RegionalPlanningAgent",
      `  · ${r.name} (${r.role}): ~${n} instances planned`,
      "detail",
    );
  }

  onProgress("object_gen", 0.7);
  log(
    "object_gen",
    "ObjectGenerationAgent",
    "Terrain-conditioned composition → semantic placement → browser asset resolution…",
  );
  check();

  let objects = generateRegionalObjects(plan, heightField, seed, explicitObjectCounts);
  const placementTelemetry: RequiredObjectPlacementTelemetry[] = [];
  const regionalRepair = repairRegionalObjectCoverage(
    plan,
    heightField,
    seed,
    objects,
    explicitObjectCounts,
  );
  objects = regionalRepair.objects;
  for (const decision of regionalRepair.decisions) {
    const required = Math.max(decision.chosen, decision.minimum);
    log(
      "object_gen",
      "RegionalPlacementAgent",
      `${decision.regionName} ${decision.kind}: requested ${decision.requested} · capacity ${decision.capacity} · chosen ${decision.chosen} · placed ${decision.placed} · scale ${decision.scaleFactor.toFixed(2)} · ${decision.exact ? "user-exact" : `model-density (street minimum ${decision.minimum})`} · attempts ${decision.attempts} · rejected world=${decision.rejected.world}, terrain=${decision.rejected.terrain}, region=${decision.rejected.region}, collision=${decision.rejected.collision}`,
      decision.placed >= required ? "detail" : "warn",
    );
  }
  if (regionalRepair.deficits.length > 0) {
    const summary = regionalRepair.deficits
      .map((deficit) => {
        const decision = regionalRepair.decisions.find(
          (candidate) => candidate.regionId === deficit.regionId && candidate.kind === deficit.kind,
        );
        const telemetry = decision
          ? `; capacity=${decision.capacity}, chosen=${decision.chosen}, scale=${decision.scaleFactor.toFixed(2)}, attempts=${decision.attempts}, rejected world=${decision.rejected.world}, terrain=${decision.rejected.terrain}, region=${decision.rejected.region}, collision=${decision.rejected.collision}`
          : "";
        return `${deficit.regionName} ${deficit.kind}: ${deficit.placed}/${deficit.required} placed (${deficit.missing} missing${telemetry})`;
      })
      .join("; ");
    throw new Error(`Regional placement contract failed: ${summary}`);
  }
  objects = ensureRequiredObjectKinds(
    plan,
    heightField,
    seed,
    objects,
    heroRequiredCounts(plan, explicitObjectCounts),
    placementTelemetry,
  );
  let placementTelemetryLogged = 0;
  for (const entry of placementTelemetry) {
    log(
      "object_gen",
      "RegionalPlacementAgent",
      `Required placement: ${formatRequiredPlacementTelemetry([entry])}`,
      entry.placed >= entry.required ? "detail" : "warn",
    );
    placementTelemetryLogged++;
  }
  const placedCounts = new Map<ObjectKind, number>();
  for (const object of objects) {
    placedCounts.set(object.kind, (placedCounts.get(object.kind) ?? 0) + 1);
  }
  for (const s of scattered) {
    const kind = terrainScatterObjectKind(plan, s.kind);
    const exactLimit = explicitObjectCounts.get(kind);
    if (exactLimit !== undefined && (placedCounts.get(kind) ?? 0) >= exactLimit) continue;
    const scatteredObject: WorldScene["objects"][number] = {
      id: `scatter_${objects.length}`,
      kind,
      regionId: "terrain",
      position: s.position,
      rotation: [0, s.rotation, 0],
      scale: s.scale * WORLD_OBJECT_FIT,
      color:
        kind === "palm" || kind === "tree" || kind === "pine"
          ? "#2d5a28"
          : kind === "cactus"
            ? "#3a7a40"
            : kind === "crystal"
              ? "#66aaff"
              : "#6a6560",
      secondaryColor: "#4a3020",
      label: `terrain:${s.kind}`,
      contactScore: 0.6,
      refined: false,
    };
    const scatteredFootprint = objectFootprintXZ(scatteredObject);
    if (
      objects.some((existing) =>
        footprintsOverlapXZ(scatteredFootprint, objectFootprintXZ(existing)),
      )
    ) {
      continue;
    }
    objects.push(scatteredObject);
    placedCounts.set(kind, (placedCounts.get(kind) ?? 0) + 1);
  }

  // Count the actual terrain scatter, then make one bounded, collision-aware
  // attempt to fill every remaining authored requirement.
  objects = repairRequestedObjectCoverage(
    plan,
    heightField,
    seed,
    objects,
    explicitObjectCounts,
    placementTelemetry,
  );
  for (const entry of placementTelemetry.slice(placementTelemetryLogged)) {
    log(
      "object_gen",
      "RegionalPlacementAgent",
      `Coverage placement: ${formatRequiredPlacementTelemetry([entry])}`,
      entry.placed >= entry.required ? "detail" : "warn",
    );
  }
  const coverage = objectCoverage(plan, objects, explicitObjectCounts);
  const coverageDecision = objectCoveragePipelineDecision(coverage);
  log(
    "object_gen",
    "ObjectGenerationAgent",
    `Requirement coverage ${(coverage.satisfactionRatio * 100).toFixed(1)}% · missing kinds ${coverage.missingKinds.join(", ") || "none"}`,
    coverageDecision === "pass" ? "success" : "warn",
  );
  if (coverage.missingHeroKinds.length > 0) {
    const missingSet = new Set(coverage.missingHeroKinds);
    const placementSummary = formatRequiredPlacementTelemetry(placementTelemetry, missingSet);
    throw new Error(
      `Reference contract failed: missing required hero objects ${coverage.missingHeroKinds.join(
        ", ",
      )}${placementSummary ? `. Placement rejection ledger: ${placementSummary}` : ""}`,
    );
  }
  if (coverageDecision === "retain-warning") {
    log(
      "object_gen",
      "ObjectGenerationAgent",
      `World retained for inspection with requested-object coverage warning: ${(coverage.satisfactionRatio * 100).toFixed(1)}% placed (missing kinds ${coverage.missingKinds.join(", ") || "none"}); exact heroes remain satisfied`,
      "warn",
    );
  }

  const assetResolution = await attachBrowserAssets(objects, undefined, requestSignal);
  objects = assetResolution.objects;
  const assetEvidence = summarizeAssetResolution(assetResolution);
  ensembleEvidence = buildAssetVariantEvidence(ensembleEvidence, assetResolution);
  if (ensembleEvidence) onEvidence?.(ensembleEvidence);
  check();

  log(
    "object_gen",
    "ObjectGenerationAgent",
    assetEvidence.status === "compiled"
      ? `Prepared ${objects.length} placed-object records · compiled=${assetEvidence.compiledInstances} · fallback=0 · missing=0`
      : `Prepared ${objects.length} placed-object records · asset status=${assetEvidence.status} · compiled=${assetEvidence.compiledInstances} · fallback=${assetEvidence.fallbackInstances} · missing=${assetEvidence.missingInstances}${assetResolution.error ? ` (${assetResolution.error.slice(0, 90)})` : ""}`,
    assetEvidence.status === "compiled" ? "success" : "warn",
  );
  if (assetResolution.prototypes.length > 0) {
    log(
      "object_gen",
      "ObjectGenerationAgent",
      `Cached GLB library ${assetResolution.manifest?.library.uri} · prototypes ${assetResolution.prototypes.join(", ")}`,
      "detail",
    );
  }
  assertAssetResolutionPolicy(assetResolution, options);

  onProgress("object_place", 0.8);
  log(
    "object_place",
    "PlacementAgent",
    "Applying deterministic kind-scale calibration and terrain contact constraints…",
  );
  objects = calibrateScales(objects);
  log("object_place", "PlacementAgent", "Scale calibration + contact search complete", "success");
  check();

  onProgress("scene_refine", 0.9);
  log(
    "scene_refine",
    "SceneRefineAgent",
    "Numerical transform refinement: floating, penetration, pose, and support checks…",
  );

  const { objects: refined, report } = refineScene(objects, heightField, plan, seed, 3);
  log(
    "scene_refine",
    "SceneRefineAgent",
    `Fixed floating=${report.floatingFixed} · penetration=${report.penetrationFixed} · scale=${report.scaleFixed} · pose=${report.poseFixed}`,
    "detail",
  );
  log(
    "scene_refine",
    "SceneRefineAgent",
    "Numerical transform refinement completed within the iteration budget",
    "success",
  );

  onProgress("compose", 0.96);
  log(
    "compose",
    "WorldClaw",
    "Composing S = Compose(T, O) — Blender prototype instances and primitive fallbacks ready for free-viewpoint exploration",
  );
  await sleep(80);

  const world: WorldScene = {
    id: `world_${seed.toString(16)}`,
    plan,
    terrainSpec,
    heightField,
    objects: refined,
    seed,
    generatedAt: Date.now(),
    inferenceMeta: {
      layoutImageUrl,
      layoutPrompt,
      planSource,
      terrainSource,
      planProvider,
      terrainProvider,
      perspectiveProvider,
      visualAnalysisProvider,
      ensemble: ensembleEvidence,
      objectCoverage: coverage,
    },
  };

  onProgress("done", 1);
  log(
    "done",
    "WorldClaw",
    `World ready · deterministic seed=0x${seed.toString(16)} · plan=${planSource} · terrain=${terrainSource} · ${plan.regions.length} regions · Blender GLB=${assetResolution.blenderPrototypeInstances} · primitive=${assetResolution.primitiveFallbackInstances}`,
    "success",
  );

  return world;
}

export function ensureObjectRequirements(plan: ScenePlan) {
  const tropicalIntent = hasTropicalIntent(plan);
  const settlementCountMatch = new RegExp(
    String.raw`\b(${Object.keys(NUMBER_WORDS).join("|")}|\d{1,2})\b(?:\s+[a-z][a-z-]*){0,5}\s+(?:towns?|settlements?|villages?)\b`,
    "i",
  ).exec(plan.prompt.slice(0, 4_096));
  const explicitSettlementCount = settlementCountMatch
    ? (NUMBER_WORDS[settlementCountMatch[1]!.toLocaleLowerCase()] ??
      Number.parseInt(settlementCountMatch[1]!, 10))
    : undefined;
  const populatedSettlements = plan.regions.filter(
    (region) =>
      (region.category === "settlement" ||
        /settlement|village|town/i.test(`${region.name} ${region.role}`)) &&
      (plan.objectRequirements[region.name]?.length ?? 0) > 0,
  ).length;
  let remainingSettlementDefaults =
    explicitSettlementCount !== undefined && Number.isFinite(explicitSettlementCount)
      ? Math.max(0, explicitSettlementCount - populatedSettlements)
      : Number.POSITIVE_INFINITY;
  for (const r of plan.regions) {
    if (plan.objectRequirements[r.name]?.length) continue;
    const cat = r.category;
    const regionDescription = `${r.name} ${r.role}`;
    if (cat === "settlement") {
      // A generated semantic map can classify dark roof or basalt patches as
      // extra settlement components. Once the user's exact town count is
      // already represented by authored requirement groups, those empty
      // components must remain empty rather than inventing another town.
      if (remainingSettlementDefaults <= 0) {
        plan.objectRequirements[r.name] = [];
        continue;
      }
      remainingSettlementDefaults--;
      plan.objectRequirements[r.name] =
        plan.theme === "snow"
          ? [
              { category: "building", count: 10 },
              { category: "antenna", count: 3 },
              { category: "satellite", count: 2 },
            ]
          : plan.theme === "desert"
            ? [
                { category: "building", count: 12 },
                { category: "tower", count: 2 },
                { category: "crate", count: 8 },
              ]
            : plan.theme === "medieval"
              ? [
                  { category: "house", count: 10 },
                  { category: "tower", count: 2 },
                  { category: "market", count: 4 },
                ]
              : [
                  { category: "hut", count: 9 },
                  { category: "watchtower", count: 2 },
                  { category: "crate", count: 8 },
                  { category: "campfire", count: 2 },
                ];
    } else if (cat === "forest") {
      plan.objectRequirements[r.name] = /\bbamboo\b/i.test(regionDescription)
        ? [
            {
              category: "tree",
              count: 48,
              appearance:
                "Tall segmented bamboo culms with visible joint rings and narrow lanceolate leaves",
            },
            { category: "rock", count: 8 },
          ]
        : /\b(?:sakura|cherry|blossom)\b/i.test(regionDescription)
          ? [
              {
                category: "tree",
                count: 40,
                appearance:
                  "Branching cherry trees with broad crowns and pale-pink blossom clusters",
              },
              { category: "rock", count: 8 },
            ]
          : tropicalIntent
            ? [
                { category: "palm", count: 48 },
                { category: "tree", count: 18 },
                { category: "rock", count: 10 },
              ]
            : plan.theme === "snow"
              ? [
                  { category: "pine", count: 44 },
                  { category: "rock", count: 12 },
                ]
              : [
                  { category: "tree", count: 40 },
                  { category: "rock", count: 10 },
                ];
    } else if (cat === "beach") {
      plan.objectRequirements[r.name] = tropicalIntent
        ? [
            { category: "palm", count: 18 },
            { category: "dock", count: 2 },
            { category: "boat", count: 4 },
            { category: "ship", count: 2, scale: 1.3 },
          ]
        : [
            {
              category: "tree",
              count: 6,
              appearance: "Sparse native coastal broadleaf trees; no tropical palms",
            },
            { category: "dock", count: 2 },
            { category: "boat", count: 4 },
            { category: "ship", count: 2, scale: 1.3 },
          ];
    } else if (cat === "rock" || cat === "mountain" || cat === "cliff" || cat === "canyon") {
      plan.objectRequirements[r.name] = hasCombatOpenWorldIntent(plan)
        ? /cover|ridge|high ground/i.test(`${r.name} ${r.role}`)
          ? [
              { category: "boulder", count: 6 },
              { category: "rock", count: 5 },
            ]
          : []
        : [
            { category: "boulder", count: 14 },
            { category: "rock", count: 18 },
          ];
    } else if (cat === "sand" || cat === "desert") {
      plan.objectRequirements[r.name] =
        hasCombatOpenWorldIntent(plan) || isOpenCombatRegion(r)
          ? []
          : [
              { category: "cactus", count: 22 },
              { category: "rock", count: 12 },
            ];
    } else if (cat === "snow") {
      plan.objectRequirements[r.name] = [
        { category: "pine", count: 28 },
        { category: "rock", count: 10 },
      ];
    } else if (cat === "ocean" && (plan.theme === "tropical" || plan.theme === "island")) {
      plan.objectRequirements[r.name] = [
        { category: "ship", count: 3, scale: 1.5 },
        { category: "boat", count: 5 },
      ];
    }
  }
}

export function makeLogEntry(partial: Omit<AgentLogEntry, "id" | "t">): AgentLogEntry {
  return {
    ...partial,
    id: `log_${logId++}`,
    t: Date.now(),
  };
}

import type { BrowserAssetMetadata, WorldScene } from "./types";

interface ConstructionRule {
  readonly label: string;
  readonly family?: string;
  readonly required: RegExp;
  readonly satisfied: (vocabulary: string) => boolean;
}

const CONSTRUCTION_RULES: readonly ConstructionRule[] = [
  {
    label: "exposed timber frame",
    family: "timber",
    required: /(?:exposed|structural|dark)\s+timber|timber\s+(?:frame|beams?)/i,
    satisfied: (vocabulary) => /timber frame|structural timber|timber structural/.test(vocabulary),
  },
  {
    label: "thatch",
    family: "thatch",
    required: /thatch/i,
    satisfied: (vocabulary) => /thatch/.test(vocabulary),
  },
  {
    label: "natural slate",
    family: "slate",
    // A phrase such as "dark slate overlapping roof tiles" describes a
    // Japanese tile colour, not a natural-slate construction family.
    required: /\bslate\b(?![^,.;]{0,32}\btiles?\b)/i,
    satisfied: (vocabulary) => /slate/.test(vocabulary),
  },
  {
    label: "overlapping roof tile",
    family: "roof tile",
    required: /(?:roof|slate|charcoal|dark)\s+tiles?|tiled\s+roof/i,
    satisfied: (vocabulary) =>
      /roof tile|charcoal tile|tile (?:gable|eave)|kawara|slate (?:roof )?courses?|slate eaves?/.test(
        vocabulary,
      ),
  },
  {
    label: "brick",
    family: "brick",
    required: /brick/i,
    satisfied: (vocabulary) => /brick/.test(vocabulary),
  },
  {
    label: "stone",
    family: "stone",
    required: /stone masonry|stone wall/i,
    satisfied: (vocabulary) => /stone|granite|limestone/.test(vocabulary),
  },
  {
    label: "plaster infill",
    family: "plaster",
    required: /plaster|lime infill/i,
    satisfied: (vocabulary) => /plaster|lime infill/.test(vocabulary),
  },
  {
    label: "constructed door",
    required: /door/i,
    satisfied: (vocabulary) => /door assembly|door/.test(vocabulary),
  },
  {
    label: "constructed window",
    required: /window/i,
    satisfied: (vocabulary) => /opening assembl|window|glazing|lattice/.test(vocabulary),
  },
] as const;

const KIND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  house: ["house", "building"],
  houses: ["house", "building"],
  building: ["building", "house"],
  buildings: ["building", "house"],
};

const BUILDING_ENVELOPE_KINDS = new Set(["building", "house", "hut", "watchtower"]);

const SUBJECT_PATTERNS: Readonly<Record<string, RegExp>> = {
  building: /\b(?:buildings?|houses?)\b/gi,
  house: /\b(?:houses?|buildings?)\b/gi,
  hut: /\bhuts?\b/gi,
  watchtower: /\bwatchtowers?\b/gi,
  pagoda: /\b(?:pagodas?|temples?)\b/gi,
  torii: /\btorii\b/gi,
  fence: /\bfences?\b/gi,
  bridge: /\bbridges?\b/gi,
  dock: /\b(?:docks?|piers?|jett(?:y|ies))\b/gi,
  ship: /\bships?\b/gi,
  boat: /\bboats?\b/gi,
  tower: /\btowers?\b/gi,
};

function normalizedKind(value: string): string {
  const kind = value.trim().toLocaleLowerCase();
  return kind.endsWith("s") && kind.length > 3 ? kind.slice(0, -1) : kind;
}

function regexMatches(regex: RegExp, value: string): Array<{ index: number; text: string }> {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matcher = new RegExp(regex.source, flags);
  const matches: Array<{ index: number; text: string }> = [];
  for (const match of value.matchAll(matcher)) {
    if (match.index === undefined) continue;
    matches.push({ index: match.index, text: match[0] });
  }
  return matches;
}

function allSubjectMatches(value: string): Array<{ index: number; kind: string }> {
  return Object.entries(SUBJECT_PATTERNS)
    .flatMap(([kind, pattern]) => regexMatches(pattern, value).map((match) => ({ ...match, kind })))
    .sort((left, right) => left.index - right.index);
}

/**
 * Construction language in the original prompt is authoritative only for the
 * nearest named subject. This prevents "Buildings use timber and plaster"
 * from silently becoming a pagoda or fence contract elsewhere in the prompt.
 */
export function promptExplicitlyScopesConstructionRule(
  prompt: string,
  requestedKind: string,
  rule: Pick<ConstructionRule, "required">,
): boolean {
  const kind = normalizedKind(requestedKind);
  const acceptedKinds = new Set(KIND_ALIASES[kind] ?? [kind]);
  for (const clause of prompt.split(/[.!?;\n]+/).map((value) => value.trim())) {
    if (!clause) continue;
    const ruleMatches = regexMatches(rule.required, clause);
    if (ruleMatches.length === 0) continue;
    const subjects = allSubjectMatches(clause);
    for (const ruleMatch of ruleMatches) {
      const before = subjects.filter((subject) => subject.index <= ruleMatch.index).at(-1);
      const after = subjects.find((subject) => subject.index > ruleMatch.index);
      const candidates = [before, after].filter(
        (subject): subject is { index: number; kind: string } => Boolean(subject),
      );
      const nearest = candidates.sort(
        (left, right) =>
          Math.abs(left.index - ruleMatch.index) - Math.abs(right.index - ruleMatch.index),
      )[0];
      if (nearest && acceptedKinds.has(nearest.kind)) return true;
    }
  }
  return false;
}

function assetVocabulary(asset: BrowserAssetMetadata | undefined): string {
  if (!asset) return "";
  return [
    asset.variantId,
    asset.prototype,
    ...(asset.appearanceTerms ?? []),
    ...(asset.materialIds ?? []),
    asset.constructionRecipe?.wallAssembly,
    ...(asset.constructionRecipe?.openingAssemblies ?? []),
    asset.constructionRecipe?.doorAssembly,
    asset.constructionRecipe?.roofAssembly,
    asset.constructionRecipe?.gateAssembly,
    asset.constructionRecipe?.weatheringProfile,
    ...(asset.constructionRecipe?.systems ?? []),
    ...(asset.constructionRecipe?.geometryGuarantees ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .replaceAll("_", " ")
    .toLocaleLowerCase();
}

export type ConstructionRequirementAuthority =
  "user_subject_scoped" | "building_envelope" | "selected_manifest_variant";

export function constructionRequirementAuthority(input: {
  readonly prompt: string;
  readonly requestedKind: string;
  readonly appearance: string;
  readonly ruleLabel: string;
}): ConstructionRequirementAuthority {
  const rule = CONSTRUCTION_RULES.find((candidate) => candidate.label === input.ruleLabel);
  if (!rule) throw new Error(`Unknown construction audit rule: ${input.ruleLabel}`);
  if (promptExplicitlyScopesConstructionRule(input.prompt, input.requestedKind, rule)) {
    return "user_subject_scoped";
  }
  if (
    BUILDING_ENVELOPE_KINDS.has(normalizedKind(input.requestedKind)) &&
    rule.required.test(input.appearance)
  ) {
    return "building_envelope";
  }
  return "selected_manifest_variant";
}

function addFamilyCount(
  familyCounts: Map<string, { expected: number; matched: number }>,
  family: string | undefined,
  expected: number,
  matched: number,
): void {
  if (!family || expected === 0) return;
  const counts = familyCounts.get(family) ?? { expected: 0, matched: 0 };
  counts.expected += expected;
  counts.matched += matched;
  familyCounts.set(family, counts);
}

/**
 * Audit prompt-authoritative building construction while respecting authored
 * specialty assets. Pagodas, torii, bridges, and similar objects are audited
 * against their selected manifest variant unless the user explicitly scopes a
 * construction request to that subject. Primitive dressing such as an
 * unrequested fence cannot inherit a neighboring house contract.
 */
export function constructionAudit(world: WorldScene): {
  conflicts: string[];
  materialFamilyMacroF1: number;
} {
  const conflicts = new Set<string>();
  const familyCounts = new Map<string, { expected: number; matched: number }>();
  for (const [regionName, requirements] of Object.entries(world.plan.objectRequirements)) {
    const regionId = world.plan.regions.find((region) => region.name === regionName)?.id;
    for (const requirement of requirements) {
      const appearance = requirement.appearance ?? "";
      const requestedKind = requirement.category.toLocaleLowerCase();
      const acceptedKinds = KIND_ALIASES[requestedKind] ?? [requestedKind.replace(/s$/, "")];
      const candidates = world.objects
        .filter(
          (object) =>
            acceptedKinds.includes(object.kind) && (!regionId || object.regionId === regionId),
        )
        .slice(0, requirement.count)
        .map((object) => ({ object, vocabulary: assetVocabulary(object.browserAsset) }));

      for (const rule of CONSTRUCTION_RULES) {
        const authority = constructionRequirementAuthority({
          prompt: world.plan.prompt,
          requestedKind,
          appearance,
          ruleLabel: rule.label,
        });
        if (authority === "selected_manifest_variant") {
          // A selected authored variant declares its own applicable systems.
          // Only rules evidenced by that variant participate; leaked prose in
          // another object's appearance field has no authority here.
          const declared = candidates.filter(
            ({ vocabulary }) =>
              vocabulary && (rule.required.test(vocabulary) || rule.satisfied(vocabulary)),
          );
          const matched = declared.filter(({ vocabulary }) => rule.satisfied(vocabulary)).length;
          addFamilyCount(familyCounts, rule.family, declared.length, matched);
          if (matched < declared.length) {
            conflicts.add(
              `${regionName} ${requirement.category}: ${matched}/${declared.length} selected manifest variants resolve their declared ${rule.label} construction`,
            );
          }
          continue;
        }

        if (authority === "building_envelope" && !rule.required.test(appearance)) continue;
        const matched = candidates.filter(({ vocabulary }) => rule.satisfied(vocabulary)).length;
        addFamilyCount(familyCounts, rule.family, requirement.count, matched);
        if (matched < requirement.count) {
          conflicts.add(
            `${regionName} ${requirement.category}: ${matched}/${requirement.count} resolve required ${rule.label} construction`,
          );
        }
      }
    }
  }
  const familyF1 = [...familyCounts.values()].map(({ expected, matched }) => {
    const truePositive = Math.min(expected, matched);
    const precision = matched === 0 ? 0 : truePositive / matched;
    const recall = expected === 0 ? 1 : truePositive / expected;
    return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  });
  return {
    conflicts: [...conflicts].sort(),
    materialFamilyMacroF1:
      familyF1.length === 0 ? 1 : familyF1.reduce((sum, value) => sum + value, 0) / familyF1.length,
  };
}

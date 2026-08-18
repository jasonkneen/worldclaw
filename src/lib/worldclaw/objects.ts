/**
 * Stage 3 — Regional Object Generation & Placement (paper §2.3).
 * Region composition prior → instance generation → terrain placement → scale calibration.
 */

import { OBJECT_PALETTES } from "./materials";
import { mulberry32 } from "./noise";
import { sampleHeight, sampleNormal, sampleSlope } from "./terrain";
import type {
  HeightField,
  ObjectKind,
  ObjectRequirement,
  PlacedObject,
  RegionSpec,
  ScenePlan,
} from "./types";

const TWO_PI = Math.PI * 2;
const MAX_OBJECTS_PER_REQUIREMENT = 160;
const BRIDGE_AUTHORED_SPAN_METERS = 16;
const BRIDGE_BASE_SCALE = 3.5;
const MIN_BRIDGE_SPAN_METERS = 12;
const MAX_BRIDGE_SPAN_METERS = 24;
const MAX_BRIDGE_CANDIDATES = 96;

const KIND_ALIASES: Record<string, ObjectKind> = {
  hut: "hut",
  house: "house",
  tower: "tower",
  dock: "dock",
  ship: "ship",
  tree: "tree",
  palm: "palm",
  pine: "pine",
  rock: "rock",
  boulder: "boulder",
  cactus: "cactus",
  vehicle: "vehicle",
  tank: "tank",
  building: "building",
  antenna: "antenna",
  fence: "fence",
  campfire: "campfire",
  tent: "tent",
  bridge: "bridge",
  statue: "statue",
  crystal: "crystal",
  mine: "mine",
  dragon: "dragon",
  windmill: "windmill",
  well: "well",
  crate: "crate",
  watchtower: "watchtower",
  satellite: "satellite",
  bunker: "bunker",
  boat: "boat",
  pagoda: "pagoda",
  torii: "torii",
  barn: "barn",
  market: "market",
  totem: "statue",
};

/**
 * Terrain stays at WORLD_SIZE meters. Placed objects use this fit so houses,
 * boats, and landmarks occupy a village-scale fraction of each region instead
 * of filling a 12 m town radius with 8 m authored buildings.
 */
export const WORLD_OBJECT_FIT = 0.64;

const BASE_SCALES: Partial<Record<ObjectKind, number>> = {
  hut: 1.2,
  house: 1.6,
  tower: 2.2,
  dock: 2.5,
  ship: 3.2,
  tree: 1.4,
  palm: 1.6,
  pine: 1.8,
  rock: 0.8,
  boulder: 1.3,
  cactus: 1,
  vehicle: 1.4,
  tank: 1.8,
  building: 2.4,
  antenna: 2.8,
  fence: 1,
  campfire: 0.7,
  tent: 1.1,
  bridge: 3.5,
  statue: 1.5,
  crystal: 0.9,
  mine: 2,
  dragon: 4,
  windmill: 3.5,
  well: 1,
  crate: 0.55,
  watchtower: 2.5,
  satellite: 1.6,
  bunker: 2,
  boat: 1.4,
  pagoda: 2.8,
  torii: 2.2,
  barn: 2.2,
  market: 1.8,
};

export function kindBaseScale(kind: ObjectKind): number {
  return (BASE_SCALES[kind] ?? 1) * WORLD_OBJECT_FIT;
}

interface FootprintDefinition {
  widthMeters: number;
  depthMeters: number;
  nominalScale: number;
  source: "compiled-prototype" | "primitive-fallback";
}

/** Dimensions mirror the browser GLB collider manifest and its aliases. */
const COMPILED_FOOTPRINTS: Partial<Record<ObjectKind, FootprintDefinition>> = {
  palm: { widthMeters: 0.84, depthMeters: 0.84, nominalScale: 1.6, source: "compiled-prototype" },
  tree: { widthMeters: 1.16, depthMeters: 1.16, nominalScale: 1.4, source: "compiled-prototype" },
  pine: { widthMeters: 1.04, depthMeters: 1.04, nominalScale: 1.8, source: "compiled-prototype" },
  rock: { widthMeters: 2.1, depthMeters: 2.1, nominalScale: 0.8, source: "compiled-prototype" },
  boulder: { widthMeters: 2.1, depthMeters: 2.1, nominalScale: 1.3, source: "compiled-prototype" },
  cactus: { widthMeters: 0.8, depthMeters: 0.8, nominalScale: 1, source: "compiled-prototype" },
  hut: { widthMeters: 4.5, depthMeters: 3.8, nominalScale: 1.2, source: "compiled-prototype" },
  house: { widthMeters: 4.5, depthMeters: 3.8, nominalScale: 1.6, source: "compiled-prototype" },
  barn: { widthMeters: 4.5, depthMeters: 3.8, nominalScale: 2.2, source: "compiled-prototype" },
  building: { widthMeters: 5.4, depthMeters: 4.4, nominalScale: 2.4, source: "compiled-prototype" },
  bunker: { widthMeters: 5.4, depthMeters: 4.4, nominalScale: 2, source: "compiled-prototype" },
  tower: { widthMeters: 3.8, depthMeters: 3.4, nominalScale: 2.2, source: "compiled-prototype" },
  watchtower: {
    widthMeters: 3.8,
    depthMeters: 3.4,
    nominalScale: 2.5,
    source: "compiled-prototype",
  },
  ship: { widthMeters: 9.4, depthMeters: 3.6, nominalScale: 3.2, source: "compiled-prototype" },
  boat: { widthMeters: 9.4, depthMeters: 3.6, nominalScale: 1.4, source: "compiled-prototype" },
  bridge: { widthMeters: 16, depthMeters: 3.4, nominalScale: 3.5, source: "compiled-prototype" },
  vehicle: { widthMeters: 5.8, depthMeters: 3.2, nominalScale: 1.4, source: "compiled-prototype" },
  tank: { widthMeters: 5.8, depthMeters: 3.2, nominalScale: 1.8, source: "compiled-prototype" },
  pagoda: { widthMeters: 7.9, depthMeters: 7.9, nominalScale: 2.8, source: "compiled-prototype" },
  torii: { widthMeters: 6.9, depthMeters: 1.1, nominalScale: 2.2, source: "compiled-prototype" },
};

const FALLBACK_FOOTPRINTS: Partial<Record<ObjectKind, [number, number]>> = {
  dock: [3.2, 1.1],
  market: [1.8, 1.4],
  mine: [1.7, 1.2],
  tent: [1.6, 1.3],
  fence: [2.1, 0.25],
  crate: [1, 1],
  campfire: [1, 1],
  well: [1.3, 1.3],
  windmill: [1.3, 1.3],
  antenna: [0.7, 0.7],
  satellite: [1.1, 1.1],
  statue: [1.1, 1.1],
  crystal: [0.9, 0.9],
  dragon: [2.4, 2.4],
};

const STRUCTURE_KINDS = new Set<ObjectKind>([
  "hut",
  "house",
  "tower",
  "building",
  "barn",
  "market",
  "pagoda",
  "bunker",
  "mine",
  "watchtower",
  "windmill",
  "antenna",
  "satellite",
  "torii",
  "bridge",
]);

const PLAZA_ANCHOR_KINDS = new Set<ObjectKind>(["well", "statue", "campfire"]);
const REGIONAL_SETTLEMENT_BUILDING_KINDS = new Set<ObjectKind>([
  "building",
  "house",
  "hut",
  "barn",
]);
const REGIONAL_DRESSING_KINDS = new Set<ObjectKind>([
  "tree",
  "palm",
  "pine",
  "rock",
  "boulder",
  "cactus",
  "fence",
  "campfire",
  "crate",
  "crystal",
  "market",
  "well",
  "statue",
  "tent",
]);
const MIN_SETTLEMENT_STREET_BUILDINGS = 4;
const MAX_SETTLEMENT_CAPACITY_PROBE = 24;

export interface RegionalObjectDeficit {
  regionId: string;
  regionName: string;
  kind: ObjectKind;
  required: number;
  placed: number;
  missing: number;
}

export interface RegionalObjectCountDecision {
  regionId: string;
  regionName: string;
  kind: ObjectKind;
  requested: number;
  capacity: number;
  chosen: number;
  placed: number;
  minimum: number;
  exact: boolean;
  scaleFactor: number;
  attempts: number;
  rejected: {
    world: number;
    terrain: number;
    region: number;
    collision: number;
  };
}

export interface RegionalObjectRepairResult {
  objects: PlacedObject[];
  deficits: RegionalObjectDeficit[];
  decisions: RegionalObjectCountDecision[];
}

export interface RequiredPlacementRegionTelemetry {
  regionId: string;
  regionName: string;
  category: RegionSpec["category"];
  center: readonly [number, number];
  radius: number;
  waterBearing: number | null;
  attempts: number;
  rejected: {
    world: number;
    terrain: number;
    region: number;
    collision: number;
  };
  placed: number;
}

export interface RequiredObjectPlacementTelemetry {
  kind: ObjectKind;
  required: number;
  initiallyPlaced: number;
  placed: number;
  authoredRegionLock: boolean;
  locationAuthority?: "user-explicit" | "model-suggested" | "unassigned";
  sourceRegionIds?: string[];
  selectedRegionId?: string;
  relocated?: boolean;
  relocationReason?: string;
  regions: RequiredPlacementRegionTelemetry[];
}

export interface ObjectFootprintXZ {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  yaw: number;
  source: "compiled-prototype" | "primitive-fallback";
}

interface FootprintObjectInput {
  kind: ObjectKind;
  scale: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
}

interface CandidateXZ {
  x: number;
  z: number;
  yaw: number;
}

interface HarborFormationPlacement extends CandidateXZ {
  scale: number;
}

interface HarborFormation {
  placements: HarborFormationPlacement[];
  scaleFactor: number;
  attempt: number;
}

interface BridgeCrossingCandidate extends CandidateXZ {
  scale: number;
  spanMeters: number;
  deckY: number;
  score: number;
}

interface PlannedRequirement {
  requirement: ObjectRequirement;
  kind: ObjectKind;
  count: number;
  order: number;
}

interface RegionalPlacementContext {
  regionIndex: number;
  centerX: number;
  centerZ: number;
  semanticYaw: number;
  hasDrySemanticCells: boolean;
}

interface RegionalPackingItem {
  object: PlacedObject;
  requirement: ObjectRequirement;
  targetIndex: number;
}

interface RegionalRequirementTarget {
  requirement: ObjectRequirement;
  kind: ObjectKind;
  requested: number;
  exact: boolean;
  chosen: number;
}

interface RegionalSettlementPlan {
  region: RegionSpec;
  targets: RegionalRequirementTarget[];
  availableItems: RegionalPackingItem[];
  capacity: number;
  chosenTotal: number;
  scaleFactor: number;
}

interface RegionalPackingTelemetry {
  attempts: number;
  rejected: {
    world: number;
    terrain: number;
    region: number;
    collision: number;
  };
}

interface RegionalPackingTrial {
  objects: PlacedObject[];
  packedByRegionId: Map<string, PlacedObject[]>;
  telemetryByRegionId: Map<string, RegionalPackingTelemetry>;
  shortfall: number;
  satisfiedRegions: number;
  placedTotal: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const CATEGORY_WORD_ALIASES: Record<string, ObjectKind> = {
  ...KIND_ALIASES,
  huts: "hut",
  houses: "house",
  towers: "tower",
  docks: "dock",
  pier: "dock",
  piers: "dock",
  jetty: "dock",
  jetties: "dock",
  ships: "ship",
  boats: "boat",
  trees: "tree",
  palms: "palm",
  pines: "pine",
  rocks: "rock",
  boulders: "boulder",
  cacti: "cactus",
  vehicles: "vehicle",
  truck: "vehicle",
  trucks: "vehicle",
  car: "vehicle",
  cars: "vehicle",
  wreck: "vehicle",
  wrecks: "vehicle",
  tanks: "tank",
  buildings: "building",
  fort: "building",
  forts: "building",
  castle: "building",
  castles: "building",
  factory: "building",
  factories: "building",
  antennas: "antenna",
  fences: "fence",
  campfires: "campfire",
  tents: "tent",
  bridges: "bridge",
  statues: "statue",
  monument: "statue",
  monuments: "statue",
  totems: "statue",
  crystals: "crystal",
  mines: "mine",
  dragons: "dragon",
  windmills: "windmill",
  wells: "well",
  crates: "crate",
  watchtowers: "watchtower",
  satellites: "satellite",
  bunkers: "bunker",
  pagodas: "pagoda",
  temple: "pagoda",
  temples: "pagoda",
  gates: "torii",
  barns: "barn",
  markets: "market",
};

/** Resolve model-authored category prose and plurals to the placement kind. */
export function resolveObjectKind(category: string): ObjectKind {
  const normalized = category.toLocaleLowerCase().trim();
  const direct = CATEGORY_WORD_ALIASES[normalized];
  if (direct) return direct;
  for (const token of normalized.split(/[^a-z]+/).filter(Boolean)) {
    const kind = CATEGORY_WORD_ALIASES[token];
    if (kind) return kind;
  }
  return "crate";
}

function isVegetation(kind: ObjectKind): boolean {
  return kind === "tree" || kind === "palm" || kind === "pine" || kind === "cactus";
}

function isStructure(kind: ObjectKind): boolean {
  return STRUCTURE_KINDS.has(kind);
}

function isMaritime(kind: ObjectKind): boolean {
  return kind === "ship" || kind === "boat";
}

function isSettlementRegion(region: RegionSpec): boolean {
  return (
    region.category === "settlement" ||
    /settlement|village|town|habitation|compound|base|plaza/i.test(`${region.name} ${region.role}`)
  );
}

/** Apply bounded reference-derived density without needing runtime image pixels. */
export function effectiveRequirementCount(
  plan: ScenePlan,
  requirement: ObjectRequirement,
  kind: ObjectKind,
): number {
  const authoredCount = Math.trunc(
    clamp(finiteOr(requirement.count, 0), 0, MAX_OBJECTS_PER_REQUIREMENT),
  );
  if (authoredCount === 0) return 0;
  const requirementDensity = clamp(finiteOr(requirement.density, 1), 0, 2);
  if (requirementDensity === 0) return 0;
  // Docks are discrete harbor infrastructure, not scatter dressing. Applying
  // the appearance committee's global object-density multiplier turned a
  // single hero pier into 11 unrelated slabs in a strict Japanese-island run.
  if (kind === "dock") return authoredCount;
  const referenceDensity = clamp(
    finiteOr(
      isVegetation(kind)
        ? plan.visualContract?.vegetationDensityScale
        : plan.visualContract?.objectDensityScale,
      1,
    ),
    0.25,
    2,
  );
  return clamp(
    Math.max(1, Math.round(authoredCount * requirementDensity * referenceDensity)),
    0,
    MAX_OBJECTS_PER_REQUIREMENT,
  );
}

export function objectFootprintXZ(object: FootprintObjectInput): ObjectFootprintXZ {
  const compiled = COMPILED_FOOTPRINTS[object.kind];
  const scale = clamp(Math.abs(finiteOr(object.scale, 1)), 0.05, 16);
  const positionX = finiteOr(object.position[0], 0);
  const positionZ = finiteOr(object.position[2], 0);
  const yaw = finiteOr(object.rotation[1], 0);
  if (compiled) {
    const instanceScale = scale / compiled.nominalScale;
    return {
      centerX: positionX,
      centerZ: positionZ,
      halfX: clamp(compiled.widthMeters * instanceScale * 0.5, 0.05, 32),
      halfZ: clamp(compiled.depthMeters * instanceScale * 0.5, 0.05, 32),
      yaw,
      source: compiled.source,
    };
  }
  const [localWidth, localDepth] = FALLBACK_FOOTPRINTS[object.kind] ?? [1, 1];
  return {
    centerX: positionX,
    centerZ: positionZ,
    halfX: clamp(localWidth * scale * 0.5, 0.05, 32),
    halfZ: clamp(localDepth * scale * 0.5, 0.05, 32),
    yaw,
    source: "primitive-fallback",
  };
}

function footprintAxes(footprint: ObjectFootprintXZ): [[number, number], [number, number]] {
  const cosine = Math.cos(footprint.yaw);
  const sine = Math.sin(footprint.yaw);
  return [
    [cosine, -sine],
    [sine, cosine],
  ];
}

/** Separating-axis overlap for two yaw-only physical footprints. */
export function footprintsOverlapXZ(
  a: ObjectFootprintXZ,
  b: ObjectFootprintXZ,
  clearance = 0,
): boolean {
  const safeClearance = clamp(finiteOr(clearance, 0), 0, 8);
  const [aX, aZ] = footprintAxes(a);
  const [bX, bZ] = footprintAxes(b);
  const deltaX = b.centerX - a.centerX;
  const deltaZ = b.centerZ - a.centerZ;
  for (const axis of [aX, aZ, bX, bZ]) {
    const centerDistance = Math.abs(deltaX * axis[0] + deltaZ * axis[1]);
    const radiusA =
      a.halfX * Math.abs(aX[0] * axis[0] + aX[1] * axis[1]) +
      a.halfZ * Math.abs(aZ[0] * axis[0] + aZ[1] * axis[1]);
    const radiusB =
      b.halfX * Math.abs(bX[0] * axis[0] + bX[1] * axis[1]) +
      b.halfZ * Math.abs(bZ[0] * axis[0] + bZ[1] * axis[1]);
    if (centerDistance >= radiusA + radiusB + safeClearance) return false;
  }
  return true;
}

function pairClearance(a: ObjectKind, b: ObjectKind): number {
  if (isMaritime(a) && isMaritime(b)) return 1.2;
  if (isStructure(a) && isStructure(b)) return 0.9;
  if (a === "cactus" && b === "cactus") return 2.4;
  if (isVegetation(a) && isVegetation(b)) return 0.55;
  if (a === "crate" || b === "crate") return 0.3;
  if (a === "dock" || b === "dock") return 0.75;
  return 0.5;
}

function footprintFitsWorld(footprint: ObjectFootprintXZ, worldHalfExtent: number): boolean {
  const cosine = Math.abs(Math.cos(footprint.yaw));
  const sine = Math.abs(Math.sin(footprint.yaw));
  const extentX = cosine * footprint.halfX + sine * footprint.halfZ;
  const extentZ = sine * footprint.halfX + cosine * footprint.halfZ;
  const limit = worldHalfExtent * 0.96;
  return (
    Math.abs(footprint.centerX) + extentX <= limit && Math.abs(footprint.centerZ) + extentZ <= limit
  );
}

function footprintPoints(footprint: ObjectFootprintXZ): [number, number][] {
  const [axisX, axisZ] = footprintAxes(footprint);
  const points: [number, number][] = [[footprint.centerX, footprint.centerZ]];
  for (const signX of [-1, 1]) {
    for (const signZ of [-1, 1]) {
      points.push([
        footprint.centerX + axisX[0] * footprint.halfX * signX + axisZ[0] * footprint.halfZ * signZ,
        footprint.centerZ + axisX[1] * footprint.halfX * signX + axisZ[1] * footprint.halfZ * signZ,
      ]);
    }
  }
  return points;
}

function terrainAccepts(kind: ObjectKind, footprint: ObjectFootprintXZ, hf: HeightField): boolean {
  const heights = footprintPoints(footprint).map(([x, z]) => sampleHeight(hf, x, z));
  const centerHeight = heights[0] ?? 0;
  const slope = sampleSlope(hf, footprint.centerX, footprint.centerZ);
  // Bridges require dry opposing shores and a water-bearing interior. They are
  // accepted only by the bounded crossing solver below, never generic scatter.
  if (kind === "bridge") return false;
  if (isMaritime(kind)) return Math.max(...heights) <= 0.35;
  if (kind === "dock") return centerHeight >= -0.8 && centerHeight <= 1.2;
  if (centerHeight < -0.2) return false;
  if (isStructure(kind) && slope > 0.35) return false;
  if (isVegetation(kind) && slope > 0.55) return false;
  return slope <= 0.7;
}

function normalizedHalfTurn(yaw: number): number {
  const value = yaw % Math.PI;
  return value < 0 ? value + Math.PI : value;
}

function bridgeSpanOptions(desiredSpan: number): number[] {
  const desired = clamp(finiteOr(desiredSpan, BRIDGE_AUTHORED_SPAN_METERS), 12, 24);
  const candidates = [desired, 12, 14, 16, 18, 20, 22, 24];
  return [...new Set(candidates.map((value) => Number(value.toFixed(3))))].sort(
    (a, b) => Math.abs(a - desired) - Math.abs(b - desired) || a - b,
  );
}

function evaluateBridgeCrossing(
  hf: HeightField,
  centerX: number,
  centerZ: number,
  yaw: number,
  spanMeters: number,
  desiredSpan: number,
  waterline: number,
  sourceBias: number,
): BridgeCrossingCandidate | undefined {
  const safeSpan = clamp(finiteOr(spanMeters, BRIDGE_AUTHORED_SPAN_METERS), 12, 24);
  const scale = BRIDGE_BASE_SCALE * (safeSpan / BRIDGE_AUTHORED_SPAN_METERS);
  const footprint = objectFootprintXZ({
    kind: "bridge",
    scale,
    position: [centerX, 0, centerZ],
    rotation: [0, yaw, 0],
  });
  if (!footprintFitsWorld(footprint, hf.worldSize * 0.5)) return undefined;

  const directionX = Math.cos(yaw);
  const directionZ = -Math.sin(yaw);
  const lateralX = Math.sin(yaw);
  const lateralZ = Math.cos(yaw);
  const point = (longitudinal: number, lateral: number): [number, number] => [
    centerX + directionX * longitudinal + lateralX * lateral,
    centerZ + directionZ * longitudinal + lateralZ * lateral,
  ];
  const dryMinimum = waterline + 0.08;
  const waterMaximum = waterline + 0.02;
  const endpointAHeights = [-0.65, 0, 0.65].map((factor) => {
    const [x, z] = point(-footprint.halfX, footprint.halfZ * factor);
    return sampleHeight(hf, x, z);
  });
  const endpointBHeights = [-0.65, 0, 0.65].map((factor) => {
    const [x, z] = point(footprint.halfX, footprint.halfZ * factor);
    return sampleHeight(hf, x, z);
  });
  if (
    endpointAHeights.some((height) => !Number.isFinite(height) || height < dryMinimum) ||
    endpointBHeights.some((height) => !Number.isFinite(height) || height < dryMinimum)
  ) {
    return undefined;
  }

  const centerHeight = sampleHeight(hf, centerX, centerZ);
  if (!Number.isFinite(centerHeight) || centerHeight > waterMaximum) return undefined;
  const interiorHeights = [-0.72, -0.48, -0.24, 0, 0.24, 0.48, 0.72].map((factor) => {
    const [x, z] = point(footprint.halfX * factor, 0);
    return sampleHeight(hf, x, z);
  });
  const waterSamples = interiorHeights.filter((height) => height <= waterMaximum).length;
  if (waterSamples < 5) return undefined;

  const endpointMeanA =
    endpointAHeights.reduce((sum, height) => sum + height, 0) / endpointAHeights.length;
  const endpointMeanB =
    endpointBHeights.reduce((sum, height) => sum + height, 0) / endpointBHeights.length;
  if (Math.abs(endpointMeanA - endpointMeanB) > 2.5) return undefined;
  const waterRatio = waterSamples / interiorHeights.length;
  return {
    x: centerX,
    z: centerZ,
    yaw,
    scale,
    spanMeters: safeSpan,
    deckY: Math.max(...endpointAHeights, ...endpointBHeights) + 0.08,
    score:
      sourceBias +
      Math.abs(safeSpan - desiredSpan) * 0.08 +
      Math.abs(endpointMeanA - endpointMeanB) * 1.5 +
      (1 - waterRatio) * 2,
  };
}

function bridgeCrossingCandidates(
  plan: ScenePlan,
  hf: HeightField,
  desiredSpan: number,
): BridgeCrossingCandidate[] {
  const waterline = finiteOr(plan.visualContract?.waterLevelMeters, 0);
  const spans = bridgeSpanOptions(desiredSpan);
  const origins: { x: number; z: number; yaws: number[]; bias: number }[] = [];
  const dryRegions = plan.regions
    .filter((region) => region.category !== "ocean" && region.category !== "river")
    .sort((a, b) => {
      const aPriority = a.category === "settlement" ? 0 : 1;
      const bPriority = b.category === "settlement" ? 0 : 1;
      return aPriority - bPriority || a.id.localeCompare(b.id);
    })
    .slice(0, 24);

  for (let a = 0; a < dryRegions.length; a++) {
    const regionA = dryRegions[a]!;
    const ax = (regionA.center[0] - 0.5) * hf.worldSize;
    const az = (regionA.center[1] - 0.5) * hf.worldSize;
    if (sampleHeight(hf, ax, az) < waterline + 0.08) continue;
    for (let b = a + 1; b < dryRegions.length; b++) {
      const regionB = dryRegions[b]!;
      const bx = (regionB.center[0] - 0.5) * hf.worldSize;
      const bz = (regionB.center[1] - 0.5) * hf.worldSize;
      if (sampleHeight(hf, bx, bz) < waterline + 0.08) continue;
      const deltaX = bx - ax;
      const deltaZ = bz - az;
      const distance = Math.hypot(deltaX, deltaZ);
      if (distance < MIN_BRIDGE_SPAN_METERS * 0.75) continue;
      const directionX = deltaX / distance;
      const directionZ = deltaZ / distance;
      const yaw = Math.atan2(-directionZ, directionX);
      for (const shift of [-2.5, 0, 2.5]) {
        origins.push({
          x: (ax + bx) * 0.5 + directionX * shift,
          z: (az + bz) * 0.5 + directionZ * shift,
          yaws: [-0.16, -0.08, 0, 0.08, 0.16].map((offset) => yaw + offset),
          bias: a * 0.002 + b * 0.0001,
        });
      }
    }
  }

  const broadYaws = Array.from({ length: 12 }, (_, index) => (index / 12) * Math.PI);
  for (const region of plan.regions.slice(0, 32)) {
    if (region.category !== "ocean" && region.category !== "river") continue;
    origins.push({
      x: (region.center[0] - 0.5) * hf.worldSize,
      z: (region.center[1] - 0.5) * hf.worldSize,
      yaws: broadYaws,
      bias: 1,
    });
  }

  const gridSize = 17;
  const gridExtent = hf.worldSize * 0.44;
  for (let gridZ = 0; gridZ < gridSize; gridZ++) {
    const z = -gridExtent + (gridZ / (gridSize - 1)) * gridExtent * 2;
    for (let gridX = 0; gridX < gridSize; gridX++) {
      const x = -gridExtent + (gridX / (gridSize - 1)) * gridExtent * 2;
      if (sampleHeight(hf, x, z) > waterline + 0.02) continue;
      origins.push({ x, z, yaws: broadYaws, bias: 3 + (gridZ * gridSize + gridX) * 1e-6 });
    }
  }

  const candidates: BridgeCrossingCandidate[] = [];
  const seen = new Set<string>();
  for (const origin of origins) {
    for (const yaw of origin.yaws) {
      for (const span of spans) {
        const candidate = evaluateBridgeCrossing(
          hf,
          origin.x,
          origin.z,
          yaw,
          span,
          desiredSpan,
          waterline,
          origin.bias,
        );
        if (!candidate) continue;
        const key = `${Math.round(candidate.x * 4)}:${Math.round(candidate.z * 4)}:${Math.round(
          normalizedHalfTurn(candidate.yaw) * 100,
        )}:${Math.round(candidate.spanMeters * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.x - b.x ||
        a.z - b.z ||
        normalizedHalfTurn(a.yaw) - normalizedHalfTurn(b.yaw) ||
        a.spanMeters - b.spanMeters,
    )
    .slice(0, MAX_BRIDGE_CANDIDATES);
}

function bridgeRegionId(plan: ScenePlan, hf: HeightField, x: number, z: number): string {
  const gridX = clamp(
    Math.round((x / hf.worldSize + 0.5) * (hf.resolution - 1)),
    0,
    hf.resolution - 1,
  );
  const gridZ = clamp(
    Math.round((z / hf.worldSize + 0.5) * (hf.resolution - 1)),
    0,
    hf.resolution - 1,
  );
  const regionIndex = hf.regionId[gridZ * hf.resolution + gridX] ?? 0;
  return plan.regions[regionIndex]?.id ?? plan.regions[0]?.id ?? "bridge";
}

function bridgeCandidateCollides(
  candidate: BridgeCrossingCandidate,
  objects: readonly PlacedObject[],
): boolean {
  const footprint = objectFootprintXZ({
    kind: "bridge",
    scale: candidate.scale,
    position: [candidate.x, candidate.deckY, candidate.z],
    rotation: [0, candidate.yaw, 0],
  });
  return objects.some((existing) =>
    footprintsOverlapXZ(
      footprint,
      objectFootprintXZ(existing),
      pairClearance("bridge", existing.kind),
    ),
  );
}

function chooseWaterBearing(
  hf: HeightField,
  centerX: number,
  centerZ: number,
  regionRadius: number,
  baseAngle: number,
): number {
  const sampleDirectionalHeight = (angle: number, distance: number) => {
    const x = centerX + Math.cos(angle) * distance;
    const z = centerZ + Math.sin(angle) * distance;
    const limit = hf.worldSize * 0.48;
    // sampleHeight's outside-world sentinel is also a plausible ocean height;
    // penalize those rays explicitly so a border cannot masquerade as a bay.
    if (Math.abs(x) > limit || Math.abs(z) > limit) return 20;
    return sampleHeight(hf, x, z);
  };
  // First estimate the center of the low-elevation sector. Choosing the first
  // equally-low ray biases ships toward a shoreline edge; a weighted circular
  // mean instead points into the middle of a broad harbor opening.
  const directionalSamples: { angle: number; height: number }[] = [];
  let maximumHeight = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < 32; index++) {
    const angle = baseAngle + (index / 32) * TWO_PI;
    const distance = Math.max(2, regionRadius * 0.85);
    const height = sampleDirectionalHeight(angle, distance);
    maximumHeight = Math.max(maximumHeight, height);
    directionalSamples.push({ angle, height });
  }
  let waterVectorX = 0;
  let waterVectorZ = 0;
  for (const sample of directionalSamples) {
    const weight = Math.max(0, maximumHeight - sample.height);
    waterVectorX += Math.cos(sample.angle) * weight;
    waterVectorZ += Math.sin(sample.angle) * weight;
  }
  const vectorLength = Math.hypot(waterVectorX, waterVectorZ);
  const searchOrigin = vectorLength > 1e-5 ? Math.atan2(waterVectorZ, waterVectorX) : baseAngle;
  let bestAngle = baseAngle;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 32; index++) {
    const angle = searchOrigin + (index / 32) * TWO_PI;
    let score = 0;
    for (const angleOffset of [-0.35, 0, 0.35]) {
      for (const distanceScale of [0.4, 0.75, 1.1]) {
        const distance = Math.max(2, regionRadius * distanceScale);
        score += sampleDirectionalHeight(angle + angleOffset, distance);
      }
    }
    if (score < bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

function harborCandidate(
  ordinal: number,
  total: number,
  attempt: number,
  centerX: number,
  centerZ: number,
  regionRadius: number,
  waterBearing: number,
  maximumHalfLength: number,
): CandidateXZ {
  const safeTotal = Math.max(1, total);
  if (safeTotal === 4) {
    // Four full-size fishing hulls fit a small image-derived cove much more
    // reliably as two parallel berth rows than on a wide circular arc. The
    // formation stays centered on the named harbor and preserves real hull
    // separation; retries move the whole logical berth outward/sideways only
    // when the local shoreline rejects an individual slot.
    const column = ordinal % 2;
    const row = Math.floor(ordinal / 2);
    const retryIndex = attempt % 9;
    const retryRing = Math.floor(attempt / 9);
    const bearingOffset = (retryIndex - 4) * 0.035;
    const bearing = waterBearing + bearingOffset;
    const tangentX = -Math.sin(bearing);
    const tangentZ = Math.cos(bearing);
    const radialX = Math.cos(bearing);
    const radialZ = Math.sin(bearing);
    const alongSpacing = maximumHalfLength * 2 + 1.4;
    const acrossSpacing = Math.max(4.8, maximumHalfLength * 0.9 + 1.4);
    const tangentOffset = (column - 0.5) * alongSpacing;
    const rowOffset = (row - 0.5) * acrossSpacing;
    const estimatedHalfDepth = Math.max(1.8, maximumHalfLength * 0.38);
    const anchorDistance =
      Math.max(regionRadius * 0.72, estimatedHalfDepth + acrossSpacing * 0.5 + 1) +
      retryRing * Math.max(0.75, acrossSpacing * 0.35);
    return {
      x: centerX + radialX * (anchorDistance + rowOffset) + tangentX * tangentOffset,
      z: centerZ + radialZ * (anchorDistance + rowOffset) + tangentZ * tangentOffset,
      yaw: -(bearing + Math.PI * 0.5),
    };
  }
  const arcSpan = safeTotal === 1 ? 0 : Math.min(2.4, Math.max(0.7, (safeTotal - 1) * 0.62));
  const angleStep = safeTotal === 1 ? 0 : arcSpan / (safeTotal - 1);
  const requiredSeparation = maximumHalfLength * 2 + 1.4;
  const separationRadius =
    angleStep > 0.01 ? requiredSeparation / (2 * Math.sin(angleStep * 0.5)) : maximumHalfLength + 2;
  const ring = Math.floor(attempt / 7);
  const retryOffset = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3][attempt % 7] ?? 0;
  const normalized = safeTotal === 1 ? 0 : ordinal / (safeTotal - 1) - 0.5;
  const angle = waterBearing + normalized * arcSpan + retryOffset;
  const radius = Math.max(regionRadius * 0.7, separationRadius) + ring * (maximumHalfLength + 1);
  return {
    x: centerX + Math.cos(angle) * radius,
    z: centerZ + Math.sin(angle) * radius,
    // The GLB hull's long axis is local +X. This yaw makes it tangent to the arc.
    yaw: -(angle + Math.PI * 0.5),
  };
}

function completeFourBoatFormation(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  region: RegionSpec,
  kind: ObjectKind,
  authoredScale: number,
  centerX: number,
  centerZ: number,
  regionRadius: number,
  waterBearing: number,
  obstacles: readonly PlacedObject[],
  placementContext: RegionalPlacementContext,
): HarborFormation | undefined {
  if (!isMaritime(kind)) return undefined;
  const worldHalfExtent = hf.worldSize * 0.5;
  // The provider scale is a visual suggestion; the user-exact four-hull and
  // non-overlap contracts are authoritative. Keep reductions bounded and
  // readable, and commit only a complete formation so two successful early
  // hulls can never strand the remaining pair.
  for (const scaleFactor of [1, 0.9, 0.82, 0.74]) {
    const scale = kindBaseScale(kind) * authoredScale * scaleFactor * 0.96;
    const maximumHalfLength = objectFootprintXZ({
      kind,
      scale,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    }).halfX;
    for (let attempt = 0; attempt < 72; attempt++) {
      const placements: HarborFormationPlacement[] = [];
      const footprints: ObjectFootprintXZ[] = [];
      let accepted = true;
      for (let ordinal = 0; ordinal < 4; ordinal++) {
        const candidate = harborCandidate(
          ordinal,
          4,
          attempt,
          centerX,
          centerZ,
          regionRadius,
          waterBearing,
          maximumHalfLength,
        );
        const provisional = {
          kind,
          scale,
          position: [candidate.x, 0, candidate.z] as [number, number, number],
          rotation: [0, candidate.yaw, 0] as [number, number, number],
        };
        const footprint = objectFootprintXZ(provisional);
        if (
          !footprintFitsWorld(footprint, worldHalfExtent) ||
          !terrainAccepts(kind, footprint, hf) ||
          !candidateBelongsToAuthoredRegion(
            plan,
            hf,
            region,
            kind,
            footprint,
            seed,
            placementContext,
          ) ||
          obstacles.some((existing) =>
            footprintsOverlapXZ(
              footprint,
              objectFootprintXZ(existing),
              pairClearance(kind, existing.kind),
            ),
          ) ||
          footprints.some((existing) =>
            footprintsOverlapXZ(footprint, existing, pairClearance(kind, kind)),
          )
        ) {
          accepted = false;
          break;
        }
        placements.push({ ...candidate, scale });
        footprints.push(footprint);
      }
      if (accepted && placements.length === 4) {
        return { placements, scaleFactor, attempt };
      }
    }
  }
  return undefined;
}

function settlementCandidate(
  ordinal: number,
  total: number,
  attempt: number,
  centerX: number,
  centerZ: number,
  regionRadius: number,
  baseAngle: number,
  maximumHalfDimension: number,
): CandidateXZ {
  const safeTotal = Math.max(1, total);
  const slotsPerSide = Math.max(1, Math.ceil(safeTotal / 2));
  const row = ordinal % 2;
  const slot = Math.floor(ordinal / 2);
  const side = row === 0 ? -1 : 1;
  const fullDimension = maximumHalfDimension * 2;
  const streetSpacing = fullDimension + 1.15;
  const laneHalfWidth = clamp(regionRadius * 0.16, 2.3, 3.8);
  const retryIndex = attempt % 9;
  const retryBand = Math.floor(attempt / 9);
  const retryAlong = (retryIndex - 4) * 0.16;
  const retryOutward = retryBand * 0.65;
  const along = (slot - (slotsPerSide - 1) * 0.5) * streetSpacing + retryAlong;
  const across = side * (laneHalfWidth + maximumHalfDimension + 0.7 + retryOutward);
  const cosine = Math.cos(baseAngle);
  const sine = Math.sin(baseAngle);
  return {
    x: centerX + cosine * along - sine * across,
    z: centerZ + sine * along + cosine * across,
    // Parallel street walls with both rows facing the central lane read as an
    // authored town block from map, oblique, and walk cameras.
    yaw: -baseAngle + (row === 0 ? 0 : Math.PI),
  };
}

function plazaCandidate(
  ordinal: number,
  attempt: number,
  centerX: number,
  centerZ: number,
  baseAngle: number,
): CandidateXZ {
  const angle = baseAngle + (ordinal + attempt * 0.2) * 2.399963229728653;
  const radius = ordinal === 0 ? 0 : 1.4 + Math.floor(ordinal / 4) * 1.2;
  return {
    x: centerX + Math.cos(angle) * radius,
    z: centerZ + Math.sin(angle) * radius,
    yaw: -angle,
  };
}

function randomCandidate(
  rng: () => number,
  centerX: number,
  centerZ: number,
  regionRadius: number,
): CandidateXZ {
  const angle = rng() * TWO_PI;
  const distance = Math.sqrt(rng()) * regionRadius;
  return {
    x: centerX + Math.cos(angle) * distance,
    z: centerZ + Math.sin(angle) * distance,
    yaw: rng() * TWO_PI,
  };
}

function requirementPriority(kind: ObjectKind, settlement: boolean, harbor: boolean): number {
  if (kind === "bridge") return -1;
  // Singular authored landmarks own their lot. If ordinary buildings are laid
  // out first, the large pagoda/torii footprint can be crowded out and the
  // later exact-count rescue used to migrate it to an unrelated dry region.
  // A landmark can deliberately sit in a forest clearing, so reservation is
  // global rather than conditional on the classifier calling that clearing a
  // settlement.
  if (kind === "pagoda" || kind === "torii") return -0.8;
  // User-exact hulls reserve the harbor water before model-suggested piers.
  // Otherwise several docks can split a viable four-boat formation into two
  // individually valid but collectively incomplete berths.
  if (harbor && isMaritime(kind)) return -0.7;
  if (harbor && kind === "dock") return -0.5;
  if (settlement && isStructure(kind)) return 0;
  if (settlement && PLAZA_ANCHOR_KINDS.has(kind)) return 1;
  return 2;
}

function authoredRegionsForKind(plan: ScenePlan, kind: ObjectKind): RegionSpec[] {
  return plan.regions.filter((region) =>
    (plan.objectRequirements[region.name] ?? []).some(
      (requirement) =>
        resolveObjectKind(requirement.category) === kind &&
        Math.trunc(clamp(finiteOr(requirement.count, 0), 0, MAX_OBJECTS_PER_REQUIREMENT)) > 0,
    ),
  );
}

function candidateBelongsToAuthoredRegion(
  plan: ScenePlan,
  hf: HeightField,
  region: RegionSpec,
  kind: ObjectKind,
  footprint: ObjectFootprintXZ,
  seed: number,
  preparedContext?: RegionalPlacementContext,
): boolean {
  const centerX = (region.center[0] - 0.5) * hf.worldSize;
  const centerZ = (region.center[1] - 0.5) * hf.worldSize;
  if (isMaritime(kind) || kind === "dock") {
    const authoredRadius = Math.max(4, region.radius * hf.worldSize);
    const footprintRadius = Math.hypot(footprint.halfX, footprint.halfZ);
    return (
      Math.hypot(footprint.centerX - centerX, footprint.centerZ - centerZ) <=
      authoredRadius * 1.9 + footprintRadius
    );
  }
  const context = preparedContext ?? regionalPlacementContext(plan, hf, region, seed);
  if (isVegetation(kind) && context.hasDrySemanticCells) {
    const gridX = Math.round((footprint.centerX / hf.worldSize + 0.5) * (hf.resolution - 1));
    const gridZ = Math.round((footprint.centerZ / hf.worldSize + 0.5) * (hf.resolution - 1));
    if (gridX < 0 || gridZ < 0 || gridX >= hf.resolution || gridZ >= hf.resolution) return false;
    const index = gridZ * hf.resolution + gridX;
    return (hf.regionId[index] ?? -1) === context.regionIndex && (hf.data[index] ?? -2) >= -0.2;
  }
  const tolerance = isVegetation(kind)
    ? Math.max((hf.worldSize / (hf.resolution - 1)) * 0.75, 0.5)
    : clamp(Math.hypot(footprint.halfX, footprint.halfZ) * 0.72, 2.5, 6);
  return candidateNearRegionalSemantic(
    context,
    region,
    hf,
    footprint.centerX,
    footprint.centerZ,
    tolerance,
  );
}

/**
 * Generate physically separated instances. Image influence arrives through the
 * bounded VisualContract density factors produced from the reference pass.
 */
export function generateRegionalObjects(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  exactCountKinds?: ReadonlyMap<ObjectKind, number>,
): PlacedObject[] {
  const rng = mulberry32(seed ^ 0x5f3759df);
  const objects: PlacedObject[] = [];
  let idCounter = 0;

  for (const region of plan.regions) {
    const requirements = plan.objectRequirements[region.name] ?? [];
    if (requirements.length === 0) continue;

    const settlement = isSettlementRegion(region);
    const harbor = /harbor|port|dock|cove/i.test(`${region.name} ${region.role}`);
    const centerX = (region.center[0] - 0.5) * hf.worldSize;
    const centerZ = (region.center[1] - 0.5) * hf.worldSize;
    const regionRadius = Math.max(1, region.radius * hf.worldSize * 0.95);
    const worldHalfExtent = hf.worldSize * 0.5;
    const baseAngle = rng() * TWO_PI;
    const needsWaterBearing = requirements.some((requirement) => {
      const kind = resolveObjectKind(requirement.category);
      return isMaritime(kind) || kind === "dock";
    });
    const waterBearing = needsWaterBearing
      ? chooseWaterBearing(hf, centerX, centerZ, regionRadius, baseAngle)
      : baseAngle;
    const toriiBearing = requirements.some(
      (requirement) => resolveObjectKind(requirement.category) === "torii",
    )
      ? chooseWaterBearing(hf, centerX, centerZ, regionRadius, baseAngle)
      : baseAngle;
    const placementContext = regionalPlacementContext(plan, hf, region, seed);

    const planned: PlannedRequirement[] = requirements
      .map((requirement, order) => {
        const kind = resolveObjectKind(requirement.category);
        return {
          requirement,
          kind,
          count: exactCountKinds?.has(kind)
            ? Math.trunc(clamp(finiteOr(requirement.count, 0), 0, MAX_OBJECTS_PER_REQUIREMENT))
            : effectiveRequirementCount(plan, requirement, kind),
          order,
        };
      })
      .filter(({ count }) => count > 0)
      .sort((a, b) => {
        const priority =
          requirementPriority(a.kind, settlement, harbor) -
          requirementPriority(b.kind, settlement, harbor);
        return priority || a.order - b.order;
      });

    const maritimeTotal = planned.reduce(
      (sum, item) => sum + (isMaritime(item.kind) ? item.count : 0),
      0,
    );
    const maximumMarineHalfLength = Math.max(
      1,
      ...planned
        .filter((item) => isMaritime(item.kind))
        .map((item) => {
          const scale =
            kindBaseScale(item.kind) * clamp(finiteOr(item.requirement.scale, 1), 0.1, 4);
          return objectFootprintXZ({
            kind: item.kind,
            scale,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
          }).halfX;
        }),
    );
    const maximumStructureHalfDimension = Math.max(
      1,
      ...planned
        .filter((item) => isStructure(item.kind) && item.kind !== "bridge")
        .map((item) => {
          const scale =
            kindBaseScale(item.kind) * clamp(finiteOr(item.requirement.scale, 1), 0.1, 4);
          const footprint = objectFootprintXZ({
            kind: item.kind,
            scale,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
          });
          return Math.max(footprint.halfX, footprint.halfZ);
        }),
    );
    const structureTotal = planned.reduce(
      (sum, item) => sum + (isStructure(item.kind) && item.kind !== "bridge" ? item.count : 0),
      0,
    );
    let maritimeOrdinal = 0;
    let structureOrdinal = 0;
    let plazaOrdinal = 0;

    for (const item of planned) {
      const authoredScale = clamp(finiteOr(item.requirement.scale, 1), 0.1, 4);
      if (item.kind === "bridge") {
        const desiredSpan = clamp(
          BRIDGE_AUTHORED_SPAN_METERS * authoredScale,
          MIN_BRIDGE_SPAN_METERS,
          MAX_BRIDGE_SPAN_METERS,
        );
        const candidates = bridgeCrossingCandidates(plan, hf, desiredSpan);
        const palette = OBJECT_PALETTES.bridge ?? { primary: "#888", secondary: "#444" };
        for (let ordinal = 0; ordinal < item.count; ordinal++) {
          const candidate = candidates.find(
            (crossing) => !bridgeCandidateCollides(crossing, objects),
          );
          if (!candidate) break;
          objects.push({
            id: `obj_${idCounter++}`,
            kind: "bridge",
            regionId: bridgeRegionId(plan, hf, candidate.x, candidate.z),
            position: [candidate.x, candidate.deckY, candidate.z],
            rotation: [0, candidate.yaw, 0],
            scale: candidate.scale,
            color: palette.primary,
            secondaryColor: palette.secondary,
            label: item.requirement.appearance
              ? `bridge (${item.requirement.appearance})`
              : "bridge",
            contactScore: 0.5,
            refined: false,
          });
        }
        continue;
      }
      const baseScale = kindBaseScale(item.kind) * authoredScale;
      if (
        isMaritime(item.kind) &&
        maritimeTotal === 4 &&
        item.count === 4 &&
        exactCountKinds?.get(item.kind) === 4
      ) {
        const formation = completeFourBoatFormation(
          plan,
          hf,
          seed,
          region,
          item.kind,
          authoredScale,
          centerX,
          centerZ,
          regionRadius,
          waterBearing,
          objects,
          placementContext,
        );
        if (formation) {
          const palette = OBJECT_PALETTES[item.kind] ?? {
            primary: "#888",
            secondary: "#444",
          };
          for (const placement of formation.placements) {
            const height = sampleHeight(hf, placement.x, placement.z);
            objects.push({
              id: `obj_${idCounter++}`,
              kind: item.kind,
              regionId: region.id,
              position: [placement.x, Math.max(height, -0.3) + 0.15, placement.z],
              rotation: [0, placement.yaw, 0],
              scale: placement.scale,
              color: palette.primary,
              secondaryColor: palette.secondary,
              label: item.requirement.appearance
                ? `${item.kind} (${item.requirement.appearance})`
                : item.kind,
              contactScore: 0.5,
              refined: false,
            });
          }
          maritimeOrdinal += 4;
          continue;
        }
      }
      for (let ordinal = 0; ordinal < item.count; ordinal++) {
        const scaleJitter = isMaritime(item.kind) ? 0.94 + rng() * 0.12 : 0.85 + rng() * 0.35;
        const scale = baseScale * scaleJitter;
        const layoutOrdinal = isMaritime(item.kind)
          ? maritimeOrdinal++
          : isStructure(item.kind)
            ? structureOrdinal++
            : PLAZA_ANCHOR_KINDS.has(item.kind)
              ? plazaOrdinal++
              : ordinal;
        const maxAttempts =
          isMaritime(item.kind) || (settlement && isStructure(item.kind)) ? 72 : 48;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          let candidate: CandidateXZ;
          if (isMaritime(item.kind)) {
            candidate = harborCandidate(
              layoutOrdinal,
              maritimeTotal,
              attempt,
              centerX,
              centerZ,
              regionRadius,
              waterBearing,
              maximumMarineHalfLength,
            );
          } else if (settlement && isStructure(item.kind)) {
            candidate = settlementCandidate(
              layoutOrdinal,
              structureTotal,
              attempt,
              centerX,
              centerZ,
              regionRadius,
              baseAngle,
              maximumStructureHalfDimension,
            );
            if (item.kind === "torii") {
              // Face the gate along the coast normal, leaving its broad beam
              // tangent to the shoreline and readable from map/oblique views.
              candidate.yaw = -(toriiBearing + Math.PI * 0.5);
            }
          } else if (settlement && PLAZA_ANCHOR_KINDS.has(item.kind)) {
            candidate = plazaCandidate(layoutOrdinal, attempt, centerX, centerZ, baseAngle);
          } else if (item.kind === "dock") {
            const retry = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1][attempt % 7] ?? 0;
            const retryRing = Math.floor(attempt / 7);
            const tangentOffset = (ordinal - (item.count - 1) * 0.5) * 4.2 + retry;
            const radialDistance =
              regionRadius * 0.3 + retryRing * Math.min(0.8, regionRadius * 0.08);
            candidate = {
              x:
                centerX +
                Math.cos(waterBearing) * radialDistance -
                Math.sin(waterBearing) * tangentOffset,
              z:
                centerZ +
                Math.sin(waterBearing) * radialDistance +
                Math.cos(waterBearing) * tangentOffset,
              yaw: -waterBearing,
            };
          } else {
            candidate = randomCandidate(rng, centerX, centerZ, regionRadius);
          }

          const provisional = {
            kind: item.kind,
            scale,
            position: [candidate.x, 0, candidate.z] as [number, number, number],
            rotation: [0, candidate.yaw, 0] as [number, number, number],
          };
          const footprint = objectFootprintXZ(provisional);
          if (!footprintFitsWorld(footprint, worldHalfExtent)) continue;
          if (!terrainAccepts(item.kind, footprint, hf)) continue;
          if (
            (isVegetation(item.kind) ||
              isStructure(item.kind) ||
              isMaritime(item.kind) ||
              item.kind === "dock") &&
            !candidateBelongsToAuthoredRegion(
              plan,
              hf,
              region,
              item.kind,
              footprint,
              seed,
              placementContext,
            )
          ) {
            continue;
          }

          let collision = false;
          for (const existing of objects) {
            if (
              footprintsOverlapXZ(
                footprint,
                objectFootprintXZ(existing),
                pairClearance(item.kind, existing.kind),
              )
            ) {
              collision = true;
              break;
            }
          }
          if (collision) continue;

          const height = sampleHeight(hf, candidate.x, candidate.z);
          const normal = sampleNormal(hf, candidate.x, candidate.z);
          let rotationX = 0;
          let rotationZ = 0;
          if (!isStructure(item.kind) && !isMaritime(item.kind)) {
            rotationX = Math.atan2(normal[2], normal[1]) * 0.25;
            rotationZ = -Math.atan2(normal[0], normal[1]) * 0.25;
          }
          const y = isMaritime(item.kind) ? Math.max(height, -0.3) + 0.15 : height;
          const palette = OBJECT_PALETTES[item.kind] ?? {
            primary: "#888",
            secondary: "#444",
          };
          objects.push({
            id: `obj_${idCounter++}`,
            kind: item.kind,
            regionId: region.id,
            position: [candidate.x, y, candidate.z],
            rotation: [rotationX, candidate.yaw, rotationZ],
            scale,
            color: palette.primary,
            secondaryColor: palette.secondary,
            label: item.requirement.appearance
              ? `${item.kind} (${item.requirement.appearance})`
              : item.kind,
            contactScore: 0.5,
            refined: false,
          });
          break;
        }
      }
    }
  }

  return objects;
}

function stableTextHash(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function regionalPlacementContext(
  plan: ScenePlan,
  hf: HeightField,
  region: RegionSpec,
  seed: number,
): RegionalPlacementContext {
  const regionIndex = Math.max(
    0,
    plan.regions.findIndex((candidate) => candidate.id === region.id),
  );
  const plannedCenterX = (region.center[0] - 0.5) * hf.worldSize;
  const plannedCenterZ = (region.center[1] - 0.5) * hf.worldSize;
  const localRadius = Math.max(4, region.radius * hf.worldSize * 1.8);
  let closestX = plannedCenterX;
  let closestZ = plannedCenterZ;
  let closestDistance = Number.POSITIVE_INFINITY;
  let sampleCount = 0;
  let sumX = 0;
  let sumZ = 0;
  let sumXX = 0;
  let sumXZ = 0;
  let sumZZ = 0;
  let hasDrySemanticCells = false;

  for (let gridZ = 0; gridZ < hf.resolution; gridZ++) {
    for (let gridX = 0; gridX < hf.resolution; gridX++) {
      const index = gridZ * hf.resolution + gridX;
      if ((hf.regionId[index] ?? -1) !== regionIndex || (hf.data[index] ?? -2) < -0.2) continue;
      hasDrySemanticCells = true;
      const x = (gridX / (hf.resolution - 1) - 0.5) * hf.worldSize;
      const z = (gridZ / (hf.resolution - 1) - 0.5) * hf.worldSize;
      const distance = Math.hypot(x - plannedCenterX, z - plannedCenterZ);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestX = x;
        closestZ = z;
      }
      if (distance > localRadius) continue;
      sampleCount++;
      sumX += x;
      sumZ += z;
      sumXX += x * x;
      sumXZ += x * z;
      sumZZ += z * z;
    }
  }

  const fallbackYaw =
    ((((seed ^ stableTextHash(`${region.id}:${region.name}`)) >>> 0) / 0xffff_ffff) * Math.PI) %
    Math.PI;
  let semanticYaw = fallbackYaw;
  let semanticCenterX = plannedCenterX;
  let semanticCenterZ = plannedCenterZ;
  if (sampleCount >= 6) {
    const meanX = sumX / sampleCount;
    const meanZ = sumZ / sampleCount;
    semanticCenterX = meanX;
    semanticCenterZ = meanZ;
    const covarianceXX = sumXX / sampleCount - meanX * meanX;
    const covarianceXZ = sumXZ / sampleCount - meanX * meanZ;
    const covarianceZZ = sumZZ / sampleCount - meanZ * meanZ;
    const anisotropy = Math.hypot(covarianceXX - covarianceZZ, covarianceXZ * 2);
    if (anisotropy > 0.25) {
      const worldAngle = 0.5 * Math.atan2(covarianceXZ * 2, covarianceXX - covarianceZZ);
      semanticYaw = -worldAngle;
    }
  }

  // The semantic centroid is the capacity authority for image-guided terrain;
  // the authored center is only a fallback when classification produced no
  // usable dry component. Anchoring a grid at a merely-near plan point can put
  // half of a small coastal town over water.
  return {
    regionIndex,
    centerX: hasDrySemanticCells ? (sampleCount >= 6 ? semanticCenterX : closestX) : plannedCenterX,
    centerZ: hasDrySemanticCells ? (sampleCount >= 6 ? semanticCenterZ : closestZ) : plannedCenterZ,
    semanticYaw,
    hasDrySemanticCells,
  };
}

function candidateNearRegionalSemantic(
  context: RegionalPlacementContext,
  region: RegionSpec,
  hf: HeightField,
  x: number,
  z: number,
  toleranceMeters: number,
): boolean {
  const tolerance = clamp(finiteOr(toleranceMeters, 0), 0, 8);
  if (!context.hasDrySemanticCells) {
    const plannedX = (region.center[0] - 0.5) * hf.worldSize;
    const plannedZ = (region.center[1] - 0.5) * hf.worldSize;
    return (
      Math.hypot(x - plannedX, z - plannedZ) <= region.radius * hf.worldSize * 1.35 + tolerance
    );
  }

  const cellSize = hf.worldSize / (hf.resolution - 1);
  const centerGridX = (x / hf.worldSize + 0.5) * (hf.resolution - 1);
  const centerGridZ = (z / hf.worldSize + 0.5) * (hf.resolution - 1);
  const cellRadius = Math.max(0, Math.ceil(tolerance / cellSize));
  const minX = Math.max(0, Math.floor(centerGridX) - cellRadius);
  const maxX = Math.min(hf.resolution - 1, Math.ceil(centerGridX) + cellRadius);
  const minZ = Math.max(0, Math.floor(centerGridZ) - cellRadius);
  const maxZ = Math.min(hf.resolution - 1, Math.ceil(centerGridZ) + cellRadius);
  const toleranceSquared = tolerance * tolerance + cellSize * cellSize;
  for (let gridZ = minZ; gridZ <= maxZ; gridZ++) {
    for (let gridX = minX; gridX <= maxX; gridX++) {
      const index = gridZ * hf.resolution + gridX;
      if ((hf.regionId[index] ?? -1) !== context.regionIndex || (hf.data[index] ?? -2) < -0.2) {
        continue;
      }
      const sampleX = (gridX / (hf.resolution - 1) - 0.5) * hf.worldSize;
      const sampleZ = (gridZ / (hf.resolution - 1) - 0.5) * hf.worldSize;
      if ((sampleX - x) ** 2 + (sampleZ - z) ** 2 <= toleranceSquared) return true;
    }
  }
  return false;
}

function settlementStreetYaw(
  plan: ScenePlan,
  region: RegionSpec,
  context: RegionalPlacementContext,
): number {
  const other = plan.regions
    .filter((candidate) => candidate.id !== region.id && isSettlementRegion(candidate))
    .sort(
      (left, right) =>
        regionDistanceSquaredForPlacement(region, left) -
          regionDistanceSquaredForPlacement(region, right) || left.id.localeCompare(right.id),
    )[0];
  if (!other) return context.semanticYaw;
  const deltaX = other.center[0] - region.center[0];
  const deltaZ = other.center[1] - region.center[1];
  if (Math.hypot(deltaX, deltaZ) < 1e-5) return context.semanticYaw;
  // Extend the long street axis perpendicular to the line between towns so
  // one settlement cannot consume the other's capacity with an oversized row.
  const worldAngle = Math.atan2(deltaZ, deltaX) + Math.PI * 0.5;
  return -worldAngle;
}

function regionDistanceSquaredForPlacement(left: RegionSpec, right: RegionSpec): number {
  const deltaX = left.center[0] - right.center[0];
  const deltaZ = left.center[1] - right.center[1];
  return deltaX * deltaX + deltaZ * deltaZ;
}

function settlementBuildingRequirements(
  plan: ScenePlan,
  region: RegionSpec,
): { requirement: ObjectRequirement; kind: ObjectKind; count: number }[] {
  if (!isSettlementRegion(region)) return [];
  return (plan.objectRequirements[region.name] ?? [])
    .map((requirement) => ({
      requirement,
      kind: resolveObjectKind(requirement.category),
      count: Math.trunc(clamp(finiteOr(requirement.count, 0), 0, MAX_OBJECTS_PER_REQUIREMENT)),
    }))
    .filter(({ kind, count }) => count > 0 && REGIONAL_SETTLEMENT_BUILDING_KINDS.has(kind));
}

function regionalObjectId(
  usedIds: Set<string>,
  region: RegionSpec,
  kind: ObjectKind,
  ordinal: number,
): string {
  const safeRegion = region.id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "region";
  let suffix = Math.max(0, ordinal);
  while (usedIds.has(`regional_${safeRegion}_${kind}_${suffix}`)) suffix++;
  const id = `regional_${safeRegion}_${kind}_${suffix}`;
  usedIds.add(id);
  return id;
}

function packingSlots(
  centerX: number,
  centerZ: number,
  yaw: number,
  rows: number,
  columns: number,
  alongSpacing: number,
  acrossSpacing: number,
  alongShift: number,
  acrossShift: number,
): CandidateXZ[] {
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  const slots: CandidateXZ[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const along = (column - (columns - 1) * 0.5) * alongSpacing + alongShift * alongSpacing;
      const across = (row - (rows - 1) * 0.5) * acrossSpacing + acrossShift * acrossSpacing;
      slots.push({
        x: centerX + cosine * along + sine * across,
        z: centerZ - sine * along + cosine * across,
        yaw,
      });
    }
  }
  return slots.sort(
    (left, right) =>
      Math.hypot(left.x - centerX, left.z - centerZ) -
        Math.hypot(right.x - centerX, right.z - centerZ) ||
      left.x - right.x ||
      left.z - right.z,
  );
}

function packRegionalSettlementBuildings(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  region: RegionSpec,
  items: RegionalPackingItem[],
  obstacles: readonly PlacedObject[],
  telemetry?: RegionalPackingTelemetry,
): PlacedObject[] {
  if (items.length === 0) return [];
  const context = regionalPlacementContext(plan, hf, region, seed);
  const baseYaw = settlementStreetYaw(plan, region, context);
  const worldHalfExtent = hf.worldSize * 0.5;
  const maximumHalfX = Math.max(
    0.5,
    ...items.map(
      ({ object }) =>
        objectFootprintXZ({ ...object, position: [0, 0, 0], rotation: [0, 0, 0] }).halfX,
    ),
  );
  const maximumHalfZ = Math.max(
    0.5,
    ...items.map(
      ({ object }) =>
        objectFootprintXZ({ ...object, position: [0, 0, 0], rotation: [0, 0, 0] }).halfZ,
    ),
  );
  const alongSpacing = maximumHalfX * 2 + 0.95;
  const rowChoices = [items.length >= 7 ? 3 : 2, 2, 3, 1, 4].filter(
    (rows, index, values) => rows <= items.length && values.indexOf(rows) === index,
  );
  const yawChoices = [
    context.semanticYaw,
    context.semanticYaw + Math.PI * 0.5,
    baseYaw,
    baseYaw + Math.PI * 0.5,
    context.semanticYaw + Math.PI / 6,
    context.semanticYaw - Math.PI / 6,
    baseYaw + Math.PI / 6,
    baseYaw - Math.PI / 6,
  ].filter(
    (yaw, index, values) =>
      values.findIndex((candidate) => Math.abs(Math.sin(candidate - yaw)) < 1e-5) === index,
  );
  const shifts = [
    [0, 0],
    [0, 0.45],
    [0, -0.45],
    [0.45, 0],
    [-0.45, 0],
    [0.35, 0.35],
    [-0.35, 0.35],
    [0.35, -0.35],
    [-0.35, -0.35],
  ] as const;
  const orderedItems = [...items].sort((left, right) => {
    const leftFootprint = objectFootprintXZ(left.object);
    const rightFootprint = objectFootprintXZ(right.object);
    return (
      rightFootprint.halfX * rightFootprint.halfZ - leftFootprint.halfX * leftFootprint.halfZ ||
      left.object.id.localeCompare(right.object.id)
    );
  });
  let best: PlacedObject[] = [];

  for (const rows of rowChoices) {
    const acrossSpacing = maximumHalfZ * 2 + (rows === 2 ? 2.2 : rows > 2 ? 1.35 : 0);
    for (const extraColumns of [0, 1]) {
      const columns = Math.max(1, Math.ceil(items.length / rows) + extraColumns);
      for (const yaw of yawChoices) {
        for (const [alongShift, acrossShift] of shifts) {
          const slots = packingSlots(
            context.centerX,
            context.centerZ,
            yaw,
            rows,
            columns,
            alongSpacing,
            acrossSpacing,
            alongShift,
            acrossShift,
          );
          const usedSlots = new Set<number>();
          const placed: PlacedObject[] = [];
          for (const item of orderedItems) {
            let accepted: PlacedObject | undefined;
            for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
              if (usedSlots.has(slotIndex)) continue;
              if (telemetry) telemetry.attempts++;
              const slot = slots[slotIndex]!;
              const provisional: PlacedObject = {
                ...item.object,
                position: [slot.x, 0, slot.z],
                rotation: [0, slot.yaw, 0],
              };
              const footprint = objectFootprintXZ(provisional);
              const semanticTolerance = clamp(
                Math.hypot(footprint.halfX, footprint.halfZ) * 0.72,
                2.5,
                4.5,
              );
              if (!footprintFitsWorld(footprint, worldHalfExtent)) {
                if (telemetry) telemetry.rejected.world++;
                continue;
              }
              if (!terrainAccepts(provisional.kind, footprint, hf)) {
                if (telemetry) telemetry.rejected.terrain++;
                continue;
              }
              if (
                !candidateNearRegionalSemantic(
                  context,
                  region,
                  hf,
                  slot.x,
                  slot.z,
                  semanticTolerance,
                )
              ) {
                if (telemetry) telemetry.rejected.region++;
                continue;
              }
              if (
                [...obstacles, ...placed].some((existing) =>
                  footprintsOverlapXZ(
                    footprint,
                    objectFootprintXZ(existing),
                    pairClearance(provisional.kind, existing.kind),
                  ),
                )
              ) {
                if (telemetry) telemetry.rejected.collision++;
                continue;
              }
              accepted = {
                ...provisional,
                position: [slot.x, sampleHeight(hf, slot.x, slot.z), slot.z],
                contactScore: 0.5,
                refined: false,
              };
              usedSlots.add(slotIndex);
              break;
            }
            if (accepted) placed.push(accepted);
          }
          if (placed.length > best.length) best = placed;
          if (placed.length === items.length) return placed;
        }
      }
    }
  }
  return best;
}

function proportionalIntegerAllocation(weights: readonly number[], total: number): number[] {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeWeights = weights.map((weight) => Math.max(0, finiteOr(weight, 0)));
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (safeTotal === 0 || weightTotal <= 0) return safeWeights.map(() => 0);
  const exact = safeWeights.map((weight) => (weight / weightTotal) * safeTotal);
  const allocated = exact.map(Math.floor);
  let remaining = safeTotal - allocated.reduce((sum, count) => sum + count, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const entry of order) {
    if (remaining <= 0) break;
    allocated[entry.index]!++;
    remaining--;
  }
  return allocated;
}

function probeCountsForRegionalTargets(targets: readonly RegionalRequirementTarget[]): number[] {
  const counts = targets.map((target) => (target.exact ? target.requested : 0));
  const suggestedIndices = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.exact);
  if (suggestedIndices.length === 0) return counts;

  const requestedTotal = suggestedIndices.reduce((sum, { target }) => sum + target.requested, 0);
  const exactTotal = counts.reduce((sum, count) => sum + count, 0);
  const desiredTotal = Math.max(
    requestedTotal,
    Math.max(0, MIN_SETTLEMENT_STREET_BUILDINGS - exactTotal),
  );
  const boundedTotal = Math.min(MAX_SETTLEMENT_CAPACITY_PROBE, desiredTotal);
  const allocation = proportionalIntegerAllocation(
    suggestedIndices.map(({ target }) => target.requested),
    boundedTotal,
  );
  for (let index = 0; index < suggestedIndices.length; index++) {
    counts[suggestedIndices[index]!.index] = allocation[index] ?? 0;
  }
  return counts;
}

function selectRegionalPackingItems(
  availableItems: readonly RegionalPackingItem[],
  counts: readonly number[],
): RegionalPackingItem[] {
  const queues = counts.map((count, targetIndex) =>
    availableItems
      .filter((item) => item.targetIndex === targetIndex)
      .slice(0, Math.max(0, Math.trunc(count))),
  );
  const selected: RegionalPackingItem[] = [];
  const maximumLength = Math.max(0, ...queues.map((queue) => queue.length));
  for (let ordinal = 0; ordinal < maximumLength; ordinal++) {
    for (const queue of queues) {
      const item = queue[ordinal];
      if (item) selected.push(item);
    }
  }
  return selected;
}

function probeRegionalSettlementCapacity(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  region: RegionSpec,
  availableItems: readonly RegionalPackingItem[],
  obstacles: readonly PlacedObject[],
): number {
  // Model density is only a proposal. Probe the actual image-derived dry
  // component, using the same footprints and street solver as final packing.
  // Descending full-fit trials avoid mistaking one lucky partial layout for
  // usable capacity.
  const maximumProbe = Math.min(availableItems.length, MAX_SETTLEMENT_CAPACITY_PROBE);
  for (let count = maximumProbe; count > 0; count--) {
    const candidateItems = availableItems.slice(0, count);
    if (
      packRegionalSettlementBuildings(plan, hf, seed, region, candidateItems, obstacles).length ===
      count
    ) {
      return count;
    }
  }
  return 0;
}

function scaledRegionalPackingItems(
  items: readonly RegionalPackingItem[],
  scaleFactor: number,
): RegionalPackingItem[] {
  const safeFactor = clamp(finiteOr(scaleFactor, 1), 0.7, 1);
  return items.map((item) => ({
    ...item,
    object: {
      ...item.object,
      scale: item.object.scale * safeFactor,
    },
  }));
}

function regionalMinimumCounts(
  targets: readonly RegionalRequirementTarget[],
  capacity?: number,
): number[] {
  const minimums = targets.map((target) => (target.exact ? target.requested : 0));
  const suggestedIndices = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.exact);
  if (suggestedIndices.length === 0) return minimums;
  const exactTotal = minimums.reduce((sum, count) => sum + count, 0);
  const streetMinimum = Math.max(0, MIN_SETTLEMENT_STREET_BUILDINGS - exactTotal);
  // A positive image-derived capacity is stronger evidence than the default
  // four-building aesthetic. Retain the street target when it can fit, but do
  // not turn a truthful two-building quay into a failed user contract. A zero
  // capacity remains a real plan/terrain failure, and exact user counts are
  // never reduced here.
  const missingForStreet =
    capacity !== undefined && capacity > 0
      ? Math.min(streetMinimum, Math.max(0, capacity - exactTotal))
      : streetMinimum;
  const allocation = proportionalIntegerAllocation(
    suggestedIndices.map(({ target }) => target.requested),
    missingForStreet,
  );
  for (let index = 0; index < suggestedIndices.length; index++) {
    minimums[suggestedIndices[index]!.index] = allocation[index] ?? 0;
  }
  return minimums;
}

function allocateRegionalChosenCounts(
  targets: readonly RegionalRequirementTarget[],
  capacity: number,
  sharedDensityScale: number,
): number[] {
  const minimums = regionalMinimumCounts(targets, capacity);
  const counts = targets.map((target) =>
    target.exact
      ? target.requested
      : Math.max(0, Math.round(target.requested * sharedDensityScale)),
  );
  const exactTotal = targets.reduce(
    (sum, target, index) => sum + (target.exact ? (counts[index] ?? 0) : 0),
    0,
  );
  const suggestedCapacity = Math.max(0, capacity - exactTotal);
  const suggestedIndices = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.exact);

  let suggestedTotal = suggestedIndices.reduce((sum, { index }) => sum + (counts[index] ?? 0), 0);
  while (suggestedTotal > suggestedCapacity) {
    const candidate = [...suggestedIndices]
      .filter(({ index }) => (counts[index] ?? 0) > 0)
      .sort(
        (left, right) =>
          (counts[right.index] ?? 0) / Math.max(1, right.target.requested) -
            (counts[left.index] ?? 0) / Math.max(1, left.target.requested) ||
          right.index - left.index,
      )[0];
    if (!candidate) break;
    counts[candidate.index]!--;
    suggestedTotal--;
  }

  const minimumSuggestedTotal = Math.min(
    suggestedCapacity,
    suggestedIndices.reduce((sum, { index }) => sum + (minimums[index] ?? 0), 0),
  );
  while (suggestedTotal < minimumSuggestedTotal) {
    const candidate = [...suggestedIndices].sort(
      (left, right) =>
        right.target.requested / Math.max(1, (counts[right.index] ?? 0) + 1) -
          left.target.requested / Math.max(1, (counts[left.index] ?? 0) + 1) ||
        left.index - right.index,
    )[0];
    if (!candidate) break;
    counts[candidate.index]!++;
    suggestedTotal++;
  }
  return counts;
}

function emptyRegionalPackingTelemetry(): RegionalPackingTelemetry {
  return {
    attempts: 0,
    rejected: { world: 0, terrain: 0, region: 0, collision: 0 },
  };
}

function regionalPackingOrders(
  regionPlans: readonly RegionalSettlementPlan[],
): RegionalSettlementPlan[][] {
  const orders: RegionalSettlementPlan[][] = [];
  const seen = new Set<string>();
  const add = (order: RegionalSettlementPlan[]) => {
    const key = order.map((entry) => entry.region.id).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(order);
    }
  };
  const original = [...regionPlans];
  const constrainedFirst = [...regionPlans].sort(
    (left, right) =>
      left.capacity - left.chosenTotal - (right.capacity - right.chosenTotal) ||
      left.capacity - right.capacity ||
      left.region.id.localeCompare(right.region.id),
  );
  add(original);
  add(constrainedFirst);

  // A capacity probe measures each semantic footprint against the immutable
  // landmarks. Final street blocks additionally collide with previously
  // reserved towns. Try each constrained town as the first reservation in a
  // small deterministic set, then fail closed if no ordering satisfies every
  // regional minimum. This is bounded by the number of authored town regions,
  // not by arbitrary placement retries.
  for (const promoted of constrainedFirst.slice(0, 8)) {
    add([promoted, ...constrainedFirst.filter((entry) => entry !== promoted)]);
  }
  return orders;
}

function packRegionalSettlementOrder(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  regionPlans: readonly RegionalSettlementPlan[],
  hardObstacles: readonly PlacedObject[],
): RegionalPackingTrial {
  let objects = [...hardObstacles];
  let shortfall = 0;
  let satisfiedRegions = 0;
  let placedTotal = 0;
  const packedByRegionId = new Map<string, PlacedObject[]>();
  const telemetryByRegionId = new Map<string, RegionalPackingTelemetry>();

  for (const regionPlan of regionPlans) {
    const chosenCounts = regionPlan.targets.map((target) => target.chosen);
    const selectedItems = selectRegionalPackingItems(regionPlan.availableItems, chosenCounts);
    const telemetry = emptyRegionalPackingTelemetry();
    const packed = packRegionalSettlementBuildings(
      plan,
      hf,
      seed,
      regionPlan.region,
      selectedItems,
      objects,
      telemetry,
    );
    objects = [...objects, ...packed];
    packedByRegionId.set(regionPlan.region.id, packed);
    telemetryByRegionId.set(regionPlan.region.id, telemetry);
    placedTotal += packed.length;

    const itemTargetById = new Map(selectedItems.map((item) => [item.object.id, item.targetIndex]));
    const placedByTarget = regionPlan.targets.map(() => 0);
    for (const object of packed) {
      const targetIndex = itemTargetById.get(object.id);
      if (targetIndex !== undefined) placedByTarget[targetIndex]!++;
    }
    const minimums = regionalMinimumCounts(regionPlan.targets, regionPlan.capacity);
    let regionShortfall = 0;
    for (let targetIndex = 0; targetIndex < regionPlan.targets.length; targetIndex++) {
      const target = regionPlan.targets[targetIndex]!;
      const required = Math.max(target.chosen, minimums[targetIndex] ?? 0);
      regionShortfall += Math.max(0, required - (placedByTarget[targetIndex] ?? 0));
    }
    shortfall += regionShortfall;
    if (regionShortfall === 0) satisfiedRegions++;
  }

  return {
    objects,
    packedByRegionId,
    telemetryByRegionId,
    shortfall,
    satisfiedRegions,
    placedTotal,
  };
}

function betterRegionalPackingTrial(
  candidate: RegionalPackingTrial,
  current: RegionalPackingTrial | undefined,
): boolean {
  if (!current) return true;
  if (candidate.shortfall !== current.shortfall) return candidate.shortfall < current.shortfall;
  if (candidate.satisfiedRegions !== current.satisfiedRegions) {
    return candidate.satisfiedRegions > current.satisfiedRegions;
  }
  return candidate.placedTotal > current.placedTotal;
}

/**
 * Restore settlement-building ownership before any aggregate rescue can move
 * a global count into the wrong town. Existing records keep their identity and
 * labels but are repacked into a bounded street block on (or within one
 * footprint of) their own dry semantic component. A physically impossible
 * region returns an explicit deficit for the pipeline to fail closed on.
 */
export function repairRegionalObjectCoverage(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  input: readonly PlacedObject[],
  exactCountKinds: ReadonlyMap<ObjectKind, number> = new Map(),
): RegionalObjectRepairResult {
  const usedIds = new Set(input.map((object) => object.id));
  const regionPlans: RegionalSettlementPlan[] = [];
  const selectedStructureIds = new Set<string>();

  const targetRegionIds = new Set(
    plan.regions
      .filter((region) => settlementBuildingRequirements(plan, region).length > 0)
      .map((region) => region.id),
  );
  for (const object of input) {
    if (
      targetRegionIds.has(object.regionId) &&
      REGIONAL_SETTLEMENT_BUILDING_KINDS.has(object.kind)
    ) {
      selectedStructureIds.add(object.id);
    }
  }

  // Dressing is deliberately removed from the capacity authority. It was
  // generated after structures within one region but could still be generated
  // before the next town, turning trees and crates into accidental zoning.
  // Reinsert it collision-aware only after every town has reserved its block.
  const dressing = input.filter((object) => REGIONAL_DRESSING_KINDS.has(object.kind));
  const hardObstacles = input.filter(
    (object) => !selectedStructureIds.has(object.id) && !REGIONAL_DRESSING_KINDS.has(object.kind),
  );

  for (const region of plan.regions) {
    const requirements = settlementBuildingRequirements(plan, region);
    if (requirements.length === 0) continue;
    const targets: RegionalRequirementTarget[] = requirements.map(
      ({ requirement, kind, count }) => ({
        requirement,
        kind,
        requested: count,
        exact: exactCountKinds.has(kind),
        chosen: count,
      }),
    );
    const existingByKind = new Map<ObjectKind, PlacedObject[]>();
    for (const object of input) {
      if (object.regionId !== region.id || !REGIONAL_SETTLEMENT_BUILDING_KINDS.has(object.kind)) {
        continue;
      }
      const list = existingByKind.get(object.kind) ?? [];
      list.push(object);
      existingByKind.set(object.kind, list);
    }
    for (const list of existingByKind.values())
      list.sort((left, right) => left.id.localeCompare(right.id));

    const itemsByTarget: RegionalPackingItem[][] = targets.map(() => []);
    const probeCounts = probeCountsForRegionalTargets(targets);
    let regionalOrdinal = 0;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const { requirement, kind } = targets[targetIndex]!;
      const count = probeCounts[targetIndex] ?? 0;
      const pool = existingByKind.get(kind) ?? [];
      const authoredScale = clamp(finiteOr(requirement.scale, 1), 0.1, 4);
      const compactBaseScale = kindBaseScale(kind) * authoredScale;
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const existing = pool.shift();
        const palette = OBJECT_PALETTES[kind] ?? { primary: "#888", secondary: "#444" };
        const object: PlacedObject = existing
          ? {
              ...existing,
              scale: clamp(existing.scale, compactBaseScale * 0.82, compactBaseScale * 0.94),
            }
          : {
              id: regionalObjectId(usedIds, region, kind, regionalOrdinal),
              kind,
              regionId: region.id,
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: compactBaseScale * 0.86,
              color: palette.primary,
              secondaryColor: palette.secondary,
              label: requirement.appearance
                ? `${kind} (${requirement.appearance})`
                : `Regional ${kind}`,
              contactScore: 0.5,
              refined: false,
            };
        itemsByTarget[targetIndex]!.push({ object, requirement, targetIndex });
        regionalOrdinal++;
      }
      existingByKind.set(kind, pool);
    }
    const baseAvailableItems = selectRegionalPackingItems(itemsByTarget.flat(), probeCounts);
    let availableItems = baseAvailableItems;
    let scaleFactor = 1;
    let capacity = probeRegionalSettlementCapacity(
      plan,
      hf,
      seed,
      region,
      availableItems,
      hardObstacles,
    );
    const physicalMinimum = regionalMinimumCounts(targets).reduce((sum, count) => sum + count, 0);
    if (capacity < physicalMinimum) {
      // A provider-authored scale is a visual suggestion, unlike the user's
      // count and region contract. Retry only the failing town with bounded
      // readable reductions while retaining the same terrain, semantic mask,
      // collision clearances, and exact footprints. This turns a truthful
      // capacity=3 into four compact houses when the component can physically
      // support them; otherwise the regional deficit still fails closed.
      for (const candidateFactor of [0.9, 0.82, 0.74]) {
        const candidateItems = scaledRegionalPackingItems(baseAvailableItems, candidateFactor);
        const candidateCapacity = probeRegionalSettlementCapacity(
          plan,
          hf,
          seed,
          region,
          candidateItems,
          hardObstacles,
        );
        if (candidateCapacity > capacity) {
          availableItems = candidateItems;
          capacity = candidateCapacity;
          scaleFactor = candidateFactor;
        }
        if (capacity >= physicalMinimum) break;
      }
    }
    regionPlans.push({
      region,
      targets,
      availableItems,
      capacity,
      chosenTotal: 0,
      scaleFactor,
    });
  }

  let sharedDensityScale = 1;
  for (const regionPlan of regionPlans) {
    const exactTotal = regionPlan.targets.reduce(
      (sum, target) => sum + (target.exact ? target.requested : 0),
      0,
    );
    const suggestedTotal = regionPlan.targets.reduce(
      (sum, target) => sum + (target.exact ? 0 : target.requested),
      0,
    );
    if (suggestedTotal <= 0) continue;
    const minimumTotal = exactTotal + Math.max(0, MIN_SETTLEMENT_STREET_BUILDINGS - exactTotal);
    if (regionPlan.capacity < minimumTotal) continue;
    sharedDensityScale = Math.min(
      sharedDensityScale,
      Math.max(0, regionPlan.capacity - exactTotal) / suggestedTotal,
    );
  }
  sharedDensityScale = clamp(sharedDensityScale, 0, 1);

  for (const regionPlan of regionPlans) {
    const chosenCounts = allocateRegionalChosenCounts(
      regionPlan.targets,
      regionPlan.capacity,
      sharedDensityScale,
    );
    regionPlan.chosenTotal = chosenCounts.reduce((sum, count) => sum + count, 0);
    for (let targetIndex = 0; targetIndex < regionPlan.targets.length; targetIndex++) {
      const target = regionPlan.targets[targetIndex]!;
      target.chosen = chosenCounts[targetIndex] ?? 0;
      if (!target.exact) target.requirement.count = target.chosen;
    }
  }

  let selectedTrial: RegionalPackingTrial | undefined;
  for (const order of regionalPackingOrders(regionPlans)) {
    const trial = packRegionalSettlementOrder(plan, hf, seed, order, hardObstacles);
    if (betterRegionalPackingTrial(trial, selectedTrial)) selectedTrial = trial;
    if (trial.shortfall === 0) break;
  }
  selectedTrial ??= packRegionalSettlementOrder(plan, hf, seed, [], hardObstacles);

  const objects = selectedTrial.objects;
  const deficits: RegionalObjectDeficit[] = [];
  const decisions: RegionalObjectCountDecision[] = [];
  for (const regionPlan of regionPlans) {
    const chosenCounts = regionPlan.targets.map((target) => target.chosen);
    const selectedItems = selectRegionalPackingItems(regionPlan.availableItems, chosenCounts);
    const packed = selectedTrial.packedByRegionId.get(regionPlan.region.id) ?? [];
    const telemetry =
      selectedTrial.telemetryByRegionId.get(regionPlan.region.id) ??
      emptyRegionalPackingTelemetry();
    const itemTargetById = new Map(selectedItems.map((item) => [item.object.id, item.targetIndex]));
    const placedByTarget = regionPlan.targets.map(() => 0);
    for (const object of packed) {
      const targetIndex = itemTargetById.get(object.id);
      if (targetIndex !== undefined) placedByTarget[targetIndex]!++;
    }
    const minimums = regionalMinimumCounts(regionPlan.targets, regionPlan.capacity);
    const deficitByKind = new Map<ObjectKind, { required: number; placed: number }>();
    for (let targetIndex = 0; targetIndex < regionPlan.targets.length; targetIndex++) {
      const target = regionPlan.targets[targetIndex]!;
      const placed = placedByTarget[targetIndex] ?? 0;
      const minimum = minimums[targetIndex] ?? 0;
      const required = Math.max(target.chosen, minimum);
      decisions.push({
        regionId: regionPlan.region.id,
        regionName: regionPlan.region.name,
        kind: target.kind,
        requested: target.requested,
        capacity: regionPlan.capacity,
        chosen: target.chosen,
        placed,
        minimum,
        exact: target.exact,
        scaleFactor: regionPlan.scaleFactor,
        attempts: telemetry.attempts,
        rejected: { ...telemetry.rejected },
      });
      if (placed >= required) continue;
      const current = deficitByKind.get(target.kind) ?? { required: 0, placed: 0 };
      current.required += required;
      current.placed += placed;
      deficitByKind.set(target.kind, current);
    }
    for (const [kind, deficit] of deficitByKind) {
      deficits.push({
        regionId: regionPlan.region.id,
        regionName: regionPlan.region.name,
        kind,
        required: deficit.required,
        placed: deficit.placed,
        missing: deficit.required - deficit.placed,
      });
    }
  }

  for (const object of dressing) {
    const footprint = objectFootprintXZ(object);
    const authoredRegion = plan.regions.find((region) => region.id === object.regionId);
    if (
      authoredRegion &&
      isVegetation(object.kind) &&
      !candidateBelongsToAuthoredRegion(plan, hf, authoredRegion, object.kind, footprint, seed)
    ) {
      continue;
    }
    if (
      objects.some((existing) =>
        footprintsOverlapXZ(
          footprint,
          objectFootprintXZ(existing),
          pairClearance(object.kind, existing.kind),
        ),
      )
    ) {
      continue;
    }
    objects.push(object);
  }

  return { objects, deficits, decisions };
}

function heroRegionOrder(plan: ScenePlan, kind: ObjectKind): RegionSpec[] {
  const categoryOrder: RegionSpec["category"][] =
    isMaritime(kind) || kind === "dock"
      ? ["ocean", "river", "beach"]
      : kind === "tank" || kind === "vehicle" || kind === "bunker"
        ? ["road", "settlement", "grass", "desert", "sand"]
        : kind === "pagoda" || kind === "torii" || isStructure(kind)
          ? ["settlement", "grass", "forest", "hill", "rock"]
          : ["grass", "settlement", "forest", "rock", "sand"];
  return [...plan.regions].sort((a, b) => {
    const maritime = isMaritime(kind) || kind === "dock";
    const aHarbor =
      maritime && /harbou?r|port|dock|cove|marina|berth|fishing/i.test(`${a.name} ${a.role}`);
    const bHarbor =
      maritime && /harbou?r|port|dock|cove|marina|berth|fishing/i.test(`${b.name} ${b.role}`);
    if (aHarbor !== bHarbor) return aHarbor ? -1 : 1;
    const aIndex = categoryOrder.indexOf(a.category);
    const bIndex = categoryOrder.indexOf(b.category);
    return (
      (aIndex < 0 ? categoryOrder.length : aIndex) - (bIndex < 0 ? categoryOrder.length : bIndex) ||
      a.id.localeCompare(b.id)
    );
  });
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptExplicitlyAssignsRegion(
  plan: ScenePlan,
  kind: ObjectKind,
  region: RegionSpec,
): boolean {
  const prompt = plan.prompt.slice(0, 4_096).toLocaleLowerCase();
  const regionName = region.name.trim().toLocaleLowerCase();
  if (regionName.length < 3 || !prompt.includes(regionName)) return false;
  const nounAliases = Object.entries(CATEGORY_WORD_ALIASES)
    .filter(([, candidate]) => candidate === kind)
    .map(([noun]) => regexEscape(noun))
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
  if (nounAliases.length === 0) return false;
  const noun = `(?:${nounAliases.join("|")})`;
  const namedRegion = regexEscape(regionName);
  const relation = "(?:in|inside|within|at|on|along|beside|near|by|with)";
  return (
    new RegExp(
      `\\b${noun}\\b[^,;.!?]{0,96}\\b${relation}\\b[^,;.!?]{0,64}\\b${namedRegion}\\b`,
      "i",
    ).test(prompt) ||
    new RegExp(
      `\\b${namedRegion}\\b[^,;.!?]{0,64}\\b${relation}\\b[^,;.!?]{0,96}\\b${noun}\\b`,
      "i",
    ).test(prompt)
  );
}

function compatibleModelSuggestedRegions(
  plan: ScenePlan,
  kind: ObjectKind,
  authoredRegions: readonly RegionSpec[],
): RegionSpec[] {
  if (authoredRegions.length === 0) return [];
  const source = authoredRegions[0]!;
  const sourceIds = new Set(authoredRegions.map((region) => region.id));
  const categoryOrder = heroRegionOrder(plan, kind).map((region) => region.category);
  return plan.regions
    .filter((region) => {
      if (sourceIds.has(region.id)) return false;
      if (isMaritime(kind) || kind === "dock") {
        return (
          region.category === "ocean" || region.category === "river" || region.category === "beach"
        );
      }
      return region.category !== "ocean" && region.category !== "river";
    })
    .map((region) => {
      const distance = Math.hypot(
        region.center[0] - source.center[0],
        region.center[1] - source.center[1],
      );
      const categoryIndex = categoryOrder.indexOf(region.category);
      const occupiedRequirements = (plan.objectRequirements[region.name] ?? []).filter(
        (requirement) => resolveObjectKind(requirement.category) !== kind,
      ).length;
      const clearingBonus = /clearing|plaza|precinct|sacred|shrine|temple|upland/i.test(
        `${region.name} ${region.role}`,
      )
        ? -0.18
        : 0;
      return {
        region,
        distance,
        score:
          distance +
          (categoryIndex < 0 ? 0.9 : categoryIndex * 0.08) +
          Math.min(0.7, occupiedRequirements * 0.18) +
          clearingBonus,
      };
    })
    .filter(({ distance }) => distance <= Math.max(0.24, source.radius * 2.6))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.distance - right.distance ||
        left.region.id.localeCompare(right.region.id),
    )
    .slice(0, 3)
    .map(({ region }) => region);
}

function relocateModelSuggestedRequirement(
  plan: ScenePlan,
  kind: ObjectKind,
  sources: readonly RegionSpec[],
  target: RegionSpec,
): void {
  const sourceIds = new Set(sources.map((region) => region.id));
  const moved: ObjectRequirement[] = [];
  for (const region of plan.regions) {
    if (!sourceIds.has(region.id)) continue;
    const retained: ObjectRequirement[] = [];
    for (const requirement of plan.objectRequirements[region.name] ?? []) {
      if (resolveObjectKind(requirement.category) === kind) moved.push(requirement);
      else retained.push(requirement);
    }
    plan.objectRequirements[region.name] = retained;
  }
  if (moved.length === 0) return;
  const targetRequirements = plan.objectRequirements[target.name] ?? [];
  for (const requirement of moved) targetRequirements.push(requirement);
  plan.objectRequirements[target.name] = targetRequirements;
}

/**
 * A model-authored required count must not disappear because its first
 * semantic region is too steep, crowded, or was renamed by layout vision.
 * This bounded second pass searches every compatible region using the same
 * terrain and authored-footprint checks as normal placement. It adds only the
 * exact shortfall requested by the authoritative plan.
 */
export function ensureRequiredObjectKinds(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  input: PlacedObject[],
  requiredCounts: ReadonlyMap<ObjectKind, number>,
  telemetry?: RequiredObjectPlacementTelemetry[],
): PlacedObject[] {
  const objects = [...input];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const worldHalfExtent = hf.worldSize * 0.5;

  for (const [kind, rawRequiredCount] of requiredCounts) {
    const sanitizedCount = Math.round(finiteOr(rawRequiredCount, 0));
    if (sanitizedCount <= 0) continue;
    const requiredCount = clamp(sanitizedCount, 1, MAX_OBJECTS_PER_REQUIREMENT);
    const initiallyPlaced = objects.filter((object) => object.kind === kind).length;
    let shortfall = requiredCount - initiallyPlaced;
    if (shortfall <= 0) continue;

    const appearance = Object.values(plan.objectRequirements)
      .flat()
      .find((requirement) => resolveObjectKind(requirement.category) === kind)?.appearance;
    const palette = OBJECT_PALETTES[kind] ?? {
      primary: "#888",
      secondary: "#444",
    };
    if (kind === "bridge") {
      const requirement = Object.values(plan.objectRequirements)
        .flat()
        .find((candidate) => resolveObjectKind(candidate.category) === "bridge");
      const desiredSpan = clamp(
        BRIDGE_AUTHORED_SPAN_METERS * clamp(finiteOr(requirement?.scale, 1), 0.1, 4),
        MIN_BRIDGE_SPAN_METERS,
        MAX_BRIDGE_SPAN_METERS,
      );
      const candidates = bridgeCrossingCandidates(plan, hf, desiredSpan);
      while (shortfall > 0) {
        const candidate = candidates.find(
          (crossing) => !bridgeCandidateCollides(crossing, objects),
        );
        if (!candidate) break;
        objects.push({
          id: `required_bridge_${requiredCount - shortfall}`,
          kind: "bridge",
          regionId: bridgeRegionId(plan, hf, candidate.x, candidate.z),
          position: [candidate.x, candidate.deckY, candidate.z],
          rotation: [0, candidate.yaw, 0],
          scale: candidate.scale,
          color: palette.primary,
          secondaryColor: palette.secondary,
          label: appearance ? `bridge (${appearance})` : "Required bridge",
          contactScore: 0.5,
          refined: false,
        });
        shortfall--;
      }
      continue;
    }
    const kindPhase = [...kind].reduce((value, character) => value + character.charCodeAt(0), 0);
    const phase = (((seed ^ (kindPhase * 2654435761)) >>> 0) / 0xffff_ffff) * TWO_PI;

    const authoredRegions = authoredRegionsForKind(plan, kind);
    const userExplicitRegionLock = authoredRegions.some((region) =>
      promptExplicitlyAssignsRegion(plan, kind, region),
    );
    // A user-located subject is immovable. A model-located subject first gets
    // the same full physical preflight in its authored region; only when that
    // is impossible may it try up to three nearby compatible semantic regions
    // in a deterministic plan-aware order. Every attempted region and any
    // committed move are retained in telemetry.
    const modelFallbackRegions =
      authoredRegions.length > 0 && !userExplicitRegionLock && requiredCount === 1
        ? compatibleModelSuggestedRegions(plan, kind, authoredRegions)
        : [];
    const candidateRegions =
      authoredRegions.length > 0
        ? [...authoredRegions, ...modelFallbackRegions]
        : heroRegionOrder(plan, kind);
    const telemetryEntry: RequiredObjectPlacementTelemetry = {
      kind,
      required: requiredCount,
      initiallyPlaced,
      placed: initiallyPlaced,
      authoredRegionLock: authoredRegions.length > 0,
      locationAuthority:
        authoredRegions.length === 0
          ? "unassigned"
          : userExplicitRegionLock
            ? "user-explicit"
            : "model-suggested",
      sourceRegionIds: authoredRegions.map((region) => region.id),
      relocated: false,
      regions: [],
    };
    let relocatedTarget: RegionSpec | undefined;
    for (const region of candidateRegions) {
      if (shortfall <= 0) break;
      const centerX = (region.center[0] - 0.5) * hf.worldSize;
      const centerZ = (region.center[1] - 0.5) * hf.worldSize;
      const radius = Math.max(2, region.radius * hf.worldSize * 0.92);
      const namedHarbor = /harbou?r|port|dock|cove|marina|berth|fishing/i.test(
        `${region.name} ${region.role}`,
      );
      const waterBearing =
        namedHarbor && (isMaritime(kind) || kind === "dock")
          ? chooseWaterBearing(hf, centerX, centerZ, radius, phase)
          : phase;
      const landmarkBearing =
        kind === "torii" ? chooseWaterBearing(hf, centerX, centerZ, radius, phase) : phase;
      const placementContext = regionalPlacementContext(plan, hf, region, seed);
      const regionTelemetry: RequiredPlacementRegionTelemetry = {
        regionId: region.id,
        regionName: region.name,
        category: region.category,
        center: [region.center[0], region.center[1]],
        radius: region.radius,
        waterBearing: namedHarbor && (isMaritime(kind) || kind === "dock") ? waterBearing : null,
        attempts: 0,
        rejected: { world: 0, terrain: 0, region: 0, collision: 0 },
        placed: 0,
      };
      const attempts = 256;
      for (let attempt = 0; attempt < attempts && shortfall > 0; attempt++) {
        regionTelemetry.attempts++;
        const scale = kindBaseScale(kind) * (0.92 + ((attempt + kindPhase) % 5) * 0.025);
        const placedOrdinal = requiredCount - shortfall;
        let candidate: CandidateXZ;
        if (namedHarbor && isMaritime(kind)) {
          const halfLength = objectFootprintXZ({
            kind,
            scale,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
          }).halfX;
          candidate = harborCandidate(
            placedOrdinal,
            requiredCount,
            attempt,
            centerX,
            centerZ,
            radius,
            waterBearing,
            halfLength,
          );
        } else if (namedHarbor && kind === "dock") {
          const retry = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1][attempt % 7] ?? 0;
          const retryRing = Math.floor(attempt / 7);
          const tangentOffset = (placedOrdinal - (requiredCount - 1) * 0.5) * 4.2 + retry;
          const radialDistance = radius * 0.3 + retryRing * Math.min(0.8, radius * 0.08);
          candidate = {
            x:
              centerX +
              Math.cos(waterBearing) * radialDistance -
              Math.sin(waterBearing) * tangentOffset,
            z:
              centerZ +
              Math.sin(waterBearing) * radialDistance +
              Math.cos(waterBearing) * tangentOffset,
            yaw: -waterBearing,
          };
        } else {
          const angle = phase + attempt * goldenAngle;
          const distance = Math.sqrt((attempt + 0.5) / attempts) * radius;
          candidate = {
            x: centerX + Math.cos(angle) * distance,
            z: centerZ + Math.sin(angle) * distance,
            yaw:
              kind === "torii"
                ? -(landmarkBearing + Math.PI * 0.5)
                : isMaritime(kind)
                  ? -(angle + Math.PI * 0.5)
                  : -angle,
          };
        }
        const provisional = {
          kind,
          scale,
          position: [candidate.x, 0, candidate.z] as [number, number, number],
          rotation: [0, candidate.yaw, 0] as [number, number, number],
        };
        const footprint = objectFootprintXZ(provisional);
        if (!footprintFitsWorld(footprint, worldHalfExtent)) {
          regionTelemetry.rejected.world++;
          continue;
        }
        if (!terrainAccepts(kind, footprint, hf)) {
          regionTelemetry.rejected.terrain++;
          continue;
        }
        if (
          authoredRegions.length > 0 &&
          !candidateBelongsToAuthoredRegion(
            plan,
            hf,
            region,
            kind,
            footprint,
            seed,
            placementContext,
          )
        ) {
          regionTelemetry.rejected.region++;
          continue;
        }
        if (
          objects.some((existing) =>
            footprintsOverlapXZ(
              footprint,
              objectFootprintXZ(existing),
              pairClearance(kind, existing.kind),
            ),
          )
        ) {
          regionTelemetry.rejected.collision++;
          continue;
        }

        const height = sampleHeight(hf, candidate.x, candidate.z);
        objects.push({
          id: `required_${kind}_${requiredCount - shortfall}`,
          kind,
          regionId: region.id,
          position: [
            candidate.x,
            isMaritime(kind) ? Math.max(height, -0.3) + 0.15 : height,
            candidate.z,
          ],
          rotation: [0, candidate.yaw, 0],
          scale,
          color: palette.primary,
          secondaryColor: palette.secondary,
          label: appearance ? `${kind} (${appearance})` : `Required ${kind}`,
          contactScore: 0.5,
          refined: false,
        });
        shortfall--;
        regionTelemetry.placed++;
        if (!authoredRegions.some((candidate) => candidate.id === region.id)) {
          relocatedTarget = region;
        }
      }
      telemetryEntry.regions.push(regionTelemetry);
    }
    if (relocatedTarget) {
      relocateModelSuggestedRequirement(plan, kind, authoredRegions, relocatedTarget);
      telemetryEntry.selectedRegionId = relocatedTarget.id;
      telemetryEntry.relocated = true;
      telemetryEntry.relocationReason =
        "model-suggested source failed physical preflight; selected nearest compatible bounded region";
    } else if (authoredRegions.length > 0) {
      telemetryEntry.selectedRegionId = authoredRegions[0]!.id;
    }
    telemetryEntry.placed = objects.filter((object) => object.kind === kind).length;
    if (telemetry && telemetry.length < 32) telemetry.push(telemetryEntry);
  }
  return objects;
}

/** Image-space scale calibration analogue — normalize outlier scales in region. */
export function calibrateScales(objects: PlacedObject[]): PlacedObject[] {
  const byKind = new Map<ObjectKind, PlacedObject[]>();
  for (const object of objects) {
    const list = byKind.get(object.kind) ?? [];
    list.push(object);
    byKind.set(object.kind, list);
  }
  const out = objects.map((object) => ({ ...object }));
  for (const [, list] of byKind) {
    if (list.length < 2) continue;
    const mean = list.reduce((sum, object) => sum + object.scale, 0) / list.length;
    for (const object of list) {
      const target = out.find((candidate) => candidate.id === object.id)!;
      if (object.scale > mean * 1.6) target.scale = mean * 1.35;
      if (object.scale < mean * 0.5) target.scale = mean * 0.7;
    }
  }
  return out;
}

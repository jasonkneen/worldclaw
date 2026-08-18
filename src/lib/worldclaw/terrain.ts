/**
 * Stage 2 — Global Terrain Generation (paper §2.2)
 * Semantic layout map → height field (eq. 6) → materials → asset scatter → refine
 */

import { TERRAIN_MATERIALS } from "./materials";
import {
  erosionFactor,
  fbm,
  geomorphicDune,
  geomorphicPeak,
  geomorphicTerrace,
  mulberry32,
} from "./noise";
import type {
  HeightField,
  RegionSpec,
  ScenePlan,
  TerrainAssetDef,
  TerrainCategory,
  TerrainSpec,
} from "./types";

const LAYOUT_RES = 160;
const WORLD_SIZE = 120;
const TROPICAL_INTENT_TEXT_BUDGET = 4_096;

const COMBAT_INTENT_TEXT_BUDGET = 4_096;
const CACTUS_SCATTER_MIN_SPACING_METERS = 4.2;

/** Palm scatter is a user-language decision; the generic `island` theme is not tropical. */
export function hasTropicalIntent(plan: Pick<ScenePlan, "prompt"> | string): boolean {
  const source = typeof plan === "string" ? plan : plan.prompt;
  const bounded = typeof source === "string" ? source.slice(0, TROPICAL_INTENT_TEXT_BUDGET) : "";
  const tropicalTerm = String.raw`(?:tropical|palms?|jungle|rain[-\s]?forest)`;
  const withoutExplicitNegation = bounded
    .replace(new RegExp(String.raw`\bnon[-\s]?${tropicalTerm}\b`, "gi"), "")
    .replace(
      new RegExp(
        String.raw`\b(?:not|no|without)\s+(?:(?:a|any)\s+)?${tropicalTerm}(?:(?:\s*(?:,|\/|\+|-|\bor\b|\band\b)\s*|\s+)(?:(?:a|any)\s+)?${tropicalTerm})*\b`,
        "gi",
      ),
      "",
    );
  return /\b(?:tropical|palms?|jungle|rain[-\s]?forest)\b/i.test(withoutExplicitNegation);
}

/** PUBG-style / PvP battlefield prompts need open sightlines, not oasis dressing. */
export function hasCombatOpenWorldIntent(
  plan: Pick<ScenePlan, "prompt" | "sceneType"> | string,
): boolean {
  const source =
    typeof plan === "string" ? plan : `${plan.prompt ?? ""} ${plan.sceneType ?? ""}`;
  return /\b(?:battlefield|pvp|pubg|large-scale combat|open combat)\b/i.test(
    source.slice(0, COMBAT_INTENT_TEXT_BUDGET),
  );
}

export function isOpenCombatRegion(region: Pick<RegionSpec, "name" | "role">): boolean {
  return /\b(?:combat flats?|open (?:combat|battlefield)|pvp|sightline|contested zone)\b/i.test(
    `${region.name} ${region.role}`,
  );
}

/** Soft regional weights from layout centers (paper soft masks m̃_r) */
function softWeights(
  u: number,
  v: number,
  regions: RegionSpec[],
): { weights: number[]; primary: number } {
  const weights = regions.map((r) => {
    const dx = u - r.center[0];
    const dy = v - r.center[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    const falloff = Math.max(0, 1 - d / (r.radius * 1.45));
    return Math.pow(falloff, 1.6);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum < 1e-6) {
    let minI = 0;
    let minD = Infinity;
    regions.forEach((r, i) => {
      const dx = u - r.center[0];
      const dy = v - r.center[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD) {
        minD = d;
        minI = i;
      }
    });
    const w = regions.map((_, i) => (i === minI ? 1 : 0));
    return { weights: w, primary: minI };
  }
  const norm = weights.map((w) => w / sum);
  let primary = 0;
  let maxW = -1;
  norm.forEach((w, i) => {
    if (w > maxW) {
      maxW = w;
      primary = i;
    }
  });
  return { weights: norm, primary };
}

export function buildLayoutMap(
  regions: RegionSpec[],
  resolution = LAYOUT_RES,
): TerrainCategory[][] {
  const map: TerrainCategory[][] = [];
  for (let y = 0; y < resolution; y++) {
    const row: TerrainCategory[] = [];
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1);
      const v = y / (resolution - 1);
      const { primary } = softWeights(u, v, regions);
      row.push(regions[primary]?.category ?? "grass");
    }
    map.push(row);
  }
  return map;
}

export function planTerrainAssets(plan: ScenePlan): TerrainAssetDef[] {
  const theme = plan.theme;
  const tropicalIntent = hasTropicalIntent(plan);
  const base: TerrainAssetDef[] = [
    {
      kind: "rock",
      categoryAffinity: ["rock", "mountain", "cliff", "canyon", "hill"],
      density: 0.55,
      scaleRange: [0.6, 1.9],
    },
  ];
  if (tropicalIntent) {
    base.push({
      kind: "tree",
      // Named forests and settlements are owned by the model-authored regional
      // requirements so bamboo, cherry, mangrove, or architectural planting is
      // not overwritten by a blanket tropical-palm scatter pass.
      categoryAffinity: ["beach", "grass"],
      density: 0.45,
      scaleRange: [0.85, 1.7],
    });
  } else if (theme === "tropical" || theme === "island") {
    base.push({
      kind: "tree",
      // Sparse, species-neutral coast dressing. Authored forests and settlements
      // retain their bamboo, sakura, or architectural planting requirements.
      categoryAffinity: ["beach", "grass"],
      density: 0.16,
      scaleRange: [0.8, 1.45],
    });
  } else if (theme === "snow") {
    base.push({
      kind: "tree",
      categoryAffinity: ["snow", "forest", "hill", "settlement", "mountain"],
      density: 0.6,
      scaleRange: [0.9, 1.7],
    });
    base.push({
      kind: "ice",
      categoryAffinity: ["ice", "snow", "mountain"],
      density: 0.28,
      scaleRange: [0.5, 1.3],
    });
  } else if (theme === "desert") {
    const combatOpen = hasCombatOpenWorldIntent(plan);
    base.push({
      kind: "cactus",
      // Open sand is reserved as a sightline on battlefield plans.
      categoryAffinity: combatOpen ? ["desert"] : ["desert", "sand"],
      density: combatOpen ? 0.12 : 0.28,
      scaleRange: [0.7, 1.7],
    });
  } else if (theme === "volcanic") {
    base.push({
      kind: "crystal",
      categoryAffinity: ["rock", "lava", "cliff"],
      density: 0.35,
      scaleRange: [0.5, 1.4],
    });
  } else {
    base.push({
      kind: "tree",
      categoryAffinity: ["forest", "grass", "hill"],
      density: 0.65,
      scaleRange: [0.8, 1.55],
    });
    base.push({
      kind: "bush",
      categoryAffinity: ["grass", "hill", "settlement"],
      density: 0.4,
      scaleRange: [0.4, 0.95],
    });
  }
  return base;
}

/**
 * Recover named structural terrain semantics when painterly layout colors are
 * classified as a generic dry category. Water categories are never rewritten,
 * preserving the selected canonical shoreline mask exactly.
 */
export function normalizeNamedTerrainRegions(plan: ScenePlan): void {
  for (const region of plan.regions) {
    if (region.category === "ocean" || region.category === "river") continue;
    const description = `${region.name} ${region.role}`;
    if (/bamboo/i.test(description) && /terrac|step|slope|hillside/i.test(description)) {
      region.category = "forest";
      region.color = "#315c2b";
      region.baseElevation = Math.max(region.baseElevation, 1.15);
      region.roughness = Math.max(region.roughness, 0.22);
      continue;
    }
    if (/volcan|basalt|ridge|cliff|spine/i.test(description)) {
      region.category = "rock";
      region.color = "#343238";
      region.baseElevation = Math.max(region.baseElevation, 1.35);
      region.roughness = Math.max(region.roughness, 0.58);
      region.peakStrength = Math.max(region.peakStrength, 0.72);
    }
  }
}

/** Rebuild HeightField from serializable arrays (server → client) */
export function heightFieldFromArrays(
  resolution: number,
  worldSize: number,
  height: number[],
  regionId: number[],
): HeightField {
  const data = new Float32Array(resolution * resolution);
  const rid = new Uint8Array(resolution * resolution);
  const n = resolution * resolution;
  for (let i = 0; i < n; i++) {
    data[i] = height[i] ?? 0;
    rid[i] = regionId[i] ?? 0;
  }
  return {
    resolution,
    worldSize,
    data,
    regionId: rid,
    source: "image_guided",
  };
}

/**
 * Height field generation following paper eq. (6):
 * H(x) = Σ_r m̃_r(x) [ h_r + Σ_k w_{r,k} N_{r,k}(x) + Σ_j α_{r,j} G_{r,j}(x) ]
 */
export function generateHeightField(
  plan: ScenePlan,
  seed: number,
  resolution = LAYOUT_RES,
  worldSize = WORLD_SIZE,
): HeightField {
  const regions = plan.regions;
  const data = new Float32Array(resolution * resolution);
  const regionId = new Uint8Array(resolution * resolution);
  const hasOcean = regions.some((r) => r.category === "ocean" || r.category === "river");
  const islandLike =
    plan.theme === "tropical" || plan.theme === "island" || plan.theme === "volcanic";

  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1);
      const v = y / (resolution - 1);
      const wx = (u - 0.5) * worldSize;
      const wz = (v - 0.5) * worldSize;
      const { weights, primary } = softWeights(u, v, regions);

      let h = 0;
      for (let ri = 0; ri < regions.length; ri++) {
        const r = regions[ri]!;
        const m = weights[ri]!;
        if (m < 1e-5) continue;

        // fbm(x, y, seed, octaves, lacunarity, gain)
        const noiseTerm =
          fbm(wx * 0.035, wz * 0.035, seed + ri, 5, 2.0, 0.5) * r.roughness * 2.2 +
          fbm(wx * 0.09, wz * 0.09, seed + 31 + ri, 3, 2.1, 0.45) * r.roughness * 0.9;

        let geo = 0;
        // geomorphicPeak(dx, dy, radius) relative to region center in world space
        const rcx = (r.center[0] - 0.5) * worldSize;
        const rcz = (r.center[1] - 0.5) * worldSize;
        const dx = wx - rcx;
        const dz = wz - rcz;
        const rad = r.radius * worldSize;

        if (r.category === "mountain" || r.category === "rock" || r.category === "cliff") {
          geo += geomorphicPeak(dx, dz, rad * 0.9, 2.0) * r.peakStrength * 5.5;
          geo += geomorphicTerrace(noiseTerm + 0.5, 4) * 0.8;
        } else if (r.category === "canyon") {
          geo += geomorphicTerrace(noiseTerm + 0.6, 5) * 2.2;
          geo += geomorphicPeak(dx, dz, rad, 1.6) * r.peakStrength * 2.5;
        } else if (r.category === "desert" || r.category === "sand") {
          geo += geomorphicDune(wx, wz, seed + ri, 0.08) * 1.8;
        } else if (r.category === "hill") {
          geo += geomorphicPeak(dx, dz, rad, 1.8) * r.peakStrength * 2.2;
        } else if (r.category === "snow") {
          geo += geomorphicPeak(dx, dz, rad * 1.1, 2.2) * r.peakStrength * 3.5;
        }

        let local = (r.baseElevation + noiseTerm + geo) * m;

        if (r.category === "ocean" || r.category === "river") {
          local = (r.baseElevation + noiseTerm * 0.15) * m;
        }
        h += local;
      }

      if (islandLike && hasOcean) {
        const dist = Math.hypot(u - 0.5, v - 0.5);
        const shore = 0.32;
        if (dist > shore) {
          const t = Math.min(1, (dist - shore) / 0.28);
          h = h * (1 - t) + -2.6 * t;
        }
      }

      h *= erosionFactor(wx, wz, seed) * 0.15 + 0.92;

      data[y * resolution + x] = h;
      regionId[y * resolution + x] = primary;
    }
  }

  return {
    resolution,
    worldSize,
    data,
    regionId,
    source: "procedural",
  };
}

export function sampleHeight(hf: HeightField, wx: number, wz: number): number {
  const { resolution, worldSize, data } = hf;
  const u = wx / worldSize + 0.5;
  const v = wz / worldSize + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return -2;
  const x = u * (resolution - 1);
  const y = v * (resolution - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(resolution - 1, x0 + 1);
  const y1 = Math.min(resolution - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const h00 = data[y0 * resolution + x0] ?? 0;
  const h10 = data[y0 * resolution + x1] ?? 0;
  const h01 = data[y1 * resolution + x0] ?? 0;
  const h11 = data[y1 * resolution + x1] ?? 0;
  return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
}

export function sampleNormal(hf: HeightField, wx: number, wz: number): [number, number, number] {
  const e = hf.worldSize / hf.resolution;
  const hL = sampleHeight(hf, wx - e, wz);
  const hR = sampleHeight(hf, wx + e, wz);
  const hD = sampleHeight(hf, wx, wz - e);
  const hU = sampleHeight(hf, wx, wz + e);
  const nx = hL - hR;
  const ny = 2 * e;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export function sampleSlope(hf: HeightField, wx: number, wz: number): number {
  const n = sampleNormal(hf, wx, wz);
  return 1 - Math.max(0, n[1]);
}

export function buildTerrainSpec(plan: ScenePlan, _seed: number): TerrainSpec {
  const layout = buildLayoutMap(plan.regions);
  return {
    layout,
    resolution: LAYOUT_RES,
    worldSize: WORLD_SIZE,
    heightScale: 1,
    materials: { ...TERRAIN_MATERIALS },
    assetPrototypes: planTerrainAssets(plan),
    source: "procedural",
  };
}

export function scatterTerrainAssets(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
  densityScale = 1,
): {
  kind: TerrainAssetDef["kind"];
  position: [number, number, number];
  scale: number;
  rotation: number;
}[] {
  const rng = mulberry32(seed ^ 0xabc);
  const out: {
    kind: TerrainAssetDef["kind"];
    position: [number, number, number];
    scale: number;
    rotation: number;
  }[] = [];
  const assets = planTerrainAssets(plan);
  const half = hf.worldSize * 0.48;
  const safeDensityScale = Number.isFinite(densityScale)
    ? Math.min(1.5, Math.max(0, densityScale))
    : 0;

  for (const asset of assets) {
    const count = Math.floor(90 * asset.density * safeDensityScale);
    for (let i = 0; i < count; i++) {
      const wx = (rng() * 2 - 1) * half;
      const wz = (rng() * 2 - 1) * half;
      const u = wx / hf.worldSize + 0.5;
      const v = wz / hf.worldSize + 0.5;
      const ri =
        hf.regionId[
          Math.min(hf.resolution - 1, Math.max(0, Math.floor(v * (hf.resolution - 1)))) *
            hf.resolution +
            Math.min(hf.resolution - 1, Math.max(0, Math.floor(u * (hf.resolution - 1))))
        ];
      const region = plan.regions[ri!];
      const cat = region?.category;
      if (!cat || !asset.categoryAffinity.includes(cat)) continue;
      if (asset.kind === "cactus" && region && isOpenCombatRegion(region)) continue;
      const slope = sampleSlope(hf, wx, wz);
      if (slope > 0.55) continue;
      const h = sampleHeight(hf, wx, wz);
      if (h < 0.05) continue;
      if (asset.kind === "cactus") {
        const tooClose = out.some((existing) => {
          if (existing.kind !== "cactus") return false;
          const dx = existing.position[0] - wx;
          const dz = existing.position[2] - wz;
          return dx * dx + dz * dz < CACTUS_SCATTER_MIN_SPACING_METERS ** 2;
        });
        if (tooClose) continue;
      }
      const scale = asset.scaleRange[0] + rng() * (asset.scaleRange[1] - asset.scaleRange[0]);
      out.push({
        kind: asset.kind,
        position: [wx, h, wz],
        scale,
        rotation: rng() * Math.PI * 2,
      });
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function regionPhase(region: RegionSpec): number {
  const text = `${region.id}:${region.name}:${region.role}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffff_ffff) * Math.PI;
}

function regionalMeanHeights(hf: HeightField, plan: ScenePlan): number[] {
  const sums = new Float64Array(plan.regions.length);
  const counts = new Uint32Array(plan.regions.length);
  for (let index = 0; index < hf.data.length; index++) {
    const regionIndex = hf.regionId[index] ?? 0;
    const region = plan.regions[regionIndex];
    if (!region || region.category === "ocean" || region.category === "river") continue;
    sums[regionIndex] = (sums[regionIndex] ?? 0) + (hf.data[index] ?? 0);
    counts[regionIndex] = (counts[regionIndex] ?? 0) + 1;
  }
  return plan.regions.map((region, index) =>
    counts[index] ? (sums[index] ?? region.baseElevation) / counts[index]! : region.baseElevation,
  );
}

type StructuralTerrainKind = "bamboo" | "ridge" | "town";

interface StructuralTerrainEnvelope {
  region: RegionSpec;
  regionIndex: number;
  kind: StructuralTerrainKind;
  sourceRegionIndices: Set<number>;
  centerX: number;
  centerZ: number;
  worldAngle: number;
  halfAlong: number;
  halfAcross: number;
}

function structuralTerrainKind(region: RegionSpec): StructuralTerrainKind | undefined {
  const description = `${region.name} ${region.role}`;
  if (
    region.category === "settlement" &&
    /\b(?:town|village|settlement|community)\b/i.test(description) &&
    !isGenericSettlementSibling(region) &&
    !/\b(?:harbou?r|marina|cove)\b/i.test(region.name)
  ) {
    return "town";
  }
  if (/bamboo/i.test(description) && /terrac|step|slope|hillside/i.test(description)) {
    return "bamboo";
  }
  if (/volcan|basalt|ridge|cliff|spine/i.test(description)) return "ridge";
  return undefined;
}

function isGenericSettlementSibling(region: RegionSpec): boolean {
  if (region.category !== "settlement" && region.category !== "road") return false;
  const name = region.name.trim();
  const role = region.role.trim();
  return /^(?:settlement|road)(?:\s+\d+)?$/i.test(name) ||
    /^(?:settlement|road)(?:\s+\d+)?$/i.test(role);
}

function isGenericRidgeSibling(region: RegionSpec): boolean {
  const name = region.name.trim();
  const role = region.role.trim();
  const genericLabel = /^(?:rock|mountain|cliff|canyon|hill|settlement)(?:\s+\d+)?$/i;
  return genericLabel.test(name) || genericLabel.test(role);
}

function buildStructuralTerrainEnvelopes(
  hf: HeightField,
  plan: ScenePlan,
): StructuralTerrainEnvelope[] {
  const cellSize = hf.worldSize / (hf.resolution - 1);
  const envelopes: StructuralTerrainEnvelope[] = [];

  for (let regionIndex = 0; regionIndex < plan.regions.length; regionIndex++) {
    const region = plan.regions[regionIndex]!;
    const kind = structuralTerrainKind(region);
    if (!kind) continue;
    const plannedCenterX = (region.center[0] - 0.5) * hf.worldSize;
    const plannedCenterZ = (region.center[1] - 0.5) * hf.worldSize;
    const sourceRegionIndices = new Set<number>([regionIndex]);

    if (kind === "ridge") {
      for (let candidateIndex = 0; candidateIndex < plan.regions.length; candidateIndex++) {
        if (candidateIndex === regionIndex) continue;
        const candidate = plan.regions[candidateIndex]!;
        if (!isGenericRidgeSibling(candidate)) continue;
        if ((plan.objectRequirements[candidate.name]?.length ?? 0) > 0) continue;
        const distance = Math.hypot(
          candidate.center[0] - region.center[0],
          candidate.center[1] - region.center[1],
        );
        if (distance > 0.32) continue;
        sourceRegionIndices.add(candidateIndex);
      }
    } else if (kind === "town") {
      // Illustrated roof blocks often fragment into several settlement masks.
      // Reunite only nearby generic, requirement-free siblings with the named
      // town; another authored town/harbor remains independently owned.
      for (let candidateIndex = 0; candidateIndex < plan.regions.length; candidateIndex++) {
        if (candidateIndex === regionIndex) continue;
        const candidate = plan.regions[candidateIndex]!;
        if (!isGenericSettlementSibling(candidate)) continue;
        if ((plan.objectRequirements[candidate.name]?.length ?? 0) > 0) continue;
        const distance = Math.hypot(
          candidate.center[0] - region.center[0],
          candidate.center[1] - region.center[1],
        );
        if (distance > 0.24) continue;
        sourceRegionIndices.add(candidateIndex);
      }
    }

    const maximumSampleDistance =
      kind === "ridge"
        ? hf.worldSize * 0.36
        : kind === "town"
          ? Math.max(hf.worldSize * 0.2, region.radius * hf.worldSize * 1.55)
        : Math.max(hf.worldSize * 0.18, region.radius * hf.worldSize * 1.45);
    const points: [number, number][] = [];
    for (let gridZ = 0; gridZ < hf.resolution; gridZ++) {
      for (let gridX = 0; gridX < hf.resolution; gridX++) {
        const index = gridZ * hf.resolution + gridX;
        const sourceRegionIndex = hf.regionId[index] ?? 0;
        if (
          (kind === "ridge"
            ? !sourceRegionIndices.has(sourceRegionIndex)
            : sourceRegionIndex !== regionIndex) ||
          (hf.data[index] ?? -2) < -0.2
        ) {
          continue;
        }
        const x = (gridX / (hf.resolution - 1) - 0.5) * hf.worldSize;
        const z = (gridZ / (hf.resolution - 1) - 0.5) * hf.worldSize;
        if (Math.hypot(x - plannedCenterX, z - plannedCenterZ) > maximumSampleDistance) continue;
        points.push([x, z]);
      }
    }

    let centerX = plannedCenterX;
    let centerZ = plannedCenterZ;
    let worldAngle = regionPhase(region);
    if (points.length >= 6) {
      centerX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
      centerZ = points.reduce((sum, point) => sum + point[1], 0) / points.length;
      let covarianceXX = 0;
      let covarianceXZ = 0;
      let covarianceZZ = 0;
      for (const [x, z] of points) {
        const deltaX = x - centerX;
        const deltaZ = z - centerZ;
        covarianceXX += deltaX * deltaX;
        covarianceXZ += deltaX * deltaZ;
        covarianceZZ += deltaZ * deltaZ;
      }
      covarianceXX /= points.length;
      covarianceXZ /= points.length;
      covarianceZZ /= points.length;
      const anisotropy = Math.hypot(covarianceXX - covarianceZZ, covarianceXZ * 2);
      if (anisotropy > cellSize * cellSize * 0.4) {
        worldAngle = 0.5 * Math.atan2(covarianceXZ * 2, covarianceXX - covarianceZZ);
      }
    }

    const cosine = Math.cos(worldAngle);
    const sine = Math.sin(worldAngle);
    let sampledHalfAlong = 0;
    let sampledHalfAcross = 0;
    for (const [x, z] of points) {
      const deltaX = x - centerX;
      const deltaZ = z - centerZ;
      sampledHalfAlong = Math.max(sampledHalfAlong, Math.abs(deltaX * cosine + deltaZ * sine));
      sampledHalfAcross = Math.max(sampledHalfAcross, Math.abs(-deltaX * sine + deltaZ * cosine));
    }
    const halfAlong = clamp(
      Math.max(
        sampledHalfAlong + cellSize,
        region.radius * hf.worldSize * (kind === "ridge" ? 1.35 : 1.18),
        kind === "ridge" ? 12 : 10,
      ),
      2,
      hf.worldSize * (kind === "ridge" ? 0.34 : 0.3),
    );
    const halfAcross = clamp(
      Math.max(
        sampledHalfAcross + cellSize,
        region.radius * hf.worldSize * (kind === "ridge" ? 0.45 : 0.85),
        kind === "ridge" ? 4.5 : 8,
      ),
      2,
      hf.worldSize * (kind === "ridge" ? 0.13 : 0.3),
    );
    envelopes.push({
      region,
      regionIndex,
      kind,
      sourceRegionIndices,
      centerX,
      centerZ,
      worldAngle,
      halfAlong,
      halfAcross,
    });
  }

  return envelopes;
}

function structuralEnvelopeCoordinates(
  envelope: StructuralTerrainEnvelope,
  x: number,
  z: number,
): { along: number; across: number; normalizedDistance: number } {
  const deltaX = x - envelope.centerX;
  const deltaZ = z - envelope.centerZ;
  const cosine = Math.cos(envelope.worldAngle);
  const sine = Math.sin(envelope.worldAngle);
  const along = deltaX * cosine + deltaZ * sine;
  const across = -deltaX * sine + deltaZ * cosine;
  return {
    along,
    across,
    normalizedDistance: Math.hypot(along / envelope.halfAlong, across / envelope.halfAcross),
  };
}

export function refineTerrainHeights(hf: HeightField, plan: ScenePlan): HeightField {
  const { resolution, data } = hf;
  const next = new Float32Array(data);
  const isWater = (category: TerrainCategory | undefined) =>
    category === "ocean" || category === "river";
  normalizeNamedTerrainRegions(plan);

  // Painterly maps often classify trees, inked terrace risers, or dark lava
  // patches as several generic dry categories. Re-anchor only dry cells inside
  // the named structural region's bounded plan radius. Water cells retain their
  // original region id, so this cannot alter the canonical shoreline mask.
  const regionId = hf.regionId.slice();
  const structuralRegions = buildStructuralTerrainEnvelopes(hf, plan);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const index = y * resolution + x;
      const sourceRegionIndex = hf.regionId[index] ?? 0;
      const sourceRegion = plan.regions[sourceRegionIndex];
      const sourceCategory = sourceRegion?.category;
      if (isWater(sourceCategory)) continue;
      const wx = (x / (resolution - 1) - 0.5) * hf.worldSize;
      const wz = (y / (resolution - 1) - 0.5) * hf.worldSize;
      let bestRegion: number | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const structural of structuralRegions) {
        if (isWater(structural.region.category)) continue;
        const authoredRequirements = plan.objectRequirements[sourceRegion?.name ?? ""] ?? [];
        if (sourceRegionIndex !== structural.regionIndex && authoredRequirements.length > 0) {
          continue;
        }
        const compatibleCategory =
          structural.kind === "bamboo"
            ? sourceCategory === "forest" || sourceCategory === "grass" || sourceCategory === "hill"
            : structural.kind === "town"
              ? sourceCategory === "settlement" || sourceCategory === "road"
              : sourceCategory === "rock" ||
                sourceCategory === "mountain" ||
                sourceCategory === "cliff" ||
                sourceCategory === "canyon" ||
                sourceCategory === "hill" ||
                sourceCategory === "grass" ||
                (sourceCategory === "settlement" &&
                  Boolean(sourceRegion && isGenericRidgeSibling(sourceRegion)));
        if (!compatibleCategory && !structural.sourceRegionIndices.has(sourceRegionIndex)) {
          continue;
        }
        const { normalizedDistance } = structuralEnvelopeCoordinates(structural, wx, wz);
        if (normalizedDistance <= 1 && normalizedDistance < bestDistance) {
          bestDistance = normalizedDistance;
          bestRegion = structural.regionIndex;
        }
      }
      if (bestRegion !== undefined) regionId[index] = bestRegion;
    }
  }
  const anchoredField = { ...hf, regionId };

  // Only soften boundaries within the same land/water class. Cross-class
  // averaging would visibly erode the canonical shoreline and can lift water
  // vertices into walls.
  for (let y = 2; y < resolution - 2; y++) {
    for (let x = 2; x < resolution - 2; x++) {
      const i = y * resolution + x;
      const r0 = regionId[i]!;
      const category = plan.regions[r0]?.category;
      let boundary = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (regionId[(y + dy) * resolution + (x + dx)] !== r0) {
          boundary = true;
          break;
        }
      }
      if (boundary) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const neighbor = (y + dy) * resolution + (x + dx);
            const neighborCategory = plan.regions[regionId[neighbor]!]?.category;
            if (isWater(category) !== isWater(neighborCategory)) continue;
            s += data[neighbor]!;
            c++;
          }
        }
        if (c > 0) next[i] = data[i]! * 0.45 + (s / c) * 0.55;
      }
    }
  }

  const regionMeans = regionalMeanHeights(anchoredField, plan);
  const reliefScale = clamp(plan.visualContract?.terrainReliefScale ?? 1, 0.65, 1.2);
  const waterLevel = clamp(plan.visualContract?.waterLevelMeters ?? -0.25, -3, 1);
  const dryFloor = waterLevel + 0.16;
  const structuralByRegion = new Map(
    structuralRegions.map((structural) => [structural.regionIndex, structural]),
  );

  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i = y * resolution + x;
      const regionIndex = regionId[i]!;
      const region = plan.regions[regionIndex];
      if (!region) continue;
      const category = region.category;
      if (isWater(category)) {
        next[i] = Math.min(next[i]!, waterLevel - 0.38);
        continue;
      }

      const wx = (x / (resolution - 1) - 0.5) * hf.worldSize;
      const wz = (y / (resolution - 1) - 0.5) * hf.worldSize;
      const centerX = (region.center[0] - 0.5) * hf.worldSize;
      const centerZ = (region.center[1] - 0.5) * hf.worldSize;
      const radius = Math.max(2, region.radius * hf.worldSize);
      const dx = wx - centerX;
      const dz = wz - centerZ;
      const radial = clamp(1 - Math.hypot(dx, dz) / (radius * 1.18), 0, 1);
      const description = `${region.name} ${region.role}`;
      const mean = Math.max(dryFloor, regionMeans[regionIndex] ?? region.baseElevation);

      if (category === "settlement" || category === "road") {
        // Buildable coastal lots remain level and legible, while a subtle
        // two-tier rise keeps the town grounded in the surrounding terrain.
        const tier = radial > 0.58 ? 0.18 * reliefScale : 0;
        const target = mean + tier;
        const influence = 0.72 * radial;
        next[i] = Math.max(dryFloor, next[i]! * (1 - influence) + target * influence);
        continue;
      }

      if (
        category === "forest" &&
        /bamboo/i.test(description) &&
        /terrac|step|slope|hillside/i.test(description)
      ) {
        // Six explicit retaining levels create readable terrace risers in the
        // geometry rather than relying on painted green rings in the concept.
        // The semantic component's principal envelope replaces the small
        // scalar plan radius, so a broad terrace system cannot collapse to one
        // circular mound after image partitioning.
        const structural = structuralByRegion.get(regionIndex);
        const envelopeRadial = structural
          ? clamp(1 - structuralEnvelopeCoordinates(structural, wx, wz).normalizedDistance, 0, 1)
          : radial;
        const level = Math.min(5, Math.floor(envelopeRadial * 6));
        // Keep the six bands materially separated after the terrain is viewed
        // beneath tall bamboo canopies. The cap is local to the authored
        // envelope and does not touch the shoreline or generic terrain.
        const target = Math.min(6.35, mean - 0.16 + level * 1.05 * reliefScale);
        const influence = envelopeRadial > 0 ? 0.985 : 0;
        next[i] = Math.max(dryFloor, next[i]! * (1 - influence) + target * influence);
        continue;
      }

      if (
        (category === "rock" ||
          category === "mountain" ||
          category === "cliff" ||
          category === "canyon") &&
        /volcan|basalt|ridge|cliff|spine/i.test(description)
      ) {
        // An elongated, broken basalt spine reads as a ridge from oblique and
        // map cameras. Its direction and length come from the aligned semantic
        // rock components rather than a hash, reuniting split ridge segments.
        const structural = structuralByRegion.get(regionIndex);
        const phase = regionPhase(region);
        const coordinates = structural
          ? structuralEnvelopeCoordinates(structural, wx, wz)
          : { along: dx, across: dz, normalizedDistance: Math.hypot(dx, dz) / radius };
        const halfAlong = structural?.halfAlong ?? radius;
        const halfAcross = structural?.halfAcross ?? radius * 0.68;
        const along = coordinates.along;
        const across = coordinates.across;
        const alongWeight = clamp(1 - Math.abs(along) / halfAlong, 0, 1);
        const spineWeight = clamp(1 - Math.abs(across) / (halfAcross * 0.52), 0, 1);
        const shelfWeight = clamp(1 - Math.abs(across) / halfAcross, 0, 1);
        const jagged = 0.78 + Math.abs(Math.sin(along * 0.72 + phase * 3)) * 0.22;
        const target = Math.min(
          8.25,
          mean +
            shelfWeight * alongWeight * 1.35 * reliefScale +
            spineWeight * Math.pow(alongWeight, 0.48) * jagged * 7.1 * reliefScale,
        );
        const influence = clamp(Math.max(spineWeight, shelfWeight * 0.7), 0, 0.99);
        next[i] = Math.max(dryFloor, next[i]! * (1 - influence) + target * influence);
        continue;
      }

      next[i] = Math.max(dryFloor, next[i]!);
    }
  }
  return { ...hf, data: next, regionId };
}

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
  const base: TerrainAssetDef[] = [
    {
      kind: "rock",
      categoryAffinity: ["rock", "mountain", "cliff", "canyon", "hill"],
      density: 0.55,
      scaleRange: [0.6, 1.9],
    },
  ];
  if (theme === "tropical" || theme === "island") {
    base.push({
      kind: "tree",
      categoryAffinity: ["forest", "beach", "grass", "settlement"],
      density: 0.85,
      scaleRange: [0.85, 1.7],
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
    base.push({
      kind: "cactus",
      categoryAffinity: ["desert", "sand"],
      density: 0.55,
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
  const hasOcean = regions.some(
    (r) => r.category === "ocean" || r.category === "river",
  );
  const islandLike =
    plan.theme === "tropical" ||
    plan.theme === "island" ||
    plan.theme === "volcanic";

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
          fbm(wx * 0.035, wz * 0.035, seed + ri, 5, 2.0, 0.5) *
            r.roughness *
            2.2 +
          fbm(wx * 0.09, wz * 0.09, seed + 31 + ri, 3, 2.1, 0.45) *
            r.roughness *
            0.9;

        let geo = 0;
        // geomorphicPeak(dx, dy, radius) relative to region center in world space
        const rcx = (r.center[0] - 0.5) * worldSize;
        const rcz = (r.center[1] - 0.5) * worldSize;
        const dx = wx - rcx;
        const dz = wz - rcz;
        const rad = r.radius * worldSize;

        if (
          r.category === "mountain" ||
          r.category === "rock" ||
          r.category === "cliff"
        ) {
          geo +=
            geomorphicPeak(dx, dz, rad * 0.9, 2.0) * r.peakStrength * 5.5;
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
  return (
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  );
}

export function sampleNormal(
  hf: HeightField,
  wx: number,
  wz: number,
): [number, number, number] {
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

  for (const asset of assets) {
    const count = Math.floor(90 * asset.density);
    for (let i = 0; i < count; i++) {
      const wx = (rng() * 2 - 1) * half;
      const wz = (rng() * 2 - 1) * half;
      const u = wx / hf.worldSize + 0.5;
      const v = wz / hf.worldSize + 0.5;
      const ri =
        hf.regionId[
          Math.min(
            hf.resolution - 1,
            Math.max(0, Math.floor(v * (hf.resolution - 1))),
          ) *
            hf.resolution +
            Math.min(
              hf.resolution - 1,
              Math.max(0, Math.floor(u * (hf.resolution - 1))),
            )
        ];
      const cat = plan.regions[ri!]?.category;
      if (!cat || !asset.categoryAffinity.includes(cat)) continue;
      const slope = sampleSlope(hf, wx, wz);
      if (slope > 0.55) continue;
      const h = sampleHeight(hf, wx, wz);
      if (h < 0.05) continue;
      const scale =
        asset.scaleRange[0] +
        rng() * (asset.scaleRange[1] - asset.scaleRange[0]);
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

export function refineTerrainHeights(
  hf: HeightField,
  plan: ScenePlan,
): HeightField {
  const { resolution, data } = hf;
  const next = new Float32Array(data);
  for (let y = 2; y < resolution - 2; y++) {
    for (let x = 2; x < resolution - 2; x++) {
      const i = y * resolution + x;
      const r0 = hf.regionId[i]!;
      let boundary = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (hf.regionId[(y + dy) * resolution + (x + dx)] !== r0) {
          boundary = true;
          break;
        }
      }
      if (boundary) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            s += data[(y + dy) * resolution + (x + dx)]!;
            c++;
          }
        }
        next[i] = data[i]! * 0.45 + (s / c) * 0.55;
      }
    }
  }
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i = y * resolution + x;
      const cat = plan.regions[hf.regionId[i]!]?.category;
      if (cat === "settlement" || cat === "road") {
        next[i] = next[i]! * 0.4 + data[i]! * 0.6;
      }
    }
  }
  return { ...hf, data: next };
}

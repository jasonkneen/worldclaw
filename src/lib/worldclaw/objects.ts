/**
 * Stage 3 — Regional Object Generation & Placement (paper §2.3)
 * Region composition prior → instance gen → ray-based placement → scale cal
 */

import { OBJECT_PALETTES } from "./materials";
import { mulberry32 } from "./noise";
import {
  sampleHeight,
  sampleNormal,
  sampleSlope,
} from "./terrain";
import type {
  HeightField,
  ObjectKind,
  ObjectRequirement,
  PlacedObject,
  ScenePlan,
} from "./types";

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
  cactus: 1.0,
  vehicle: 1.4,
  tank: 1.8,
  building: 2.4,
  antenna: 2.8,
  fence: 1.0,
  campfire: 0.7,
  tent: 1.1,
  bridge: 3.5,
  statue: 1.5,
  crystal: 0.9,
  mine: 2.0,
  dragon: 4.0,
  windmill: 3.5,
  well: 1.0,
  crate: 0.55,
  watchtower: 2.5,
  satellite: 1.6,
  bunker: 2.0,
  boat: 1.4,
  pagoda: 2.8,
  torii: 2.2,
  barn: 2.2,
  market: 1.8,
};

function resolveKind(cat: string): ObjectKind {
  return KIND_ALIASES[cat.toLowerCase()] ?? "crate";
}

function isVegetation(k: ObjectKind): boolean {
  return k === "tree" || k === "palm" || k === "pine" || k === "cactus";
}

function isStructure(k: ObjectKind): boolean {
  return [
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
  ].includes(k);
}

/**
 * Sample placement candidates inside a region disk on the terrain.
 * Filters by slope / water / spacing (paper placement constraints).
 */
export function generateRegionalObjects(
  plan: ScenePlan,
  hf: HeightField,
  seed: number,
): PlacedObject[] {
  const rng = mulberry32(seed ^ 0x5f3759df);
  const objects: PlacedObject[] = [];
  let idCounter = 0;

  for (const region of plan.regions) {
    const reqs: ObjectRequirement[] =
      plan.objectRequirements[region.name] ?? [];
    if (reqs.length === 0) continue;

    const half = hf.worldSize * 0.5;
    const cx = (region.center[0] - 0.5) * hf.worldSize;
    const cz = (region.center[1] - 0.5) * hf.worldSize;
    const rad = region.radius * hf.worldSize * 0.95;

    for (const req of reqs) {
      const kind = resolveKind(req.category);
      const baseScale = (BASE_SCALES[kind] ?? 1) * (req.scale ?? 1);
      let placed = 0;
      let attempts = 0;
      const maxAttempts = req.count * 40;

      while (placed < req.count && attempts < maxAttempts) {
        attempts++;
        const ang = rng() * Math.PI * 2;
        const dist = Math.sqrt(rng()) * rad;
        const wx = cx + Math.cos(ang) * dist;
        const wz = cz + Math.sin(ang) * dist;
        if (Math.abs(wx) > half * 0.96 || Math.abs(wz) > half * 0.96) continue;

        const h = sampleHeight(hf, wx, wz);
        const slope = sampleSlope(hf, wx, wz);
        const n = sampleNormal(hf, wx, wz);

        // Water / ocean rules
        if (kind === "ship" || kind === "boat") {
          if (h > 0.35) continue;
        } else if (kind === "dock") {
          if (h < -0.8 || h > 1.2) continue;
        } else {
          if (h < -0.2) continue;
          if (isStructure(kind) && slope > 0.35) continue;
          if (isVegetation(kind) && slope > 0.55) continue;
          if (slope > 0.7) continue;
        }

        // Spacing: reject if too close to existing of same cluster
        const minDist = isVegetation(kind)
          ? 2.2
          : isStructure(kind)
            ? 4.5
            : kind === "crate"
              ? 1.2
              : 2.8;
        let clash = false;
        for (const o of objects) {
          const dx = o.position[0] - wx;
          const dz = o.position[2] - wz;
          if (dx * dx + dz * dz < minDist * minDist * 0.7) {
            clash = true;
            break;
          }
        }
        if (clash) continue;

        const palette =
          OBJECT_PALETTES[kind] ?? { primary: "#888", secondary: "#444" };

        // Align yaw to random; pitch/roll lightly follow terrain for non-structures
        let rotX = 0;
        let rotZ = 0;
        if (!isStructure(kind) && kind !== "ship" && kind !== "boat") {
          rotX = Math.atan2(n[2], n[1]) * 0.25;
          rotZ = -Math.atan2(n[0], n[1]) * 0.25;
        }
        const rotY = rng() * Math.PI * 2;
        const scaleJitter = 0.85 + rng() * 0.35;
        const scale = baseScale * scaleJitter;

        // Contact: place base on terrain
        const y = kind === "ship" || kind === "boat" ? Math.max(h, -0.3) + 0.15 : h;

        objects.push({
          id: `obj_${idCounter++}`,
          kind,
          regionId: region.id,
          position: [wx, y, wz],
          rotation: [rotX, rotY, rotZ],
          scale,
          color: palette.primary,
          secondaryColor: palette.secondary,
          label: req.appearance
            ? `${kind} (${req.appearance})`
            : kind,
          contactScore: 0.5,
          refined: false,
        });
        placed++;
      }
    }
  }

  return objects;
}

/** Image-space scale calibration analogue — normalize outlier scales in region */
export function calibrateScales(objects: PlacedObject[]): PlacedObject[] {
  const byKind = new Map<ObjectKind, PlacedObject[]>();
  for (const o of objects) {
    const list = byKind.get(o.kind) ?? [];
    list.push(o);
    byKind.set(o.kind, list);
  }
  const out = objects.map((o) => ({ ...o }));
  for (const [, list] of byKind) {
    if (list.length < 2) continue;
    const mean =
      list.reduce((s, o) => s + o.scale, 0) / list.length;
    for (const o of list) {
      const target = out.find((x) => x.id === o.id)!;
      // Pull toward mean if outlier (paper asymmetric scale clamp)
      if (o.scale > mean * 1.6) target.scale = mean * 1.35;
      if (o.scale < mean * 0.5) target.scale = mean * 0.7;
    }
  }
  return out;
}

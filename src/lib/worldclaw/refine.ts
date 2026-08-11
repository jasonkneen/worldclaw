/**
 * Scene refinement agent (paper §2.3.3)
 * Object pose/scale/mesh quality + terrain contact co-deformation
 */

import { mulberry32 } from "./noise";
import { sampleHeight, sampleNormal, sampleSlope } from "./terrain";
import type { HeightField, PlacedObject, ScenePlan } from "./types";

export interface RefineReport {
  objectsFixed: number;
  floatingFixed: number;
  penetrationFixed: number;
  scaleFixed: number;
  poseFixed: number;
  iterations: number;
}

export function refineScene(
  objects: PlacedObject[],
  hf: HeightField,
  _plan: ScenePlan,
  seed: number,
  iterations = 2,
): { objects: PlacedObject[]; report: RefineReport } {
  const rng = mulberry32(seed ^ 0xef1ed);
  let current = objects.map((o) => ({
    ...o,
    position: [...o.position] as [number, number, number],
    rotation: [...o.rotation] as [number, number, number],
  }));
  const report: RefineReport = {
    objectsFixed: 0,
    floatingFixed: 0,
    penetrationFixed: 0,
    scaleFixed: 0,
    poseFixed: 0,
    iterations,
  };

  for (let iter = 0; iter < iterations; iter++) {
    for (const o of current) {
      const [wx, , wz] = o.position;
      const terrainH = sampleHeight(hf, wx, wz);
      const slope = sampleSlope(hf, wx, wz);
      const n = sampleNormal(hf, wx, wz);

      const isWatercraft = o.kind === "ship" || o.kind === "boat";

      // Object refinement: scale
      if (o.scale > 6) {
        o.scale = 5.5;
        report.scaleFixed++;
      }
      if (o.scale < 0.25) {
        o.scale = 0.4;
        report.scaleFixed++;
      }

      // Pose: structures upright
      const structures = [
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
        "well",
        "torii",
      ];
      if (structures.includes(o.kind)) {
        if (Math.abs(o.rotation[0]) > 0.08 || Math.abs(o.rotation[2]) > 0.08) {
          o.rotation[0] = 0;
          o.rotation[2] = 0;
          report.poseFixed++;
        }
      } else if (!isWatercraft) {
        o.rotation[0] = Math.atan2(n[2], n[1]) * 0.3;
        o.rotation[2] = -Math.atan2(n[0], n[1]) * 0.3;
      }

      // Contact: floating / penetration
      let targetY = terrainH;
      if (isWatercraft) {
        targetY = Math.max(terrainH, -0.25) + 0.1;
      } else if (o.kind === "dock") {
        targetY = terrainH + 0.05;
      } else {
        targetY = terrainH;
      }

      const dy = o.position[1] - targetY;
      if (dy > 0.35) {
        o.position[1] = targetY;
        report.floatingFixed++;
        report.objectsFixed++;
      } else if (dy < -0.45) {
        o.position[1] = targetY;
        report.penetrationFixed++;
        report.objectsFixed++;
      } else {
        o.position[1] = targetY;
      }

      // Unstable support on steep slope - nudge toward flatter
      if (structures.includes(o.kind) && slope > 0.4) {
        const step = 1.2;
        let best = { x: wx, z: wz, s: slope, h: terrainH };
        for (let k = 0; k < 6; k++) {
          const a = rng() * Math.PI * 2;
          const nx = wx + Math.cos(a) * step;
          const nz = wz + Math.sin(a) * step;
          const s = sampleSlope(hf, nx, nz);
          if (s < best.s) {
            best = { x: nx, z: nz, s, h: sampleHeight(hf, nx, nz) };
          }
        }
        if (best.s < slope) {
          o.position[0] = best.x;
          o.position[2] = best.z;
          o.position[1] = best.h;
          report.poseFixed++;
        }
      }

      const finalDy = Math.abs(
        o.position[1] - sampleHeight(hf, o.position[0], o.position[2]),
      );
      o.contactScore = Math.max(0, 1 - finalDy / 0.5);
      o.refined = true;
    }
  }

  return { objects: current, report };
}

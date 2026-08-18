/**
 * Scene refinement agent (paper §2.3.3).
 *
 * Contact is evaluated across an explicit primitive collider footprint. Static
 * structures may make one small, deterministic terrain adjustment; the pass is
 * not a mesh-aware physics or learned co-deformation system.
 */

import {
  colliderSupportPointsXZ,
  normalizedFootprintDistanceXZ,
  worldColliderForObject,
  type WorldColliderProxy,
} from "./collision";
import { sampleHeight, sampleNormal } from "./terrain";
import type { HeightField, ObjectKind, PlacedObject, ScenePlan } from "./types";

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
  "well",
  "torii",
]);

const SUPPORT_VARIATION_THRESHOLD = 0.45;
const MAX_DEFORMATION_METERS = 0.35;
const MAX_DEFORMATION_RADIUS_METERS = 8;
const DEFORMATION_BLEND = 0.48;

export interface RefineReport {
  objectsFixed: number;
  floatingFixed: number;
  penetrationFixed: number;
  scaleFixed: number;
  poseFixed: number;
  iterations: number;
  supportSamples: number;
  maxSupportSpread: number;
  maxSupportGap: number;
  terrainCellsDeformed: number;
  terrainObjectsDeformed: number;
}

interface FootprintSupport {
  heights: number[];
  min: number;
  max: number;
  median: number;
  spread: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) * 0.5;
}

function safeSampleHeight(hf: HeightField, x: number, z: number): number {
  const half = Math.max(0, finiteOr(hf.worldSize, 1) * 0.5);
  const cell = hf.resolution > 1 ? hf.worldSize / (hf.resolution - 1) : hf.worldSize;
  const inset = Math.max(0, half - Math.abs(finiteOr(cell, 0)) * 0.5);
  const safeX = clamp(finiteOr(x, 0), -inset, inset);
  const safeZ = clamp(finiteOr(z, 0), -inset, inset);
  return finiteOr(sampleHeight(hf, safeX, safeZ), 0);
}

function sampleFootprintSupport(hf: HeightField, collider: WorldColliderProxy): FootprintSupport {
  const heights = colliderSupportPointsXZ(collider).map(([x, z]) => safeSampleHeight(hf, x, z));
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  return {
    heights,
    min,
    max,
    median: median(heights),
    spread: max - min,
  };
}

/**
 * Approximate bridge abutment support with three samples across each authored
 * end. A level bridge is placed on the higher endpoint; unequal-bank gaps stay
 * visible in the contact score instead of tilting the deck or moving terrain.
 * This deliberately makes no mesh- or intermediate-pier-contact claim.
 */
function sampleBridgeEndpointSupport(
  hf: HeightField,
  collider: WorldColliderProxy,
): FootprintSupport | undefined {
  if (collider.shape !== "obb") return undefined;
  const cosine = Math.cos(collider.yaw);
  const sine = Math.sin(collider.yaw);
  const heights: number[] = [];
  for (const longitudinalSign of [-1, 1]) {
    for (const lateralFactor of [-0.65, 0, 0.65]) {
      const localX = collider.halfWidth * longitudinalSign;
      const localZ = collider.halfDepth * lateralFactor;
      const worldX = collider.centerX + cosine * localX + sine * localZ;
      const worldZ = collider.centerZ - sine * localX + cosine * localZ;
      heights.push(safeSampleHeight(hf, worldX, worldZ));
    }
  }
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  return {
    heights,
    min,
    max,
    median: median(heights),
    spread: max - min,
  };
}

function colliderAabbRadius(collider: WorldColliderProxy): [number, number] {
  if (collider.shape === "circle") {
    return [collider.radius, collider.radius];
  }
  const c = Math.abs(Math.cos(collider.yaw));
  const s = Math.abs(Math.sin(collider.yaw));
  return [
    c * collider.halfWidth + s * collider.halfDepth,
    s * collider.halfWidth + c * collider.halfDepth,
  ];
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Move only interior heightfield cells toward the support median. The maximum
 * per-cell change and inspected radius are capped so malformed scale metadata
 * cannot flatten an unbounded portion of the world.
 */
function flattenStructureFootprint(
  hf: HeightField,
  collider: WorldColliderProxy,
  targetHeight: number,
): number[] {
  const resolution = Math.trunc(finiteOr(hf.resolution, 0));
  const worldSize = finiteOr(hf.worldSize, 0);
  if (resolution < 3 || worldSize <= 0 || hf.data.length < resolution * resolution) {
    return [];
  }

  const [rawRadiusX, rawRadiusZ] = colliderAabbRadius(collider);
  const radiusX = Math.min(MAX_DEFORMATION_RADIUS_METERS, rawRadiusX);
  const radiusZ = Math.min(MAX_DEFORMATION_RADIUS_METERS, rawRadiusZ);
  const worldToGrid = (resolution - 1) / worldSize;
  const toIndex = (world: number) => (world / worldSize + 0.5) * (resolution - 1);
  const minX = clamp(Math.floor(toIndex(collider.centerX - radiusX)), 1, resolution - 2);
  const maxX = clamp(Math.ceil(toIndex(collider.centerX + radiusX)), 1, resolution - 2);
  const minZ = clamp(Math.floor(toIndex(collider.centerZ - radiusZ)), 1, resolution - 2);
  const maxZ = clamp(Math.ceil(toIndex(collider.centerZ + radiusZ)), 1, resolution - 2);
  if (minX > maxX || minZ > maxZ || worldToGrid <= 0) return [];

  const changedCells: number[] = [];
  for (let gridZ = minZ; gridZ <= maxZ; gridZ++) {
    const worldZ = (gridZ / (resolution - 1) - 0.5) * worldSize;
    for (let gridX = minX; gridX <= maxX; gridX++) {
      const worldX = (gridX / (resolution - 1) - 0.5) * worldSize;
      const footprintDistance = normalizedFootprintDistanceXZ(collider, worldX, worldZ);
      if (footprintDistance >= 1) continue;
      const edgeFade = 1 - smoothstep(0.45, 1, footprintDistance);
      if (edgeFade <= 0) continue;

      const index = gridZ * resolution + gridX;
      const before = finiteOr(hf.data[index] ?? 0, 0);
      const desiredDelta = (finiteOr(targetHeight, before) - before) * DEFORMATION_BLEND * edgeFade;
      const boundedDelta = clamp(desiredDelta, -MAX_DEFORMATION_METERS, MAX_DEFORMATION_METERS);
      if (Math.abs(boundedDelta) < 1e-5) continue;
      hf.data[index] = before + boundedDelta;
      if (Math.abs((hf.data[index] ?? before) - before) >= 1e-5) {
        changedCells.push(index);
      }
    }
  }
  return changedCells;
}

function contactScore(
  support: FootprintSupport,
  contactPlaneY: number,
  watercraft: boolean,
): { score: number; maxGap: number } {
  const expected = watercraft
    ? support.heights.map((height) => Math.max(height, -0.25) + 0.1)
    : support.heights;
  const errors = expected.map((height) => Math.abs(contactPlaneY - height));
  const meanError = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const maxGap = Math.max(...errors);
  // 0.75 m is an intentionally explicit proxy-contact tolerance, not a claim
  // of exact mesh contact. Flat support still evaluates to exactly 1.
  const score = clamp(1 - meanError / 0.75 - support.spread / 3, 0, 1);
  return { score, maxGap };
}

export function refineScene(
  objects: PlacedObject[],
  hf: HeightField,
  _plan: ScenePlan,
  _seed: number,
  iterations = 2,
): { objects: PlacedObject[]; report: RefineReport } {
  const safeIterations = Math.trunc(clamp(finiteOr(iterations, 2), 1, 4));
  const current = objects.map((object) => ({
    ...object,
    position: [...object.position] as [number, number, number],
    rotation: [...object.rotation] as [number, number, number],
  }));
  const report: RefineReport = {
    objectsFixed: 0,
    floatingFixed: 0,
    penetrationFixed: 0,
    scaleFixed: 0,
    poseFixed: 0,
    iterations: safeIterations,
    supportSamples: 0,
    maxSupportSpread: 0,
    maxSupportGap: 0,
    terrainCellsDeformed: 0,
    terrainObjectsDeformed: 0,
  };
  const fixedObjects = new Set<string>();
  const floatingObjects = new Set<string>();
  const penetratingObjects = new Set<string>();
  const scaleObjects = new Set<string>();
  const poseObjects = new Set<string>();
  const deformedObjects = new Set<string>();
  const deformedCells = new Set<number>();

  for (let iter = 0; iter < safeIterations; iter++) {
    for (const object of current) {
      const half = Math.max(0, finiteOr(hf.worldSize, 1) * 0.5);
      const inset = Math.max(0, half - hf.worldSize / Math.max(2, hf.resolution));
      const originalX = object.position[0];
      const originalZ = object.position[2];
      object.position[0] = clamp(finiteOr(originalX, 0), -inset, inset);
      object.position[2] = clamp(finiteOr(originalZ, 0), -inset, inset);
      if (object.position[0] !== originalX || object.position[2] !== originalZ) {
        fixedObjects.add(object.id);
        poseObjects.add(object.id);
      }

      const originalScale = object.scale;
      object.scale = clamp(finiteOr(originalScale, 1), 0.4, 5.5);
      if (object.scale !== originalScale) {
        fixedObjects.add(object.id);
        scaleObjects.add(object.id);
      }

      for (let axis = 0; axis < 3; axis++) {
        object.rotation[axis] = finiteOr(object.rotation[axis], 0);
      }
      const isWatercraft = object.kind === "ship" || object.kind === "boat";
      const isBridge = object.kind === "bridge";
      const isStructure = STRUCTURE_KINDS.has(object.kind);
      if (isBridge) {
        if (object.rotation[0] !== 0 || object.rotation[2] !== 0) {
          object.rotation[0] = 0;
          object.rotation[2] = 0;
          fixedObjects.add(object.id);
          poseObjects.add(object.id);
        }
      } else if (isStructure) {
        if (Math.abs(object.rotation[0]) > 0.08 || Math.abs(object.rotation[2]) > 0.08) {
          object.rotation[0] = 0;
          object.rotation[2] = 0;
          fixedObjects.add(object.id);
          poseObjects.add(object.id);
        }
      } else if (!isWatercraft) {
        const normal = sampleNormal(hf, object.position[0], object.position[2]);
        object.rotation[0] = Math.atan2(normal[2], normal[1]) * 0.3;
        object.rotation[2] = -Math.atan2(normal[0], normal[1]) * 0.3;
      }

      const collider = worldColliderForObject(object);
      let support = sampleFootprintSupport(hf, collider);
      report.supportSamples += support.heights.length;
      report.maxSupportSpread = Math.max(report.maxSupportSpread, support.spread);

      if (iter === 0 && isStructure && support.spread > SUPPORT_VARIATION_THRESHOLD) {
        const changedCells = flattenStructureFootprint(hf, collider, support.median);
        if (changedCells.length > 0) {
          for (const index of changedCells) deformedCells.add(index);
          deformedObjects.add(object.id);
          support = sampleFootprintSupport(hf, collider);
          report.supportSamples += support.heights.length;
        }
      }

      const bridgeEndpointSupport = isBridge
        ? sampleBridgeEndpointSupport(hf, collider)
        : undefined;
      if (bridgeEndpointSupport) {
        report.supportSamples += bridgeEndpointSupport.heights.length;
      }
      const contactSupport = bridgeEndpointSupport ?? support;

      const colliderBaseOffset = collider.bottomY - finiteOr(object.position[1], 0);
      let contactPlane = contactSupport.max;
      if (isWatercraft) {
        contactPlane = Math.max(contactSupport.median, -0.25) + 0.1;
      } else if (object.kind === "dock") {
        contactPlane = contactSupport.max + 0.05;
      }
      const targetY = contactPlane - colliderBaseOffset;
      const originalY = object.position[1];
      const deltaY = finiteOr(originalY, targetY) - targetY;
      if (!Number.isFinite(originalY) || deltaY > 0.35) {
        floatingObjects.add(object.id);
        fixedObjects.add(object.id);
      } else if (deltaY < -0.45) {
        penetratingObjects.add(object.id);
        fixedObjects.add(object.id);
      }
      object.position[1] = targetY;

      const contact = contactScore(contactSupport, contactPlane, isWatercraft);
      object.contactScore = contact.score;
      object.refined = true;
      report.maxSupportGap = Math.max(report.maxSupportGap, contact.maxGap);
    }
  }

  report.objectsFixed = fixedObjects.size;
  report.floatingFixed = floatingObjects.size;
  report.penetrationFixed = penetratingObjects.size;
  report.scaleFixed = scaleObjects.size;
  report.poseFixed = poseObjects.size;
  report.terrainCellsDeformed = deformedCells.size;
  report.terrainObjectsDeformed = deformedObjects.size;
  return { objects: current, report };
}

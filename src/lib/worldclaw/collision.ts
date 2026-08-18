/**
 * Deterministic, allocation-light collision helpers for the walk controller and
 * terrain-contact pass. Three.js remains the renderer: detailed GLB geometry is
 * intentionally never used as a gameplay collider.
 */

import { browserAssetInstanceScale } from "./assets";
import type { ObjectKind, PlacedObject } from "./types";

const EPSILON = 1e-7;
const MIN_RADIUS = 0.05;
const MAX_RADIUS = 32;
const MAX_CENTER_OFFSET = 64;

export type WorldColliderSource = "browser-asset" | "primitive-fallback";

interface WorldColliderCommon {
  objectId: string;
  source: WorldColliderSource;
  centerX: number;
  centerY: number;
  centerZ: number;
  bottomY: number;
  topY: number;
}

export interface WorldCircleCollider extends WorldColliderCommon {
  shape: "circle";
  radius: number;
}

export interface WorldObbCollider extends WorldColliderCommon {
  shape: "obb";
  halfWidth: number;
  halfDepth: number;
  yaw: number;
}

export type WorldColliderProxy = WorldCircleCollider | WorldObbCollider;

export interface ResolveCircleMovementInput {
  start: [number, number];
  delta: [number, number];
  radius: number;
  colliders: readonly WorldColliderProxy[];
  /** Square world bounds, measured from the origin to one edge. */
  worldHalfExtent: number;
  maxSubsteps?: number;
  maxPushIterations?: number;
}

export interface ResolveCircleMovementResult {
  position: [number, number];
  radius: number;
  collidedIds: string[];
  /** Non-empty only when overlapping proxies/bounds leave no valid push-out. */
  unresolvedIds: string[];
  substeps: number;
  boundsClamped: boolean;
}

interface PrimitiveApproximation {
  shape: "box" | "circle";
  width?: number;
  depth?: number;
  radius?: number;
  height: number;
  centerY: number;
}

const DEFAULT_FALLBACK: PrimitiveApproximation = {
  shape: "circle",
  radius: 0.45,
  height: 1,
  centerY: 0.5,
};

/**
 * Conservative proxies matching the existing code-built primitive families.
 * Values are local primitive units and are scaled by PlacedObject.scale.
 */
const PRIMITIVE_APPROXIMATIONS: Partial<
  Record<ObjectKind, PrimitiveApproximation>
> = {
  hut: { shape: "circle", radius: 0.9, height: 1.55, centerY: 0.78 },
  house: { shape: "box", width: 1.5, depth: 1.2, height: 1.7, centerY: 0.85 },
  tower: { shape: "circle", radius: 0.58, height: 2.5, centerY: 1.25 },
  watchtower: { shape: "box", width: 1.2, depth: 1.2, height: 2.5, centerY: 1.25 },
  building: { shape: "box", width: 1.9, depth: 1.5, height: 2.05, centerY: 1.03 },
  bunker: { shape: "box", width: 1.9, depth: 1.5, height: 2.05, centerY: 1.03 },
  barn: { shape: "box", width: 2.3, depth: 1.5, height: 1.9, centerY: 0.95 },
  market: { shape: "box", width: 1.8, depth: 1.4, height: 1.4, centerY: 0.7 },
  pagoda: { shape: "box", width: 1.4, depth: 1.4, height: 2.1, centerY: 1.05 },
  torii: { shape: "box", width: 1.8, depth: 0.35, height: 2.2, centerY: 1.1 },
  dock: { shape: "box", width: 3.2, depth: 1.1, height: 0.35, centerY: 0.18 },
  bridge: { shape: "box", width: 4.2, depth: 1.2, height: 0.45, centerY: 0.23 },
  ship: { shape: "box", width: 3.2, depth: 1.2, height: 1.1, centerY: 0.55 },
  boat: { shape: "box", width: 2.2, depth: 0.9, height: 0.7, centerY: 0.35 },
  vehicle: { shape: "box", width: 1.8, depth: 1.1, height: 0.8, centerY: 0.4 },
  tank: { shape: "box", width: 2.1, depth: 1.4, height: 1.1, centerY: 0.55 },
  tree: { shape: "circle", radius: 0.3, height: 2.7, centerY: 1.35 },
  palm: { shape: "circle", radius: 0.3, height: 3, centerY: 1.5 },
  pine: { shape: "circle", radius: 0.34, height: 3.1, centerY: 1.55 },
  cactus: { shape: "circle", radius: 0.32, height: 2, centerY: 1 },
  rock: { shape: "circle", radius: 0.62, height: 1.2, centerY: 0.6 },
  boulder: { shape: "circle", radius: 0.8, height: 1.4, centerY: 0.7 },
  fence: { shape: "box", width: 2.1, depth: 0.25, height: 1, centerY: 0.5 },
  crate: { shape: "box", width: 1, depth: 1, height: 1, centerY: 0.5 },
  mine: { shape: "box", width: 1.7, depth: 1.2, height: 1.5, centerY: 0.75 },
  tent: { shape: "box", width: 1.6, depth: 1.3, height: 1.15, centerY: 0.58 },
  well: { shape: "circle", radius: 0.65, height: 0.9, centerY: 0.45 },
  windmill: { shape: "circle", radius: 0.65, height: 3, centerY: 1.5 },
  antenna: { shape: "circle", radius: 0.35, height: 3, centerY: 1.5 },
  satellite: { shape: "circle", radius: 0.55, height: 1.8, centerY: 0.9 },
  statue: { shape: "circle", radius: 0.55, height: 2.2, centerY: 1.1 },
  crystal: { shape: "circle", radius: 0.45, height: 1.5, centerY: 0.75 },
  campfire: { shape: "circle", radius: 0.5, height: 0.65, centerY: 0.33 },
  dragon: { shape: "circle", radius: 1.2, height: 2, centerY: 1 },
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeMagnitude(value: number, fallback: number, max: number): number {
  return clamp(Math.abs(finiteOr(value, fallback)), MIN_RADIUS, max);
}

function rotateLocalXZ(
  x: number,
  z: number,
  yaw: number,
): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * x + s * z, -s * x + c * z];
}

function inverseRotateWorldXZ(
  x: number,
  z: number,
  yaw: number,
): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * x - s * z, s * x + c * z];
}

/** Convert an authored or fallback object collider into a finite world proxy. */
export function worldColliderForObject(object: PlacedObject): WorldColliderProxy {
  const positionX = finiteOr(object.position[0], 0);
  const positionY = finiteOr(object.position[1], 0);
  const positionZ = finiteOr(object.position[2], 0);
  const yaw = finiteOr(object.rotation[1], 0);
  const authored = object.browserAsset?.collider;

  if (authored) {
    const scale = safeMagnitude(browserAssetInstanceScale(object), 1, 16);
    const localCenterX = clamp(
      finiteOr(authored.centerMeters[0], 0) * scale,
      -MAX_CENTER_OFFSET,
      MAX_CENTER_OFFSET,
    );
    const localCenterY = clamp(
      finiteOr(authored.centerMeters[1], 0) * scale,
      -MAX_CENTER_OFFSET,
      MAX_CENTER_OFFSET,
    );
    const localCenterZ = clamp(
      finiteOr(authored.centerMeters[2], 0) * scale,
      -MAX_CENTER_OFFSET,
      MAX_CENTER_OFFSET,
    );
    const [offsetX, offsetZ] = rotateLocalXZ(localCenterX, localCenterZ, yaw);
    const centerX = positionX + offsetX;
    const centerY = positionY + localCenterY;
    const centerZ = positionZ + offsetZ;

    if (authored.type === "box") {
      const halfWidth = safeMagnitude(authored.sizeMeters[0] * scale * 0.5, 0.5, MAX_RADIUS);
      const halfHeight = safeMagnitude(authored.sizeMeters[1] * scale * 0.5, 0.5, MAX_RADIUS);
      const halfDepth = safeMagnitude(authored.sizeMeters[2] * scale * 0.5, 0.5, MAX_RADIUS);
      return {
        objectId: object.id,
        source: "browser-asset",
        shape: "obb",
        centerX,
        centerY,
        centerZ,
        bottomY: centerY - halfHeight,
        topY: centerY + halfHeight,
        halfWidth,
        halfDepth,
        yaw,
      };
    }

    const radius = safeMagnitude(authored.radiusMeters * scale, 0.5, MAX_RADIUS);
    const halfHeight =
      authored.type === "capsule"
        ? safeMagnitude(authored.heightMeters * scale * 0.5, radius, MAX_RADIUS)
        : radius;
    return {
      objectId: object.id,
      source: "browser-asset",
      shape: "circle",
      centerX,
      centerY,
      centerZ,
      bottomY: centerY - halfHeight,
      topY: centerY + halfHeight,
      radius,
    };
  }

  const approximation = PRIMITIVE_APPROXIMATIONS[object.kind] ?? DEFAULT_FALLBACK;
  const scale = safeMagnitude(object.scale, 1, 16);
  const centerY = positionY + approximation.centerY * scale;
  const halfHeight = safeMagnitude(approximation.height * scale * 0.5, 0.5, MAX_RADIUS);
  if (approximation.shape === "box") {
    return {
      objectId: object.id,
      source: "primitive-fallback",
      shape: "obb",
      centerX: positionX,
      centerY,
      centerZ: positionZ,
      bottomY: centerY - halfHeight,
      topY: centerY + halfHeight,
      halfWidth: safeMagnitude((approximation.width ?? 1) * scale * 0.5, 0.5, MAX_RADIUS),
      halfDepth: safeMagnitude((approximation.depth ?? 1) * scale * 0.5, 0.5, MAX_RADIUS),
      yaw,
    };
  }
  return {
    objectId: object.id,
    source: "primitive-fallback",
    shape: "circle",
    centerX: positionX,
    centerY,
    centerZ: positionZ,
    bottomY: centerY - halfHeight,
    topY: centerY + halfHeight,
    radius: safeMagnitude((approximation.radius ?? 0.45) * scale, 0.45, MAX_RADIUS),
  };
}

/** Center + perimeter/edge samples covering the collider's ground footprint. */
export function colliderSupportPointsXZ(
  collider: WorldColliderProxy,
): [number, number][] {
  const points: [number, number][] = [[collider.centerX, collider.centerZ]];
  if (collider.shape === "circle") {
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      points.push([
        collider.centerX + Math.cos(angle) * collider.radius,
        collider.centerZ + Math.sin(angle) * collider.radius,
      ]);
    }
    return points;
  }

  for (const localZ of [-collider.halfDepth, 0, collider.halfDepth]) {
    for (const localX of [-collider.halfWidth, 0, collider.halfWidth]) {
      if (localX === 0 && localZ === 0) continue;
      const [offsetX, offsetZ] = rotateLocalXZ(localX, localZ, collider.yaw);
      points.push([collider.centerX + offsetX, collider.centerZ + offsetZ]);
    }
  }
  return points;
}

/** <= 1 is within a primitive's XZ footprint; values are dimensionless. */
export function normalizedFootprintDistanceXZ(
  collider: WorldColliderProxy,
  x: number,
  z: number,
): number {
  const dx = finiteOr(x, collider.centerX) - collider.centerX;
  const dz = finiteOr(z, collider.centerZ) - collider.centerZ;
  if (collider.shape === "circle") {
    return Math.hypot(dx, dz) / collider.radius;
  }
  const [localX, localZ] = inverseRotateWorldXZ(dx, dz, collider.yaw);
  return Math.max(
    Math.abs(localX) / collider.halfWidth,
    Math.abs(localZ) / collider.halfDepth,
  );
}

export function circleIntersectsColliderXZ(
  position: readonly [number, number],
  radius: number,
  collider: WorldColliderProxy,
): boolean {
  const x = finiteOr(position[0], 0);
  const z = finiteOr(position[1], 0);
  const safeRadius = safeMagnitude(radius, 0.45, 4);
  const dx = x - collider.centerX;
  const dz = z - collider.centerZ;
  if (collider.shape === "circle") {
    const combined = safeRadius + collider.radius;
    return dx * dx + dz * dz < combined * combined - EPSILON;
  }
  const [localX, localZ] = inverseRotateWorldXZ(dx, dz, collider.yaw);
  return (
    Math.abs(localX) < collider.halfWidth + safeRadius - EPSILON &&
    Math.abs(localZ) < collider.halfDepth + safeRadius - EPSILON
  );
}

function pushCircleOut(
  position: [number, number],
  radius: number,
  collider: WorldColliderProxy,
  incoming: [number, number],
): boolean {
  const dx = position[0] - collider.centerX;
  const dz = position[1] - collider.centerZ;
  if (collider.shape === "circle") {
    const combined = radius + collider.radius;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared >= combined * combined - EPSILON) return false;
    const distance = Math.sqrt(Math.max(0, distanceSquared));
    let normalX: number;
    let normalZ: number;
    if (distance > EPSILON) {
      normalX = dx / distance;
      normalZ = dz / distance;
    } else {
      const incomingLength = Math.hypot(incoming[0], incoming[1]);
      normalX = incomingLength > EPSILON ? -incoming[0] / incomingLength : 1;
      normalZ = incomingLength > EPSILON ? -incoming[1] / incomingLength : 0;
    }
    position[0] = collider.centerX + normalX * combined;
    position[1] = collider.centerZ + normalZ * combined;
    return true;
  }

  const [localX, localZ] = inverseRotateWorldXZ(dx, dz, collider.yaw);
  const expandedX = collider.halfWidth + radius;
  const expandedZ = collider.halfDepth + radius;
  if (
    Math.abs(localX) >= expandedX - EPSILON ||
    Math.abs(localZ) >= expandedZ - EPSILON
  ) {
    return false;
  }

  const [incomingX, incomingZ] = inverseRotateWorldXZ(
    incoming[0],
    incoming[1],
    collider.yaw,
  );
  const distanceToXFace = expandedX - Math.abs(localX);
  const distanceToZFace = expandedZ - Math.abs(localZ);
  let pushedX = localX;
  let pushedZ = localZ;
  if (distanceToXFace <= distanceToZFace) {
    const sign = Math.abs(localX) > EPSILON ? Math.sign(localX) : incomingX > 0 ? -1 : 1;
    pushedX = sign * expandedX;
  } else {
    const sign = Math.abs(localZ) > EPSILON ? Math.sign(localZ) : incomingZ > 0 ? -1 : 1;
    pushedZ = sign * expandedZ;
  }
  const [worldX, worldZ] = rotateLocalXZ(pushedX, pushedZ, collider.yaw);
  position[0] = collider.centerX + worldX;
  position[1] = collider.centerZ + worldZ;
  return true;
}

/**
 * Resolve an on-foot circular XZ controller with bounded substeps and
 * deterministic push-out. Projecting to the nearest expanded primitive face
 * preserves the tangential component, producing stable arcade-style sliding.
 */
export function resolveCircleMovementXZ(
  input: ResolveCircleMovementInput,
): ResolveCircleMovementResult {
  const radius = safeMagnitude(input.radius, 0.45, 4);
  const halfExtent = clamp(
    Math.abs(finiteOr(input.worldHalfExtent, 100)),
    radius + 0.1,
    10_000,
  );
  const limit = halfExtent - radius;
  const position: [number, number] = [
    clamp(finiteOr(input.start[0], 0), -limit, limit),
    clamp(finiteOr(input.start[1], 0), -limit, limit),
  ];
  let boundsClamped =
    position[0] !== input.start[0] || position[1] !== input.start[1];
  const delta: [number, number] = [
    clamp(finiteOr(input.delta[0], 0), -halfExtent * 2, halfExtent * 2),
    clamp(finiteOr(input.delta[1], 0), -halfExtent * 2, halfExtent * 2),
  ];
  const movementLength = Math.hypot(delta[0], delta[1]);
  const maxSubsteps = Math.round(clamp(finiteOr(input.maxSubsteps ?? 128, 128), 1, 512));
  const desiredStepLength = Math.max(0.1, radius * 0.5);
  const substeps = Math.max(
    1,
    Math.min(maxSubsteps, Math.ceil(movementLength / desiredStepLength)),
  );
  const step: [number, number] = [delta[0] / substeps, delta[1] / substeps];
  const pushIterations = Math.round(
    clamp(finiteOr(input.maxPushIterations ?? 6, 6), 1, 16),
  );
  const collided = new Set<string>();

  // Repair an injected spawn before applying the intended movement.
  for (let iteration = 0; iteration < pushIterations; iteration++) {
    let changed = false;
    for (const collider of input.colliders) {
      if (pushCircleOut(position, radius, collider, [0, 0])) {
        collided.add(collider.objectId);
        changed = true;
      }
    }
    const clampedX = clamp(position[0], -limit, limit);
    const clampedZ = clamp(position[1], -limit, limit);
    boundsClamped ||= clampedX !== position[0] || clampedZ !== position[1];
    position[0] = clampedX;
    position[1] = clampedZ;
    if (!changed) break;
  }

  for (let substep = 0; substep < substeps; substep++) {
    position[0] += step[0];
    position[1] += step[1];
    for (let iteration = 0; iteration < pushIterations; iteration++) {
      let changed = false;
      for (const collider of input.colliders) {
        if (pushCircleOut(position, radius, collider, step)) {
          collided.add(collider.objectId);
          changed = true;
        }
      }
      const clampedX = clamp(position[0], -limit, limit);
      const clampedZ = clamp(position[1], -limit, limit);
      boundsClamped ||= clampedX !== position[0] || clampedZ !== position[1];
      position[0] = clampedX;
      position[1] = clampedZ;
      if (!changed) break;
    }
  }

  return {
    position,
    radius,
    collidedIds: [...collided].sort(),
    unresolvedIds: input.colliders
      .filter((collider) =>
        circleIntersectsColliderXZ(position, radius, collider),
      )
      .map((collider) => collider.objectId)
      .sort(),
    substeps,
    boundsClamped,
  };
}

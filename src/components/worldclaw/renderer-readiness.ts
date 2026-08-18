export const WORLDCLAW_RENDERER_READY_TIMEOUT_MS = 90_000;

export const LIVE_DEPTH_MINIMUM_LUMINANCE = 0.08;
export const LIVE_DEPTH_LUMINANCE_RANGE = 0.9;
// Compiled GLB geometries do not guarantee a per-vertex `color` attribute.
// Three enables USE_INSTANCING_COLOR from InstancedMesh.instanceColor itself;
// enabling material vertex colors as well would multiply by a missing/black
// geometry color attribute and erase every categorical instance color.
export const LIVE_COMPILED_INSTANCE_MATERIAL_VERTEX_COLORS = false;
const LIVE_MAP_CONTENT_FILL = 0.9;

export type LiveDiagnosticColor = readonly [number, number, number];

function hueToRgb(p: number, q: number, value: number): number {
  let hue = value;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

/**
 * Stable numeric HSL conversion for the live instance diagnostic. Three's
 * Color parser does not accept the space-separated CSS Color 4 HSL strings
 * used by the older mesh components, so relying on string parsing turns every
 * logical object white in current Three releases.
 */
export function stableLiveInstanceColor(logicalId: string): LiveDiagnosticColor {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < logicalId.length; index++) {
    hash ^= logicalId.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb_352d);
  hash ^= hash >>> 15;
  const hue = (hash >>> 0) / 0x1_0000_0000;
  const saturation = 0.72;
  const lightness = 0.56;
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueToRgb(p, q, hue + 1 / 3), hueToRgb(p, q, hue), hueToRgb(p, q, hue - 1 / 3)];
}

/** Linear, bounded grayscale used by the live depth material. */
export function liveDepthLuminance(
  distanceMeters: number,
  nearMeters: number,
  farMeters: number,
): number {
  const safeNear = Number.isFinite(nearMeters) ? nearMeters : 0;
  const safeFar = Number.isFinite(farMeters) ? Math.max(safeNear + 1e-6, farMeters) : safeNear + 1;
  const safeDistance = Number.isFinite(distanceMeters) ? distanceMeters : safeFar;
  const normalized = Math.max(0, Math.min(1, (safeDistance - safeNear) / (safeFar - safeNear)));
  return LIVE_DEPTH_MINIMUM_LUMINANCE + (1 - normalized) * LIVE_DEPTH_LUMINANCE_RANGE;
}

export interface LiveMapContentEnvelope {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumZ: number;
  readonly maximumZ: number;
}

export interface LiveMapFraming {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfHorizontal: number;
  readonly halfVertical: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly minimumVisibleX: number;
  readonly maximumVisibleX: number;
  readonly minimumVisibleZ: number;
  readonly maximumVisibleZ: number;
  readonly majorAxisFill: number;
}

/** Fit an overhead camera to finite rendered content, independent of world size. */
export function fitLiveMapFraming(
  envelope: LiveMapContentEnvelope,
  viewportAspect: number,
  contentFill = LIVE_MAP_CONTENT_FILL,
): LiveMapFraming {
  const coordinates = [envelope.minimumX, envelope.maximumX, envelope.minimumZ, envelope.maximumZ];
  if (
    !coordinates.every(Number.isFinite) ||
    envelope.maximumX < envelope.minimumX ||
    envelope.maximumZ < envelope.minimumZ
  ) {
    throw new Error("Live map content envelope must be finite and ordered");
  }
  if (!Number.isFinite(viewportAspect) || viewportAspect <= 0) {
    throw new Error("Live map viewport aspect must be positive and finite");
  }
  if (!Number.isFinite(contentFill) || contentFill <= 0 || contentFill > 1) {
    throw new Error("Live map content fill must be in the interval (0, 1]");
  }

  const centerX = (envelope.minimumX + envelope.maximumX) * 0.5;
  const centerZ = (envelope.minimumZ + envelope.maximumZ) * 0.5;
  const contentWidth = Math.max(0.1, envelope.maximumX - envelope.minimumX);
  const contentHeight = Math.max(0.1, envelope.maximumZ - envelope.minimumZ);
  const paddingRatio = 1 / contentFill;
  const halfVertical =
    Math.max(contentHeight * 0.5, (contentWidth * 0.5) / viewportAspect) * paddingRatio;
  const halfHorizontal = halfVertical * viewportAspect;
  return {
    centerX,
    centerZ,
    halfHorizontal,
    halfVertical,
    left: -halfHorizontal,
    right: halfHorizontal,
    top: halfVertical,
    bottom: -halfVertical,
    minimumVisibleX: centerX - halfHorizontal,
    maximumVisibleX: centerX + halfHorizontal,
    minimumVisibleZ: centerZ - halfVertical,
    maximumVisibleZ: centerZ + halfVertical,
    majorAxisFill: Math.max(
      contentWidth / (halfHorizontal * 2),
      contentHeight / (halfVertical * 2),
    ),
  };
}

export interface LiveWalkHeadingObstacle {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
}

export interface LiveWalkHeadingOptions {
  readonly preferredYaw?: number;
  readonly maximumSightlineMeters?: number;
  readonly clearanceRadiusMeters?: number;
  readonly worldHalfExtent?: number;
  readonly headingCount?: number;
}

export interface LiveWalkHeading {
  readonly yaw: number;
  readonly clearanceMeters: number;
}

export interface LiveWalkSpawnSafety {
  readonly unresolvedColliderCount: number;
  readonly dryGroundAccepted: boolean;
  readonly minimumColliderClearanceMeters: number;
  readonly forwardClearanceMeters: number;
}

export interface LiveWalkSpawnRequirements {
  readonly minimumColliderClearanceMeters: number;
  readonly minimumForwardSightlineMeters: number;
}

/** Prevent a push-out result from being mislabeled as a safe live spawn. */
export function isLiveWalkSpawnSafe(
  safety: LiveWalkSpawnSafety,
  requirements: LiveWalkSpawnRequirements,
): boolean {
  return (
    safety.unresolvedColliderCount === 0 &&
    safety.dryGroundAccepted &&
    Number.isFinite(safety.minimumColliderClearanceMeters) &&
    safety.minimumColliderClearanceMeters >= requirements.minimumColliderClearanceMeters &&
    Number.isFinite(safety.forwardClearanceMeters) &&
    safety.forwardClearanceMeters >= requirements.minimumForwardSightlineMeters
  );
}

function liveWalkHeadingClearance(
  position: readonly [number, number],
  yaw: number,
  obstacles: readonly LiveWalkHeadingObstacle[],
  maximumSightlineMeters: number,
  clearanceRadiusMeters: number,
  worldHalfExtent: number | undefined,
): number {
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  let clearance = maximumSightlineMeters;

  if (worldHalfExtent !== undefined && Number.isFinite(worldHalfExtent) && worldHalfExtent > 0) {
    const boundaryDistances = [
      forwardX > 1e-9 ? (worldHalfExtent - position[0]) / forwardX : Number.POSITIVE_INFINITY,
      forwardX < -1e-9 ? (-worldHalfExtent - position[0]) / forwardX : Number.POSITIVE_INFINITY,
      forwardZ > 1e-9 ? (worldHalfExtent - position[1]) / forwardZ : Number.POSITIVE_INFINITY,
      forwardZ < -1e-9 ? (-worldHalfExtent - position[1]) / forwardZ : Number.POSITIVE_INFINITY,
    ].filter((distance) => distance >= 0);
    clearance = Math.min(clearance, ...boundaryDistances);
  }

  for (const obstacle of obstacles) {
    const effectiveRadius = Math.max(0, obstacle.radius) + clearanceRadiusMeters;
    const relativeX = obstacle.centerX - position[0];
    const relativeZ = obstacle.centerZ - position[1];
    const centerDistanceSquared = relativeX * relativeX + relativeZ * relativeZ;
    if (centerDistanceSquared <= effectiveRadius * effectiveRadius) return 0;
    const projected = relativeX * forwardX + relativeZ * forwardZ;
    if (projected <= 0 || projected > clearance + effectiveRadius) continue;
    const lateralSquared = centerDistanceSquared - projected * projected;
    if (lateralSquared > effectiveRadius * effectiveRadius) continue;
    const entryDistance = projected - Math.sqrt(effectiveRadius * effectiveRadius - lateralSquared);
    clearance = Math.min(clearance, Math.max(0, entryDistance));
  }
  return Math.max(0, Math.min(maximumSightlineMeters, clearance));
}

/** Select a deterministic clear heading while preserving yaw zero in open space. */
export function selectLiveWalkHeading(
  position: readonly [number, number],
  obstacles: readonly LiveWalkHeadingObstacle[],
  options: LiveWalkHeadingOptions = {},
): LiveWalkHeading {
  const preferredYaw = options.preferredYaw ?? 0;
  const maximumSightlineMeters = Math.max(0.1, options.maximumSightlineMeters ?? 9);
  const clearanceRadiusMeters = Math.max(0, options.clearanceRadiusMeters ?? 0.45);
  const headingCount = Math.max(4, Math.floor(options.headingCount ?? 32));
  let best: LiveWalkHeading = {
    yaw: preferredYaw,
    clearanceMeters: liveWalkHeadingClearance(
      position,
      preferredYaw,
      obstacles,
      maximumSightlineMeters,
      clearanceRadiusMeters,
      options.worldHalfExtent,
    ),
  };

  for (let offset = 1; offset < headingCount; offset++) {
    const alternatingOffset = Math.ceil(offset / 2) * (offset % 2 === 1 ? 1 : -1);
    const yaw = preferredYaw + (alternatingOffset * Math.PI * 2) / headingCount;
    const clearanceMeters = liveWalkHeadingClearance(
      position,
      yaw,
      obstacles,
      maximumSightlineMeters,
      clearanceRadiusMeters,
      options.worldHalfExtent,
    );
    if (clearanceMeters > best.clearanceMeters + 1e-9) {
      best = { yaw, clearanceMeters };
    }
  }
  return best;
}

export interface WorldClawRendererReadiness {
  readonly worldId: string;
  readonly ready: Promise<void>;
}

interface RendererReadinessTarget {
  __WORLDCLAW_RENDERER_READINESS__?: WorldClawRendererReadiness;
}

export function registerRendererReadiness(
  target: RendererReadinessTarget,
  readiness: WorldClawRendererReadiness,
): () => void {
  target.__WORLDCLAW_RENDERER_READINESS__ = readiness;
  return () => {
    if (target.__WORLDCLAW_RENDERER_READINESS__ === readiness) {
      delete target.__WORLDCLAW_RENDERER_READINESS__;
    }
  };
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(() => finish(), delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function waitForReadyPromise(
  ready: Promise<void>,
  remainingMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(
      () =>
        finish(new Error("Renderer readiness timed out before compiled GLB batches were ready")),
      remainingMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    ready.then(() => finish(), finish);
    if (signal.aborted) abort();
  });
}

export async function waitForRendererReadiness(
  target: RendererReadinessTarget,
  expectedWorldId: string,
  signal: AbortSignal,
  timeoutMs = WORLDCLAW_RENDERER_READY_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Renderer readiness timeout must be a positive finite number");
  }

  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const readiness = target.__WORLDCLAW_RENDERER_READINESS__;
    if (readiness?.worldId === expectedWorldId) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await waitForReadyPromise(readiness.ready, remaining, signal);
      signal.throwIfAborted();
      return;
    }
    const remaining = deadline - performance.now();
    await waitForDelay(Math.min(100, Math.max(0, remaining)), signal);
  }
  throw new Error(
    `Renderer readiness timed out before compiled GLB batches were ready for ${expectedWorldId}`,
  );
}

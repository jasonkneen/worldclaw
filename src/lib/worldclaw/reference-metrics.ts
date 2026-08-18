/**
 * Deterministic, dependency-free raster metrics for WorldClaw reference gates.
 *
 * Raster orientation follows browser image data: x increases left-to-right and
 * y increases top-to-bottom. Binary metrics treat every finite non-zero sample
 * as foreground. Callers should compare like-for-like semantic passes rather
 * than beauty renders.
 */

export const MAX_REFERENCE_RASTER_PIXELS = 16_777_216;

export interface RasterLike {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export interface MaskOverlap {
  readonly referenceForeground: number;
  readonly candidateForeground: number;
  readonly intersection: number;
  readonly union: number;
  readonly iou: number;
}

export interface ReferenceInteriorLeakageResult {
  readonly boundaryTolerancePixels: number;
  readonly maximumBoundaryTolerancePixels: number;
  readonly referenceRegionPixels: number;
  readonly rawLeakagePixels: number;
  readonly rawLeakageRatio: number | null;
  readonly excludedBoundaryPixels: number;
  readonly excludedBoundaryLeakagePixels: number;
  readonly referenceInteriorPixels: number;
  readonly interiorLeakagePixels: number;
  readonly interiorLeakageRatio: number | null;
}

export interface BinaryBoundaryMask extends RasterLike {
  readonly data: Uint8Array;
}

export interface BoundaryF1Result {
  readonly tolerancePixels: number;
  readonly referenceBoundaryPixels: number;
  readonly candidateBoundaryPixels: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface BidirectionalBoundaryDistance {
  readonly percentile: 0.95;
  readonly referenceToCandidateP95: number;
  readonly candidateToReferenceP95: number;
  /** Symmetric percentile Hausdorff distance: max of both directions. */
  readonly bidirectionalP95: number;
}

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export interface PixelBoundingBox extends PixelPoint {
  readonly width: number;
  readonly height: number;
}

export interface MaskGeometry {
  readonly foregroundPixels: number;
  readonly centroid: PixelPoint | null;
  readonly bbox: PixelBoundingBox | null;
}

export interface MaskGeometryDrift {
  readonly reference: MaskGeometry;
  readonly candidate: MaskGeometry;
  readonly centroidDxPixels: number | null;
  readonly centroidDyPixels: number | null;
  readonly centroidDistancePixels: number | null;
  readonly centroidDistanceRatio: number | null;
  readonly bboxCenterDxPixels: number | null;
  readonly bboxCenterDyPixels: number | null;
  readonly bboxCenterDistancePixels: number | null;
  readonly bboxWidthDriftPixels: number | null;
  readonly bboxHeightDriftPixels: number | null;
  readonly bboxWidthDriftRatio: number | null;
  readonly bboxHeightDriftRatio: number | null;
}

/** `flipX` reverses left/right; `flipY` reverses top/bottom. */
export type MaskTransform = "identity" | "flipX" | "flipY" | "rotate180";

export interface MaskTransformComparison {
  readonly minimumSuspiciousImprovement: number;
  readonly scores: Readonly<Record<MaskTransform, number>>;
  readonly bestTransform: MaskTransform;
  readonly bestAlternateTransform: Exclude<MaskTransform, "identity">;
  readonly alternateImprovement: number;
  readonly suspicious: boolean;
  readonly suspicionKind: "reflection" | "rotation" | null;
}

export interface ConnectedComponentOptions {
  /** Minimum component area divided by full raster area; default 0. */
  readonly minAreaRatio?: number;
  readonly connectivity?: 4 | 8;
}

export interface ConnectedComponentAnalysis {
  readonly connectivity: 4 | 8;
  readonly minAreaRatio: number;
  readonly minAreaPixels: number;
  readonly totalComponentCount: number;
  readonly keptComponentCount: number;
  readonly ignoredComponentCount: number;
  readonly keptAreas: readonly number[];
  readonly ignoredAreas: readonly number[];
}

export interface RgbIdRaster {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly data: ArrayLike<number>;
}

export interface StableHeroInstance {
  readonly heroKey: string;
  /** Packed 0xRRGGBB stable instance id; 0 is background by default. */
  readonly rgbId: number;
}

export interface HeroPixelCoverageOptions {
  readonly minPixelsPerInstance?: number;
  readonly backgroundRgbId?: number;
}

export interface HeroInstancePixelCoverage extends StableHeroInstance {
  readonly pixelCount: number;
  readonly visible: boolean;
}

export interface HeroGroupPixelCoverage {
  readonly heroKey: string;
  readonly expectedCount: number;
  readonly actualCount: number;
  readonly visibleCount: number;
  readonly exactCountPassed: boolean;
  readonly visibilityPassed: boolean;
  readonly passed: boolean;
  readonly instances: readonly HeroInstancePixelCoverage[];
}

export interface HeroPixelCoverageReport {
  readonly minPixelsPerInstance: number;
  readonly backgroundRgbId: number;
  readonly totalExpectedCount: number;
  readonly totalActualCount: number;
  readonly totalVisibleCount: number;
  readonly duplicateStableIds: readonly number[];
  readonly groups: readonly HeroGroupPixelCoverage[];
  readonly passed: boolean;
}

export interface MaterialFamilyF1Options {
  /** Labels excluded from the macro average; background label 0 by default. */
  readonly ignoreLabels?: readonly number[];
}

export interface MaterialFamilyF1 {
  readonly label: number;
  readonly referencePixels: number;
  readonly candidatePixels: number;
  readonly truePositivePixels: number;
  readonly falsePositivePixels: number;
  readonly falseNegativePixels: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface MaterialFamilyMacroF1Result {
  readonly ignoredLabels: readonly number[];
  readonly evaluatedReferencePixels: number;
  readonly evaluatedCandidatePixels: number;
  readonly families: readonly MaterialFamilyF1[];
  /** Arithmetic mean across the union of non-ignored reference/candidate labels. */
  readonly macroF1: number;
}

/** Validate positive integer dimensions, bounded area, and exact buffer size. */
export function validateRasterDimensions(raster: RasterLike, label = "raster"): number {
  const { width, height, data } = raster;
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError(`${label}.width must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError(`${label}.height must be a positive safe integer`);
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_REFERENCE_RASTER_PIXELS) {
    throw new RangeError(
      `${label} exceeds the ${MAX_REFERENCE_RASTER_PIXELS}-pixel validation budget`,
    );
  }
  if (!data || !Number.isSafeInteger(data.length) || data.length !== pixelCount) {
    throw new RangeError(`${label}.data length must equal width * height (${pixelCount})`);
  }
  return pixelCount;
}

/** Validate that two single-channel rasters have exactly matching dimensions. */
export function validateComparableRasters(reference: RasterLike, candidate: RasterLike): number {
  const pixelCount = validateRasterDimensions(reference, "reference");
  validateRasterDimensions(candidate, "candidate");
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new RangeError("reference and candidate dimensions must match exactly");
  }
  return pixelCount;
}

function isForeground(value: number | undefined): boolean {
  return Number.isFinite(value) && value !== 0;
}

/** Return overlap counts and intersection-over-union for two binary masks. */
export function measureMaskOverlap(reference: RasterLike, candidate: RasterLike): MaskOverlap {
  const pixelCount = validateComparableRasters(reference, candidate);
  let referenceForeground = 0;
  let candidateForeground = 0;
  let intersection = 0;

  for (let index = 0; index < pixelCount; index++) {
    const inReference = isForeground(reference.data[index]);
    const inCandidate = isForeground(candidate.data[index]);
    if (inReference) referenceForeground++;
    if (inCandidate) candidateForeground++;
    if (inReference && inCandidate) intersection++;
  }

  const union = referenceForeground + candidateForeground - intersection;
  return {
    referenceForeground,
    candidateForeground,
    intersection,
    union,
    iou: union === 0 ? 1 : intersection / union,
  };
}

export function maskIoU(reference: RasterLike, candidate: RasterLike): number {
  return measureMaskOverlap(reference, candidate).iou;
}

function transformedSourceIndex(
  x: number,
  y: number,
  width: number,
  height: number,
  transform: MaskTransform,
): number {
  const sourceX = transform === "flipX" || transform === "rotate180" ? width - x - 1 : x;
  const sourceY = transform === "flipY" || transform === "rotate180" ? height - y - 1 : y;
  return sourceY * width + sourceX;
}

function transformedMaskIoU(
  reference: RasterLike,
  candidate: RasterLike,
  transform: MaskTransform,
): number {
  const pixelCount = reference.width * reference.height;
  let referenceForeground = 0;
  let candidateForeground = 0;
  let intersection = 0;
  for (let index = 0; index < pixelCount; index++) {
    const x = index % reference.width;
    const y = Math.floor(index / reference.width);
    const inReference = isForeground(reference.data[index]);
    const inCandidate = isForeground(
      candidate.data[transformedSourceIndex(x, y, reference.width, reference.height, transform)],
    );
    if (inReference) referenceForeground++;
    if (inCandidate) candidateForeground++;
    if (inReference && inCandidate) intersection++;
  }
  const union = referenceForeground + candidateForeground - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Compare identity against left/right, top/bottom, and 180-degree alternatives.
 * An alternate is suspicious when it improves IoU by at least 0.02 by default.
 */
export function compareMaskTransforms(
  reference: RasterLike,
  candidate: RasterLike,
  minimumSuspiciousImprovement = 0.02,
): MaskTransformComparison {
  validateComparableRasters(reference, candidate);
  if (
    !Number.isFinite(minimumSuspiciousImprovement) ||
    minimumSuspiciousImprovement < 0 ||
    minimumSuspiciousImprovement > 1
  ) {
    throw new RangeError("minimumSuspiciousImprovement must be between 0 and 1");
  }
  const transforms: readonly MaskTransform[] = ["identity", "flipX", "flipY", "rotate180"];
  const scores = {} as Record<MaskTransform, number>;
  let bestTransform: MaskTransform = "identity";
  for (const transform of transforms) {
    const score = transformedMaskIoU(reference, candidate, transform);
    scores[transform] = score;
    if (score > (scores[bestTransform] ?? Number.NEGATIVE_INFINITY)) {
      bestTransform = transform;
    }
  }

  const alternates: readonly Exclude<MaskTransform, "identity">[] = ["flipX", "flipY", "rotate180"];
  let bestAlternateTransform: Exclude<MaskTransform, "identity"> = "flipX";
  for (const transform of alternates.slice(1)) {
    if (scores[transform] > scores[bestAlternateTransform]) {
      bestAlternateTransform = transform;
    }
  }
  const alternateImprovement = scores[bestAlternateTransform] - scores.identity;
  const suspicious = alternateImprovement + Number.EPSILON >= minimumSuspiciousImprovement;
  return {
    minimumSuspiciousImprovement,
    scores,
    bestTransform,
    bestAlternateTransform,
    alternateImprovement,
    suspicious,
    suspicionKind: suspicious
      ? bestAlternateTransform === "rotate180"
        ? "rotation"
        : "reflection"
      : null,
  };
}

/** Count foreground components, optionally ignoring small image-area specks. */
export function analyzeConnectedComponents(
  mask: RasterLike,
  options: ConnectedComponentOptions = {},
): ConnectedComponentAnalysis {
  const pixelCount = validateRasterDimensions(mask, "mask");
  const minAreaRatio = options.minAreaRatio ?? 0;
  const connectivity = options.connectivity ?? 4;
  if (!Number.isFinite(minAreaRatio) || minAreaRatio < 0 || minAreaRatio > 1) {
    throw new RangeError("minAreaRatio must be between 0 and 1");
  }
  if (connectivity !== 4 && connectivity !== 8) {
    throw new RangeError("connectivity must be 4 or 8");
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const keptAreas: number[] = [];
  const ignoredAreas: number[] = [];
  const minAreaPixels = minAreaRatio * pixelCount;
  const { width, height } = mask;

  for (let start = 0; start < pixelCount; start++) {
    if (visited[start] !== 0 || !isForeground(mask.data[start])) continue;
    let head = 0;
    let tail = 1;
    let area = 0;
    queue[0] = start;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head++]!;
      area++;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          if (offsetX === 0 && offsetY === 0) continue;
          if (connectivity === 4 && Math.abs(offsetX) + Math.abs(offsetY) !== 1) {
            continue;
          }
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
            continue;
          }
          const neighbor = neighborY * width + neighborX;
          if (visited[neighbor] !== 0 || !isForeground(mask.data[neighbor])) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }

    if (area >= minAreaPixels) keptAreas.push(area);
    else ignoredAreas.push(area);
  }

  return {
    connectivity,
    minAreaRatio,
    minAreaPixels,
    totalComponentCount: keptAreas.length + ignoredAreas.length,
    keptComponentCount: keptAreas.length,
    ignoredComponentCount: ignoredAreas.length,
    keptAreas,
    ignoredAreas,
  };
}

export function countConnectedComponents(
  mask: RasterLike,
  options: ConnectedComponentOptions = {},
): number {
  return analyzeConnectedComponents(mask, options).keptComponentCount;
}

function validateRgb24Id(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff_ff_ff) {
    throw new RangeError(`${label} must be an integer from 0x000000 through 0xFFFFFF`);
  }
  return value;
}

function validateRgbByte(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0 || (value ?? 256) > 255) {
    throw new RangeError(`${label} must be an integer from 0 through 255`);
  }
  return value!;
}

export function encodeRgb24Id(red: number, green: number, blue: number): number {
  return (
    validateRgbByte(red, "red") * 65_536 +
    validateRgbByte(green, "green") * 256 +
    validateRgbByte(blue, "blue")
  );
}

export function decodeRgb24Id(rgbId: number): readonly [number, number, number] {
  validateRgb24Id(rgbId, "rgbId");
  return [(rgbId >>> 16) & 0xff, (rgbId >>> 8) & 0xff, rgbId & 0xff];
}

export function validateRgbIdRaster(raster: RgbIdRaster): number {
  if (raster.channels !== 3 && raster.channels !== 4) {
    throw new RangeError("RGB id raster channels must be 3 or 4");
  }
  if (!Number.isSafeInteger(raster.width) || raster.width <= 0) {
    throw new RangeError("RGB id raster width must be a positive safe integer");
  }
  if (!Number.isSafeInteger(raster.height) || raster.height <= 0) {
    throw new RangeError("RGB id raster height must be a positive safe integer");
  }
  const pixelCount = raster.width * raster.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_REFERENCE_RASTER_PIXELS) {
    throw new RangeError(
      `RGB id raster exceeds the ${MAX_REFERENCE_RASTER_PIXELS}-pixel validation budget`,
    );
  }
  const expectedLength = pixelCount * raster.channels;
  if (raster.data.length !== expectedLength) {
    throw new RangeError(`RGB id raster data length must be ${expectedLength}`);
  }
  return pixelCount;
}

/**
 * Check exact semantic hero counts from the instance manifest and prove that
 * every stable 24-bit instance id covers the minimum number of rendered pixels.
 */
export function checkHeroPixelCoverage(
  raster: RgbIdRaster,
  expectedCounts: Readonly<Record<string, number>>,
  instances: readonly StableHeroInstance[],
  options: HeroPixelCoverageOptions = {},
): HeroPixelCoverageReport {
  const pixelCount = validateRgbIdRaster(raster);
  const minPixelsPerInstance = options.minPixelsPerInstance ?? 64;
  const backgroundRgbId = validateRgb24Id(options.backgroundRgbId ?? 0, "backgroundRgbId");
  if (!Number.isSafeInteger(minPixelsPerInstance) || minPixelsPerInstance < 1) {
    throw new RangeError("minPixelsPerInstance must be a positive safe integer");
  }

  const expectedByKey = new Map<string, number>();
  for (const [heroKey, expectedCount] of Object.entries(expectedCounts)) {
    if (!heroKey.trim()) throw new RangeError("hero keys must be non-empty strings");
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
      throw new RangeError(`expected count for ${heroKey} must be a non-negative integer`);
    }
    expectedByKey.set(heroKey, expectedCount);
  }

  const idsSeen = new Set<number>();
  const duplicateStableIds = new Set<number>();
  const instancesByKey = new Map<string, StableHeroInstance[]>();
  const trackedPixelCounts = new Map<number, number>();
  for (const instance of instances) {
    if (!instance.heroKey.trim()) throw new RangeError("hero keys must be non-empty strings");
    const rgbId = validateRgb24Id(instance.rgbId, `hero ${instance.heroKey} rgbId`);
    if (rgbId === backgroundRgbId) {
      throw new RangeError(`hero ${instance.heroKey} cannot use the background RGB id`);
    }
    if (idsSeen.has(rgbId)) duplicateStableIds.add(rgbId);
    idsSeen.add(rgbId);
    trackedPixelCounts.set(rgbId, 0);
    const group = instancesByKey.get(instance.heroKey) ?? [];
    group.push(instance);
    instancesByKey.set(instance.heroKey, group);
  }

  const { channels, data } = raster;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * channels;
    const red = validateRgbByte(data[offset], "RGB id raster red channel");
    const green = validateRgbByte(data[offset + 1], "RGB id raster green channel");
    const blue = validateRgbByte(data[offset + 2], "RGB id raster blue channel");
    const rgbId = red * 65_536 + green * 256 + blue;
    if (trackedPixelCounts.has(rgbId)) {
      trackedPixelCounts.set(rgbId, (trackedPixelCounts.get(rgbId) ?? 0) + 1);
    }
  }

  const heroKeys = new Set([...expectedByKey.keys(), ...instancesByKey.keys()]);
  const groups = [...heroKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((heroKey): HeroGroupPixelCoverage => {
      const sourceInstances = instancesByKey.get(heroKey) ?? [];
      const coveredInstances = sourceInstances.map((instance): HeroInstancePixelCoverage => {
        const pixelCountForInstance = trackedPixelCounts.get(instance.rgbId) ?? 0;
        return {
          ...instance,
          pixelCount: pixelCountForInstance,
          visible: pixelCountForInstance >= minPixelsPerInstance,
        };
      });
      const expectedCount = expectedByKey.get(heroKey) ?? 0;
      const actualCount = sourceInstances.length;
      const visibleCount = coveredInstances.filter((instance) => instance.visible).length;
      const exactCountPassed = actualCount === expectedCount;
      const visibilityPassed = visibleCount === actualCount;
      return {
        heroKey,
        expectedCount,
        actualCount,
        visibleCount,
        exactCountPassed,
        visibilityPassed,
        passed: exactCountPassed && visibilityPassed,
        instances: coveredInstances,
      };
    });

  return {
    minPixelsPerInstance,
    backgroundRgbId,
    totalExpectedCount: groups.reduce((sum, group) => sum + group.expectedCount, 0),
    totalActualCount: groups.reduce((sum, group) => sum + group.actualCount, 0),
    totalVisibleCount: groups.reduce((sum, group) => sum + group.visibleCount, 0),
    duplicateStableIds: [...duplicateStableIds].sort((left, right) => left - right),
    groups,
    passed: duplicateStableIds.size === 0 && groups.every((group) => group.passed),
  };
}

function validateIntegerLabel(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new RangeError(`${label} must contain non-negative safe integer labels`);
  }
  return value!;
}

/** Macro-F1 over integer material-family labels, excluding background by default. */
export function materialFamilyMacroF1(
  reference: RasterLike,
  candidate: RasterLike,
  options: MaterialFamilyF1Options = {},
): MaterialFamilyMacroF1Result {
  const pixelCount = validateComparableRasters(reference, candidate);
  const ignored = new Set(
    (options.ignoreLabels ?? [0]).map((label, index) =>
      validateIntegerLabel(label, `ignoreLabels[${index}]`),
    ),
  );
  const referenceCounts = new Map<number, number>();
  const candidateCounts = new Map<number, number>();
  const truePositiveCounts = new Map<number, number>();
  let evaluatedReferencePixels = 0;
  let evaluatedCandidatePixels = 0;

  for (let index = 0; index < pixelCount; index++) {
    const referenceLabel = validateIntegerLabel(reference.data[index], "reference");
    const candidateLabel = validateIntegerLabel(candidate.data[index], "candidate");
    if (!ignored.has(referenceLabel)) {
      referenceCounts.set(referenceLabel, (referenceCounts.get(referenceLabel) ?? 0) + 1);
      evaluatedReferencePixels++;
    }
    if (!ignored.has(candidateLabel)) {
      candidateCounts.set(candidateLabel, (candidateCounts.get(candidateLabel) ?? 0) + 1);
      evaluatedCandidatePixels++;
    }
    if (referenceLabel === candidateLabel && !ignored.has(referenceLabel)) {
      truePositiveCounts.set(referenceLabel, (truePositiveCounts.get(referenceLabel) ?? 0) + 1);
    }
  }

  const labels = new Set([...referenceCounts.keys(), ...candidateCounts.keys()]);
  const families = [...labels]
    .sort((left, right) => left - right)
    .map((label): MaterialFamilyF1 => {
      const referencePixels = referenceCounts.get(label) ?? 0;
      const candidatePixels = candidateCounts.get(label) ?? 0;
      const truePositivePixels = truePositiveCounts.get(label) ?? 0;
      const falsePositivePixels = candidatePixels - truePositivePixels;
      const falseNegativePixels = referencePixels - truePositivePixels;
      const precision = candidatePixels === 0 ? 0 : truePositivePixels / candidatePixels;
      const recall = referencePixels === 0 ? 0 : truePositivePixels / referencePixels;
      return {
        label,
        referencePixels,
        candidatePixels,
        truePositivePixels,
        falsePositivePixels,
        falseNegativePixels,
        precision,
        recall,
        f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      };
    });

  return {
    ignoredLabels: [...ignored].sort((left, right) => left - right),
    evaluatedReferencePixels,
    evaluatedCandidatePixels,
    families,
    macroF1:
      families.length === 0
        ? 1
        : families.reduce((sum, family) => sum + family.f1, 0) / families.length,
  };
}

/**
 * Extract a four-connected inner boundary. A foreground pixel is a boundary
 * pixel when it touches the raster edge or a cardinal background neighbour.
 */
export function extractBoundaryMask(mask: RasterLike): BinaryBoundaryMask {
  const pixelCount = validateRasterDimensions(mask, "mask");
  const { width, height } = mask;
  const data = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!isForeground(mask.data[index])) continue;
      if (
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        !isForeground(mask.data[index - 1]) ||
        !isForeground(mask.data[index + 1]) ||
        !isForeground(mask.data[index - width]) ||
        !isForeground(mask.data[index + width])
      ) {
        data[index] = 1;
      }
    }
  }
  return { width, height, data };
}

function countSetPixels(data: ArrayLike<number>): number {
  let count = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 0) count++;
  }
  return count;
}

/** Exact one-dimensional squared Euclidean distance transform. */
function distanceTransform1d(
  input: Float64Array,
  output: Float64Array,
  length: number,
  sites: Int32Array,
  intersections: Float64Array,
): void {
  let envelopeIndex = 0;
  sites[0] = 0;
  intersections[0] = Number.NEGATIVE_INFINITY;
  intersections[1] = Number.POSITIVE_INFINITY;

  for (let q = 1; q < length; q++) {
    let intersection = 0;
    while (true) {
      const site = sites[envelopeIndex] ?? 0;
      intersection = (input[q]! + q * q - (input[site]! + site * site)) / (2 * (q - site));
      if (intersection > intersections[envelopeIndex]! || envelopeIndex === 0) {
        break;
      }
      envelopeIndex--;
    }
    envelopeIndex++;
    sites[envelopeIndex] = q;
    intersections[envelopeIndex] = intersection;
    intersections[envelopeIndex + 1] = Number.POSITIVE_INFINITY;
  }

  envelopeIndex = 0;
  for (let q = 0; q < length; q++) {
    while (intersections[envelopeIndex + 1]! < q) envelopeIndex++;
    const site = sites[envelopeIndex] ?? 0;
    const delta = q - site;
    output[q] = delta * delta + input[site]!;
  }
}

/** O(width * height) exact squared distance to the nearest set boundary pixel. */
function squaredDistanceToSet(boundary: BinaryBoundaryMask): Float64Array {
  const { width, height, data } = boundary;
  const pixelCount = width * height;
  const unreachable = width * width + height * height + 1;
  const distances = new Float64Array(pixelCount);
  const lineLength = Math.max(width, height);
  const input = new Float64Array(lineLength);
  const output = new Float64Array(lineLength);
  const sites = new Int32Array(lineLength);
  const intersections = new Float64Array(lineLength + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      input[y] = data[y * width + x] !== 0 ? 0 : unreachable;
    }
    distanceTransform1d(input, output, height, sites, intersections);
    for (let y = 0; y < height; y++) distances[y * width + x] = output[y]!;
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) input[x] = distances[rowOffset + x]!;
    distanceTransform1d(input, output, width, sites, intersections);
    for (let x = 0; x < width; x++) distances[rowOffset + x] = output[x]!;
  }
  return distances;
}

/**
 * Measure an undesired candidate category inside a protected reference region,
 * excluding reference pixels within `boundaryTolerancePixels` of the nearest
 * in-raster non-region pixel. For false water on land, pass reference land as
 * `referenceRegion` and rendered water as `candidateLeakage`.
 *
 * A zero tolerance reproduces the raw overlap leakage. A null ratio means its
 * denominator is empty. The raster perimeter is not itself a category edge.
 */
export function measureReferenceInteriorLeakage(
  referenceRegion: RasterLike,
  candidateLeakage: RasterLike,
  boundaryTolerancePixels: number,
): ReferenceInteriorLeakageResult {
  const pixelCount = validateComparableRasters(referenceRegion, candidateLeakage);
  const maximumBoundaryTolerancePixels = Math.hypot(
    referenceRegion.width - 1,
    referenceRegion.height - 1,
  );
  if (!Number.isFinite(boundaryTolerancePixels) || boundaryTolerancePixels < 0) {
    throw new RangeError("boundaryTolerancePixels must be a finite non-negative number");
  }
  if (boundaryTolerancePixels > maximumBoundaryTolerancePixels) {
    throw new RangeError(
      `boundaryTolerancePixels must not exceed the raster diagonal (${maximumBoundaryTolerancePixels})`,
    );
  }

  const referenceBackground = new Uint8Array(pixelCount);
  let referenceRegionPixels = 0;
  let referenceBackgroundPixels = 0;
  let rawLeakagePixels = 0;
  for (let index = 0; index < pixelCount; index++) {
    if (isForeground(referenceRegion.data[index])) {
      referenceRegionPixels++;
      if (isForeground(candidateLeakage.data[index])) rawLeakagePixels++;
    } else {
      referenceBackground[index] = 1;
      referenceBackgroundPixels++;
    }
  }

  let excludedBoundaryPixels = 0;
  let excludedBoundaryLeakagePixels = 0;
  let referenceInteriorPixels = referenceRegionPixels;
  let interiorLeakagePixels = rawLeakagePixels;
  if (boundaryTolerancePixels >= 1 && referenceRegionPixels > 0 && referenceBackgroundPixels > 0) {
    const distanceToBackground = squaredDistanceToSet({
      width: referenceRegion.width,
      height: referenceRegion.height,
      data: referenceBackground,
    });
    const toleranceSquared = boundaryTolerancePixels * boundaryTolerancePixels + Number.EPSILON;
    referenceInteriorPixels = 0;
    interiorLeakagePixels = 0;
    for (let index = 0; index < pixelCount; index++) {
      if (!isForeground(referenceRegion.data[index])) continue;
      if (distanceToBackground[index]! <= toleranceSquared) {
        excludedBoundaryPixels++;
        if (isForeground(candidateLeakage.data[index])) excludedBoundaryLeakagePixels++;
        continue;
      }
      referenceInteriorPixels++;
      if (isForeground(candidateLeakage.data[index])) interiorLeakagePixels++;
    }
  }

  return {
    boundaryTolerancePixels,
    maximumBoundaryTolerancePixels,
    referenceRegionPixels,
    rawLeakagePixels,
    rawLeakageRatio: referenceRegionPixels === 0 ? null : rawLeakagePixels / referenceRegionPixels,
    excludedBoundaryPixels,
    excludedBoundaryLeakagePixels,
    referenceInteriorPixels,
    interiorLeakagePixels,
    interiorLeakageRatio:
      referenceInteriorPixels === 0 ? null : interiorLeakagePixels / referenceInteriorPixels,
  };
}

/** Boundary precision/recall/F1 using exact Euclidean pixel tolerance. */
export function boundaryF1WithinTolerance(
  reference: RasterLike,
  candidate: RasterLike,
  tolerancePixels: number,
): BoundaryF1Result {
  validateComparableRasters(reference, candidate);
  if (!Number.isFinite(tolerancePixels) || tolerancePixels < 0) {
    throw new RangeError("tolerancePixels must be a finite non-negative number");
  }
  const referenceBoundary = extractBoundaryMask(reference);
  const candidateBoundary = extractBoundaryMask(candidate);
  const referenceBoundaryPixels = countSetPixels(referenceBoundary.data);
  const candidateBoundaryPixels = countSetPixels(candidateBoundary.data);
  if (referenceBoundaryPixels === 0 || candidateBoundaryPixels === 0) {
    const equal = referenceBoundaryPixels === candidateBoundaryPixels;
    return {
      tolerancePixels,
      referenceBoundaryPixels,
      candidateBoundaryPixels,
      precision: equal ? 1 : 0,
      recall: equal ? 1 : 0,
      f1: equal ? 1 : 0,
    };
  }

  const distanceToReference = squaredDistanceToSet(referenceBoundary);
  const distanceToCandidate = squaredDistanceToSet(candidateBoundary);
  const toleranceSquared = tolerancePixels * tolerancePixels + Number.EPSILON;
  let matchedReference = 0;
  let matchedCandidate = 0;
  for (let index = 0; index < referenceBoundary.data.length; index++) {
    if (referenceBoundary.data[index] !== 0 && distanceToCandidate[index]! <= toleranceSquared) {
      matchedReference++;
    }
    if (candidateBoundary.data[index] !== 0 && distanceToReference[index]! <= toleranceSquared) {
      matchedCandidate++;
    }
  }
  const precision = matchedCandidate / candidateBoundaryPixels;
  const recall = matchedReference / referenceBoundaryPixels;
  return {
    tolerancePixels,
    referenceBoundaryPixels,
    candidateBoundaryPixels,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function nearestRankPercentile95(values: Float64Array): number {
  if (values.length === 0) return 0;
  values.sort();
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
}

function directionalBoundaryP95(
  source: BinaryBoundaryMask,
  sourceCount: number,
  target: BinaryBoundaryMask,
  targetCount: number,
): number {
  if (sourceCount === 0) return 0;
  if (targetCount === 0) return Number.POSITIVE_INFINITY;
  const distanceToTarget = squaredDistanceToSet(target);
  const distances = new Float64Array(sourceCount);
  let distanceIndex = 0;
  for (let index = 0; index < source.data.length; index++) {
    if (source.data[index] !== 0) {
      distances[distanceIndex++] = Math.sqrt(distanceToTarget[index]!);
    }
  }
  return nearestRankPercentile95(distances);
}

/** Symmetric 95th-percentile boundary distance in pixels. */
export function measureBidirectionalBoundaryDistance(
  reference: RasterLike,
  candidate: RasterLike,
): BidirectionalBoundaryDistance {
  validateComparableRasters(reference, candidate);
  const referenceBoundary = extractBoundaryMask(reference);
  const candidateBoundary = extractBoundaryMask(candidate);
  const referenceCount = countSetPixels(referenceBoundary.data);
  const candidateCount = countSetPixels(candidateBoundary.data);
  const referenceToCandidateP95 = directionalBoundaryP95(
    referenceBoundary,
    referenceCount,
    candidateBoundary,
    candidateCount,
  );
  const candidateToReferenceP95 = directionalBoundaryP95(
    candidateBoundary,
    candidateCount,
    referenceBoundary,
    referenceCount,
  );
  return {
    percentile: 0.95,
    referenceToCandidateP95,
    candidateToReferenceP95,
    bidirectionalP95: Math.max(referenceToCandidateP95, candidateToReferenceP95),
  };
}

export function measureMaskGeometry(mask: RasterLike): MaskGeometry {
  const pixelCount = validateRasterDimensions(mask, "mask");
  let foregroundPixels = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < pixelCount; index++) {
    if (!isForeground(mask.data[index])) continue;
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    foregroundPixels++;
    sumX += x;
    sumY += y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (foregroundPixels === 0) {
    return { foregroundPixels: 0, centroid: null, bbox: null };
  }
  return {
    foregroundPixels,
    centroid: { x: sumX / foregroundPixels, y: sumY / foregroundPixels },
    bbox: {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
  };
}

/** Centroid and bounding-box drift. Null fields mean one mask was empty. */
export function measureMaskGeometryDrift(
  referenceMask: RasterLike,
  candidateMask: RasterLike,
): MaskGeometryDrift {
  validateComparableRasters(referenceMask, candidateMask);
  const reference = measureMaskGeometry(referenceMask);
  const candidate = measureMaskGeometry(candidateMask);
  if (!reference.centroid || !candidate.centroid || !reference.bbox || !candidate.bbox) {
    return {
      reference,
      candidate,
      centroidDxPixels: null,
      centroidDyPixels: null,
      centroidDistancePixels: null,
      centroidDistanceRatio: null,
      bboxCenterDxPixels: null,
      bboxCenterDyPixels: null,
      bboxCenterDistancePixels: null,
      bboxWidthDriftPixels: null,
      bboxHeightDriftPixels: null,
      bboxWidthDriftRatio: null,
      bboxHeightDriftRatio: null,
    };
  }

  const centroidDxPixels = candidate.centroid.x - reference.centroid.x;
  const centroidDyPixels = candidate.centroid.y - reference.centroid.y;
  const centroidDistancePixels = Math.hypot(centroidDxPixels, centroidDyPixels);
  const referenceCenterX = reference.bbox.x + (reference.bbox.width - 1) / 2;
  const referenceCenterY = reference.bbox.y + (reference.bbox.height - 1) / 2;
  const candidateCenterX = candidate.bbox.x + (candidate.bbox.width - 1) / 2;
  const candidateCenterY = candidate.bbox.y + (candidate.bbox.height - 1) / 2;
  const bboxCenterDxPixels = candidateCenterX - referenceCenterX;
  const bboxCenterDyPixels = candidateCenterY - referenceCenterY;
  const bboxWidthDriftPixels = Math.abs(candidate.bbox.width - reference.bbox.width);
  const bboxHeightDriftPixels = Math.abs(candidate.bbox.height - reference.bbox.height);

  return {
    reference,
    candidate,
    centroidDxPixels,
    centroidDyPixels,
    centroidDistancePixels,
    centroidDistanceRatio:
      centroidDistancePixels / Math.hypot(referenceMask.width, referenceMask.height),
    bboxCenterDxPixels,
    bboxCenterDyPixels,
    bboxCenterDistancePixels: Math.hypot(bboxCenterDxPixels, bboxCenterDyPixels),
    bboxWidthDriftPixels,
    bboxHeightDriftPixels,
    bboxWidthDriftRatio: bboxWidthDriftPixels / referenceMask.width,
    bboxHeightDriftRatio: bboxHeightDriftPixels / referenceMask.height,
  };
}

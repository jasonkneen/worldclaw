import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  analyzeConnectedComponents,
  boundaryF1WithinTolerance,
  checkHeroPixelCoverage,
  compareMaskTransforms,
  countConnectedComponents,
  measureBidirectionalBoundaryDistance,
  measureMaskGeometryDrift,
  measureMaskOverlap,
  measureReferenceInteriorLeakage,
  materialFamilyMacroF1,
  validateRasterDimensions,
} from "../src/lib/worldclaw/reference-metrics.ts";

const referenceManifest = JSON.parse(
  readFileSync(
    new URL("../assets/worldclaw/reference-validation/reference_manifest.json", import.meta.url),
    "utf8",
  ),
);

test("the published reference gate keeps map authority and strict non-overridable floors", () => {
  assert.deepEqual(referenceManifest.authorityOrder, [
    "canonical_semantic_map",
    "approved_multiview_concept_sheet",
    "structured_scene_plan",
  ]);
  assert.deepEqual(referenceManifest.requiredFinalViews.map, {
    projection: "orthographic",
    aspect: "1:1",
    orientation: "north_up",
    comparisonMode: "binary_land_water_and_semantic_ids",
  });
  assert.equal(referenceManifest.hardThresholds.landWaterIoU, 0.95);
  assert.equal(referenceManifest.hardThresholds.shorelineBoundaryF1, 0.95);
  assert.equal(referenceManifest.hardThresholds.leakageBoundaryTolerancePixelsAt1024, 4);
  assert.equal(referenceManifest.hardThresholds.minimumHeroPixelsInAnyView, 64);
  assert.equal(referenceManifest.hardThresholds.materialFamilyMacroF1, 0.9);
  assert.equal(referenceManifest.failurePolicy.aggregation, "logical_and");
  assert.equal(referenceManifest.failurePolicy.modelReviewMayOverrideHardFailure, false);
});

function binaryRaster(width, height, foreground) {
  const data = new Uint8Array(width * height);
  for (const [x, y] of foreground) data[y * width + x] = 1;
  return { width, height, data };
}

function filledRect(width, height, x, y, rectWidth, rectHeight) {
  const foreground = [];
  for (let row = y; row < y + rectHeight; row++) {
    for (let column = x; column < x + rectWidth; column++) {
      foreground.push([column, row]);
    }
  }
  return binaryRaster(width, height, foreground);
}

function rgbIdRaster(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) data[index * 4 + 3] = 255;
  return { width, height, channels: 4, data };
}

function paintRgbIdPixels(raster, rgbId, startPixel, pixelCount) {
  const red = (rgbId >>> 16) & 0xff;
  const green = (rgbId >>> 8) & 0xff;
  const blue = rgbId & 0xff;
  for (let pixel = startPixel; pixel < startPixel + pixelCount; pixel++) {
    const offset = pixel * raster.channels;
    raster.data[offset] = red;
    raster.data[offset + 1] = green;
    raster.data[offset + 2] = blue;
  }
}

test("an identical binary mask has complete overlap", () => {
  const mask = binaryRaster(8, 6, [
    [1, 1],
    [2, 1],
    [1, 2],
    [4, 3],
  ]);

  assert.equal(validateRasterDimensions(mask), 48);
  assert.deepEqual(measureMaskOverlap(mask, mask), {
    referenceForeground: 4,
    candidateForeground: 4,
    intersection: 4,
    union: 4,
    iou: 1,
  });
  assert.equal(boundaryF1WithinTolerance(mask, mask, 0).f1, 1);
  assert.equal(measureBidirectionalBoundaryDistance(mask, mask).bidirectionalP95, 0);
  assert.equal(measureMaskGeometryDrift(mask, mask).centroidDistancePixels, 0);
  const transforms = compareMaskTransforms(mask, mask);
  assert.equal(transforms.bestTransform, "identity");
  assert.equal(transforms.suspicious, false);
});

test("raster validation rejects malformed and mismatched dimensions", () => {
  assert.throws(
    () => validateRasterDimensions({ width: 4, height: 4, data: new Uint8Array(15) }),
    /data length must equal/,
  );
  assert.throws(
    () =>
      measureMaskOverlap(
        { width: 4, height: 4, data: new Uint8Array(16) },
        { width: 8, height: 2, data: new Uint8Array(16) },
      ),
    /dimensions must match/,
  );
});

test("a five-percent shoreline shift has five-pixel registration drift", () => {
  const reference = filledRect(100, 100, 20, 20, 40, 60);
  const shifted = filledRect(100, 100, 25, 20, 40, 60);

  const boundaryAtFour = boundaryF1WithinTolerance(reference, shifted, 4);
  const boundaryAtFive = boundaryF1WithinTolerance(reference, shifted, 5);
  const distance = measureBidirectionalBoundaryDistance(reference, shifted);
  const drift = measureMaskGeometryDrift(reference, shifted);

  assert.ok(boundaryAtFour.f1 < 1);
  assert.equal(boundaryAtFive.f1, 1);
  assert.equal(distance.bidirectionalP95, 5);
  assert.equal(drift.centroidDxPixels, 5);
  assert.equal(drift.centroidDyPixels, 0);
  assert.equal(drift.bboxCenterDistancePixels, 5);
  assert.equal(drift.bboxWidthDriftRatio, 0);
  assert.equal(drift.bboxHeightDriftRatio, 0);
});

test("a left-right mirrored shoreline is reported as an X reflection", () => {
  const reference = binaryRaster(9, 7, [
    [1, 1],
    [2, 1],
    [1, 2],
    [1, 3],
    [3, 4],
  ]);
  const mirrored = binaryRaster(
    9,
    7,
    [
      [1, 1],
      [2, 1],
      [1, 2],
      [1, 3],
      [3, 4],
    ].map(([x, y]) => [8 - x, y]),
  );

  const comparison = compareMaskTransforms(reference, mirrored);
  assert.equal(comparison.scores.flipX, 1);
  assert.equal(comparison.bestTransform, "flipX");
  assert.equal(comparison.suspicious, true);
  assert.equal(comparison.suspicionKind, "reflection");
  assert.ok(comparison.alternateImprovement >= 0.02);
});

test("a top-bottom mirrored shoreline is reported as a Y reflection", () => {
  const points = [
    [1, 1],
    [2, 1],
    [3, 1],
    [3, 2],
    [5, 4],
  ];
  const reference = binaryRaster(9, 7, points);
  const mirrored = binaryRaster(
    9,
    7,
    points.map(([x, y]) => [x, 6 - y]),
  );

  const comparison = compareMaskTransforms(reference, mirrored);
  assert.equal(comparison.scores.flipY, 1);
  assert.equal(comparison.bestTransform, "flipY");
  assert.equal(comparison.suspicious, true);
  assert.equal(comparison.suspicionKind, "reflection");
});

test("a 180-degree rotated shoreline is reported as a rotation", () => {
  const points = [
    [1, 1],
    [2, 1],
    [1, 2],
    [4, 2],
    [3, 5],
  ];
  const reference = binaryRaster(9, 7, points);
  const rotated = binaryRaster(
    9,
    7,
    points.map(([x, y]) => [8 - x, 6 - y]),
  );

  const comparison = compareMaskTransforms(reference, rotated);
  assert.equal(comparison.scores.rotate180, 1);
  assert.equal(comparison.bestTransform, "rotate180");
  assert.equal(comparison.suspicious, true);
  assert.equal(comparison.suspicionKind, "rotation");
});

test("disconnected one-pixel water specks can be ignored by image-area ratio", () => {
  const water = filledRect(10, 10, 1, 1, 5, 5);
  water.data[9 * water.width + 9] = 1;

  const unfiltered = analyzeConnectedComponents(water);
  const filtered = analyzeConnectedComponents(water, { minAreaRatio: 0.02 });

  assert.equal(unfiltered.totalComponentCount, 2);
  assert.equal(unfiltered.keptComponentCount, 2);
  assert.equal(filtered.totalComponentCount, 2);
  assert.equal(filtered.keptComponentCount, 1);
  assert.equal(filtered.ignoredComponentCount, 1);
  assert.equal(countConnectedComponents(water, { minAreaRatio: 0.02 }), 1);
  assert.deepEqual(filtered.keptAreas, [25]);
  assert.deepEqual(filtered.ignoredAreas, [1]);
});

test("water bleeding onto canonical land is counted as extra union area", () => {
  const canonicalWater = filledRect(10, 10, 2, 2, 4, 4);
  const renderedWater = filledRect(10, 10, 2, 2, 5, 4);

  assert.deepEqual(measureMaskOverlap(canonicalWater, renderedWater), {
    referenceForeground: 16,
    candidateForeground: 20,
    intersection: 16,
    union: 20,
    iou: 0.8,
  });
});

test("one-pixel shoreline disagreement is excluded from reference-interior leakage", () => {
  const referenceLand = filledRect(9, 9, 1, 1, 7, 7);
  const renderedWater = binaryRaster(9, 9, [[1, 4]]);

  const leakage = measureReferenceInteriorLeakage(referenceLand, renderedWater, 1);

  assert.equal(leakage.referenceRegionPixels, 49);
  assert.equal(leakage.rawLeakagePixels, 1);
  assert.equal(leakage.rawLeakageRatio, 1 / 49);
  assert.equal(leakage.excludedBoundaryPixels, 24);
  assert.equal(leakage.excludedBoundaryLeakagePixels, 1);
  assert.equal(leakage.referenceInteriorPixels, 25);
  assert.equal(leakage.interiorLeakagePixels, 0);
  assert.equal(leakage.interiorLeakageRatio, 0);
});

test("leakage deeper than the shoreline tolerance remains an inland failure", () => {
  const referenceLand = filledRect(9, 9, 1, 1, 7, 7);
  const renderedWater = binaryRaster(9, 9, [
    [1, 4],
    [2, 4],
  ]);

  const leakage = measureReferenceInteriorLeakage(referenceLand, renderedWater, 1);

  assert.equal(leakage.rawLeakagePixels, 2);
  assert.equal(leakage.excludedBoundaryLeakagePixels, 1);
  assert.equal(leakage.interiorLeakagePixels, 1);
  assert.equal(leakage.referenceInteriorPixels, 25);
  assert.equal(leakage.interiorLeakageRatio, 1 / 25);
});

test("reference-interior leakage validates dimensions and bounds boundary tolerance", () => {
  const referenceLand = filledRect(4, 4, 1, 1, 2, 2);
  const renderedWater = binaryRaster(4, 4, []);
  const diagonal = Math.hypot(3, 3);

  assert.throws(
    () => measureReferenceInteriorLeakage(referenceLand, binaryRaster(2, 8, []), 1),
    /dimensions must match/,
  );
  assert.throws(
    () => measureReferenceInteriorLeakage(referenceLand, renderedWater, -1),
    /finite non-negative/,
  );
  assert.throws(
    () => measureReferenceInteriorLeakage(referenceLand, renderedWater, Number.POSITIVE_INFINITY),
    /finite non-negative/,
  );
  assert.throws(
    () => measureReferenceInteriorLeakage(referenceLand, renderedWater, diagonal + 0.01),
    /must not exceed the raster diagonal/,
  );

  const atBound = measureReferenceInteriorLeakage(referenceLand, renderedWater, diagonal);
  assert.equal(atBound.maximumBoundaryTolerancePixels, diagonal);
  assert.equal(atBound.referenceInteriorPixels, 0);
  assert.equal(atBound.interiorLeakageRatio, null);
});

test("a missing hero instance fails exact count even when the rendered instance is visible", () => {
  const ids = rgbIdRaster(16, 8);
  paintRgbIdPixels(ids, 0x11_22_33, 0, 64);

  const report = checkHeroPixelCoverage(ids, { ship: 2 }, [{ heroKey: "ship", rgbId: 0x11_22_33 }]);

  assert.equal(report.passed, false);
  assert.equal(report.groups[0].heroKey, "ship");
  assert.equal(report.groups[0].expectedCount, 2);
  assert.equal(report.groups[0].actualCount, 1);
  assert.equal(report.groups[0].visibleCount, 1);
  assert.equal(report.groups[0].exactCountPassed, false);
  assert.equal(report.groups[0].visibilityPassed, true);
});

test("a duplicated hero fails exact count when both stable ids are visible", () => {
  const ids = rgbIdRaster(16, 8);
  paintRgbIdPixels(ids, 0x10_20_30, 0, 64);
  paintRgbIdPixels(ids, 0x40_50_60, 64, 64);

  const report = checkHeroPixelCoverage(ids, { tower: 1 }, [
    { heroKey: "tower", rgbId: 0x10_20_30 },
    { heroKey: "tower", rgbId: 0x40_50_60 },
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.groups[0].actualCount, 2);
  assert.equal(report.groups[0].visibleCount, 2);
  assert.equal(report.groups[0].exactCountPassed, false);
  assert.equal(report.groups[0].visibilityPassed, true);
});

test("a hero covering fewer than 64 pixels fails the visibility floor", () => {
  const ids = rgbIdRaster(16, 8);
  paintRgbIdPixels(ids, 0xaa_bb_cc, 0, 63);

  const report = checkHeroPixelCoverage(ids, { dragon: 1 }, [
    { heroKey: "dragon", rgbId: 0xaa_bb_cc },
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.groups[0].exactCountPassed, true);
  assert.equal(report.groups[0].visibilityPassed, false);
  assert.equal(report.groups[0].instances[0].pixelCount, 63);
  assert.equal(report.groups[0].instances[0].visible, false);
});

test("substituting one material family for another produces zero macro-F1", () => {
  const reference = {
    width: 4,
    height: 2,
    data: Uint8Array.from([0, 1, 1, 0, 0, 1, 1, 0]),
  };
  const substituted = {
    width: 4,
    height: 2,
    data: Uint8Array.from([0, 2, 2, 0, 0, 2, 2, 0]),
  };

  const report = materialFamilyMacroF1(reference, substituted);
  assert.equal(report.macroF1, 0);
  assert.deepEqual(
    report.families.map(({ label, f1 }) => ({ label, f1 })),
    [
      { label: 1, f1: 0 },
      { label: 2, f1: 0 },
    ],
  );
});

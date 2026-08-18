import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";

export const PAPER_CAPTURE_VIEW_NAMES = [
  "global",
  "region-1",
  "region-2",
  "region-3",
  "region-4",
  "walk-1",
  "walk-2",
  "walk-3",
  "walk-4",
];

export const PAPER_CAPTURE_PASS_NAMES = ["beauty", "instance", "depth", "normal"];

const WIDTH = 640;
const HEIGHT = 360;
const MAXIMUM_ENCODED_CHARACTERS = 64_000_000;
export const NORMALIZED_SCENE_PLAN_MAX_BYTES = 256_000;
const MAXIMUM_RAW_NORMALIZED_PLAN_CHARACTERS = 64_000_000;
const DATA_URL = /^data:/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SUITE_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const CASE_ID = /^figure-\d{2}-[a-z0-9-]{1,100}$/;
const CASE_TOKEN = /^[a-f0-9]{32,64}$/;

export function paperEvidenceSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertIsoTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} is missing`);
  assert.equal(new Date(value).toISOString(), value, `${label} is not canonical ISO-8601`);
}

function assertCaptureBinding(binding, label = "Paper capture binding") {
  assert.ok(binding && typeof binding === "object", `${label} is missing`);
  assert.match(binding.suiteId ?? "", SUITE_ID, `${label} suite id is invalid`);
  assert.match(binding.caseId ?? "", CASE_ID, `${label} case id is invalid`);
  assert.match(binding.caseToken ?? "", CASE_TOKEN, `${label} case token is invalid`);
  assert.match(binding.promptSha256 ?? "", SHA256, `${label} prompt hash is invalid`);
  assertRegionalRoles(binding.regionalReadability, `${label} regional readability`);
  assert.deepEqual(Object.keys(binding).sort(), [
    "caseId",
    "caseToken",
    "promptSha256",
    "regionalReadability",
    "suiteId",
  ]);
  return binding;
}

function assertRegionalRoles(value, label) {
  assert.ok(Array.isArray(value) && value.length === 4, `${label} must contain four roles`);
  for (const [index, role] of value.entries()) {
    assert.equal(typeof role, "string", `${label} role ${index + 1} must be text`);
    assert.ok(role.trim() && role.length <= 120, `${label} role ${index + 1} is invalid`);
  }
  return value;
}

function assertCaptureIdentity(matrix, expected = {}) {
  const expectedBinding = expected.binding ?? null;
  if (matrix?.binding !== undefined && matrix.binding !== null) {
    assertCaptureBinding(matrix.binding);
    assert.match(matrix.worldPromptSha256 ?? "", SHA256, "Paper world prompt hash is invalid");
    assert.equal(
      matrix.worldPromptSha256,
      matrix.binding.promptSha256,
      "Paper capture prompt hash is not bound to its world prompt",
    );
    assert.match(matrix.worldFingerprint ?? "", /^[a-f0-9]{16}$/, "Paper world fingerprint is invalid");
    assert.equal(matrix.worldFingerprintAlgorithm, "fnv1a-dual32-canonical-world");
    assertIsoTimestamp(matrix.capturedAt, "Paper capture timestamp");
    assert.deepEqual(
      matrix.regionalReadability,
      matrix.binding.regionalReadability,
      "Paper capture regional readability drifted from its binding",
    );
  }
  if (expectedBinding) {
    assertCaptureBinding(expectedBinding, "Expected paper capture binding");
    assert.deepEqual(matrix?.binding, expectedBinding, "Paper capture binding drifted");
    assert.equal(
      matrix?.worldPromptSha256,
      expectedBinding.promptSha256,
      "Paper capture world prompt drifted",
    );
    assert.match(matrix?.worldFingerprint ?? "", /^[a-f0-9]{16}$/);
    assert.equal(matrix?.worldFingerprintAlgorithm, "fnv1a-dual32-canonical-world");
    assertIsoTimestamp(matrix?.capturedAt, "Paper capture timestamp");
  }
  if (expected.regionalRoles) {
    assertRegionalRoles(expected.regionalRoles, "Expected regional readability");
    assert.deepEqual(matrix?.regionalReadability, expected.regionalRoles, "Paper regional roles drifted");
  }
  if (expected.generatedWorld) {
    assert.equal(matrix?.worldId, expected.generatedWorld.id, "Paper capture world id drifted");
    assert.equal(matrix?.seed, expected.generatedWorld.seed, "Paper capture seed drifted");
    assert.equal(
      matrix?.worldPromptSha256,
      expected.generatedWorld.promptSha256,
      "Paper capture prompt hash drifted from generated world",
    );
  }
}

function decodePngDataUrl(dataUrl, label) {
  assert.equal(typeof dataUrl, "string", `${label} has no PNG data URL`);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  assert.ok(match, `${label} is not an inline PNG`);
  const bytes = Buffer.from(match[1], "base64");
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, WIDTH, `${label} width is not ${WIDTH}`);
  assert.equal(png.height, HEIGHT, `${label} height is not ${HEIGHT}`);
  return bytes;
}

function assertIsolation(isolation) {
  assert.deepEqual(isolation, {
    worldDataMutated: false,
    liveCameraMutated: false,
    liveMaterialsUsedForDiagnostics: false,
    diagnosticPostprocessingBypassed: true,
    rendererStateRestored: true,
    uiViewModeRestored: true,
    uiSelectionRestored: true,
  });
}

function assertStateAudit(stateAudit) {
  assert.deepEqual(stateAudit, {
    directLitBeautyReportedAsVisiblePostprocessingEquivalent: false,
    liveMaterialStateVerified: true,
    liveCameraStateVerified: true,
    worldFingerprintVerified: true,
  });
}

function assertMaterialAudit(materialAudit) {
  assert.equal(
    materialAudit?.verification,
    "live-mesh-uuid-material-reference-and-property-fingerprint",
  );
  assert.ok(materialAudit?.originalMaterialEntryCount >= 1);
  assert.ok(materialAudit?.litMaterialEntryCount >= 1);
  assert.equal(materialAudit?.liveMaterialReferencesUnchangedDuringDiagnostics, true);
  assert.equal(materialAudit?.liveMaterialPropertiesUnchangedDuringDiagnostics, true);
  assert.equal(materialAudit?.originalMaterialPropertiesRestored, true);
}

function assertCaptureContract(matrix, expected) {
  assert.equal(matrix?.version, 1, "Paper capture version is not supported");
  assert.equal(matrix?.mimeType, "image/png");
  assert.match(matrix?.worldId ?? "", /^[a-zA-Z0-9._:-]{1,160}$/);
  assert.ok(Number.isSafeInteger(matrix?.seed));
  assert.deepEqual(matrix.capturePolicy?.availableViews, PAPER_CAPTURE_VIEW_NAMES);
  assert.deepEqual(matrix.capturePolicy?.capturedViews, PAPER_CAPTURE_VIEW_NAMES);
  assert.deepEqual(matrix.capturePolicy?.passesPerView, PAPER_CAPTURE_PASS_NAMES);
  assert.deepEqual(matrix.capturePolicy?.fixedResolution, { width: WIDTH, height: HEIGHT });
  assert.equal(matrix.capturePolicy?.sequential, true);
  assert.equal(matrix.capturePolicy?.rawPixelsRetained, false);
  assert.equal(
    matrix.capturePolicy?.beautyPipeline,
    "direct-lit-structural-beauty-not-visible-postprocessed-ui",
  );
  assert.equal(
    matrix.capturePolicy?.diagnosticPipeline,
    "literal-geometry-direct-render-postprocessing-bypassed",
  );
  assert.ok(
    Number.isFinite(matrix.performance?.encodedPayloadCharacters) &&
      matrix.performance.encodedPayloadCharacters > 0 &&
      matrix.performance.encodedPayloadCharacters <= MAXIMUM_ENCODED_CHARACTERS,
    "Paper capture encoded payload is empty or exceeds its QA bound",
  );
  assert.equal(matrix.logicalIds?.stableAcrossViewsAndCompiledSubmeshes, true);
  assert.equal(matrix.logicalIds?.source, "world-object-id-and-rendered-surface-id");
  assert.ok(matrix.logicalIds?.mapping?.length >= 1, "Paper capture has no logical ID mapping");
  assert.equal(matrix.geometryInventory?.diagnosticsUseColliderProxies, false);
  assert.equal(matrix.geometryInventory?.compiledLogicalIdAssignmentsStable, true);
  assert.equal(matrix.geometryInventory?.geometryFinitePreflightPassed, true);
  assert.equal(matrix.geometryInventory?.nonFiniteGeometryValueCount, 0);
  assert.deepEqual(matrix.geometryInventory?.missingLogicalObjectIds, []);
  assert.deepEqual(matrix.geometryInventory?.unexpectedLogicalObjectIds, []);
  assert.equal(
    matrix.geometryInventory?.renderedLogicalObjectCount,
    matrix.geometryInventory?.expectedLogicalObjectCount,
    "Paper diagnostics do not contain every expected logical object",
  );
  assertIsolation(matrix.isolation);
  assertStateAudit(matrix.stateAudit);
  assertMaterialAudit(matrix.materialAudit);
  assertCaptureIdentity(matrix, expected);
  if (matrix?.binding) {
    const regionIds = [];
    for (let index = 0; index < 4; index++) {
      const role = matrix.regionalReadability[index];
      const regionView = matrix.views?.[`region-${index + 1}`];
      const walkView = matrix.views?.[`walk-${index + 1}`];
      for (const [label, view] of [
        [`region-${index + 1}`, regionView],
        [`walk-${index + 1}`, walkView],
      ]) {
        assert.equal(view?.camera?.region?.requestedSemanticRole, role, `${label} semantic role drifted`);
        assert.equal(
          view?.camera?.region?.selectionSource,
          "preregistered-semantic-role-match",
          `${label} was not selected by semantic role`,
        );
        assert.equal(
          view?.camera?.region?.semanticMatch?.method,
          "plan-region-semantic-token-and-category-match",
        );
        assert.ok(view?.camera?.region?.semanticMatch?.score > 0, `${label} has no semantic match score`);
        assert.ok(
          view?.camera?.region?.semanticMatch?.matchedTerms?.length > 0,
          `${label} has no semantic match terms`,
        );
        assert.equal(view?.camera?.region?.semanticMatch?.distinctRegion, true);
      }
      assert.equal(regionView.camera.region.id, walkView.camera.region.id, `Region/walk ${index + 1} drifted`);
      regionIds.push(regionView.camera.region.id);
    }
    assert.equal(new Set(regionIds).size, 4, "Bound paper regional anchors are not distinct");
  }
}

function determinant4(values) {
  assert.ok(Array.isArray(values) && values.length === 16, "Camera matrix must contain 16 values");
  const [
    n11, n21, n31, n41,
    n12, n22, n32, n42,
    n13, n23, n33, n43,
    n14, n24, n34, n44,
  ] = values;
  return (
    n41 * (+n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34) +
    n42 * (+n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31) +
    n43 * (+n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31) +
    n44 * (-n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31)
  );
}

function recomputeCameraSanity(camera, viewName) {
  const values = [...(camera?.viewMatrix ?? []), ...(camera?.projectionMatrix ?? [])];
  assert.equal(values.length, 32, `${viewName} camera matrices are incomplete`);
  assert.ok(values.every(Number.isFinite), `${viewName} camera matrices are non-finite`);
  const viewDeterminant = determinant4(camera.viewMatrix);
  const projectionDeterminant = determinant4(camera.projectionMatrix);
  const worldBasisDeterminant = 1 / viewDeterminant;
  const reflectionDetected = worldBasisDeterminant < 0;
  const passed =
    Math.abs(viewDeterminant - 1) < 1e-5 &&
    Math.abs(projectionDeterminant) > 1e-12 &&
    Math.abs(worldBasisDeterminant - 1) < 1e-5 &&
    !reflectionDetected;
  assert.ok(passed, `${viewName} persisted camera matrix sanity failed`);
  assert.ok(
    Math.abs(viewDeterminant - camera.matrixSanity.viewDeterminant) <= 1e-10,
    `${viewName} view determinant metadata drifted`,
  );
  assert.ok(
    Math.abs(projectionDeterminant - camera.matrixSanity.projectionDeterminant) <= 1e-10,
    `${viewName} projection determinant metadata drifted`,
  );
  assert.ok(
    Math.abs(worldBasisDeterminant - camera.matrixSanity.worldBasisDeterminant) <= 1e-10,
    `${viewName} world basis determinant metadata drifted`,
  );
  assert.equal(camera.matrixSanity.finite, true);
  assert.equal(camera.matrixSanity.reflectionDetected, reflectionDetected);
  assert.equal(camera.matrixSanity.passed, passed);
  return { finite: true, viewDeterminant, projectionDeterminant, worldBasisDeterminant, reflectionDetected, passed };
}

function recomputeBeautyMetrics(png) {
  const pixelCount = png.width * png.height;
  const stride = Math.max(1, Math.floor(pixelCount / 32_768));
  let samples = 0;
  let opaqueSamples = 0;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let minimumLuminance = 255;
  let maximumLuminance = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const luminance =
      (png.data[offset] ?? 0) * 0.2126 +
      (png.data[offset + 1] ?? 0) * 0.7152 +
      (png.data[offset + 2] ?? 0) * 0.0722;
    samples++;
    if ((png.data[offset + 3] ?? 0) >= 250) opaqueSamples++;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    minimumLuminance = Math.min(minimumLuminance, luminance);
    maximumLuminance = Math.max(maximumLuminance, luminance);
  }
  const mean = luminanceSum / samples;
  return {
    opaqueCoverage: opaqueSamples / samples,
    luminanceStandardDeviation: Math.sqrt(
      Math.max(0, luminanceSquaredSum / samples - mean * mean),
    ),
    luminanceRange: maximumLuminance - minimumLuminance,
  };
}

function assertMetricClose(actual, expected, label, tolerance = 1e-9) {
  assert.ok(Number.isFinite(expected), `${label} metadata is non-finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} metadata drifted`);
}

/** Independently re-derive persisted metrics from the decoded PNG bytes. */
export function validatePersistedPaperImageBytes(manifest, viewName, passName, bytes) {
  assert.ok(PAPER_CAPTURE_VIEW_NAMES.includes(viewName), "Unknown persisted paper view");
  assert.ok(PAPER_CAPTURE_PASS_NAMES.includes(passName), "Unknown persisted paper pass");
  const view = manifest.views?.[viewName];
  const pass = view?.[passName];
  assert.ok(pass, `${viewName} ${passName} metadata is missing`);
  const png = PNG.sync.read(bytes);
  assert.deepEqual([png.width, png.height], [WIDTH, HEIGHT]);
  assert.equal(paperEvidenceSha256(bytes), pass.sha256, `${viewName} ${passName} hash drifted`);
  assert.equal(bytes.length, pass.bytes, `${viewName} ${passName} byte count drifted`);
  const camera = recomputeCameraSanity(view.camera, viewName);

  if (passName === "beauty") {
    const metrics = recomputeBeautyMetrics(png);
    assert.ok(metrics.opaqueCoverage >= 0.5, `${viewName} persisted beauty is blank`);
    assert.ok(metrics.luminanceStandardDeviation >= 2.5, `${viewName} persisted beauty is flat`);
    assert.ok(metrics.luminanceRange >= 8, `${viewName} persisted beauty has no range`);
    assertMetricClose(metrics.opaqueCoverage, pass.validation.opaqueCoverage, `${viewName} opaque coverage`);
    assertMetricClose(
      metrics.luminanceStandardDeviation,
      pass.validation.luminanceStandardDeviation,
      `${viewName} luminance deviation`,
      1e-7,
    );
    assertMetricClose(metrics.luminanceRange, pass.validation.luminanceRange, `${viewName} luminance range`, 1e-7);
    return { view: viewName, pass: passName, camera, ...metrics };
  }

  let coveredPixelCount = 0;
  let backgroundPixelCount = 0;
  let minimumPreview = 255;
  let maximumPreview = 0;
  let previewSum = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const alpha = png.data[offset + 3] ?? 0;
    if (alpha === 0) {
      backgroundPixelCount++;
      continue;
    }
    coveredPixelCount++;
    if (passName === "depth") {
      const red = png.data[offset] ?? 0;
      assert.equal(png.data[offset + 1], red, `${viewName} depth PNG is not grayscale`);
      assert.equal(png.data[offset + 2], red, `${viewName} depth PNG is not grayscale`);
      minimumPreview = Math.min(minimumPreview, red);
      maximumPreview = Math.max(maximumPreview, red);
      previewSum += red;
    }
  }
  if (passName === "normal") {
    assert.equal(coveredPixelCount, pass.coveredPixelCount, `${viewName} normal coverage drifted`);
    assert.equal(backgroundPixelCount, pass.backgroundPixelCount, `${viewName} normal background drifted`);
    assert.ok(coveredPixelCount > 0, `${viewName} persisted normal is empty`);
    return { view: viewName, pass: passName, camera, coveredPixelCount, backgroundPixelCount };
  }
  if (passName === "depth") {
    assert.equal(
      pass.runtimeAttestation,
      "float32-finiteness-and-range-validated-before-lossy-png-preview",
      `${viewName} depth omitted the runtime-only float32 attestation boundary`,
    );
    assert.equal(coveredPixelCount, pass.finiteDepthPixelCount, `${viewName} depth coverage drifted`);
    assert.equal(backgroundPixelCount, pass.backgroundPixelCount, `${viewName} depth background drifted`);
    assert.equal(pass.nonFiniteDepthPixelCount, 0, `${viewName} runtime reported non-finite depth`);
    assert.equal(pass.outOfRangeDepthPixelCount, 0, `${viewName} runtime reported out-of-range depth`);
    assert.ok(coveredPixelCount > 0, `${viewName} persisted depth is empty`);
    const quantization = (pass.farMeters - pass.nearMeters) / 255;
    const decodedMinimum = pass.nearMeters + (minimumPreview / 255) * (pass.farMeters - pass.nearMeters);
    const decodedMaximum = pass.nearMeters + (maximumPreview / 255) * (pass.farMeters - pass.nearMeters);
    const decodedMean = pass.nearMeters +
      (previewSum / coveredPixelCount / 255) * (pass.farMeters - pass.nearMeters);
    assertMetricClose(decodedMinimum, pass.minimumMeters, `${viewName} depth minimum`, quantization + 1e-9);
    assertMetricClose(decodedMaximum, pass.maximumMeters, `${viewName} depth maximum`, quantization + 1e-9);
    assertMetricClose(decodedMean, pass.meanMeters, `${viewName} depth mean`, quantization + 1e-9);
    return {
      view: viewName,
      pass: passName,
      camera,
      coveredPixelCount,
      backgroundPixelCount,
      decodedMinimumMeters: decodedMinimum,
      decodedMaximumMeters: decodedMaximum,
      decodedMeanMeters: decodedMean,
      runtimeAttestedOnly: ["float32 non-finite sentinel", "unencoded out-of-range float depth"],
    };
  }
  return { view: viewName, pass: passName, camera };
}

/**
 * Validate and materialize the complete paper comparison payload. The returned
 * manifest deliberately contains file references and hashes, never data URLs.
 */
export function preparePaperCaptureEvidence(matrix, expected = {}) {
  assertCaptureContract(matrix, expected);

  const images = [];
  const views = {};
  for (const viewName of PAPER_CAPTURE_VIEW_NAMES) {
    const view = matrix.views?.[viewName];
    assert.ok(view, `Paper capture omitted ${viewName}`);
    assert.equal(view.width, WIDTH);
    assert.equal(view.height, HEIGHT);
    assert.equal(view.camera?.view, viewName);
    assert.equal(view.camera?.matrixSanity?.passed, true, `${viewName} camera matrix is invalid`);
    assert.equal(view.camera?.matrixSanity?.reflectionDetected, false, `${viewName} is reflected`);
    assert.equal(view.camera?.matrixSanity?.finite, true, `${viewName} camera is non-finite`);
    assert.equal(view.camera?.viewMatrix?.length, 16);
    assert.equal(view.camera?.projectionMatrix?.length, 16);
    recomputeCameraSanity(view.camera, viewName);

    assert.ok(view.beauty?.validation?.opaqueCoverage >= 0.5, `${viewName} beauty is blank`);
    assert.ok(
      view.beauty?.validation?.luminanceStandardDeviation >= 2.5,
      `${viewName} beauty is visually flat`,
    );
    assert.equal(view.instance?.geometry, "literal-rendered-terrain-water-and-object-meshes");
    assert.equal(view.instance?.visibility?.invalidIdPixelCount, 0);
    assert.ok(
      view.instance?.visibility?.visibleObjectCount >= 1,
      `${viewName} contains no visible literal object mesh`,
    );
    assert.equal(view.depth?.geometry, "literal-rendered-terrain-water-and-object-meshes");
    assert.equal(
      view.depth?.measurementEncoding,
      "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel",
    );
    assert.equal(
      view.depth?.finiteValidation,
      "geometry-preflight-plus-shader-sentinel-plus-float32-readback",
    );
    assert.equal(
      view.depth?.runtimeAttestation,
      "float32-finiteness-and-range-validated-before-lossy-png-preview",
    );
    assert.equal(view.depth?.nonFiniteDepthPixelCount, 0);
    assert.equal(view.depth?.outOfRangeDepthPixelCount, 0);
    assert.ok(view.depth?.finiteDepthPixelCount > 0, `${viewName} has no finite depth pixels`);
    assert.equal(view.normal?.geometry, "literal-rendered-terrain-water-and-object-meshes");
    assert.ok(view.normal?.coveredPixelCount > 0, `${viewName} has no geometry normals`);

    const persistedView = { ...view };
    for (const passName of PAPER_CAPTURE_PASS_NAMES) {
      const pass = view[passName];
      assert.equal(pass?.pass, passName, `${viewName} ${passName} metadata is inconsistent`);
      assert.equal(pass?.width, WIDTH);
      assert.equal(pass?.height, HEIGHT);
      assert.equal(pass?.postprocessingBypassed, true);
      const bytes = decodePngDataUrl(pass.dataUrl, `${viewName} ${passName}`);
      const imageFile = `paper-matrix-${viewName}-${passName}.png`;
      const { dataUrl: _dataUrl, ...metadata } = pass;
      persistedView[passName] = {
        ...metadata,
        imageFile,
        bytes: bytes.length,
        sha256: paperEvidenceSha256(bytes),
      };
      images.push({ imageFile, bytes });
    }
    views[viewName] = persistedView;
  }

  const manifest = { ...matrix, views };
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /data:image\//, "Paper manifest retained an inline image");
  assert.equal(images.length, 36, "Paper capture did not materialize all 36 images");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    manifest,
    images,
    manifestBytes,
    manifestSha256: paperEvidenceSha256(manifestBytes),
    imageSetSha256: paperCaptureImageSetDigest(manifest),
  };
}

/** Revalidate the materialized manifest before any paid model sees it. */
export function validatePersistedPaperCaptureEvidence(matrix, expected = {}) {
  assertCaptureContract(matrix, expected);
  for (const viewName of PAPER_CAPTURE_VIEW_NAMES) {
    const view = matrix.views?.[viewName];
    assert.ok(view, `Paper capture omitted ${viewName}`);
    assert.equal(view.width, WIDTH);
    assert.equal(view.height, HEIGHT);
    assert.equal(view.camera?.view, viewName);
    assert.equal(view.camera?.matrixSanity?.passed, true);
    assert.equal(view.camera?.matrixSanity?.reflectionDetected, false);
    assert.equal(view.camera?.matrixSanity?.finite, true);
    assert.equal(view.camera?.viewMatrix?.length, 16);
    assert.equal(view.camera?.projectionMatrix?.length, 16);
    recomputeCameraSanity(view.camera, viewName);
    assert.ok(view.beauty?.validation?.opaqueCoverage >= 0.5);
    assert.ok(view.beauty?.validation?.luminanceStandardDeviation >= 2.5);
    assert.equal(view.instance?.geometry, "literal-rendered-terrain-water-and-object-meshes");
    assert.equal(view.instance?.visibility?.invalidIdPixelCount, 0);
    assert.ok(view.instance?.visibility?.visibleObjectCount >= 1);
    assert.equal(view.depth?.geometry, "literal-rendered-terrain-water-and-object-meshes");
    assert.equal(
      view.depth?.measurementEncoding,
      "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel",
    );
    assert.equal(
      view.depth?.finiteValidation,
      "geometry-preflight-plus-shader-sentinel-plus-float32-readback",
    );
    assert.equal(
      view.depth?.runtimeAttestation,
      "float32-finiteness-and-range-validated-before-lossy-png-preview",
    );
    assert.equal(view.depth?.nonFiniteDepthPixelCount, 0);
    assert.equal(view.depth?.outOfRangeDepthPixelCount, 0);
    assert.ok(view.depth?.finiteDepthPixelCount > 0);
    assert.equal(view.normal?.geometry, "literal-rendered-terrain-water-and-object-meshes");
    assert.ok(view.normal?.coveredPixelCount > 0);
    for (const passName of PAPER_CAPTURE_PASS_NAMES) {
      const pass = view[passName];
      assert.equal(pass?.pass, passName);
      assert.equal(pass?.width, WIDTH);
      assert.equal(pass?.height, HEIGHT);
      assert.equal(pass?.postprocessingBypassed, true);
      assert.equal(pass?.dataUrl, undefined, `${viewName} ${passName} retained inline image data`);
      assert.equal(pass?.imageFile, `paper-matrix-${viewName}-${passName}.png`);
      assert.match(pass?.sha256 ?? "", /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(pass?.bytes) && pass.bytes > 0);
    }
  }
  assert.doesNotMatch(JSON.stringify(matrix), /data:image\//);
  return matrix;
}

/** Digest the canonical filename/hash/size ledger, independent of JSON key order. */
export function paperCaptureImageSetDigest(manifest) {
  const entries = [];
  for (const viewName of PAPER_CAPTURE_VIEW_NAMES) {
    for (const passName of PAPER_CAPTURE_PASS_NAMES) {
      const pass = manifest?.views?.[viewName]?.[passName];
      assert.equal(pass?.imageFile, `paper-matrix-${viewName}-${passName}.png`);
      assert.match(pass?.sha256 ?? "", SHA256);
      assert.ok(Number.isSafeInteger(pass?.bytes) && pass.bytes > 0);
      entries.push(`${viewName}\0${passName}\0${pass.imageFile}\0${pass.bytes}\0${pass.sha256}`);
    }
  }
  assert.equal(entries.length, 36);
  return paperEvidenceSha256(Buffer.from(entries.join("\n"), "utf8"));
}

const OMIT_VALUE = Symbol("omit-data-url");

function stripDataUrls(value, depth = 0) {
  assert.ok(depth <= 64, "Normalized plan exceeds its nesting limit");
  if (typeof value === "string") return DATA_URL.test(value.trimStart()) ? OMIT_VALUE : value;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "Normalized plan contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripDataUrls(entry, depth + 1))
      .filter((entry) => entry !== OMIT_VALUE);
  }
  assert.ok(value && typeof value === "object", "Normalized plan contains an unsupported value");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = stripDataUrls(value[key], depth + 1);
    if (normalized !== OMIT_VALUE) output[key] = normalized;
  }
  return output;
}

/** Strip every inline data alias and create the exact bounded bytes persisted by QA. */
export function prepareNormalizedScenePlanEvidence(rawPlan, expectedPrompt) {
  if (typeof rawPlan === "string") {
    assert.ok(
      rawPlan.length <= MAXIMUM_RAW_NORMALIZED_PLAN_CHARACTERS,
      "Raw normalized scene plan exceeds its input budget",
    );
  }
  const parsed = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const plan = stripDataUrls(parsed);
  if (expectedPrompt !== undefined) {
    assert.equal(plan.prompt, expectedPrompt, "Normalized plan prompt drifted");
  }
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  assert.ok(
    bytes.length > 2 && bytes.length <= NORMALIZED_SCENE_PLAN_MAX_BYTES,
    "Normalized scene plan exceeds its persisted byte budget",
  );
  assert.doesNotMatch(bytes.toString("utf8"), /(?:^|["'])data:/i, "Normalized plan retained a data URL");
  return {
    plan,
    bytes,
    sha256: paperEvidenceSha256(bytes),
  };
}

function rejectDataUrls(value, depth = 0) {
  assert.ok(depth <= 64, "Structured model output exceeds its nesting limit");
  if (typeof value === "string") {
    assert.doesNotMatch(value.trimStart(), DATA_URL, "Structured model output retained a data URL");
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "Structured model output contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => rejectDataUrls(entry, depth + 1));
  assert.ok(value && typeof value === "object", "Structured model output contains an unsupported value");
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = rejectDataUrls(value[key], depth + 1);
  return output;
}

export function prepareStructuredModelOutputEvidence(rawOutput) {
  assert.equal(typeof rawOutput, "string", "Structured model output must be JSON text");
  assert.ok(rawOutput.length > 0 && rawOutput.length <= 32_000, "Structured model output exceeds its input budget");
  const parsed = JSON.parse(rawOutput);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Structured model output must be a JSON object");
  const value = rejectDataUrls(parsed);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  assert.ok(bytes.length <= 64_000, "Structured model output exceeds its persisted byte budget");
  return { value, bytes, sha256: paperEvidenceSha256(bytes) };
}

/** Canonical digest of every structured-output file descriptor in a committee ledger. */
export function committeeStructuredOutputSetDigest(artifacts) {
  assert.ok(Array.isArray(artifacts), "Committee artifact ledger must be an array");
  const artifactIds = new Set();
  const structuredOutputFiles = new Set();
  const entries = [];
  for (const artifact of artifacts) {
    assert.equal(typeof artifact?.id, "string", "Committee artifact id is missing");
    assert.ok(artifact.id && artifact.id.length <= 200, "Committee artifact id is invalid");
    assert.ok(!artifactIds.has(artifact.id), `Committee artifact id ${artifact.id} is duplicated`);
    artifactIds.add(artifact.id);
    const descriptors = [
      artifact.structuredOutputFile,
      artifact.structuredOutputBytes,
      artifact.structuredOutputSha256,
    ];
    const present = descriptors.filter((value) => value !== null && value !== undefined).length;
    assert.ok(present === 0 || present === 3, `Artifact ${artifact.id} has a partial structured descriptor`);
    if (present === 0) continue;
    assert.equal(typeof artifact.structuredOutputFile, "string");
    assert.ok(
      !structuredOutputFiles.has(artifact.structuredOutputFile),
      `Committee structured-output file ${artifact.structuredOutputFile} is duplicated`,
    );
    structuredOutputFiles.add(artifact.structuredOutputFile);
    assert.ok(
      Number.isSafeInteger(artifact.structuredOutputBytes) && artifact.structuredOutputBytes > 0,
      `Artifact ${artifact.id} structured byte count is invalid`,
    );
    assert.match(artifact.structuredOutputSha256, SHA256);
    entries.push(
      [
        artifact.id,
        artifact.stage ?? "",
        artifact.status ?? "",
        artifact.structuredOutputFile,
        artifact.structuredOutputBytes,
        artifact.structuredOutputSha256,
      ].join("\0"),
    );
  }
  entries.sort();
  return {
    count: entries.length,
    sha256: paperEvidenceSha256(Buffer.from(entries.join("\n"), "utf8")),
  };
}

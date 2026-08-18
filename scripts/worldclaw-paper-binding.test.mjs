import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import {
  PAPER_CAPTURE_PASS_NAMES,
  PAPER_CAPTURE_VIEW_NAMES,
  committeeStructuredOutputSetDigest,
  prepareNormalizedScenePlanEvidence,
  preparePaperCaptureEvidence,
  prepareStructuredModelOutputEvidence,
} from "./worldclaw-paper-evidence.mjs";
import {
  buildPaperReviewImages,
  cropPaperReferenceMatrix,
  promptSha256,
  sha256,
  validatePaperRunBinding,
} from "./worldclaw-paper-review-lib.mjs";

const WIDTH = 640;
const HEIGHT = 360;
const PIXELS = WIDTH * HEIGHT;

function pngBytes(pixel) {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4;
      const [r, g, b, a] = pixel(x, y);
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

function beautyMetrics(bytes) {
  const png = PNG.sync.read(bytes);
  const stride = Math.max(1, Math.floor(PIXELS / 32_768));
  let samples = 0;
  let opaque = 0;
  let sum = 0;
  let squares = 0;
  let minimum = 255;
  let maximum = 0;
  for (let pixelIndex = 0; pixelIndex < PIXELS; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const luminance =
      png.data[offset] * 0.2126 +
      png.data[offset + 1] * 0.7152 +
      png.data[offset + 2] * 0.0722;
    samples++;
    if (png.data[offset + 3] >= 250) opaque++;
    sum += luminance;
    squares += luminance * luminance;
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
  }
  const mean = sum / samples;
  return {
    opaqueCoverage: opaque / samples,
    luminanceStandardDeviation: Math.sqrt(Math.max(0, squares / samples - mean * mean)),
    luminanceRange: maximum - minimum,
  };
}

function inline(bytes) {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function camera(view) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    view,
    matrixSanity: {
      passed: true,
      reflectionDetected: false,
      finite: true,
      viewDeterminant: 1,
      projectionDeterminant: 1,
      worldBasisDeterminant: 1,
    },
    viewMatrix: identity,
    projectionMatrix: identity,
  };
}

function captureFixture(binding) {
  const beautyBytes = pngBytes((x, y) => {
    const value = ((x >> 4) + (y >> 4)) % 2 === 0 ? 28 : 224;
    return [value, value, value, 255];
  });
  const instanceBytes = pngBytes((x) => (x < WIDTH / 2 ? [0, 0, 1, 255] : [0, 0, 2, 255]));
  const depthBytes = pngBytes((x) => {
    const value = x < WIDTH / 2 ? 64 : 192;
    return [value, value, value, 255];
  });
  const normalBytes = pngBytes(() => [128, 240, 128, 255]);
  const data = {
    beauty: inline(beautyBytes),
    instance: inline(instanceBytes),
    depth: inline(depthBytes),
    normal: inline(normalBytes),
  };
  const near = 1;
  const far = 11;
  const meters = (value) => near + (value / 255) * (far - near);
  const views = {};
  for (const [ordinal, viewName] of PAPER_CAPTURE_VIEW_NAMES.entries()) {
    const common = { width: WIDTH, height: HEIGHT, postprocessingBypassed: true, durationMs: 1 };
    views[viewName] = {
      role: viewName === "global" ? "global" : viewName.startsWith("region") ? "regional" : "walk",
      ordinal,
      width: WIDTH,
      height: HEIGHT,
      camera: {
        ...camera(viewName),
        ...(viewName.startsWith("region-") || viewName.startsWith("walk-")
          ? {
              region: {
                id: `semantic-${Number(viewName.split("-")[1]) - 1}`,
                requestedSemanticRole:
                  binding.regionalReadability[Number(viewName.split("-")[1]) - 1],
                selectionSource: "preregistered-semantic-role-match",
                semanticMatch: {
                  method: "plan-region-semantic-token-and-category-match",
                  score: 1,
                  matchedTerms: ["role"],
                  distinctRegion: true,
                },
              },
            }
          : {}),
      },
      beauty: {
        ...common,
        pass: "beauty",
        dataUrl: data.beauty,
        validation: beautyMetrics(beautyBytes),
      },
      instance: {
        ...common,
        pass: "instance",
        dataUrl: data.instance,
        geometry: "literal-rendered-terrain-water-and-object-meshes",
        visibility: {
          invalidIdPixelCount: 0,
          visibleObjectCount: 1,
          backgroundPixelCount: 0,
          visibleLogicalIds: ["object:one", "surface:terrain"],
          visibleObjectIds: ["object:one"],
          visiblePixelsByLogicalId: {
            "surface:terrain": PIXELS / 2,
            "object:one": PIXELS / 2,
          },
        },
      },
      depth: {
        ...common,
        pass: "depth",
        dataUrl: data.depth,
        geometry: "literal-rendered-terrain-water-and-object-meshes",
        measurementEncoding: "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel",
        finiteValidation: "geometry-preflight-plus-shader-sentinel-plus-float32-readback",
        runtimeAttestation: "float32-finiteness-and-range-validated-before-lossy-png-preview",
        finiteDepthPixelCount: PIXELS,
        nonFiniteDepthPixelCount: 0,
        outOfRangeDepthPixelCount: 0,
        backgroundPixelCount: 0,
        nearMeters: near,
        farMeters: far,
        minimumMeters: meters(64),
        maximumMeters: meters(192),
        meanMeters: (meters(64) + meters(192)) / 2,
      },
      normal: {
        ...common,
        pass: "normal",
        dataUrl: data.normal,
        geometry: "literal-rendered-terrain-water-and-object-meshes",
        coveredPixelCount: PIXELS,
        backgroundPixelCount: 0,
      },
    };
  }
  return {
    version: 1,
    worldId: "world-bound-1",
    seed: 42,
    binding,
    worldPromptSha256: binding.promptSha256,
    worldFingerprint: "0123456789abcdef",
    worldFingerprintAlgorithm: "fnv1a-dual32-canonical-world",
    capturedAt: "2026-08-12T08:01:30.000Z",
    regionalReadability: binding.regionalReadability,
    mimeType: "image/png",
    capturePolicy: {
      availableViews: PAPER_CAPTURE_VIEW_NAMES,
      capturedViews: PAPER_CAPTURE_VIEW_NAMES,
      passesPerView: PAPER_CAPTURE_PASS_NAMES,
      fixedResolution: { width: WIDTH, height: HEIGHT },
      sequential: true,
      rawPixelsRetained: false,
      beautyPipeline: "direct-lit-structural-beauty-not-visible-postprocessed-ui",
      diagnosticPipeline: "literal-geometry-direct-render-postprocessing-bypassed",
    },
    logicalIds: {
      stableAcrossViewsAndCompiledSubmeshes: true,
      source: "world-object-id-and-rendered-surface-id",
      mapping: [
        { logicalId: "surface:terrain", logicalType: "terrain", encodedId24: 1 },
        { logicalId: "object:one", logicalType: "object", encodedId24: 2 },
      ],
    },
    geometryInventory: {
      diagnosticsUseColliderProxies: false,
      compiledLogicalIdAssignmentsStable: true,
      geometryFinitePreflightPassed: true,
      nonFiniteGeometryValueCount: 0,
      missingLogicalObjectIds: [],
      unexpectedLogicalObjectIds: [],
      renderedLogicalObjectCount: 2,
      expectedLogicalObjectCount: 2,
    },
    views,
    performance: {
      encodedPayloadCharacters: Object.values(data).reduce((sum, value) => sum + value.length, 0) * 9,
    },
    materialAudit: {
      verification: "live-mesh-uuid-material-reference-and-property-fingerprint",
      originalMaterialEntryCount: 2,
      litMaterialEntryCount: 2,
      liveMaterialReferencesUnchangedDuringDiagnostics: true,
      liveMaterialPropertiesUnchangedDuringDiagnostics: true,
      originalMaterialPropertiesRestored: true,
    },
    stateAudit: {
      directLitBeautyReportedAsVisiblePostprocessingEquivalent: false,
      liveMaterialStateVerified: true,
      liveCameraStateVerified: true,
      worldFingerprintVerified: true,
    },
    isolation: {
      worldDataMutated: false,
      liveCameraMutated: false,
      liveMaterialsUsedForDiagnostics: false,
      diagnosticPostprocessingBypassed: true,
      rendererStateRestored: true,
      uiViewModeRestored: true,
      uiSelectionRestored: true,
    },
  };
}

async function writeBoundRun(directory) {
  const runId = "2026-08-12T08-01-00-000Z";
  const suiteId = "2026-08-12T08-00-00-000Z";
  const prompt = "exact paper benchmark prompt";
  const caseId = "figure-12-bound-evidence-fixture";
  const caseToken = "a".repeat(48);
  const regionalReadability = ["role one", "role two", "role three", "role four"];
  const binding = {
    suiteId,
    caseId,
    caseToken,
    promptSha256: promptSha256(prompt),
    regionalReadability,
  };
  const generatedWorld = { id: "world-bound-1", seed: 42, promptSha256: binding.promptSha256 };
  const capture = preparePaperCaptureEvidence(captureFixture(binding), {
    binding,
    generatedWorld,
    regionalRoles: regionalReadability,
  });
  await Promise.all(
    capture.images.map((entry) => writeFile(join(directory, entry.imageFile), entry.bytes)),
  );
  await writeFile(join(directory, "paper_capture_matrix.json"), capture.manifestBytes);

  const normalized = prepareNormalizedScenePlanEvidence({
    prompt,
    layoutImageUrl: "data:image/png;base64,removed",
    regions: [],
  }, prompt);
  await writeFile(join(directory, "normalized_scene_plan.json"), normalized.bytes);
  const reference = pngBytes((x, y) => [20 + (x % 200), 40 + (y % 180), 80, 255]);
  const images = {};
  for (const key of ["canonicalMap", "semanticMap", "appearanceConcept"]) {
    const imageFile = `prebuild-${key}.png`;
    await writeFile(join(directory, imageFile), reference);
    images[key] = { imageFile, bytes: reference.length, sha256: sha256(reference) };
  }
  const normalizedPlan = {
    file: "normalized_scene_plan.json",
    bytes: normalized.bytes.length,
    sha256: normalized.sha256,
  };
  const prebuild = { version: 2, runId, binding, generatedWorld, normalizedPlan, images };
  const prebuildBytes = Buffer.from(`${JSON.stringify(prebuild, null, 2)}\n`);
  await writeFile(join(directory, "prebuild_reference_manifest.json"), prebuildBytes);
  const structured = prepareStructuredModelOutputEvidence(
    JSON.stringify({ plan: { prompt, regions: [] }, layoutPrompt: "fixture" }),
  );
  const structuredOutputFile = "committee-planning-selected-structured.json";
  await writeFile(join(directory, structuredOutputFile), structured.bytes);
  const committeeLedger = {
    version: 2,
    runId,
    binding,
    generatedWorld,
    status: "retained",
    artifacts: [
      {
        id: "planning-selected",
        provider: "xai",
        requestedModel: "grok-4.5",
        model: "grok-4.5",
        responseId: "resp-fixture-planning-selected",
        identityAttestation: "provider-response",
        stage: "planning",
        status: "selected",
        structuredOutputFile,
        structuredOutputBytes: structured.bytes.length,
        structuredOutputSha256: structured.sha256,
      },
      {
        id: "critique-gemini-same-provider-local-id",
        provider: "gemini",
        requestedModel: "gemini-3.6-flash",
        model: "gemini-3.6-flash",
        responseId: "resp-fixture-planning-selected",
        identityAttestation: "provider-response",
        stage: "critique",
        status: "rejected",
        parentArtifactIds: ["planning-selected"],
      },
      {
        id: "asset-variant-offline",
        provider: "xai",
        requestedModel: null,
        model: "worldclaw-authored-asset-library",
        responseId: null,
        identityAttestation: null,
        stage: "asset_variant",
        status: "selected",
        parentArtifactIds: ["planning-selected"],
      },
    ],
  };
  const committeeLedgerBytes = Buffer.from(`${JSON.stringify(committeeLedger, null, 2)}\n`);
  await writeFile(join(directory, "model_committee_ledger.json"), committeeLedgerBytes);
  const committeeStructuredOutputSet = committeeStructuredOutputSetDigest(
    committeeLedger.artifacts,
  );
  const prebuildDescriptor = {
    file: "prebuild_reference_manifest.json",
    bytes: prebuildBytes.length,
    sha256: sha256(prebuildBytes),
  };
  const status = {
    runId,
    status: "passed",
    startedAt: "2026-08-12T08:01:00.000Z",
    finishedAt: "2026-08-12T08:02:00.000Z",
    binding,
    generatedWorld,
    prebuildEvidence: { manifest: prebuildDescriptor, normalizedPlan, images },
    committeeEvidence: {
      manifest: {
        file: "model_committee_ledger.json",
        bytes: committeeLedgerBytes.length,
        sha256: sha256(committeeLedgerBytes),
      },
      structuredOutputSetSha256: committeeStructuredOutputSet.sha256,
      structuredOutputCount: committeeStructuredOutputSet.count,
    },
    paperCaptureEvidence: {
      manifest: {
        file: "paper_capture_matrix.json",
        bytes: capture.manifestBytes.length,
        sha256: capture.manifestSha256,
      },
      imageSetSha256: capture.imageSetSha256,
      imageCount: 36,
      capturedAt: capture.manifest.capturedAt,
      worldFingerprint: capture.manifest.worldFingerprint,
    },
  };
  await writeFile(join(directory, "generation_status.json"), `${JSON.stringify(status, null, 2)}\n`);
  const referencePath = join(directory, "reference.png");
  await writeFile(referencePath, reference);
  const crop = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const panel = cropPaperReferenceMatrix(reference, crop);
  const paperCase = {
    id: caseId,
    prompt,
    referenceImagePath: referencePath,
    referenceSha256: sha256(reference),
    referencePanelCrop: crop,
    referencePanelSha256: sha256(panel),
    regionalReadability,
  };
  return { runId, suiteId, caseToken, binding, generatedWorld, capture, prebuild, status, paperCase };
}

test("review reopens exact bound files and rejects stale, missing, and hash-drifted evidence", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "worldclaw-paper-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await writeBoundRun(directory);
  const review = await buildPaperReviewImages(directory, fixture.paperCase);
  assert.equal(review.persistedValidation.length, 36);
  assert.equal(
    validatePaperRunBinding({
      generationStatus: fixture.status,
      captureManifest: review.manifest,
      paperCase: fixture.paperCase,
      suiteId: fixture.suiteId,
      caseToken: fixture.caseToken,
      runId: fixture.runId,
    }).worldId,
    fixture.generatedWorld.id,
  );

  const committeePath = join(directory, "model_committee_ledger.json");
  const duplicateWithinProvider = JSON.parse(await readFile(committeePath, "utf8"));
  duplicateWithinProvider.artifacts[1].provider = "xai";
  duplicateWithinProvider.artifacts[1].requestedModel = "grok-4.5";
  duplicateWithinProvider.artifacts[1].model = "grok-4.5";
  const duplicateWithinProviderBytes = Buffer.from(
    `${JSON.stringify(duplicateWithinProvider, null, 2)}\n`,
  );
  const duplicateWithinProviderStatus = structuredClone(fixture.status);
  duplicateWithinProviderStatus.committeeEvidence.manifest.bytes =
    duplicateWithinProviderBytes.length;
  duplicateWithinProviderStatus.committeeEvidence.manifest.sha256 = sha256(
    duplicateWithinProviderBytes,
  );
  await writeFile(committeePath, duplicateWithinProviderBytes);
  await writeFile(
    join(directory, "generation_status.json"),
    `${JSON.stringify(duplicateWithinProviderStatus, null, 2)}\n`,
  );
  await assert.rejects(
    () => buildPaperReviewImages(directory, fixture.paperCase),
    /replayed across xai artifacts/,
  );
  const originalCommitteeBytes = Buffer.from(
    `${JSON.stringify(
      {
        ...duplicateWithinProvider,
        artifacts: duplicateWithinProvider.artifacts.map((artifact, index) =>
          index === 1
            ? {
                ...artifact,
                provider: "gemini",
                requestedModel: "gemini-3.6-flash",
                model: "gemini-3.6-flash",
              }
            : artifact,
        ),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(committeePath, originalCommitteeBytes);
  await writeFile(
    join(directory, "generation_status.json"),
    `${JSON.stringify(fixture.status, null, 2)}\n`,
  );

  const staleManifest = structuredClone(fixture.capture.manifest);
  staleManifest.binding.caseToken = "b".repeat(48);
  const staleBytes = Buffer.from(`${JSON.stringify(staleManifest, null, 2)}\n`);
  const staleStatus = structuredClone(fixture.status);
  staleStatus.paperCaptureEvidence.manifest.bytes = staleBytes.length;
  staleStatus.paperCaptureEvidence.manifest.sha256 = sha256(staleBytes);
  await writeFile(join(directory, "paper_capture_matrix.json"), staleBytes);
  await writeFile(join(directory, "generation_status.json"), `${JSON.stringify(staleStatus, null, 2)}\n`);
  await assert.rejects(
    () => buildPaperReviewImages(directory, fixture.paperCase),
    /Capture\/generation binding drifted/,
  );

  await writeFile(join(directory, "paper_capture_matrix.json"), fixture.capture.manifestBytes);
  await writeFile(join(directory, "generation_status.json"), `${JSON.stringify(fixture.status, null, 2)}\n`);
  const beautyPath = join(directory, "paper-matrix-global-beauty.png");
  const originalBeauty = await readFile(beautyPath);
  const changedBeauty = PNG.sync.read(originalBeauty);
  changedBeauty.data[0] ^= 32;
  await writeFile(beautyPath, PNG.sync.write(changedBeauty));
  await assert.rejects(
    () => buildPaperReviewImages(directory, fixture.paperCase),
    /hash drifted|byte count drifted/,
  );
  await writeFile(beautyPath, originalBeauty);

  const missingPrebuild = structuredClone(fixture.prebuild);
  delete missingPrebuild.images.semanticMap;
  const missingBytes = Buffer.from(`${JSON.stringify(missingPrebuild, null, 2)}\n`);
  const missingStatus = structuredClone(fixture.status);
  missingStatus.prebuildEvidence.manifest.bytes = missingBytes.length;
  missingStatus.prebuildEvidence.manifest.sha256 = sha256(missingBytes);
  missingStatus.prebuildEvidence.images = missingPrebuild.images;
  await writeFile(join(directory, "prebuild_reference_manifest.json"), missingBytes);
  await writeFile(join(directory, "generation_status.json"), `${JSON.stringify(missingStatus, null, 2)}\n`);
  await assert.rejects(
    () => buildPaperReviewImages(directory, fixture.paperCase),
    /prebuild image set is incomplete/i,
  );

  const originalPrebuildBytes = Buffer.from(`${JSON.stringify(fixture.prebuild, null, 2)}\n`);
  await writeFile(join(directory, "prebuild_reference_manifest.json"), originalPrebuildBytes);
  const staleCommittee = JSON.parse(await readFile(committeePath, "utf8"));
  staleCommittee.runId = "2026-08-12T07-59-00-000Z";
  const staleCommitteeBytes = Buffer.from(`${JSON.stringify(staleCommittee, null, 2)}\n`);
  const staleCommitteeStatus = structuredClone(fixture.status);
  staleCommitteeStatus.committeeEvidence.manifest.bytes = staleCommitteeBytes.length;
  staleCommitteeStatus.committeeEvidence.manifest.sha256 = sha256(staleCommitteeBytes);
  await writeFile(committeePath, staleCommitteeBytes);
  await writeFile(
    join(directory, "generation_status.json"),
    `${JSON.stringify(staleCommitteeStatus, null, 2)}\n`,
  );
  await assert.rejects(
    () => buildPaperReviewImages(directory, fixture.paperCase),
    /Committee run id drifted/,
  );
});

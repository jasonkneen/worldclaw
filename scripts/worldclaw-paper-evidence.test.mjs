import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { test } from "node:test";
import {
  PAPER_CAPTURE_PASS_NAMES,
  PAPER_CAPTURE_VIEW_NAMES,
  committeeStructuredOutputSetDigest,
  paperCaptureImageSetDigest,
  preparePaperCaptureEvidence,
  prepareNormalizedScenePlanEvidence,
  prepareStructuredModelOutputEvidence,
  validatePersistedPaperCaptureEvidence,
  validatePersistedPaperImageBytes,
} from "./worldclaw-paper-evidence.mjs";

function pngDataUrl() {
  const png = new PNG({ width: 640, height: 360 });
  png.data.fill(255);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

function fixture() {
  const dataUrl = pngDataUrl();
  const views = {};
  for (const [ordinal, name] of PAPER_CAPTURE_VIEW_NAMES.entries()) {
    const common = {
      dataUrl,
      width: 640,
      height: 360,
      postprocessingBypassed: true,
      durationMs: 1,
    };
    views[name] = {
      role: name === "global" ? "global" : name.startsWith("region") ? "regional" : "walk",
      ordinal,
      width: 640,
      height: 360,
      camera: {
        view: name,
        matrixSanity: {
          passed: true,
          reflectionDetected: false,
          finite: true,
          viewDeterminant: 1,
          projectionDeterminant: 1,
          worldBasisDeterminant: 1,
        },
        viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      beauty: {
        ...common,
        pass: "beauty",
        validation: {
          opaqueCoverage: 1,
          luminanceStandardDeviation: 12,
          luminanceRange: 40,
        },
      },
      instance: {
        ...common,
        pass: "instance",
        geometry: "literal-rendered-terrain-water-and-object-meshes",
        visibility: {
          invalidIdPixelCount: 0,
          visibleObjectCount: 2,
          backgroundPixelCount: 0,
          visibleLogicalIds: ["surface:terrain", "object:one"],
          visibleObjectIds: ["object:one"],
          visiblePixelsByLogicalId: { "surface:terrain": 1, "object:one": 1 },
        },
      },
      depth: {
        ...common,
        pass: "depth",
        geometry: "literal-rendered-terrain-water-and-object-meshes",
        measurementEncoding: "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel",
        finiteValidation: "geometry-preflight-plus-shader-sentinel-plus-float32-readback",
        runtimeAttestation:
          "float32-finiteness-and-range-validated-before-lossy-png-preview",
        nonFiniteDepthPixelCount: 0,
        outOfRangeDepthPixelCount: 0,
        finiteDepthPixelCount: 10,
      },
      normal: {
        ...common,
        pass: "normal",
        geometry: "literal-rendered-terrain-water-and-object-meshes",
        coveredPixelCount: 10,
      },
    };
  }
  return {
    version: 1,
    worldId: "world-1",
    seed: 7,
    mimeType: "image/png",
    capturePolicy: {
      availableViews: PAPER_CAPTURE_VIEW_NAMES,
      capturedViews: PAPER_CAPTURE_VIEW_NAMES,
      passesPerView: PAPER_CAPTURE_PASS_NAMES,
      fixedResolution: { width: 640, height: 360 },
      sequential: true,
      rawPixelsRetained: false,
      beautyPipeline: "direct-lit-structural-beauty-not-visible-postprocessed-ui",
      diagnosticPipeline: "literal-geometry-direct-render-postprocessing-bypassed",
    },
    logicalIds: {
      stableAcrossViewsAndCompiledSubmeshes: true,
      source: "world-object-id-and-rendered-surface-id",
      mapping: [
        { logicalId: "surface:terrain", logicalType: "terrain", encodedId24: 0xffffff },
        { logicalId: "object:one", logicalType: "object", encodedId24: 0xfffffe },
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
    performance: { encodedPayloadCharacters: 10_000 },
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

test("paper matrix materializes 36 PNGs and a data-URL-free manifest", () => {
  const result = preparePaperCaptureEvidence(fixture());
  assert.equal(result.images.length, 36);
  assert.equal(new Set(result.images.map((image) => image.imageFile)).size, 36);
  assert.doesNotMatch(JSON.stringify(result.manifest), /data:image\//);
  assert.match(result.manifest.views.global.beauty.sha256, /^[a-f0-9]{64}$/);
});

test("paper matrix fails closed on reflected cameras and incomplete geometry", () => {
  const reflected = fixture();
  reflected.views["walk-2"].camera.matrixSanity.reflectionDetected = true;
  reflected.views["walk-2"].camera.matrixSanity.passed = false;
  assert.throws(() => preparePaperCaptureEvidence(reflected), /camera matrix is invalid/);

  const missing = fixture();
  missing.geometryInventory.missingLogicalObjectIds = ["obj_missing"];
  assert.throws(() => preparePaperCaptureEvidence(missing));
});

test("persisted paper evidence is fully revalidated and rejects substituted files", () => {
  const { manifest } = preparePaperCaptureEvidence(fixture());
  assert.equal(validatePersistedPaperCaptureEvidence(manifest), manifest);
  manifest.views.global.beauty.imageFile = "../substituted.png";
  assert.throws(
    () => validatePersistedPaperCaptureEvidence(manifest),
    /paper-matrix-global-beauty/,
  );
});

test("bound paper evidence carries exact case and browser-computed world identity", () => {
  const bound = fixture();
  bound.binding = {
    suiteId: "2026-08-12T08-00-00-000Z",
    caseId: "figure-12-japanese-island-towns",
    caseToken: "a".repeat(48),
    promptSha256: "b".repeat(64),
    regionalReadability: ["role one", "role two", "role three", "role four"],
  };
  bound.regionalReadability = bound.binding.regionalReadability;
  for (let index = 0; index < 4; index++) {
    const evidence = {
      id: `semantic-${index}`,
      requestedSemanticRole: bound.regionalReadability[index],
      selectionSource: "preregistered-semantic-role-match",
      semanticMatch: {
        method: "plan-region-semantic-token-and-category-match",
        score: 1,
        matchedTerms: ["role"],
        distinctRegion: true,
      },
    };
    bound.views[`region-${index + 1}`].camera.region = evidence;
    bound.views[`walk-${index + 1}`].camera.region = evidence;
  }
  bound.worldPromptSha256 = bound.binding.promptSha256;
  bound.worldFingerprint = "0123456789abcdef";
  bound.worldFingerprintAlgorithm = "fnv1a-dual32-canonical-world";
  bound.capturedAt = "2026-08-12T08:01:02.003Z";
  const result = preparePaperCaptureEvidence(bound, {
    binding: bound.binding,
    generatedWorld: { id: "world-1", seed: 7, promptSha256: bound.binding.promptSha256 },
    regionalRoles: bound.regionalReadability,
  });
  assert.equal(result.manifestSha256.length, 64);
  assert.equal(result.imageSetSha256, paperCaptureImageSetDigest(result.manifest));

  const swapped = structuredClone(bound);
  swapped.binding.caseToken = "c".repeat(48);
  assert.throws(
    () => preparePaperCaptureEvidence(swapped, { binding: bound.binding }),
    /binding drifted/,
  );
  const wrongPrompt = structuredClone(bound);
  wrongPrompt.worldPromptSha256 = "d".repeat(64);
  assert.throws(() => preparePaperCaptureEvidence(wrongPrompt), /not bound to its world prompt/);
});

test("normalized plan persistence strips every data URL alias and rejects size drift", () => {
  const evidence = prepareNormalizedScenePlanEvidence(
    {
      prompt: "paper prompt",
      layoutImageUrl: "data:image/png;base64,AAAA",
      nested: {
        perspectiveImageUrl: "  data:image/jpeg;base64,BBBB",
        preserved: "https://example.test/reference.png",
      },
      aliases: ["data:image/webp;base64,CCCC", "ordinary text"],
    },
    "paper prompt",
  );
  const serialized = evidence.bytes.toString("utf8");
  assert.doesNotMatch(serialized, /data:/i);
  assert.equal(evidence.plan.layoutImageUrl, undefined);
  assert.equal(evidence.plan.nested.perspectiveImageUrl, undefined);
  assert.deepEqual(evidence.plan.aliases, ["ordinary text"]);
  assert.equal(evidence.plan.nested.preserved, "https://example.test/reference.png");
  assert.equal(evidence.sha256.length, 64);

  assert.throws(
    () =>
      prepareNormalizedScenePlanEvidence({
        prompt: "paper prompt",
        retained: "x".repeat(256_001),
      }),
    /persisted byte budget/,
  );
});

test("decoded persisted PNG checks reject flat beauty, coverage drift, hash drift, and forged matrices", () => {
  const raw = fixture();
  const result = preparePaperCaptureEvidence(raw);
  const beautyBytes = result.images.find(
    (entry) => entry.imageFile === "paper-matrix-global-beauty.png",
  ).bytes;
  assert.throws(
    () => validatePersistedPaperImageBytes(result.manifest, "global", "beauty", beautyBytes),
    /persisted beauty is flat/,
  );
  const normalBytes = result.images.find(
    (entry) => entry.imageFile === "paper-matrix-global-normal.png",
  ).bytes;
  assert.throws(
    () => validatePersistedPaperImageBytes(result.manifest, "global", "normal", normalBytes),
    /normal coverage drifted/,
  );
  const corrupted = Buffer.from(beautyBytes);
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(
    () => validatePersistedPaperImageBytes(result.manifest, "global", "beauty", corrupted),
    /hash drifted|unrecognised content|CRC|unexpected end/i,
  );

  const forged = fixture();
  forged.views.global.camera.viewMatrix = Array(16).fill(0);
  assert.throws(() => preparePaperCaptureEvidence(forged), /camera matrix sanity failed/);
});

test("structured stage JSON is canonical, bounded, and rejects inline image aliases", () => {
  const evidence = prepareStructuredModelOutputEvidence('{"z":2,"plan":{"prompt":"exact"},"a":1}');
  assert.match(evidence.bytes.toString("utf8"), /^\{\n {2}"a": 1,/);
  assert.equal(evidence.value.plan.prompt, "exact");
  assert.equal(evidence.sha256.length, 64);
  assert.throws(
    () => prepareStructuredModelOutputEvidence('{"image":"data:image/png;base64,AAAA"}'),
    /retained a data URL/,
  );
  assert.throws(() => prepareStructuredModelOutputEvidence("[]"), /JSON object/);
});

test("structured-output set digest binds stable artifact descriptors", () => {
  const artifacts = [
    {
      id: "planning-a",
      stage: "planning",
      status: "selected",
      structuredOutputFile: "committee-planning-a-structured.json",
      structuredOutputBytes: 42,
      structuredOutputSha256: "a".repeat(64),
    },
    { id: "layout-a", stage: "layout", status: "candidate" },
  ];
  const digest = committeeStructuredOutputSetDigest(artifacts);
  assert.equal(digest.count, 1);
  assert.equal(digest.sha256.length, 64);
  assert.notEqual(
    committeeStructuredOutputSetDigest([
      { ...artifacts[0], structuredOutputSha256: "b".repeat(64) },
      artifacts[1],
    ]).sha256,
    digest.sha256,
  );
  assert.throws(
    () => committeeStructuredOutputSetDigest([artifacts[0], artifacts[0]]),
    /duplicated/,
  );
  assert.throws(
    () =>
      committeeStructuredOutputSetDigest([
        artifacts[0],
        {
          ...artifacts[0],
          id: "planning-b",
        },
      ]),
    /structured-output file .* duplicated/,
  );
});

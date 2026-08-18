import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAssetResolutionPolicy,
  buildAssetVariantEvidence,
  summarizeAssetResolution,
} from "../src/lib/worldclaw/asset-evidence.ts";

function committee() {
  return {
    providers: [
      {
        provider: "gemini",
        configured: true,
        authenticated: true,
        available: true,
        model: "gemini-3.6-flash",
      },
    ],
    artifacts: [
      {
        id: "planning-i1-gemini-candidate",
        iteration: 1,
        stage: "planning",
        provider: "gemini",
        model: "gemini-3.6-flash",
        requestedModel: "gemini-3.6-flash",
        responseId: "gemini_plan_test",
        identityAttestation: "provider-response",
        role: "Independent plan",
        status: "selected",
        parentArtifactIds: [],
        metrics: {},
        observations: [],
        conflicts: [],
      },
    ],
    selection: {
      chosenLayoutArtifactId: "layout-i1-xai",
      chosenMultiviewArtifactId: "multiview-i1-openai",
      consensusScore: 0.8,
      rationale: [],
    },
    completedIterations: 1,
    maxIterations: 2,
  };
}

function object(id, kind, node, variantId, turnaroundUri) {
  return {
    id,
    kind,
    regionId: "r0",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
    color: "#fff",
    label: kind,
    contactScore: 1,
    refined: true,
    browserAsset: node
      ? {
          prototype: kind,
          uri: "/worldclaw/assets/worldclaw-kit.glb",
          node,
          source: "blender_procedural",
          targetHeightMeters: 4,
          collider: {
            type: "box",
            centerMeters: [0, 2, 0],
            sizeMeters: [2, 4, 2],
          },
          variantId,
          evidence: turnaroundUri ? { turnaroundUri } : undefined,
        }
      : undefined,
  };
}

test("asset-variant evidence links model intent to authored GLB variants and dossiers", () => {
  const result = buildAssetVariantEvidence(committee(), {
    status: "loaded",
    manifestUri: "/worldclaw/assets/asset-library.json",
    manifest: {
      version: 1,
      library: {
        uri: "/worldclaw/assets/worldclaw-kit.glb",
        format: "glb",
        sourceUpAxis: "Z",
        runtimeUpAxis: "Y",
        metersPerUnit: 1,
        fileBudgetBytes: 2_000_000,
        maxTriangles: 30_000,
      },
      prototypes: {},
      aliases: {},
    },
    objects: [
      object(
        "house-1",
        "building",
        "ASSET_building_timber_frame_white_tile",
        "building_timber_frame_white_tile",
        "/worldclaw/assets/dossiers/building-timber-frame-white-tile-turnaround.png",
      ),
      object(
        "house-2",
        "building",
        "ASSET_building_timber_frame_white_tile",
        "building_timber_frame_white_tile",
        "/worldclaw/assets/dossiers/building-timber-frame-white-tile-turnaround.png",
      ),
    ],
    blenderPrototypeInstances: 2,
    primitiveFallbackInstances: 0,
    prototypes: ["building"],
  });
  const artifact = result.artifacts.find((entry) => entry.stage === "asset_variant");
  assert.ok(artifact);
  assert.equal(artifact.provider, "gemini");
  assert.equal(artifact.model, "gemini-3.6-flash");
  assert.equal(artifact.requestedModel, undefined);
  assert.equal(artifact.responseId, undefined);
  assert.equal(artifact.identityAttestation, undefined);
  assert.equal(artifact.status, "selected");
  assert.equal(artifact.passed, true);
  assert.equal(artifact.metrics.compiledInstances, 2);
  assert.equal(artifact.metrics.selectedNodes, 1);
  assert.equal(artifact.metrics.selectedVariants, 1);
  assert.equal(artifact.metrics.turnaroundDossiers, 1);
  assert.deepEqual(artifact.conflicts, []);
  assert.deepEqual(artifact.parentArtifactIds, [
    "layout-i1-xai",
    "multiview-i1-openai",
    "planning-i1-gemini-candidate",
  ]);
  assert.deepEqual(JSON.parse(artifact.structuredOutput), {
    resolution: {
      status: "compiled",
      manifestStatus: "loaded",
      totalInstances: 2,
      compiledInstances: 2,
      fallbackInstances: 0,
      missingInstances: 0,
    },
    manifest: {
      uri: "/worldclaw/assets/worldclaw-kit.glb",
      format: "glb",
      sourceUpAxis: "Z",
      runtimeUpAxis: "Y",
      metersPerUnit: 1,
    },
    selectedNodes: ["ASSET_building_timber_frame_white_tile"],
    selectedVariantIds: ["building_timber_frame_white_tile"],
    turnaroundEvidenceUris: [
      "/worldclaw/assets/dossiers/building-timber-frame-white-tile-turnaround.png",
    ],
    primitiveFallbacks: [],
  });
});

test("asset-variant evidence keeps primitive fallback as an explicit failed conflict", () => {
  const result = buildAssetVariantEvidence(committee(), {
    status: "loaded",
    manifestUri: "/worldclaw/assets/asset-library.json",
    manifest: {
      version: 1,
      library: {
        uri: "/worldclaw/assets/worldclaw-kit.glb",
        format: "glb",
        sourceUpAxis: "Z",
        runtimeUpAxis: "Y",
        metersPerUnit: 1,
        fileBudgetBytes: 2_000_000,
        maxTriangles: 30_000,
      },
      prototypes: {},
      aliases: {},
    },
    objects: [object("dragon-1", "dragon")],
    blenderPrototypeInstances: 0,
    primitiveFallbackInstances: 1,
    prototypes: [],
  });
  const artifact = result.artifacts.find((entry) => entry.stage === "asset_variant");
  assert.equal(artifact.passed, false);
  assert.equal(artifact.metrics.primitiveFallbackInstances, 1);
  assert.match(artifact.conflicts[0], /^dragon: 1 placed instance lacks an authored GLB/);
  assert.deepEqual(JSON.parse(artifact.structuredOutput).primitiveFallbacks, [
    { kind: "dragon", count: 1 },
  ]);
  assert.deepEqual(JSON.parse(artifact.structuredOutput).resolution, {
    status: "fallback",
    manifestStatus: "loaded",
    totalInstances: 1,
    compiledInstances: 0,
    fallbackInstances: 1,
    missingInstances: 0,
  });
});

test("strict asset resolution fails before review when any primitive fallback remains", () => {
  const resolution = {
    status: "loaded",
    manifestUri: "/worldclaw/assets/asset-library.json",
    manifest: {
      version: 1,
      library: {
        uri: "/worldclaw/assets/worldclaw-kit.glb",
        format: "glb",
        sourceUpAxis: "Z",
        runtimeUpAxis: "Y",
        metersPerUnit: 1,
        fileBudgetBytes: 2_000_000,
        maxTriangles: 30_000,
      },
      prototypes: {},
      aliases: {},
    },
    objects: [object("house-1", "building", "ASSET_building"), object("dragon-1", "dragon")],
    blenderPrototypeInstances: 1,
    primitiveFallbackInstances: 1,
    prototypes: ["building"],
  };

  assert.throws(
    () => assertAssetResolutionPolicy(resolution, { strictAssetResolution: true }),
    /Strict asset resolution failed before final review.*compiled=1.*fallback=1.*missing=0/i,
  );
});

test("ordinary mode retains honest primitive fallback evidence", () => {
  const resolution = {
    status: "loaded",
    manifestUri: "/worldclaw/assets/asset-library.json",
    manifest: {
      version: 1,
      library: {
        uri: "/worldclaw/assets/worldclaw-kit.glb",
        format: "glb",
        sourceUpAxis: "Z",
        runtimeUpAxis: "Y",
        metersPerUnit: 1,
        fileBudgetBytes: 2_000_000,
        maxTriangles: 30_000,
      },
      prototypes: {},
      aliases: {},
    },
    objects: [object("dragon-1", "dragon")],
    blenderPrototypeInstances: 0,
    primitiveFallbackInstances: 1,
    prototypes: [],
  };

  assert.deepEqual(
    assertAssetResolutionPolicy(resolution, {}),
    summarizeAssetResolution(resolution),
  );
  assert.deepEqual(summarizeAssetResolution(resolution), {
    status: "fallback",
    manifestStatus: "loaded",
    totalInstances: 1,
    compiledInstances: 0,
    fallbackInstances: 1,
    missingInstances: 0,
  });
});

test("missing manifests report missing instances separately from intentional fallback", () => {
  const resolution = {
    status: "unavailable",
    manifestUri: "/worldclaw/assets/asset-library.json",
    error: "HTTP 404",
    objects: [object("dragon-1", "dragon")],
    blenderPrototypeInstances: 0,
    primitiveFallbackInstances: 1,
    prototypes: [],
  };

  assert.deepEqual(summarizeAssetResolution(resolution), {
    status: "missing",
    manifestStatus: "unavailable",
    totalInstances: 1,
    compiledInstances: 0,
    fallbackInstances: 0,
    missingInstances: 1,
  });
  assert.throws(
    () => assertAssetResolutionPolicy(resolution, { strictAssetResolution: true }),
    /status=missing.*fallback=0.*missing=1.*manifest=HTTP 404/i,
  );
});

test("template runs do not receive a fabricated model provider", () => {
  assert.equal(
    buildAssetVariantEvidence(undefined, {
      status: "unavailable",
      manifestUri: "/worldclaw/assets/asset-library.json",
      objects: [],
      blenderPrototypeInstances: 0,
      primitiveFallbackInstances: 0,
      prototypes: [],
    }),
    undefined,
  );
});

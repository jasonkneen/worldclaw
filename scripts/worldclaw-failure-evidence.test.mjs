import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenerationFailureEvidence } from "../src/lib/worldclaw/store.ts";

test("failed-run metadata counts the bounded committee snapshot without duplicating images", () => {
  const providers = Array.from({ length: 6 }, (_, index) => ({
    provider: ["xai", "gemini", "openai", "anthropic"][index % 4],
    configured: true,
    authenticated: true,
    available: true,
    model: `model-${index}`,
  }));
  const artifacts = Array.from({ length: 130 }, (_, index) => ({
    id: `artifact-${index}`,
    iteration: 1,
    stage: index % 2 === 0 ? "layout" : "multiview",
    provider: "xai",
    model: "test-image-model",
    role: "bounded failure evidence",
    status: "candidate",
    imageDataUrl: `data:image/png;base64,${index}`,
    parentArtifactIds: [],
    metrics: {},
    observations: [],
    conflicts: [],
  }));
  const ensemble = {
    providers,
    artifacts,
    completedIterations: 12,
    maxIterations: 12,
  };

  const result = createGenerationFailureEvidence(
    `  placement   failed ${"x".repeat(2_000)}  `,
    "object_place",
    4,
    ensemble,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.stage, "object_place");
  assert.equal(result.progress, 1);
  assert.equal(result.message.length, 1_200);
  assert.equal(result.committee.providerCount, 4);
  assert.equal(result.committee.artifactCount, 128);
  assert.equal(result.committee.imageArtifactCount, 12);
  assert.equal(result.committee.completedIterations, 8);
  assert.equal(result.committee.maxIterations, 8);
  assert.doesNotMatch(JSON.stringify(result), /data:image/);
});

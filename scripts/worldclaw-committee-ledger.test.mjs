import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCommitteeLedgerSnapshots } from "./worldclaw-committee-ledger.mjs";

test("a second empty failure snapshot cannot erase a retained committee ledger", () => {
  const first = {
    status: "failed-retained",
    completedIterations: "1",
    maximumIterations: "2",
    providers: [
      {
        provider: "xai",
        configured: "true",
        authenticated: "true",
        available: "true",
        text: "xai grok-4.5 ready",
      },
    ],
    selection: {
      chosenLayoutArtifactId: "layout-xai",
      chosenMultiviewArtifactId: "multiview-openai",
      consensusScore: "0.82",
      rationale: ["retained before placement failure"],
    },
    artifacts: [
      {
        id: "layout-xai",
        provider: "xai",
        stage: "layout",
        status: "selected",
        iteration: "1",
        imageRetained: "true",
        imageFile: "committee-layout-xai.jpg",
      },
      {
        id: "multiview-openai",
        provider: "openai",
        stage: "multiview",
        status: "selected",
        iteration: "1",
        imageRetained: "true",
        imageFile: "committee-multiview-openai.jpg",
      },
    ],
  };
  const remountingSnapshot = {
    status: "not-retained",
    completedIterations: null,
    maximumIterations: null,
    providers: [],
    selection: null,
    artifacts: [],
  };

  const merged = mergeCommitteeLedgerSnapshots(
    first,
    remountingSnapshot,
    "Regional placement contract failed",
  );
  assert.equal(merged.status, "failed-retained");
  assert.equal(merged.providers.length, 1);
  assert.equal(merged.artifacts.length, 2);
  assert.equal(merged.selection.chosenLayoutArtifactId, "layout-xai");
  assert.equal(merged.artifacts[0].imageFile, "committee-layout-xai.jpg");
  assert.equal(merged.failure.status, "failed");
  assert.equal(merged.failure.message, "Regional placement contract failed");
});

test("a later richer snapshot adds rows without duplicating stable artifact ids", () => {
  const previous = {
    status: "retained",
    providers: [{ provider: "xai", configured: "true" }],
    artifacts: [{ id: "layout-xai", stage: "layout", imageFile: "layout.jpg" }],
  };
  const next = {
    status: "failed-retained",
    providers: [
      { provider: "xai", configured: "true", available: "true", model: "grok-4.5" },
      { provider: "gemini", configured: "true", available: "true" },
    ],
    artifacts: [
      { id: "layout-xai", stage: "layout", status: "selected" },
      { id: "multiview-gemini", stage: "multiview", imageFile: "multiview.jpg" },
    ],
  };

  const merged = mergeCommitteeLedgerSnapshots(previous, next, "failed later");
  assert.equal(merged.providers.length, 2);
  assert.equal(merged.artifacts.length, 2);
  assert.equal(merged.artifacts[0].imageFile, "layout.jpg");
  assert.equal(merged.artifacts[0].status, "selected");
});

test("an old retained snapshot is labeled as failed when the retry carries failure metadata", () => {
  const retained = {
    status: "retained",
    providers: [{ provider: "xai", model: "grok-4.5" }],
    artifacts: [{ id: "layout-xai", imageFile: "layout.jpg" }],
  };
  const sparse = { status: "not-retained", providers: [], artifacts: [] };
  const merged = mergeCommitteeLedgerSnapshots(retained, sparse, "placement failed");
  assert.equal(merged.status, "failed-retained");
  assert.equal(merged.artifacts[0].imageFile, "layout.jpg");
});

test("a sparse remount cannot erase persisted structured-output descriptors", () => {
  const retained = {
    status: "retained",
    artifacts: [
      {
        id: "planning-xai",
        stage: "planning",
        status: "selected",
        structuredOutputFile: "committee-planning-xai-structured.json",
        structuredOutputBytes: 123,
        structuredOutputSha256: "a".repeat(64),
      },
    ],
  };
  const sparse = {
    status: "failed-retained",
    artifacts: [
      {
        id: "planning-xai",
        stage: "planning",
        status: "selected",
        structuredOutputFile: null,
        structuredOutputBytes: null,
        structuredOutputSha256: null,
      },
    ],
  };
  const merged = mergeCommitteeLedgerSnapshots(retained, sparse, "later failure");
  assert.equal(
    merged.artifacts[0].structuredOutputFile,
    "committee-planning-xai-structured.json",
  );
  assert.equal(merged.artifacts[0].structuredOutputBytes, 123);
  assert.equal(merged.artifacts[0].structuredOutputSha256, "a".repeat(64));
});

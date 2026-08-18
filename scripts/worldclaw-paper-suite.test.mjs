import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  persistPaidInferenceEvidence,
  reconstructTerminatedPaidInferenceLedger,
  startPaidInferenceJsonlCollector,
  validatePaidInferenceEvidence,
} from "./worldclaw-paid-benchmark-lib.mjs";
import { cropPaperReferenceMatrix, sha256 as hashBytes } from "./worldclaw-paper-review-lib.mjs";
import {
  PAPER_GENERATION_ATTEMPT_BUDGET,
  PAPER_GENERATION_MODEL_ENVIRONMENT,
  PAPER_GENERATION_PAID_RUN_CONFIG,
  PAPER_REVIEW_PAID_RUN_CONFIG,
  PAPER_SUITE_CONTRACT,
  PAPER_SUITE_TIMEOUTS_MS,
  auditPaperGenerationLedger,
  validatePaperCaseIdentity,
  validatePaperSuiteManifest,
} from "./worldclaw-paper-suite-lib.mjs";
import { XAI_TEXT_MODEL_DEFAULT } from "../src/lib/worldclaw/model-ids.ts";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL(
  "../assets/worldclaw/reference-validation/paper_prompt_suite.json",
  import.meta.url,
);

async function sha256(url) {
  return createHash("sha256")
    .update(await readFile(url))
    .digest("hex");
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestUrl, "utf8"));
}

test("paper prompt suite is tied to the exact local PDF", async () => {
  const manifest = await loadManifest();
  const primaryPdf = new URL(manifest.paper.pdf, root);
  const attachmentPdf = new URL(`attachments/${manifest.paper.pdf}`, root);
  assert.equal(await sha256(primaryPdf), manifest.paper.sha256);
  assert.equal(await sha256(attachmentPdf), manifest.paper.sha256);
});

test("paper prompt suite covers every qualitative figure exactly once", async () => {
  const manifest = await loadManifest();
  const contract = validatePaperSuiteManifest(manifest);
  assert.equal(contract.caseCount, 11);
  assert.deepEqual(contract.caseIds, PAPER_SUITE_CONTRACT.caseIds);
  assert.deepEqual(contract.sharedAxes, PAPER_SUITE_CONTRACT.sharedAxes);
  assert.equal(contract.strictWinAxesRequired, 4);
  assert.deepEqual(manifest.paper.qualitativeFigures, [4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(manifest.cases.length, 11);
  assert.deepEqual(
    manifest.cases.map((entry) => entry.figure),
    manifest.paper.qualitativeFigures,
  );
  assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, manifest.cases.length);
  assert.equal(new Set(manifest.cases.map((entry) => entry.pdfPage)).size, manifest.cases.length);
});

test("paper prompt suite fails closed when preregistered IDs, axes, threshold, or prompts drift", async () => {
  const manifest = await loadManifest();
  const duplicateId = structuredClone(manifest);
  duplicateId.cases[10].id = duplicateId.cases[0].id;
  assert.throws(() => validatePaperSuiteManifest(duplicateId), /case IDs/);

  const changedAxis = structuredClone(manifest);
  changedAxis.claimPolicy.sharedAxes[0] = "different_axis";
  assert.throws(() => validatePaperSuiteManifest(changedAxis), /shared axes/);

  for (const threshold of [0, 7]) {
    const invalidThreshold = structuredClone(manifest);
    invalidThreshold.claimPolicy.strictWinAxesRequiredAtSuiteMedian = threshold;
    assert.throws(() => validatePaperSuiteManifest(invalidThreshold), /strict-win threshold/);
  }

  const changedPrompt = structuredClone(manifest);
  changedPrompt.cases[0].prompt += " drift";
  assert.throws(() => validatePaperSuiteManifest(changedPrompt), /prompt hash drifted/);

  const changedReference = structuredClone(manifest);
  changedReference.cases[0].referenceImage = "screenshots/paper-reference/substituted.png";
  assert.throws(
    () => validatePaperSuiteManifest(changedReference),
    /manifest contract hash drifted/,
  );

  const changedPanelHash = structuredClone(manifest);
  changedPanelHash.cases[0].referencePanelSha256 = "0".repeat(64);
  assert.throws(
    () => validatePaperSuiteManifest(changedPanelHash),
    /manifest contract hash drifted/,
  );

  const changedPdfHash = structuredClone(manifest);
  changedPdfHash.paper.sha256 = "0".repeat(64);
  assert.throws(() => validatePaperSuiteManifest(changedPdfHash), /manifest contract hash drifted/);

  const weakenedExpectedEvidence = structuredClone(manifest);
  weakenedExpectedEvidence.cases[0].objectFamilies.pop();
  assert.throws(
    () => validatePaperSuiteManifest(weakenedExpectedEvidence),
    /manifest contract hash drifted/,
  );

  const reorderedRoles = structuredClone(manifest);
  reorderedRoles.cases[0].regionalReadability.reverse();
  assert.throws(() => validatePaperSuiteManifest(reorderedRoles), /regional role hash drifted/);
});

test("paper case identity includes the exact ordered regional roles", async () => {
  const manifest = await loadManifest();
  const entry = manifest.cases[0];
  const expected = {
    suiteId: "2026-08-12T09-30-00-000Z",
    caseId: entry.id,
    caseToken: "a".repeat(48),
    promptSha256: PAPER_SUITE_CONTRACT.casePromptSha256[entry.id],
    regionalReadability: entry.regionalReadability,
  };
  assert.deepEqual(validatePaperCaseIdentity(structuredClone(expected), expected), expected);

  const reordered = structuredClone(expected);
  reordered.regionalReadability.reverse();
  assert.throws(() => validatePaperCaseIdentity(reordered, expected), /identity drifted/);

  const extra = { ...structuredClone(expected), unboundAlias: "not allowed" };
  assert.throws(() => validatePaperCaseIdentity(extra, expected), /identity drifted/);
});

test("generation attempt budget is provider/stage bounded with one auditable total", () => {
  assert.deepEqual(PAPER_GENERATION_ATTEMPT_BUDGET.minimumByProviderAndStage.gemini, {
    planning: 1,
    layout: 1,
    multiview: 1,
    critique: 4,
    final_judge: 1,
  });
  assert.deepEqual(PAPER_GENERATION_ATTEMPT_BUDGET.maximumByProviderAndStage.gemini, {
    planning: 3,
    layout: 2,
    multiview: 2,
    critique: 8,
    final_judge: 2,
  });
  const recomputedTotal = Object.values(PAPER_GENERATION_ATTEMPT_BUDGET.maximumByStage).reduce(
    (total, value) => total + value,
    0,
  );
  assert.deepEqual(PAPER_GENERATION_ATTEMPT_BUDGET.maximumByStage, {
    planning: 6,
    layout: 4,
    multiview: 4,
    critique: 29,
    final_judge: 5,
  });
  assert.deepEqual(PAPER_GENERATION_ATTEMPT_BUDGET.minimumByStage, {
    planning: 4,
    layout: 3,
    multiview: 3,
    critique: 16,
    final_judge: 4,
  });
  assert.equal(PAPER_GENERATION_ATTEMPT_BUDGET.minimumTotal, 30);
  assert.equal(recomputedTotal, 48);
  assert.equal(PAPER_GENERATION_ATTEMPT_BUDGET.maximumTotal, 46);
  assert.equal(PAPER_GENERATION_MODEL_ENVIRONMENT.XAI_TEXT_MODEL, XAI_TEXT_MODEL_DEFAULT);
  assert.deepEqual(PAPER_GENERATION_MODEL_ENVIRONMENT, {
    XAI_TEXT_MODEL: XAI_TEXT_MODEL_DEFAULT,
    GEMINI_TEXT_MODEL: "gemini-3.6-flash",
    OPENAI_TEXT_MODEL: "gpt-5.6-sol",
    CLAUDE_MODEL: "anthropic/claude-opus-5",
    GEMINI_IMAGE_MODEL: "gemini-3-pro-image",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  });
});

test("paid run preflight exactly binds the generation and independent review dispatches", () => {
  assert.equal(PAPER_GENERATION_PAID_RUN_CONFIG.maxAttempts, 46);
  assert.equal(PAPER_GENERATION_PAID_RUN_CONFIG.expectedRoster.entries.length, 11);
  assert.equal(PAPER_GENERATION_PAID_RUN_CONFIG.stageCeilings.length, 18);
  assert.deepEqual(PAPER_GENERATION_PAID_RUN_CONFIG.aggregateStageCeilings, [
    { stage: "planning", maxAttempts: 6 },
    { stage: "layout", maxAttempts: 4 },
    { stage: "multiview", maxAttempts: 4 },
    { stage: "critique", maxAttempts: 29 },
    { stage: "final_judge", maxAttempts: 5 },
  ]);
  assert.deepEqual(
    PAPER_GENERATION_PAID_RUN_CONFIG.stageCeilings.find(
      ({ provider, stage }) => provider === "gemini" && stage === "layout",
    ),
    {
      provider: "gemini",
      stage: "layout",
      maxAttempts: 2,
      allowedDispatches: [{ modality: "image", model: "gemini-3-pro-image", timeoutMs: 180_000 }],
    },
  );
  assert.deepEqual(
    PAPER_GENERATION_PAID_RUN_CONFIG.stageCeilings.find(
      ({ provider, stage }) => provider === "gemini" && stage === "critique",
    )?.allowedDispatches,
    [
      { modality: "text", model: "gemini-3.6-flash", timeoutMs: 150_000 },
      { modality: "vision", model: "gemini-3.6-flash", timeoutMs: 150_000 },
    ],
  );
  assert.equal(PAPER_REVIEW_PAID_RUN_CONFIG.maxAttempts, 5);
  assert.deepEqual(PAPER_REVIEW_PAID_RUN_CONFIG.aggregateStageCeilings, [
    { stage: "final_judge", maxAttempts: 5 },
  ]);
  assert.equal(PAPER_REVIEW_PAID_RUN_CONFIG.stageCeilings.length, 4);
  assert.ok(
    PAPER_REVIEW_PAID_RUN_CONFIG.stageCeilings.every(
      (ceiling) =>
        ceiling.stage === "final_judge" &&
        ceiling.maxAttempts === (ceiling.provider === "gemini" ? 2 : 1) &&
        ceiling.allowedDispatches[0]?.modality === "vision" &&
        ceiling.allowedDispatches[0]?.timeoutMs === 180_000,
    ),
  );
  assert.ok(
    PAPER_GENERATION_PAID_RUN_CONFIG.expectedRoster.entries.every(
      (entry) => entry.configured === true && entry.timeoutMs <= 180_000,
    ),
  );
});

test("paper-suite process deadlines cover the bounded sequential critical path", () => {
  assert.equal(PAPER_SUITE_TIMEOUTS_MS.generationProviderCriticalPath, 2_220_000);
  assert.ok(
    PAPER_SUITE_TIMEOUTS_MS.generationReady >=
      PAPER_SUITE_TIMEOUTS_MS.preReadyProviderCriticalPath +
        PAPER_SUITE_TIMEOUTS_MS.rendererAndBrowserMargin,
  );
  assert.ok(
    PAPER_SUITE_TIMEOUTS_MS.generationCase >=
      PAPER_SUITE_TIMEOUTS_MS.generationReady +
        PAPER_SUITE_TIMEOUTS_MS.finalValidation +
        PAPER_SUITE_TIMEOUTS_MS.caseEvidenceMargin,
  );
  assert.ok(
    PAPER_SUITE_TIMEOUTS_MS.reviewerCase >=
      PAPER_SUITE_TIMEOUTS_MS.reviewerProviderDeadline +
        PAPER_SUITE_TIMEOUTS_MS.reviewerEvidenceMargin,
  );
});

test("loopback paid-attempt collector is authenticated, bounded, durable, and secret-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worldclaw-paid-ledger-"));
  const attemptsPath = join(directory, "attempts.jsonl");
  const runId = "2026-08-12T09-30-00-000Z:generation";
  const sinkToken = "sink-token-that-never-enters-public-evidence";
  const runToken = "run-token-that-never-enters-public-evidence";
  const collector = await startPaidInferenceJsonlCollector({
    filePath: attemptsPath,
    runId,
    token: sinkToken,
  });
  try {
    const event = {
      type: "attempt",
      sequence: 2,
      at: "2026-08-12T09:30:00.000Z",
      attemptId: "2b156e98-d30c-4a41-a44d-7df695294f56",
      provider: "xai",
      modality: "text",
      model: "grok-4.6",
      timeoutMs: 150_000,
      stage: "planning",
      iteration: 1,
      role: "Independent scene-plan candidate",
    };
    const denied = await fetch(collector.url, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, runId, event }),
    });
    assert.equal(denied.status, 401);
    const outcome = {
      type: "outcome",
      sequence: 3,
      at: "2026-08-12T09:30:01.000Z",
      attemptId: event.attemptId,
      outcome: "failed",
      error: "provider rejected the request",
    };
    const outOfOrderOutcome = fetch(collector.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sinkToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, runId, event: outcome }),
    });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    const acceptedAttempt = fetch(collector.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sinkToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, runId, event }),
    });
    const [accepted, acceptedOutcome] = await Promise.all([acceptedAttempt, outOfOrderOutcome]);
    assert.equal(accepted.status, 204);
    assert.equal(acceptedOutcome.status, 204);
  } finally {
    await collector.close();
  }
  const lines = (await readFile(attemptsPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event.model, "grok-4.6");
  assert.equal(JSON.parse(lines[1]).event.type, "outcome");
  assert.doesNotMatch(lines.join("\n"), new RegExp(`${sinkToken}|${runToken}`));

  const ledger = {
    version: 1,
    runId,
    createdAt: "2026-08-12T09:29:59.000Z",
    maxAttempts: 46,
    attemptCount: 1,
    status: "completed",
    roster: {
      version: 1,
      enforcementRequired: true,
      entries: PAPER_GENERATION_PAID_RUN_CONFIG.expectedRoster.entries.map((entry) => ({
        ...entry,
        defaultTimeoutMs: entry.timeoutMs,
        maximumTimeoutMs: 180_000,
      })),
    },
    stageCeilings: PAPER_GENERATION_PAID_RUN_CONFIG.stageCeilings,
    aggregateStageCeilings: PAPER_GENERATION_PAID_RUN_CONFIG.aggregateStageCeilings,
    events: [
      { type: "run", sequence: 1, at: "2026-08-12T09:29:59.000Z", status: "created" },
      JSON.parse(lines[0]).event,
      JSON.parse(lines[1]).event,
      { type: "run", sequence: 4, at: "2026-08-12T09:30:02.000Z", status: "completed" },
    ],
  };
  const descriptor = await persistPaidInferenceEvidence({
    directory,
    ledger,
    attemptLogPath: attemptsPath,
    ledgerFile: "paid_inference_ledger.json",
    attemptLogFile: "attempts.jsonl",
    expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
    expectedStatus: "completed",
    forbiddenSecrets: [runToken, sinkToken],
  });
  assert.equal(descriptor.attemptCount, 1);
  assert.match(descriptor.ledgerSha256, /^[a-f0-9]{64}$/);
  assert.equal(descriptor.attemptLogLines, 2);
  await validatePaidInferenceEvidence({
    directory,
    descriptor,
    expectedRunId: runId,
    expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
    expectedStatus: "completed",
  });
  const leakedLedger = structuredClone(ledger);
  leakedLedger.events[2].error = `leaked ${runToken}`;
  await assert.rejects(
    persistPaidInferenceEvidence({
      directory,
      ledger: leakedLedger,
      attemptLogPath: attemptsPath,
      ledgerFile: "leaked.json",
      attemptLogFile: "attempts.jsonl",
      expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
      expectedStatus: "completed",
      forbiddenSecrets: [runToken, sinkToken],
    }),
    /secret/i,
  );
  await rm(directory, { recursive: true, force: true });
});

test("parent reconstructs a killed reviewer from durable attempts without inventing dispatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worldclaw-review-orphan-"));
  const attemptLogPath = join(directory, "paper_review_paid_inference_attempts.jsonl");
  const runId = "2026-08-12T09-30-00-000Z:review";
  const sinkToken = "review-sink-token-not-for-evidence";
  const runToken = "review-run-token-not-for-evidence";
  const collector = await startPaidInferenceJsonlCollector({
    filePath: attemptLogPath,
    runId,
    token: sinkToken,
  });
  const attempt = {
    type: "attempt",
    sequence: 2,
    at: "2026-08-12T09:30:00.000Z",
    attemptId: "2b156e98-d30c-4a41-a44d-7df695294f56",
    provider: "xai",
    modality: "vision",
    model: "grok-4.6",
    timeoutMs: 180_000,
    stage: "final_judge",
    iteration: 1,
    role: "Independent paper visual reviewer",
  };
  try {
    const response = await fetch(collector.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sinkToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, runId, event: attempt }),
    });
    assert.equal(response.status, 204);
  } finally {
    await collector.close();
  }
  const ledger = await reconstructTerminatedPaidInferenceLedger({
    attemptLogPath,
    expectedRunId: runId,
    expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
    status: "failed",
    createdAt: "2026-08-12T09:29:59.000Z",
  });
  assert.equal(ledger.attemptCount, 1);
  assert.equal(ledger.events.filter((event) => event.type === "attempt").length, 1);
  assert.equal(ledger.events.filter((event) => event.type === "outcome").length, 1);
  const descriptor = await persistPaidInferenceEvidence({
    directory,
    ledger,
    attemptLogPath,
    ledgerFile: "paper_review_paid_inference_ledger.json",
    attemptLogFile: "paper_review_paid_inference_attempts.jsonl",
    expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
    expectedStatus: "failed",
    forbiddenSecrets: [runToken, sinkToken],
    completeAttemptLog: true,
    ledgerOrigin: "parent-reconstructed-after-child-exit",
  });
  assert.equal(descriptor.ledgerOrigin, "parent-reconstructed-after-child-exit");
  assert.equal(descriptor.attemptLogLines, 2);
  assert.equal(
    (await readFile(attemptLogPath, "utf8")).includes("Independent paper visual reviewer"),
    true,
  );
  await validatePaidInferenceEvidence({
    directory,
    descriptor,
    expectedRunId: runId,
    expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
    expectedStatus: "failed",
  });
  await rm(directory, { recursive: true, force: true });
});

test("paper suite dry-run exposes fixed model and generation-attempt ceilings without calls", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./worldclaw-paper-suite.mjs", import.meta.url)),
      "--dry-run",
      "--case",
      PAPER_SUITE_CONTRACT.caseIds[0],
    ],
    { cwd: fileURLToPath(root), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.paidCallsMade, 0);
  assert.equal(output.paidCallBudget.generationAttemptsMaximum, 46);
  assert.equal(output.paidCallBudget.fullSuiteGenerationAttemptsMaximum, 506);
  assert.deepEqual(
    output.paidCallBudget.fixedGenerationModelEnvironment,
    PAPER_GENERATION_MODEL_ENVIRONMENT,
  );
  assert.deepEqual(
    output.paidCallBudget.generationPaidRunPreflight.aggregateStageCeilings,
    PAPER_GENERATION_PAID_RUN_CONFIG.aggregateStageCeilings,
  );
  assert.deepEqual(
    output.paidCallBudget.reviewerPaidRunPreflight.aggregateStageCeilings,
    PAPER_REVIEW_PAID_RUN_CONFIG.aggregateStageCeilings,
  );
  assert.deepEqual(output.cases[0].regionalReadability, [
    "pirate settlement",
    "harbor",
    "ship anchorage",
    "vegetated interior",
  ]);
});

test("bound QA creates the paid run before Generate and closes it on every normal outcome", async () => {
  const source = await readFile(new URL("./worldclaw-qa.mjs", import.meta.url), "utf8");
  const createIndex = source.indexOf("await startBoundPaidRun(page)");
  const generateIndex = source.indexOf("await generate.click()", createIndex);
  assert.ok(createIndex >= 0 && generateIndex > createIndex, "Paid run must exist before Generate");
  assert.match(source, /headers\["x-tsr-serverfn"\] === "true"/);
  assert.match(source, /"x-worldclaw-paid-run-id": paidRunId/);
  assert.match(source, /"x-worldclaw-paid-run-token": paidRunToken/);
  assert.match(source, /finalizeBoundPaidRun\(page, "completed"\)/);
  assert.match(source, /finalizeBoundPaidRun\(activePage, "failed"\)/);
  assert.match(source, /paidInferenceEvidence: paidEvidence/);

  const suiteSource = await readFile(
    new URL("./worldclaw-paper-suite.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    suiteSource.match(/validatePaidInferenceEvidence\(\{/g)?.length,
    3,
    "Suite verifies child generation evidence, parent cleanup evidence, and reviewer evidence",
  );
  assert.match(suiteSource, /WORLDCLAW_QA_RUN_ID: caseRunId/);
  assert.match(suiteSource, /WORLDCLAW_REVIEW_PAID_RUN_ID: reviewPaidRunId/);
  assert.match(suiteSource, /recoverReviewerPaidEvidence/);
  assert.match(suiteSource, /closePreviewPaidRun/);
  assert.match(suiteSource, /PAPER_SUITE_TIMEOUTS_MS\.generationCase/);
  assert.match(suiteSource, /PAPER_SUITE_TIMEOUTS_MS\.reviewerCase/);
});

function retainedLedger(artifacts) {
  return {
    status: "retained",
    providers: [
      {
        provider: "xai",
        model: "grok-4.6",
        configured: "true",
        authenticated: "true",
        available: "true",
      },
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        configured: "true",
        authenticated: "true",
        available: "true",
      },
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        configured: "true",
        authenticated: "true",
        available: "true",
      },
      {
        provider: "anthropic",
        model: "anthropic/claude-opus-5",
        configured: "true",
        authenticated: "true",
        available: "true",
      },
    ],
    artifacts,
  };
}

function paidArtifact(id, provider, stage, model) {
  const requestOnly =
    ["layout", "multiview"].includes(stage) && ["xai", "openai"].includes(provider);
  return {
    id,
    provider,
    stage,
    requestedModel: model,
    model,
    responseId: requestOnly ? null : `response-${id}`,
    identityAttestation: requestOnly ? "request-only" : "provider-response",
    status: "selected",
    iteration: "1",
  };
}

function minimumPaidRoster() {
  const counts = {
    xai: { planning: 1, layout: 1, multiview: 1, critique: 4, final_judge: 1 },
    gemini: { planning: 1, layout: 1, multiview: 1, critique: 4, final_judge: 1 },
    openai: { planning: 1, layout: 1, multiview: 1, critique: 4, final_judge: 1 },
    anthropic: { planning: 1, layout: 0, multiview: 0, critique: 4, final_judge: 1 },
  };
  const textModels = {
    xai: "grok-4.6",
    gemini: "gemini-3.6-flash",
    openai: "gpt-5.6-sol",
    anthropic: "anthropic/claude-opus-5",
  };
  const artifacts = [];
  for (const [provider, stages] of Object.entries(counts)) {
    for (const [stage, count] of Object.entries(stages)) {
      for (let index = 0; index < count; index++) {
        const model = ["layout", "multiview"].includes(stage)
          ? provider === "gemini"
            ? "gemini-3-pro-image"
            : provider === "xai"
              ? "grok-imagine-image-quality"
              : "gpt-image-2"
          : textModels[provider];
        artifacts.push(paidArtifact(`${stage}-${provider}-${index + 1}`, provider, stage, model));
      }
    }
  }
  return artifacts;
}

test("generation ledger audit reports retained paid attempts and rejects model or budget drift", () => {
  const valid = retainedLedger([
    ...minimumPaidRoster(),
    paidArtifact("asset-local", "local", "asset_variant", "browser-asset-library"),
  ]);
  const audit = auditPaperGenerationLedger(valid);
  assert.equal(audit.attemptedTotal, 30);
  assert.equal(audit.attemptedByProviderAndStage.gemini.layout, 1);
  assert.equal(audit.maximumTotal, 46);

  const wrongModel = structuredClone(valid);
  wrongModel.artifacts.find((artifact) => artifact.stage === "planning").model = "grok-other";
  assert.throws(() => auditPaperGenerationLedger(wrongModel), /model drifted/);

  const missingRequestedModel = structuredClone(valid);
  delete missingRequestedModel.artifacts.find((artifact) => artifact.stage === "planning")
    .requestedModel;
  assert.throws(() => auditPaperGenerationLedger(missingRequestedModel), /requested model drifted/);

  const unattestedText = structuredClone(valid);
  unattestedText.artifacts.find((artifact) => artifact.stage === "planning").identityAttestation =
    "unattested";
  assert.throws(
    () => auditPaperGenerationLedger(unattestedText),
    /identity is not provider-attested/,
  );

  const failedPaidCall = structuredClone(valid);
  failedPaidCall.artifacts.find((artifact) => artifact.stage === "planning").status = "error";
  assert.throws(() => auditPaperGenerationLedger(failedPaidCall), /paid artifact is not usable/);

  const missingResponseId = structuredClone(valid);
  delete missingResponseId.artifacts.find((artifact) => artifact.stage === "planning").responseId;
  assert.throws(() => auditPaperGenerationLedger(missingResponseId), /response ID is invalid/);

  const reusedResponse = structuredClone(valid);
  const xaiPlanning = reusedResponse.artifacts.find(
    (artifact) => artifact.provider === "xai" && artifact.stage === "planning",
  );
  reusedResponse.artifacts.find(
    (artifact) => artifact.provider === "xai" && artifact.stage === "critique",
  ).responseId = xaiPlanning.responseId;
  assert.throws(
    () => auditPaperGenerationLedger(reusedResponse),
    /duplicate provider response IDs/,
  );

  const fabricatedImageResponseId = structuredClone(valid);
  fabricatedImageResponseId.artifacts.find(
    (artifact) => artifact.provider === "openai" && artifact.stage === "multiview",
  ).responseId = "fabricated";
  assert.throws(
    () => auditPaperGenerationLedger(fabricatedImageResponseId),
    /request-only identity has a response ID/,
  );

  const unsupportedGeminiImageModel = structuredClone(valid);
  for (const artifact of unsupportedGeminiImageModel.artifacts) {
    if (artifact.provider === "gemini" && artifact.stage === "layout") {
      artifact.requestedModel = "gemini-3.6-flash";
      artifact.model = "gemini-3.6-flash";
    }
  }
  assert.throws(
    () => auditPaperGenerationLedger(unsupportedGeminiImageModel),
    /gemini layout model drifted/,
  );

  const overBudget = retainedLedger(
    Array.from({ length: 3 }, (_, index) =>
      paidArtifact(`plan-xai-${index}`, "xai", "planning", "grok-4.6"),
    ),
  );
  assert.throws(() => auditPaperGenerationLedger(overBudget), /planning attempt budget/);

  const crossProviderOverBudget = retainedLedger([
    ...minimumPaidRoster(),
    paidArtifact("planning-xai-repair", "xai", "planning", "grok-4.6"),
    paidArtifact("planning-gemini-repair", "gemini", "planning", "gemini-3.6-flash"),
    paidArtifact("planning-openai-repair", "openai", "planning", "gpt-5.6-sol"),
  ]);
  assert.throws(
    () => auditPaperGenerationLedger(crossProviderOverBudget),
    /planning aggregate attempt budget exceeded/,
  );

  const unmatchedCritiqueRound = retainedLedger([
    ...minimumPaidRoster(),
    paidArtifact("planning-xai-repair", "xai", "planning", "grok-4.6"),
  ]);
  assert.throws(
    () => auditPaperGenerationLedger(unmatchedCritiqueRound),
    /adaptive repair and critique rounds drifted/,
  );

  const incompleteRoster = retainedLedger(minimumPaidRoster());
  incompleteRoster.artifacts = incompleteRoster.artifacts.filter(
    (artifact) => !(artifact.provider === "gemini" && artifact.stage === "multiview"),
  );
  assert.throws(() => auditPaperGenerationLedger(incompleteRoster), /required roster incomplete/);
});

test("generation ledger audit fails closed on missing readiness, duplicate IDs, and unknown stages", () => {
  const base = retainedLedger([paidArtifact("plan-xai", "xai", "planning", "grok-4.6")]);
  const unavailable = structuredClone(base);
  unavailable.providers[2].available = "false";
  assert.throws(() => auditPaperGenerationLedger(unavailable), /openai.*available/);

  const duplicate = structuredClone(base);
  duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
  assert.throws(() => auditPaperGenerationLedger(duplicate), /duplicate artifact IDs/);

  const unknownStage = structuredClone(base);
  unknownStage.artifacts[0].stage = "unbounded_retry";
  assert.throws(() => auditPaperGenerationLedger(unknownStage), /unknown stage/);
});

test("every paper case has immutable visual evidence and a complete evaluation contract", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.claimPolicy.minimumIndependentReviewers, 4);
  assert.equal(manifest.claimPolicy.reviewAggregation, "four_member_conservative_panel");
  assert.equal(manifest.claimPolicy.sharedAxes.length, 6);
  assert.equal(manifest.viewContract.globalViews, 1);
  assert.equal(manifest.viewContract.regionalViews, 4);
  assert.equal(manifest.viewContract.walkViews, 4);
  assert.deepEqual(manifest.viewContract.diagnosticsPerWalkView, ["instance", "depth", "normal"]);

  for (const entry of manifest.cases) {
    assert.match(entry.id, /^figure-\d{2}-[a-z0-9-]+$/);
    assert.equal(entry.pdfPage, entry.figure < 8 ? entry.figure + 9 : entry.figure + 23);
    assert.ok(entry.prompt.length >= 70, `${entry.id} prompt is unexpectedly short`);
    assert.ok(entry.expectedText.length >= 8, `${entry.id} expectedText is too weak`);
    assert.ok(entry.terrainRelationships.length >= 3, `${entry.id} lacks terrain requirements`);
    assert.ok(entry.objectFamilies.length >= 4, `${entry.id} lacks object-family requirements`);
    assert.equal(entry.regionalReadability.length, 4, `${entry.id} needs four regional roles`);
    const referenceUrl = new URL(entry.referenceImage, root);
    assert.equal(
      await sha256(referenceUrl),
      entry.referenceSha256,
      `${entry.id} reference drifted`,
    );
    const referenceBytes = await readFile(referenceUrl);
    const panel = cropPaperReferenceMatrix(
      referenceBytes,
      entry.referencePanelCrop,
      entry.referencePanelSha256,
    );
    assert.equal(hashBytes(panel), entry.referencePanelSha256, `${entry.id} panel drifted`);
    assert.ok(entry.referencePanelCrop.width >= 700);
    assert.ok(entry.referencePanelCrop.height >= 770);
  }
});

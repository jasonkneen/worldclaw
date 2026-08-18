import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  PAPER_REVIEW_MAX_CASES,
  PAPER_REVIEW_PROVIDER_ROSTER,
  aggregatePaperSuite,
  certificationExitStatus,
  promptSha256,
} from "./worldclaw-paper-review-lib.mjs";
import {
  PAPER_GENERATION_ATTEMPT_BUDGET,
  PAPER_GENERATION_MODEL_ENVIRONMENT,
  PAPER_GENERATION_PAID_RUN_CONFIG,
  PAPER_REVIEW_PAID_RUN_CONFIG,
  PAPER_SUITE_TIMEOUTS_MS,
  auditPaperGenerationLedger,
  validatePaperCaseIdentity,
  validatePaperSuiteManifest,
} from "./worldclaw-paper-suite-lib.mjs";
import {
  persistPaidInferenceEvidence,
  reconstructTerminatedPaidInferenceLedger,
  startPaidInferenceJsonlCollector,
  validatePaidInferenceEvidence,
} from "./worldclaw-paid-benchmark-lib.mjs";
import { createBoundedChildOrchestrator } from "./worldclaw-paper-process.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(
  workspaceRoot,
  "assets/worldclaw/reference-validation/paper_prompt_suite.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const manifestContract = validatePaperSuiteManifest(manifest);
assert.equal(manifestContract.caseCount, PAPER_REVIEW_MAX_CASES, "Paper suite is incomplete");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowPaidModelCalls = args.includes("--allow-paid-model-calls");
const continueOnFailure = args.includes("--continue-on-failure");
const caseIndex = args.indexOf("--case");
const requestedCase = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
if (caseIndex >= 0) assert.match(requestedCase ?? "", /^figure-\d{2}-[a-z0-9-]{1,100}$/);
const cases = requestedCase
  ? manifest.cases.filter((entry) => entry.id === requestedCase)
  : manifest.cases;
assert.ok(cases.length > 0, `Unknown paper case: ${requestedCase}`);
const paidCallBudget = {
  generatedCasesMaximum: cases.length,
  generationAttemptsPerCase: PAPER_GENERATION_ATTEMPT_BUDGET,
  generationAttemptsMaximum: cases.length * PAPER_GENERATION_ATTEMPT_BUDGET.maximumTotal,
  fullSuiteGenerationAttemptsMaximum:
    PAPER_REVIEW_MAX_CASES * PAPER_GENERATION_ATTEMPT_BUDGET.maximumTotal,
  fixedGenerationModelEnvironment: PAPER_GENERATION_MODEL_ENVIRONMENT,
  reviewerCallsPerCase: PAPER_REVIEW_PROVIDER_ROSTER.length,
  reviewerCallsMaximum: cases.length * PAPER_REVIEW_PROVIDER_ROSTER.length,
  fullSuiteReviewerCallsMaximum: PAPER_REVIEW_MAX_CASES * PAPER_REVIEW_PROVIDER_ROSTER.length,
  generationModels: [
    "grok-4.6",
    "gemini-3.6-flash",
    "gpt-5.6-sol",
    "anthropic/claude-opus-5",
    "grok-imagine-image-quality",
    "gemini-3-pro-image",
    "gpt-image-2",
  ],
  reviewerModels: PAPER_REVIEW_PROVIDER_ROSTER.map(([, model]) => model),
  generationPaidRunPreflight: PAPER_GENERATION_PAID_RUN_CONFIG,
  reviewerPaidRunPreflight: PAPER_REVIEW_PAID_RUN_CONFIG,
  processTimeoutsMs: PAPER_SUITE_TIMEOUTS_MS,
};

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        paidCallsMade: 0,
        paper: manifest.paper,
        claimPolicy: manifest.claimPolicy,
        paidCallBudget,
        cases: cases.map(
          ({ id, figure, pdfPage, title, prompt, regionalReadability, referencePanelSha256 }) => ({
            id,
            figure,
            pdfPage,
            title,
            prompt,
            promptSha256: promptSha256(prompt),
            regionalReadability,
            referencePanelSha256,
          }),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

assert.ok(
  allowPaidModelCalls,
  "Paid benchmark disabled. Re-run with --allow-paid-model-calls after reviewing --dry-run.",
);
for (const key of ["XAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"]) {
  assert.ok(process.env[key]?.trim(), `${key} is required for the fixed four-provider benchmark`);
}
const preview = await fetch("http://127.0.0.1:8080/", { signal: AbortSignal.timeout(5_000) });
assert.ok(preview.ok, `WorldClaw preview is unavailable (${preview.status})`);

const suiteStartedAt = new Date().toISOString();
const suiteId = suiteStartedAt.replace(/[:.]/g, "-");
const suiteDirectory = join(
  workspaceRoot,
  "screenshots/reference-validation/paper-suite-runs",
  suiteId,
);
const statusPath = join(suiteDirectory, "suite_status.json");
await mkdir(suiteDirectory, { recursive: true });
const results = [];
const terminationTimers = new WeakMap();

function terminateChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (terminationTimers.has(child)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  terminationTimers.set(child, force);
  child.once("exit", () => {
    clearTimeout(force);
    terminationTimers.delete(child);
  });
  force.unref();
}

const childOrchestrator = createBoundedChildOrchestrator({
  spawnChild: spawn,
  terminateChild,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    childOrchestrator.interrupt(signal);
  });
}

async function spawnBounded(label, command, childArgs, options, timeoutMs) {
  return childOrchestrator.run({
    label,
    command,
    args: childArgs,
    options: { ...options, detached: true },
    timeoutMs,
  });
}

async function closePreviewPaidRun({ runId, token, status }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto("http://127.0.0.1:8080/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    assert.ok(response?.ok(), `Paid-run cleanup navigation failed (${response?.status()})`);
    const result = await page.evaluate(
      async ({ runId: paidRunId, token: paidRunToken, requestedStatus }) => {
        const control = await import("/src/lib/worldclaw/paid-inference-control.ts");
        const headers = {
          "x-worldclaw-paid-run-id": paidRunId,
          "x-worldclaw-paid-run-token": paidRunToken,
        };
        let ledger;
        try {
          ledger = await control.getPaidInferenceBenchmarkLedger({ headers });
        } catch (error) {
          return {
            unavailable: true,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 320),
          };
        }
        if (ledger.status !== "open") return { unavailable: false, ledger };
        try {
          ledger = await control.finishPaidInferenceBenchmarkRun({
            data: { status: requestedStatus },
            headers,
          });
        } catch (error) {
          if (requestedStatus === "completed") {
            ledger = await control.finishPaidInferenceBenchmarkRun({
              data: { status: "failed" },
              headers,
            });
            return {
              unavailable: false,
              ledger,
              downgradedFromCompleted: true,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 320),
            };
          }
          throw error;
        }
        return { unavailable: false, ledger };
      },
      { runId, token, requestedStatus: status },
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(token), false, "Paid-run cleanup returned its token");
    return result;
  } finally {
    await browser.close();
  }
}

async function persistParentPaidEvidence({
  runDirectory,
  ledger,
  attemptLogPath,
  config,
  token,
  sinkToken,
  ledgerFile = "paid_inference_ledger.json",
  attemptLogFile = "paid_inference_attempts.jsonl",
  ledgerOrigin = "server-ledger-with-parent-terminal-reconciliation",
}) {
  const existingDescriptor = await readFile(join(runDirectory, "generation_status.json"), "utf8")
    .then((text) => JSON.parse(text).paidInferenceEvidence)
    .catch(() => undefined);
  if (existingDescriptor) {
    return (
      await validatePaidInferenceEvidence({
        directory: runDirectory,
        descriptor: existingDescriptor,
        expectedRunId: ledger.runId,
        expectedConfig: config,
        expectedStatus: ledger.status,
      })
    ).descriptor;
  }
  return persistPaidInferenceEvidence({
    directory: runDirectory,
    ledger,
    attemptLogPath,
    ledgerFile,
    attemptLogFile,
    expectedConfig: config,
    expectedStatus: ledger.status,
    forbiddenSecrets: [token, sinkToken],
    completeAttemptLog: true,
    ledgerOrigin,
  });
}

async function recoverReviewerPaidEvidence({
  runDirectory,
  runId,
  attemptLogPath,
  createdAt,
  status,
  token,
  sinkToken,
}) {
  const ledgerFile = "paper_review_paid_inference_ledger.json";
  const attemptLogFile = "paper_review_paid_inference_attempts.jsonl";
  const existingLedger = await readFile(join(runDirectory, ledgerFile), "utf8")
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
  const ledger =
    existingLedger ??
    (await reconstructTerminatedPaidInferenceLedger({
      attemptLogPath,
      expectedRunId: runId,
      expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
      status,
      createdAt,
    }));
  return persistPaidInferenceEvidence({
    directory: runDirectory,
    ledger,
    attemptLogPath,
    ledgerFile,
    attemptLogFile,
    expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
    expectedStatus: ledger.status,
    forbiddenSecrets: [token, sinkToken],
    completeAttemptLog: true,
    ledgerOrigin: existingLedger
      ? "server-ledger-recovered-by-parent"
      : "parent-reconstructed-after-child-exit",
  });
}

async function persist(status, extra = {}) {
  await writeFile(
    statusPath,
    `${JSON.stringify(
      {
        version: 2,
        suiteId,
        status,
        startedAt: suiteStartedAt,
        scope:
          "model-panel qualitative judgment on eleven selected WorldClaw figure pages and six preregistered axes",
        manifest: "assets/worldclaw/reference-validation/paper_prompt_suite.json",
        paidCallBudget,
        results,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

async function runCase(entry) {
  const before = Date.now();
  const caseToken = randomBytes(24).toString("hex");
  const caseRunId = new Date().toISOString().replace(/[:.]/g, "-");
  const generationPaidRunId = `${caseRunId}:generation`;
  const reviewPaidRunId = `${caseRunId}:review`;
  const generationPaidRunToken =
    process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN?.trim() || randomBytes(32).toString("hex");
  const reviewPaidRunToken = generationPaidRunToken;
  const generationSinkToken = randomBytes(32).toString("hex");
  const reviewSinkToken = randomBytes(32).toString("hex");
  const generationCreatedAt = new Date().toISOString();
  const generationRunDirectory = join(
    workspaceRoot,
    "screenshots/reference-validation/runs",
    caseRunId,
  );
  const generationAttemptLogPath = join(generationRunDirectory, "paid_inference_attempts.jsonl");
  await mkdir(generationRunDirectory, { recursive: true });
  const generationCollector = await startPaidInferenceJsonlCollector({
    filePath: generationAttemptLogPath,
    runId: generationPaidRunId,
    token: generationSinkToken,
  });
  const resultPath = join(suiteDirectory, `${entry.id}-generation.json`);
  let exitCode = null;
  let run = null;
  let review = null;
  let reviewExitCode = null;
  let generationAttemptAudit = null;
  let generationPaidInferenceEvidence = null;
  let reviewPaidInferenceEvidence = null;
  let message = null;
  let generationCleanup = null;
  let generationCleanupFailed = false;
  try {
    exitCode = await spawnBounded(
      `Generation ${entry.id}`,
      process.execPath,
      [join(workspaceRoot, "scripts/worldclaw-qa.mjs")],
      {
        cwd: workspaceRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          ...PAPER_GENERATION_MODEL_ENVIRONMENT,
          WORLDCLAW_QA_PROMPT: entry.prompt,
          WORLDCLAW_QA_EXPECT: entry.expectedText,
          WORLDCLAW_QA_REGIONAL_ROLES: JSON.stringify(entry.regionalReadability),
          WORLDCLAW_QA_TERRAIN_RELATIONSHIPS: JSON.stringify(entry.terrainRelationships),
          WORLDCLAW_QA_OBJECT_FAMILIES: JSON.stringify(entry.objectFamilies),
          WORLDCLAW_QA_READY_TIMEOUT_MS: String(PAPER_SUITE_TIMEOUTS_MS.generationReady),
          WORLDCLAW_QA_SUITE_ID: suiteId,
          WORLDCLAW_QA_CASE_ID: entry.id,
          WORLDCLAW_QA_CASE_TOKEN: caseToken,
          WORLDCLAW_QA_RESULT_PATH: resultPath,
          WORLDCLAW_QA_RUN_ID: caseRunId,
          WORLDCLAW_QA_PAID_RUN_ID: generationPaidRunId,
          WORLDCLAW_QA_PAID_RUN_TOKEN: generationPaidRunToken,
          WORLDCLAW_QA_PAID_SINK_URL: generationCollector.url,
          WORLDCLAW_QA_PAID_SINK_TOKEN: generationSinkToken,
        },
      },
      PAPER_SUITE_TIMEOUTS_MS.generationCase,
    );
    run = JSON.parse(await readFile(resultPath, "utf8"));
    const expectedBinding = {
      suiteId,
      caseId: entry.id,
      caseToken,
      promptSha256: promptSha256(entry.prompt),
      regionalReadability: entry.regionalReadability,
    };
    validatePaperCaseIdentity(run?.binding, expectedBinding);
    if (exitCode === 0 && run.status === "passed" && run.runId) {
      assert.match(run.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      assert.equal(run.evidenceDirectory, `runs/${run.runId}`, "Generation evidence path drifted");
      const runDirectory = join(workspaceRoot, "screenshots/reference-validation/runs", run.runId);
      const committeeLedger = JSON.parse(
        await readFile(join(runDirectory, "model_committee_ledger.json"), "utf8"),
      );
      generationAttemptAudit = auditPaperGenerationLedger(committeeLedger);
      const generationPaidEvidence = await validatePaidInferenceEvidence({
        directory: runDirectory,
        descriptor: run.paidInferenceEvidence,
        expectedRunId: `${run.runId}:generation`,
        expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
        expectedStatus: "completed",
      });
      generationPaidInferenceEvidence = generationPaidEvidence.descriptor;
      assert.equal(
        generationPaidEvidence.ledger.attemptCount,
        generationAttemptAudit.attemptedTotal,
        "Paid generation ledger and retained committee evidence disagree",
      );
      const reviewAttemptLogPath = join(runDirectory, "paper_review_paid_inference_attempts.jsonl");
      const reviewCreatedAt = new Date().toISOString();
      const reviewCollector = await startPaidInferenceJsonlCollector({
        filePath: reviewAttemptLogPath,
        runId: reviewPaidRunId,
        token: reviewSinkToken,
      });
      let reviewFailure;
      try {
        reviewExitCode = await spawnBounded(
          `Review ${entry.id}`,
          process.execPath,
          [
            "--import",
            join(workspaceRoot, "scripts/register-ts-extension-loader.mjs"),
            join(workspaceRoot, "scripts/worldclaw-paper-review.mjs"),
            "--case",
            entry.id,
            "--run-id",
            run.runId,
            "--suite-id",
            suiteId,
            "--case-token",
            caseToken,
          ],
          {
            cwd: workspaceRoot,
            stdio: "inherit",
            env: {
              ...process.env,
              ...PAPER_GENERATION_MODEL_ENVIRONMENT,
              WORLDCLAW_REVIEW_PAID_RUN_ID: reviewPaidRunId,
              WORLDCLAW_REVIEW_PAID_RUN_TOKEN: reviewPaidRunToken,
              WORLDCLAW_REVIEW_PAID_SINK_URL: reviewCollector.url,
              WORLDCLAW_REVIEW_PAID_SINK_TOKEN: reviewSinkToken,
            },
          },
          PAPER_SUITE_TIMEOUTS_MS.reviewerCase,
        );
        review = JSON.parse(await readFile(join(runDirectory, "paper_review.json"), "utf8"));
        assert.equal(review?.caseId, entry.id, "Review case id drifted");
        assert.equal(review?.runId, run.runId, "Review run id drifted");
        assert.equal(review?.suiteId, suiteId, "Review suite id drifted");
        validatePaperCaseIdentity(review?.binding, expectedBinding);
        assert.equal(review?.promptSha256, promptSha256(entry.prompt), "Review prompt drifted");
        const reviewPaidEvidence = await validatePaidInferenceEvidence({
          directory: runDirectory,
          descriptor: review.paidInferenceEvidence,
          expectedRunId: reviewPaidRunId,
          expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
          expectedStatus: review.paidInferenceEvidence?.status,
        });
        reviewPaidInferenceEvidence = reviewPaidEvidence.descriptor;
        if (reviewPaidEvidence.ledger.status === "completed") {
          assert.equal(
            reviewPaidEvidence.ledger.attemptCount,
            PAPER_REVIEW_PROVIDER_ROSTER.length,
            "Paid review ledger omitted a reviewer",
          );
        }
      } catch (error) {
        reviewFailure = error;
      } finally {
        let reviewCollectorFailure;
        try {
          await reviewCollector.close();
        } catch (error) {
          reviewCollectorFailure = error;
        }
        if (!reviewPaidInferenceEvidence) {
          try {
            reviewPaidInferenceEvidence = await recoverReviewerPaidEvidence({
              runDirectory,
              runId: reviewPaidRunId,
              attemptLogPath: reviewAttemptLogPath,
              createdAt: reviewCreatedAt,
              status: childOrchestrator.interruptedSignal ? "cancelled" : "failed",
              token: reviewPaidRunToken,
              sinkToken: reviewSinkToken,
            });
          } catch (error) {
            reviewCollectorFailure = reviewCollectorFailure
              ? new AggregateError(
                  [reviewCollectorFailure, error],
                  "Reviewer collector close and orphan reconstruction both failed",
                )
              : error;
          }
        }
        if (reviewCollectorFailure) {
          reviewFailure = reviewFailure
            ? new AggregateError(
                [reviewFailure, reviewCollectorFailure],
                "Reviewer child and parent accounting finalization both failed",
              )
            : reviewCollectorFailure;
        }
      }
      if (reviewFailure) throw reviewFailure;
    }
  } catch (error) {
    message = (error instanceof Error ? error.message : String(error)).slice(0, 1_200);
  } finally {
    const cleanupStatus = childOrchestrator.interruptedSignal ? "cancelled" : "failed";
    try {
      generationCleanup = await closePreviewPaidRun({
        runId: generationPaidRunId,
        token: generationPaidRunToken,
        status: cleanupStatus,
      });
    } catch (error) {
      generationCleanupFailed = true;
      message ??= `Paid generation cleanup failed: ${(error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 1_100)}`;
    }
    try {
      await generationCollector.close();
    } catch (error) {
      generationCleanupFailed = true;
      message ??= `Paid generation collector close failed: ${(error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 1_100)}`;
    }
    if (generationCleanup?.ledger) {
      try {
        generationPaidInferenceEvidence ??= await persistParentPaidEvidence({
          runDirectory: generationRunDirectory,
          ledger: generationCleanup.ledger,
          attemptLogPath: generationAttemptLogPath,
          config: PAPER_GENERATION_PAID_RUN_CONFIG,
          token: generationPaidRunToken,
          sinkToken: generationSinkToken,
        });
      } catch (error) {
        generationCleanupFailed = true;
        message ??= `Paid generation evidence failed: ${(error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 1_100)}`;
      }
    } else {
      generationCleanupFailed = true;
      try {
        const reconstructed = await reconstructTerminatedPaidInferenceLedger({
          attemptLogPath: generationAttemptLogPath,
          expectedRunId: generationPaidRunId,
          expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
          status: cleanupStatus,
          createdAt: generationCreatedAt,
        });
        generationPaidInferenceEvidence ??= await persistPaidInferenceEvidence({
          directory: generationRunDirectory,
          ledger: reconstructed,
          attemptLogPath: generationAttemptLogPath,
          ledgerFile: "paid_inference_ledger.json",
          attemptLogFile: "paid_inference_attempts.jsonl",
          expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
          expectedStatus: cleanupStatus,
          forbiddenSecrets: [generationPaidRunToken, generationSinkToken],
          completeAttemptLog: true,
          ledgerOrigin: "parent-reconstructed-after-child-exit",
        });
      } catch (error) {
        message ??= `Paid generation orphan reconstruction failed: ${(error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 1_100)}`;
      }
      message ??= generationCleanup?.unavailable
        ? `Paid generation cleanup was unavailable: ${generationCleanup.error}`
        : "Paid generation cleanup returned no ledger";
    }
  }
  const passed =
    exitCode === 0 &&
    run?.status === "passed" &&
    generationCleanupFailed === false &&
    generationPaidInferenceEvidence?.status === "completed" &&
    reviewExitCode === 0 &&
    review?.qualitativeNonLoss === true &&
    reviewPaidInferenceEvidence?.status === "completed";
  return {
    id: entry.id,
    figure: entry.figure,
    status: passed ? "passed" : "failed",
    exitCode,
    durationMs: Date.now() - before,
    runId: run?.runId ?? null,
    evidenceDirectory: run?.evidenceDirectory ?? null,
    message: message ?? run?.message ?? review?.aggregationError ?? null,
    generationAttemptAudit,
    generationPaidInferenceEvidence,
    reviewExitCode,
    reviewPaidInferenceEvidence,
    generationCleanup:
      generationCleanup && !generationCleanup.unavailable
        ? {
            status: generationCleanup.ledger?.status ?? null,
            attemptCount: generationCleanup.ledger?.attemptCount ?? null,
            downgradedFromCompleted: Boolean(generationCleanup.downgradedFromCompleted),
          }
        : null,
    review,
  };
}

await persist("running");
for (const entry of cases) {
  if (childOrchestrator.interruptedSignal) break;
  const result = await runCase(entry);
  results.push(result);
  await persist("running", { currentCase: entry.id });
  if (childOrchestrator.interruptedSignal) break;
  if (result.status !== "passed" && !continueOnFailure) break;
}

const operationalPassed =
  results.length === cases.length && results.every((entry) => entry.status === "passed");
const generationAttemptsMade = results.reduce(
  (total, entry) => total + (entry.generationAttemptAudit?.attemptedTotal ?? 0),
  0,
);
const completeSuite = !requestedCase && results.length === manifest.cases.length;
let superiority = null;
if (completeSuite && results.every((entry) => entry.review?.aggregate)) {
  superiority = aggregatePaperSuite(
    results.map((entry) => entry.review),
    manifest.claimPolicy.sharedAxes,
    manifest.claimPolicy.strictWinAxesRequiredAtSuiteMedian,
  );
  await writeFile(
    join(suiteDirectory, "paper_selected_figures_qualitative_scorecard.json"),
    `${JSON.stringify(superiority, null, 2)}\n`,
  );
}
const certificationPassed = certificationExitStatus({
  requestedCase,
  operationalPassed,
  superiority,
});
await persist(certificationPassed ? "passed" : "failed", {
  finishedAt: new Date().toISOString(),
  interruptedSignal: childOrchestrator.interruptedSignal,
  generationAttemptsMade,
  operationalPassed,
  completeSuite,
  certificationPassed,
  qualitativeClaimEligible: completeSuite && certificationPassed,
  superiority,
});
console.log(
  JSON.stringify(
    {
      suiteId,
      interruptedSignal: childOrchestrator.interruptedSignal,
      generationAttemptsMade,
      operationalPassed,
      completeSuite,
      certificationPassed,
      qualitativeClaimEligible: completeSuite && certificationPassed,
      superiority,
      results,
    },
    null,
    2,
  ),
);
process.exitCode = certificationPassed ? 0 : 1;

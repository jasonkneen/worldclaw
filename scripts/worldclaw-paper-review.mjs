import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAPER_REVIEW_IMAGE_LIMITS,
  PAPER_REVIEW_PROVIDER_ROSTER,
  aggregatePaperReviewers,
  buildPaperReviewImages,
  deterministicPaperCaptureSummary,
  normalizePaperReviewerResult,
  promptSha256,
  sha256,
  validatePaperRunBinding,
} from "./worldclaw-paper-review-lib.mjs";
import {
  persistPaidInferenceEvidence,
  validatePaidInferenceEvidence,
} from "./worldclaw-paid-benchmark-lib.mjs";
import {
  PAPER_GENERATION_PAID_RUN_CONFIG,
  PAPER_REVIEW_PAID_RUN_CONFIG,
  PAPER_SUITE_TIMEOUTS_MS,
} from "./worldclaw-paper-suite-lib.mjs";
import {
  createPaidInferenceRun,
  finishPaidInferenceRun,
  withPaidInferenceRun,
} from "../src/lib/worldclaw/paid-inference.server.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(
  workspaceRoot,
  "assets/worldclaw/reference-validation/paper_prompt_suite.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const caseId = argument("--case");
const runId = argument("--run-id");
const suiteId = argument("--suite-id");
const caseToken = argument("--case-token");
assert.match(caseId ?? "", /^figure-\d{2}-[a-z0-9-]{1,100}$/);
assert.match(runId ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
assert.match(suiteId ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
assert.match(caseToken ?? "", /^[a-f0-9]{32,64}$/);
const paperCase = manifest.cases.find((entry) => entry.id === caseId);
assert.ok(paperCase, `Unknown paper case: ${caseId}`);
const runsRoot = resolve(workspaceRoot, "screenshots/reference-validation/runs");
const runDirectory = resolve(runsRoot, runId);
assert.ok(runDirectory.startsWith(`${runsRoot}${sep}`), "Review run escaped the evidence root");
const outputPath = join(runDirectory, "paper_review.json");
const paidAttemptLogPath = join(runDirectory, "paper_review_paid_inference_attempts.jsonl");
const reviewPaidRunId = process.env.WORLDCLAW_REVIEW_PAID_RUN_ID?.trim();
const reviewPaidRunToken = process.env.WORLDCLAW_REVIEW_PAID_RUN_TOKEN?.trim();
const reviewPaidSinkUrl = process.env.WORLDCLAW_REVIEW_PAID_SINK_URL?.trim();
const reviewPaidSinkToken = process.env.WORLDCLAW_REVIEW_PAID_SINK_TOKEN?.trim();
assert.equal(reviewPaidRunId, `${runId}:review`, "Paid review run id drifted");
assert.match(reviewPaidRunToken ?? "", /^[a-z0-9][a-z0-9._:-]{15,255}$/i);
assert.match(reviewPaidSinkUrl ?? "", /^http:\/\/127\.0\.0\.1:\d{5}\/$/);
const reviewPaidSinkPort = Number(new URL(reviewPaidSinkUrl).port);
assert.ok(reviewPaidSinkPort >= 49_152 && reviewPaidSinkPort <= 65_535);
assert.match(reviewPaidSinkToken ?? "", /^[a-z0-9][a-z0-9._:-]{15,255}$/i);
const axes = manifest.claimPolicy.sharedAxes;

const pdfBytes = await readFile(resolve(workspaceRoot, manifest.paper.pdf));
assert.equal(sha256(pdfBytes), manifest.paper.sha256, "Paper PDF hash drifted");
const reviewImages = await buildPaperReviewImages(runDirectory, {
  ...paperCase,
  referenceImagePath: resolve(workspaceRoot, paperCase.referenceImage),
});
const deterministic = deterministicPaperCaptureSummary(reviewImages.manifest);
const generationStatus = JSON.parse(
  await readFile(join(runDirectory, "generation_status.json"), "utf8"),
);
await validatePaidInferenceEvidence({
  directory: runDirectory,
  descriptor: generationStatus.paidInferenceEvidence,
  expectedRunId: `${runId}:generation`,
  expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
  expectedStatus: "completed",
});
const binding = validatePaperRunBinding({
  generationStatus,
  captureManifest: reviewImages.manifest,
  paperCase,
  suiteId,
  caseToken,
  runId,
});
const generatedImageFiles = {
  beauty: "paper-review-beauty-matrix.png",
  instance: "paper-review-instance-matrix.png",
  diagnostics: "paper-review-depth-normal-matrix.png",
};
await Promise.all(
  Object.entries(generatedImageFiles).map(([key, filename]) =>
    writeFile(join(runDirectory, filename), reviewImages.images[key].bytes),
  ),
);

const system = `You are one member of a preregistered, conservative four-model visual review panel. Compare only the supplied, role-matched evidence for one selected qualitative WorldClaw figure. This is not a scientific or whole-paper superiority test. Do not reward novelty, effort, provider identity, or prose. Do not infer unseen geometry. A win requires clearly stronger visible evidence; a tie means no visible regression; a loss means visibly weaker. If an axis cannot be judged from the supplied roles, mark it unscorable rather than guessing. A normal visual weakness belongs in an axis loss, not blockingDefects. Use blockingDefects only when the comparison evidence itself is invalid or role-mismatched. Output exactly one JSON object with this shape: {"axes":[{"axis":string,"status":"scored"|"unscorable","outcome":"loss"|"tie"|"win"|null,"confidence":number,"evidence":[{"imageKey":"reference"|"beauty"|"instance"|"diagnostics","view":"global"|"region-1"|"region-2"|"region-3"|"region-4"|"walk-1"|"walk-2"|"walk-3"|"walk-4","pass":"beauty"|"instance"|"depth"|"normal","observation":string}],"rationale":string}],"blockingDefects":string[],"uncertainties":string[]}. Include every requested axis exactly once. A scored axis needs confidence at least 0.5 and at least two evidence rows: one paper-reference row and one generated-result row. Reference evidence must use imageKey reference with global/region-1..4 + beauty, or walk-1..4 + beauty|instance|depth|normal. Generated evidence must use beauty/any-view/beauty, instance/walk-view/instance, or diagnostics/walk-view/depth|normal. Every scored axis must include at least one exact like-for-like reference/generated pair sharing the same view and pass. An unscorable axis must use outcome null and no evidence, and explain the uncertainty. blockingDefects and uncertainties must always be JSON arrays, using [] when empty.`;
const user = `Case: ${paperCase.title}
Exact prompt hash: ${promptSha256(paperCase.prompt)}
Exact prompt: ${paperCase.prompt}
Terrain relationships: ${paperCase.terrainRelationships.join("; ")}
Object families: ${paperCase.objectFamilies.join("; ")}
Regional roles: ${paperCase.regionalReadability.join("; ")}
Axes in required order: ${axes.join(", ")}

Four images are attached in this exact order:
1. reference: the hash-locked paper figure matrix crop. It contains the paper global/regional structure and its walk/instance/depth/normal rows.
2. beauty: generated 3x3 matrix in row-major order: global, region-1, region-2, region-3, region-4, walk-1, walk-2, walk-3, walk-4.
3. instance: generated 1x4 row: walk-1 through walk-4.
4. diagnostics: generated 2x4 matrix: depth walk-1 through walk-4, then normal walk-1 through walk-4.
Permanent label bars identify every generated cell; colored markers reinforce row-major boundaries and are not scene content.

The generated beauty is an honest direct-lit structural capture, not the visible postprocessed UI. Compare composition, geometry, materials, lighting, and legibility available in both sources; do not give credit for omitted postprocessing.
Deterministic generated-capture evidence: ${JSON.stringify(deterministic)}

For diagnostic_correctness, deterministic failures are authoritative. For ground_level_stability, inspect walk views for clipping, exposed edges, broken water/terrain, occlusion, floating/penetrating objects, and framing. Tie every claim to a supplied image role.`;
assert.ok(system.length <= 5_000, "Reviewer system prompt exceeds its bound");
assert.ok(user.length <= 30_000, "Reviewer input exceeds its bound");

const imageBudget = {
  limits: PAPER_REVIEW_IMAGE_LIMITS,
  usage: reviewImages.budget,
};
const images = [
  reviewImages.images.reference,
  reviewImages.images.beauty,
  reviewImages.images.instance,
  reviewImages.images.diagnostics,
].map(({ bytes, mime }) => ({ b64: bytes.toString("base64"), mime }));

export const PAPER_REVIEW_SYSTEM_PROMPT = system;

export function paperReviewerRecord(reviewer, value, result) {
  assert.equal(value.model, reviewer.model, `${reviewer.provider} returned a different model`);
  assert.match(
    value.responseId,
    /^[a-z0-9][a-z0-9._:/+=-]{0,255}$/i,
    `${reviewer.provider} returned an invalid response identifier`,
  );
  return {
    provider: reviewer.provider,
    requestedModel: reviewer.model,
    model: value.model,
    responseId: value.responseId,
    status: "passed",
    result,
  };
}

async function runReviewers() {
  const [{ xaiVisionJsonResult, parseJsonFromLlm }, { geminiVisionJsonResult }, openai, claude] =
    await Promise.all([
      import("../src/lib/worldclaw/xai.server.ts"),
      import("../src/lib/worldclaw/gemini.server.ts"),
      import("../src/lib/worldclaw/openai.server.ts"),
      import("../src/lib/worldclaw/claude.server.ts"),
    ]);
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Four-model paper review exceeded ${PAPER_SUITE_TIMEOUTS_MS.reviewerProviderDeadline + 5_000}ms`,
        ),
      ),
    PAPER_SUITE_TIMEOUTS_MS.reviewerProviderDeadline + 5_000,
  );
  const xaiReviewModel =
    PAPER_REVIEW_PROVIDER_ROSTER.find(([provider]) => provider === "xai")?.[1] ?? "";
  const calls = [
    {
      provider: "xai",
      model: xaiReviewModel,
      call: async () => {
        const response = await xaiVisionJsonResult({
          system,
          user,
          images,
          model: xaiReviewModel,
          maxTokens: 8_192,
          reasoningEffort: "high",
          signal: controller.signal,
          timeoutMs: 180_000,
          dispatch: {
            stage: "final_judge",
            iteration: 1,
            role: "Independent paper visual reviewer",
          },
        });
        return {
          raw: parseJsonFromLlm(response.text),
          model: response.model,
          responseId: response.responseId,
        };
      },
    },
    {
      provider: "gemini",
      model: "gemini-3.6-flash",
      call: async () => {
        const response = await geminiVisionJsonResult({
          system,
          user,
          images,
          model: "gemini-3.6-flash",
          maxTokens: 8_192,
          thinkingLevel: "high",
          signal: controller.signal,
          timeoutMs: 180_000,
          dispatch: {
            stage: "final_judge",
            iteration: 1,
            role: "Independent paper visual reviewer",
          },
        });
        return {
          raw: parseJsonFromLlm(response.text),
          model: response.model,
          responseId: response.responseId,
        };
      },
    },
    {
      provider: "openai",
      model: "gpt-5.6-sol",
      call: async () => {
        const response = await openai.openaiVisionJson({
          system,
          user,
          images,
          model: "gpt-5.6-sol",
          maxTokens: 8_192,
          reasoningEffort: "high",
          imageDetail: "high",
          signal: controller.signal,
          timeoutMs: 180_000,
          dispatch: {
            stage: "final_judge",
            iteration: 1,
            role: "Independent paper visual reviewer",
          },
        });
        return {
          raw: JSON.parse(response.text),
          model: response.model,
          responseId: response.responseId,
        };
      },
    },
    {
      provider: "anthropic",
      model: "anthropic/claude-opus-5",
      call: async () => {
        const response = await claude.claudeVisionJson({
          system,
          user,
          images,
          model: "anthropic/claude-opus-5",
          maxTokens: 8_192,
          imageDetail: "high",
          signal: controller.signal,
          timeoutMs: 180_000,
          dispatch: {
            stage: "final_judge",
            iteration: 1,
            role: "Independent paper visual reviewer",
          },
        });
        return {
          raw: JSON.parse(response.text),
          model: response.model,
          responseId: response.responseId,
        };
      },
    },
  ];
  try {
    return await Promise.all(
      calls.map(async (reviewer) => {
        try {
          const value = await reviewer.call();
          return paperReviewerRecord(
            reviewer,
            value,
            normalizePaperReviewerResult(value.raw, axes),
          );
        } catch (error) {
          return {
            provider: reviewer.provider,
            requestedModel: reviewer.model,
            model: reviewer.model,
            status: "error",
            error: (error instanceof Error ? error.message : String(error)).slice(0, 1_200),
          };
        }
      }),
    );
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

let reviewers;
let paidReviewLedger;
let paidInferenceEvidence;
let reviewRunError;
try {
  const created = createPaidInferenceRun({
    runId: reviewPaidRunId,
    enforcementToken: reviewPaidRunToken,
    ...PAPER_REVIEW_PAID_RUN_CONFIG,
    ledgerSink: {
      url: reviewPaidSinkUrl,
      token: reviewPaidSinkToken,
      timeoutMs: 2_000,
    },
  });
  const serialized = JSON.stringify(created);
  assert.equal(serialized.includes(reviewPaidRunToken), false, "Paid review leaked its run token");
  assert.equal(
    serialized.includes(reviewPaidSinkToken),
    false,
    "Paid review leaked its sink token",
  );
  reviewers = await withPaidInferenceRun(reviewPaidRunId, reviewPaidRunToken, runReviewers);
  const paidStatus = reviewers.every((reviewer) => reviewer.status === "passed")
    ? "completed"
    : "failed";
  paidReviewLedger = finishPaidInferenceRun(reviewPaidRunId, reviewPaidRunToken, paidStatus);
} catch (error) {
  reviewRunError = error;
  if (!paidReviewLedger) {
    try {
      paidReviewLedger = finishPaidInferenceRun(reviewPaidRunId, reviewPaidRunToken, "failed");
    } catch {
      // Preflight can fail before a run exists; no paid call can occur in that state.
    }
  }
}
if (!paidReviewLedger && reviewRunError) throw reviewRunError;
assert.ok(paidReviewLedger, "Paid paper review ledger did not finalize");
paidInferenceEvidence = await persistPaidInferenceEvidence({
  directory: runDirectory,
  ledger: paidReviewLedger,
  attemptLogPath: paidAttemptLogPath,
  ledgerFile: "paper_review_paid_inference_ledger.json",
  attemptLogFile: "paper_review_paid_inference_attempts.jsonl",
  expectedConfig: PAPER_REVIEW_PAID_RUN_CONFIG,
  expectedStatus: paidReviewLedger.status,
  forbiddenSecrets: [reviewPaidRunToken, reviewPaidSinkToken],
  completeAttemptLog: true,
});
if (reviewRunError) throw reviewRunError;
assert.ok(reviewers, "Paper reviewers did not return a result");
let aggregate = null;
let aggregationError = null;
try {
  aggregate = aggregatePaperReviewers(reviewers, axes, PAPER_REVIEW_PROVIDER_ROSTER);
} catch (error) {
  aggregationError = (error instanceof Error ? error.message : String(error)).slice(0, 1_200);
}
const operationalPassed = deterministic.passed && aggregate !== null;
const qualitativeNonLoss = operationalPassed && aggregate.passed;
const output = {
  version: 2,
  scope:
    "model-panel qualitative judgment on one selected WorldClaw figure and six preregistered axes",
  caseId,
  runId,
  suiteId,
  binding,
  paper: {
    pdfSha256: manifest.paper.sha256,
    figure: paperCase.figure,
    page: paperCase.pdfPage,
    referenceImage: paperCase.referenceImage,
    referenceSha256: paperCase.referenceSha256,
    referencePanelCrop: paperCase.referencePanelCrop,
    referencePanelSha256: paperCase.referencePanelSha256,
  },
  prompt: paperCase.prompt,
  promptSha256: promptSha256(paperCase.prompt),
  inputImages: {
    referencePanel: reviewImages.hashes.reference,
    beauty: generatedImageFiles.beauty,
    beautySha256: reviewImages.hashes.beauty,
    instance: generatedImageFiles.instance,
    instanceSha256: reviewImages.hashes.instance,
    diagnostics: generatedImageFiles.diagnostics,
    diagnosticsSha256: reviewImages.hashes.diagnostics,
  },
  imageBudget,
  deterministic,
  providerRoster: PAPER_REVIEW_PROVIDER_ROSTER.map(([provider, model]) => ({ provider, model })),
  paidReviewerCalls: {
    maximum: PAPER_REVIEW_PROVIDER_ROSTER.length,
    attempted: paidInferenceEvidence.attemptCount,
    succeeded: reviewers.filter((reviewer) => reviewer.status === "passed").length,
  },
  paidInferenceEvidence,
  reviewers,
  aggregate,
  aggregationError,
  operationalPassed,
  qualitativeNonLoss,
  passed: qualitativeNonLoss,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
process.exitCode = qualitativeNonLoss ? 0 : 1;

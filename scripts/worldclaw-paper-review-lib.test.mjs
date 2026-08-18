import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import {
  PAPER_REVIEW_PROVIDER_ROSTER,
  aggregatePaperReviewers,
  aggregatePaperSuite,
  certificationExitStatus,
  composePaperContactSheet,
  normalizePaperReviewerResult,
  promptSha256,
  validatePaperReviewImageBudget,
  validatePaperRunBinding,
} from "./worldclaw-paper-review-lib.mjs";

const axes = ["terrain", "content", "materials", "walk", "alignment", "diagnostics"];

function rawResult(outcomes, overrides = {}) {
  return {
    axes: axes.map((axis, index) => ({
      axis,
      status: "scored",
      outcome: outcomes[index],
      confidence: 0.8,
      evidence: [
        {
          imageKey: "reference",
          view:
            index < 5 ? ["global", "region-1", "region-2", "region-3", "walk-1"][index] : "walk-1",
          pass: index === 5 ? "depth" : "beauty",
          observation: `paper ${axis}`,
        },
        {
          imageKey: index === 5 ? "diagnostics" : "beauty",
          view:
            index < 5 ? ["global", "region-1", "region-2", "region-3", "walk-1"][index] : "walk-1",
          pass: index === 5 ? "depth" : "beauty",
          observation: `visible ${axis}`,
        },
      ],
      rationale: `${axis} comparison`,
    })),
    blockingDefects: [],
    uncertainties: [],
    ...overrides,
  };
}

function reviewer(providerIndex, outcomes, resultOverrides = {}) {
  const [provider, model] = PAPER_REVIEW_PROVIDER_ROSTER[providerIndex];
  return {
    provider,
    model,
    status: "passed",
    result: normalizePaperReviewerResult(rawResult(outcomes, resultOverrides), axes),
  };
}

function caseReview(axisOutcome = "win") {
  const score = axisOutcome === "win" ? 1 : axisOutcome === "tie" ? 0 : -1;
  return {
    aggregate: {
      axisMedians: Object.fromEntries(
        axes.map((axis) => [
          axis,
          {
            score,
            outcome: axisOutcome,
            reviewerScores: [score, score, score, score],
            wins: axisOutcome === "win" ? 4 : 0,
            losses: axisOutcome === "loss" ? 4 : 0,
          },
        ]),
      ),
    },
  };
}

test("contact sheets have deterministic bounded geometry and cell markers", () => {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  const bytes = PNG.sync.write(image);
  const first = composePaperContactSheet(Array(9).fill(bytes));
  const second = composePaperContactSheet(Array(9).fill(bytes));
  assert.deepEqual(first, second);
  const sheet = PNG.sync.read(first);
  assert.deepEqual([sheet.width, sheet.height], [976, 604]);
  assert.notDeepEqual(
    [...sheet.data.subarray((7 * sheet.width + 18) * 4, (7 * sheet.width + 18) * 4 + 3)],
    [255, 255, 255],
  );
});

test("review normalization requires an exact axis set and structured visible evidence", () => {
  const normalized = normalizePaperReviewerResult(rawResult(Array(6).fill("tie")), axes);
  assert.equal(normalized.axes.length, 6);
  const omitted = rawResult(Array(6).fill("tie"));
  omitted.axes.pop();
  assert.throws(() => normalizePaperReviewerResult(omitted, axes), /axis set is not exact/);
  const duplicate = rawResult(Array(6).fill("tie"));
  duplicate.axes[5].axis = duplicate.axes[0].axis;
  assert.throws(() => normalizePaperReviewerResult(duplicate, axes), /duplicate axes/);
  const proseOnly = rawResult(Array(6).fill("tie"));
  proseOnly.axes[0].evidence = ["looks fine"];
  assert.throws(() => normalizePaperReviewerResult(proseOnly, axes), /structured/);
  const lowConfidence = rawResult(Array(6).fill("tie"));
  lowConfidence.axes[0].confidence = 0.49;
  assert.throws(() => normalizePaperReviewerResult(lowConfidence, axes), /scoring floor/);
  const generatedOnly = rawResult(Array(6).fill("tie"));
  generatedOnly.axes[0].evidence = generatedOnly.axes[0].evidence.filter(
    (entry) => entry.imageKey !== "reference",
  );
  assert.throws(() => normalizePaperReviewerResult(generatedOnly, axes), /paired visible evidence/);
  const impossible = rawResult(Array(6).fill("tie"));
  impossible.axes[0].evidence[1] = {
    imageKey: "instance",
    view: "region-1",
    pass: "depth",
    observation: "impossible matrix cell",
  };
  assert.throws(() => normalizePaperReviewerResult(impossible, axes), /combination is impossible/);
  const mismatchedPair = rawResult(Array(6).fill("tie"));
  mismatchedPair.axes[0].evidence[0].view = "region-1";
  mismatchedPair.axes[0].evidence[1].view = "region-2";
  assert.throws(
    () => normalizePaperReviewerResult(mismatchedPair, axes),
    /no exact like-for-like/,
  );
  const malformedBlockers = rawResult(Array(6).fill("tie"), {
    blockingDefects: "role mismatch",
  });
  assert.throws(() => normalizePaperReviewerResult(malformedBlockers, axes), /must be an array/);
  const malformedUncertainty = rawResult(Array(6).fill("tie"), {
    uncertainties: [""],
  });
  assert.throws(() => normalizePaperReviewerResult(malformedUncertainty, axes), /must not be empty/);
});

test("unscorable axes cannot smuggle outcomes or visible claims", () => {
  const raw = rawResult(Array(6).fill("tie"));
  raw.axes[0] = {
    axis: axes[0],
    status: "unscorable",
    outcome: null,
    confidence: 0,
    evidence: [],
    rationale: "Reference role is not visible",
  };
  const normalized = normalizePaperReviewerResult(raw, axes);
  assert.equal(normalized.axes[0].status, "unscorable");
  raw.axes[0].outcome = "tie";
  assert.throws(() => normalizePaperReviewerResult(raw, axes), /outcome must be null/);
});

test("four-model aggregation is conservative under split panels and any loss", () => {
  const tie = Array(6).fill("tie");
  const win = Array(6).fill("win");
  const loss = Array(6).fill("loss");
  const split = aggregatePaperReviewers(
    [reviewer(0, win), reviewer(1, win), reviewer(2, tie), reviewer(3, tie)],
    axes,
  );
  assert.equal(split.axisMedians.terrain.outcome, "tie");
  assert.deepEqual(split.strictWinAxes, []);
  const decisive = aggregatePaperReviewers(
    [reviewer(0, win), reviewer(1, win), reviewer(2, win), reviewer(3, tie)],
    axes,
  );
  assert.equal(decisive.axisMedians.terrain.outcome, "win");
  const contested = aggregatePaperReviewers(
    [reviewer(0, win), reviewer(1, win), reviewer(2, tie), reviewer(3, loss)],
    axes,
  );
  assert.equal(contested.passed, false);
  assert.equal(contested.axisMedians.terrain.outcome, "loss");
});

test("aggregation fails closed for missing models, errors, blockers, and uncertainty", () => {
  const tie = Array(6).fill("tie");
  const complete = [reviewer(0, tie), reviewer(1, tie), reviewer(2, tie), reviewer(3, tie)];
  assert.throws(() => aggregatePaperReviewers(complete.slice(0, 3), axes), /roster size/);
  const errored = structuredClone(complete);
  errored[3] = { provider: "anthropic", model: "anthropic/claude-opus-5", status: "error" };
  assert.throws(() => aggregatePaperReviewers(errored, axes), /did not complete/);
  const blocked = structuredClone(complete);
  blocked[0].result.blockingDefects = ["role mismatch"];
  assert.throws(() => aggregatePaperReviewers(blocked, axes), /blocking defects/);
  const uncertain = structuredClone(complete);
  uncertain[1].result.uncertainties = ["cannot see reference"];
  assert.throws(() => aggregatePaperReviewers(uncertain, axes), /uncertainties/);
});

test("suite requires all eleven cases, no losses, and six-case majority wins", () => {
  const winning = Array.from({ length: 11 }, () => caseReview("win"));
  assert.equal(aggregatePaperSuite(winning, axes, 4).passed, true);
  assert.throws(() => aggregatePaperSuite(winning.slice(0, 10), axes, 4), /eleven cases/);
  const fiveWins = [
    ...Array.from({ length: 5 }, () => caseReview("win")),
    ...Array.from({ length: 6 }, () => caseReview("tie")),
  ];
  assert.equal(aggregatePaperSuite(fiveWins, axes, 4).passed, false);
  const losing = structuredClone(winning);
  losing[10] = caseReview("loss");
  assert.equal(aggregatePaperSuite(losing, axes, 4).passed, false);
});

test("full-suite process success still exits nonzero without qualitative certification", () => {
  assert.equal(
    certificationExitStatus({
      requestedCase: undefined,
      operationalPassed: true,
      superiority: { passed: false },
    }),
    false,
  );
  assert.equal(
    certificationExitStatus({
      requestedCase: undefined,
      operationalPassed: true,
      superiority: { passed: true },
    }),
    true,
  );
  assert.equal(
    certificationExitStatus({
      requestedCase: "figure-12",
      operationalPassed: true,
      superiority: null,
    }),
    true,
  );
});

test("review image budget rejects oversize dimensions before provider calls", () => {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(127);
  const valid = PNG.sync.write(image);
  const images = Object.fromEntries(
    ["reference", "beauty", "instance", "diagnostics"].map((key) => [
      key,
      { bytes: valid, mime: "image/png" },
    ]),
  );
  assert.equal(validatePaperReviewImageBudget(images).imageCount, 4);
  const huge = new PNG({ width: 2_049, height: 1 });
  huge.data.fill(0);
  images.reference = { bytes: PNG.sync.write(huge), mime: "image/png" };
  assert.throws(() => validatePaperReviewImageBudget(images), /width is out of bounds/);
});

test("run binding ties exact case, prompt, token, roles, world, and seed", () => {
  const regionalReadability = ["coastal town", "hill town", "shrine district", "waterside settlement"];
  const paperCase = {
    id: "figure-12-japanese-island-towns",
    prompt: "exact prompt",
    regionalReadability,
  };
  const suiteId = "2026-08-12T08-00-00-000Z";
  const caseToken = "a".repeat(48);
  const runId = "2026-08-12T08-01-00-000Z";
  const hash = promptSha256(paperCase.prompt);
  const generationStatus = {
    status: "passed",
    runId,
    startedAt: "2026-08-12T08:01:00.000Z",
    finishedAt: "2026-08-12T08:02:00.000Z",
    binding: {
      suiteId,
      caseId: paperCase.id,
      caseToken,
      promptSha256: hash,
      regionalReadability,
    },
    generatedWorld: { id: "world-1", seed: 42, promptSha256: hash },
    paperCaptureEvidence: {
      manifest: { sha256: "b".repeat(64) },
      imageSetSha256: "c".repeat(64),
      imageCount: 36,
      capturedAt: "2026-08-12T08:01:30.000Z",
      worldFingerprint: "0123456789abcdef",
    },
    prebuildEvidence: { manifest: { sha256: "d".repeat(64) } },
    committeeEvidence: {
      manifest: { sha256: "e".repeat(64) },
      structuredOutputSetSha256: "f".repeat(64),
    },
  };
  const captureManifest = {
    worldId: "world-1",
    seed: 42,
    binding: generationStatus.binding,
    worldPromptSha256: hash,
    worldFingerprint: "0123456789abcdef",
    capturedAt: "2026-08-12T08:01:30.000Z",
    regionalReadability,
  };
  const verifiedEvidence = {
    manifestSha256: "b".repeat(64),
    imageSetSha256: "c".repeat(64),
    prebuildManifestSha256: "d".repeat(64),
    committeeManifestSha256: "e".repeat(64),
    structuredOutputSetSha256: "f".repeat(64),
  };
  assert.equal(
    validatePaperRunBinding({
      generationStatus,
      captureManifest,
      paperCase,
      suiteId,
      caseToken,
      runId,
      verifiedEvidence,
    }).worldId,
    "world-1",
  );
  generationStatus.binding.caseToken = "b".repeat(48);
  assert.throws(
    () =>
      validatePaperRunBinding({
        generationStatus,
        captureManifest,
        paperCase,
        suiteId,
        caseToken,
        runId,
        verifiedEvidence,
      }),
    /case token drifted/,
  );
});

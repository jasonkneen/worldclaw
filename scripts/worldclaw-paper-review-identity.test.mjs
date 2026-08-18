import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const REVIEWER_PATH = new URL("./worldclaw-paper-review.mjs", import.meta.url);

test("paper review requires provider-attested identities and exact like-for-like evidence", async () => {
  const source = await readFile(REVIEWER_PATH, "utf8");
  const exactEvidenceContract =
    "Reference evidence must use imageKey reference with global/region-1..4 + beauty, or walk-1..4 + beauty|instance|depth|normal. Generated evidence must use beauty/any-view/beauty, instance/walk-view/instance, or diagnostics/walk-view/depth|normal. Every scored axis must include at least one exact like-for-like reference/generated pair sharing the same view and pass.";

  assert.match(source, /xaiVisionJsonResult/);
  assert.match(source, /geminiVisionJsonResult/);
  assert.ok(source.includes(exactEvidenceContract));
  assert.equal(
    source.match(/responseId:\s*response\.responseId/g)?.length,
    4,
    "all four provider calls must forward provider-issued response identifiers",
  );
  assert.match(source, /requestedModel:\s*reviewer\.model/);
  assert.match(source, /responseId:\s*value\.responseId/);
});

test("paper review is independently prepaid, dispatch-attested, and evidence-persisted", async () => {
  const source = await readFile(REVIEWER_PATH, "utf8");
  assert.match(source, /PAPER_REVIEW_PAID_RUN_CONFIG/);
  assert.doesNotMatch(source, /startPaidInferenceJsonlCollector/);
  assert.match(source, /WORLDCLAW_REVIEW_PAID_RUN_ID/);
  assert.match(source, /WORLDCLAW_REVIEW_PAID_RUN_TOKEN/);
  assert.match(source, /WORLDCLAW_REVIEW_PAID_SINK_URL/);
  assert.match(source, /WORLDCLAW_REVIEW_PAID_SINK_TOKEN/);
  assert.match(source, /createPaidInferenceRun/);
  assert.match(source, /withPaidInferenceRun/);
  assert.match(source, /finishPaidInferenceRun/);
  assert.match(source, /persistPaidInferenceEvidence/);
  assert.equal(
    source.match(/dispatch:\s*\{\s*stage:\s*"final_judge"/g)?.length,
    4,
    "all four reviewers must carry bounded final-judge dispatch metadata",
  );
  assert.match(source, /paper_review_paid_inference_ledger\.json/);
  assert.match(source, /paper_review_paid_inference_attempts\.jsonl/);
  assert.match(source, /paidInferenceEvidence/);
});

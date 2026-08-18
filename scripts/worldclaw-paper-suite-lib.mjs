import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const CASE_PROMPT_SHA256 = Object.freeze({
  "figure-04-tropical-pirate-stronghold":
    "db52660835f37efa0de420ff1bc22e53fd2f9e42bc4dedc2113690ce33b04ae2",
  "figure-05-river-canyon-tribal-settlements":
    "c0788b71a516586b56638fac02f094a86475a2d9adf9a0f3d33959a0c5939b45",
  "figure-06-desert-battlefield":
    "cb4cde512fab948134a2c0840390728b1942c737455f9d28589b9cd6ed36d784",
  "figure-07-snow-command-valley":
    "c8893e8aba025a798382e30562f4a0d957c91fd5571dba434f11c5c6c8f806ad",
  "figure-09-medieval-diverse-terrain":
    "6306938e04f17ecb0f72cd6a5e0a6c5e37c0f7946b68173e2af0e7a51d718436",
  "figure-10-frozen-riverside-village":
    "7f384817556608145532f14a7391a7eee0850309a907b0afb2ae81d73dbe3a4f",
  "figure-11-desert-dragon-camp":
    "ef8a675d5d3001a0202112a067127b43b0dfd3589743b49a72b12436953cb9c9",
  "figure-12-japanese-island-towns":
    "6c790cee03f9d6badc7e4db792ba0877e8c68362fd98082a5b5962a4bb0d327e",
  "figure-13-volcanic-demon-lair":
    "fbaff6d8d7f941d506ea97f1d7486b533eeaf24ee5db43c72e4d181b1537c5fd",
  "figure-14-gemstone-mine": "406c5713214d452d9255ca1af4376a24716a8ec8406dc0a4adbc331f911ce120",
  "figure-15-hobbit-mountain-valley":
    "71eb2d36695177c717f33d9928e5083960403c9f6549826b76061323e9b5993e",
});

const CASE_REGIONAL_ROLES_SHA256 = Object.freeze({
  "figure-04-tropical-pirate-stronghold":
    "9d8535cb0b778fc855662291eacdccaaee919fae5c3b513c2b257b86b5049255",
  "figure-05-river-canyon-tribal-settlements":
    "f1b0e6720926091e8ba2b7c2122d3fb4bb7dfabe453e95542049d44f3b2ea09c",
  "figure-06-desert-battlefield":
    "38be9047ac18d1a9884b4b2a7fb25ea5d1004f6d28df1d3bcc76ae6cf3d64d14",
  "figure-07-snow-command-valley":
    "4e8f830b554554df7416ac52704b5f65d888a778b7d7100910b2307d9caf84a3",
  "figure-09-medieval-diverse-terrain":
    "9f4f0a20e21660b12fee081c6862db0725a7c505542ce357b9cf5716f23a6a68",
  "figure-10-frozen-riverside-village":
    "652789e40a2bffa0ac0e48effd3a4d3cbfb82812a99b7edc76897c7b86eddb9b",
  "figure-11-desert-dragon-camp":
    "13e7f7ba8fc82a0781ca3453b23f007a50c5363d02a958236c29968cc482880d",
  "figure-12-japanese-island-towns":
    "08057c32f58cbda623ecc81cee46ca0c5d99bc7c3a44fc624400a48343d71a42",
  "figure-13-volcanic-demon-lair":
    "e91fc9eeb0f05de5ec69a958e37d357d2eae9b7c46e4d38bb0b2760b14d38682",
  "figure-14-gemstone-mine": "9fc3cf9cdf5f1ba0c1aeeaa641648b7722f78a64dc7d4a106c67a611498e6636",
  "figure-15-hobbit-mountain-valley":
    "5bc0a5d621a0a040c0854f67f0ba78f6cdafe2423a67c3a9c4dd8d5e0cee01a5",
});

export const PAPER_SUITE_CONTRACT = Object.freeze({
  version: 2,
  manifestContractSha256: "88c138b87483c8f2d92327a604e53c58b771e88c8226289824d53c7d4e59c4a8",
  caseIds: Object.freeze(Object.keys(CASE_PROMPT_SHA256)),
  casePromptSha256: CASE_PROMPT_SHA256,
  caseRegionalRolesSha256: CASE_REGIONAL_ROLES_SHA256,
  qualitativeFigures: Object.freeze([4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]),
  sharedAxes: Object.freeze([
    "global_terrain_organization",
    "regional_content_richness",
    "material_and_lighting_quality",
    "ground_level_stability",
    "prompt_alignment",
    "diagnostic_correctness",
  ]),
  minimumIndependentReviewers: 4,
  reviewAggregation: "four_member_conservative_panel",
  strictWinAxesRequired: 4,
});

const PAID_STAGES = Object.freeze(["planning", "layout", "multiview", "critique", "final_judge"]);

const maximumByProviderAndStage = Object.freeze({
  xai: Object.freeze({ planning: 2, layout: 2, multiview: 2, critique: 7, final_judge: 1 }),
  gemini: Object.freeze({
    planning: 3,
    layout: 2,
    multiview: 2,
    critique: 8,
    final_judge: 2,
  }),
  openai: Object.freeze({
    planning: 2,
    layout: 2,
    multiview: 2,
    critique: 7,
    final_judge: 1,
  }),
  anthropic: Object.freeze({
    planning: 2,
    layout: 0,
    multiview: 0,
    critique: 7,
    final_judge: 1,
  }),
});

const minimumByStage = Object.freeze({
  planning: 4,
  layout: 3,
  multiview: 3,
  critique: 16,
  final_judge: 4,
});

const maximumByStage = Object.freeze({
  planning: 6,
  layout: 4,
  multiview: 4,
  critique: 29,
  final_judge: 5,
});

const minimumByProviderAndStage = Object.freeze({
  xai: Object.freeze({ planning: 1, layout: 1, multiview: 1, critique: 4, final_judge: 1 }),
  gemini: Object.freeze({ planning: 1, layout: 1, multiview: 1, critique: 4, final_judge: 1 }),
  openai: Object.freeze({ planning: 1, layout: 1, multiview: 1, critique: 4, final_judge: 1 }),
  anthropic: Object.freeze({
    planning: 1,
    layout: 0,
    multiview: 0,
    critique: 4,
    final_judge: 1,
  }),
});

const textModels = Object.freeze({
  xai: "grok-4.6",
  gemini: "gemini-3.6-flash",
  openai: "gpt-5.6-sol",
  anthropic: "anthropic/claude-opus-5",
});

export const PAPER_GENERATION_MODEL_ENVIRONMENT = Object.freeze({
  XAI_TEXT_MODEL: textModels.xai,
  GEMINI_TEXT_MODEL: textModels.gemini,
  OPENAI_TEXT_MODEL: textModels.openai,
  CLAUDE_MODEL: textModels.anthropic,
  GEMINI_IMAGE_MODEL: "gemini-3-pro-image",
  OPENAI_IMAGE_MODEL: "gpt-image-2",
});

const providerDeadlinesMs = Object.freeze({
  text: 150_000,
  vision: 150_000,
  image: 180_000,
  reviewerVision: 180_000,
});

const expectedRuntimeRoster = Object.freeze({
  entries: Object.freeze([
    Object.freeze({
      provider: "xai",
      modality: "text",
      model: textModels.xai,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.text,
    }),
    Object.freeze({
      provider: "xai",
      modality: "vision",
      model: textModels.xai,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.reviewerVision,
    }),
    Object.freeze({
      provider: "xai",
      modality: "image",
      model: "grok-imagine-image-quality",
      configured: true,
      identityAttestation: "request-only",
      timeoutMs: providerDeadlinesMs.image,
    }),
    Object.freeze({
      provider: "gemini",
      modality: "text",
      model: textModels.gemini,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.text,
    }),
    Object.freeze({
      provider: "gemini",
      modality: "vision",
      model: textModels.gemini,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.reviewerVision,
    }),
    Object.freeze({
      provider: "gemini",
      modality: "image",
      model: "gemini-3-pro-image",
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.image,
    }),
    Object.freeze({
      provider: "openai",
      modality: "text",
      model: textModels.openai,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.text,
    }),
    Object.freeze({
      provider: "openai",
      modality: "vision",
      model: textModels.openai,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.reviewerVision,
    }),
    Object.freeze({
      provider: "openai",
      modality: "image",
      model: "gpt-image-2",
      configured: true,
      identityAttestation: "request-only",
      timeoutMs: providerDeadlinesMs.image,
    }),
    Object.freeze({
      provider: "anthropic",
      modality: "text",
      model: textModels.anthropic,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.text,
    }),
    Object.freeze({
      provider: "anthropic",
      modality: "vision",
      model: textModels.anthropic,
      configured: true,
      identityAttestation: "provider-response",
      timeoutMs: providerDeadlinesMs.reviewerVision,
    }),
  ]),
});

function allowedDispatch(modality, model, timeoutMs) {
  return Object.freeze({ modality, model, timeoutMs });
}

function stageCeiling(provider, stage, maxAttempts, allowedDispatches) {
  return Object.freeze({
    provider,
    stage,
    maxAttempts,
    allowedDispatches: Object.freeze(allowedDispatches),
  });
}

const generationStageCeilings = [];
for (const [provider, model] of Object.entries(textModels)) {
  generationStageCeilings.push(
    stageCeiling(provider, "planning", maximumByProviderAndStage[provider].planning, [
      allowedDispatch("text", model, providerDeadlinesMs.text),
    ]),
    stageCeiling(provider, "critique", maximumByProviderAndStage[provider].critique, [
      allowedDispatch("text", model, providerDeadlinesMs.text),
      allowedDispatch("vision", model, providerDeadlinesMs.vision),
    ]),
    stageCeiling(provider, "final_judge", maximumByProviderAndStage[provider].final_judge, [
      allowedDispatch("vision", model, providerDeadlinesMs.vision),
    ]),
  );
}
for (const [provider, models] of Object.entries({
  xai: ["grok-imagine-image-quality"],
  gemini: ["gemini-3-pro-image"],
  openai: ["gpt-image-2"],
})) {
  for (const stage of ["layout", "multiview"]) {
    generationStageCeilings.push(
      stageCeiling(
        provider,
        stage,
        maximumByProviderAndStage[provider][stage],
        models.map((model) => allowedDispatch("image", model, providerDeadlinesMs.image)),
      ),
    );
  }
}

export const PAPER_GENERATION_PAID_RUN_CONFIG = Object.freeze({
  expectedRoster: expectedRuntimeRoster,
  stageCeilings: Object.freeze(generationStageCeilings),
  aggregateStageCeilings: Object.freeze(
    PAID_STAGES.map((stage) => Object.freeze({ stage, maxAttempts: maximumByStage[stage] })),
  ),
  maxAttempts: 46,
});

export const PAPER_REVIEW_PAID_RUN_CONFIG = Object.freeze({
  expectedRoster: expectedRuntimeRoster,
  stageCeilings: Object.freeze(
    Object.entries(textModels).map(([provider, model]) =>
      stageCeiling(provider, "final_judge", provider === "gemini" ? 2 : 1, [
        allowedDispatch("vision", model, providerDeadlinesMs.reviewerVision),
      ]),
    ),
  ),
  aggregateStageCeilings: Object.freeze([Object.freeze({ stage: "final_judge", maxAttempts: 5 })]),
  maxAttempts: 5,
});

const planningProviderCriticalPath = providerDeadlinesMs.text * 4; // initial, judge, adaptive repair, repaired judge
const layoutProviderCriticalPath = providerDeadlinesMs.image * 2 + providerDeadlinesMs.vision * 2;
const multiviewProviderCriticalPath =
  providerDeadlinesMs.image * 2 + providerDeadlinesMs.vision * 3;
const finalJudgeProviderCriticalPath = providerDeadlinesMs.vision;
const preReadyProviderCriticalPath =
  planningProviderCriticalPath + layoutProviderCriticalPath + multiviewProviderCriticalPath;
const rendererAndBrowserMargin = 270_000;
const finalValidation = 240_000;
const caseEvidenceMargin = 120_000;
const reviewerEvidenceMargin = 120_000;

export const PAPER_SUITE_TIMEOUTS_MS = Object.freeze({
  provider: providerDeadlinesMs,
  planningProviderCriticalPath,
  layoutProviderCriticalPath,
  multiviewProviderCriticalPath,
  finalJudgeProviderCriticalPath,
  preReadyProviderCriticalPath,
  generationProviderCriticalPath: preReadyProviderCriticalPath + finalJudgeProviderCriticalPath,
  rendererAndBrowserMargin,
  generationReady: preReadyProviderCriticalPath + rendererAndBrowserMargin,
  finalValidation,
  caseEvidenceMargin,
  generationCase:
    preReadyProviderCriticalPath + rendererAndBrowserMargin + finalValidation + caseEvidenceMargin,
  reviewerProviderDeadline: providerDeadlinesMs.reviewerVision,
  reviewerEvidenceMargin,
  reviewerCase: providerDeadlinesMs.reviewerVision + reviewerEvidenceMargin,
});

const modelsByProviderAndStage = Object.freeze({
  xai: Object.freeze({
    planning: Object.freeze([textModels.xai]),
    layout: Object.freeze(["grok-imagine-image-quality"]),
    multiview: Object.freeze(["grok-imagine-image-quality"]),
    critique: Object.freeze([textModels.xai]),
    final_judge: Object.freeze([textModels.xai]),
  }),
  gemini: Object.freeze({
    planning: Object.freeze([textModels.gemini]),
    layout: Object.freeze(["gemini-3-pro-image"]),
    multiview: Object.freeze(["gemini-3-pro-image"]),
    critique: Object.freeze([textModels.gemini]),
    final_judge: Object.freeze([textModels.gemini]),
  }),
  openai: Object.freeze({
    planning: Object.freeze([textModels.openai]),
    layout: Object.freeze(["gpt-image-2"]),
    multiview: Object.freeze(["gpt-image-2"]),
    critique: Object.freeze([textModels.openai]),
    final_judge: Object.freeze([textModels.openai]),
  }),
  anthropic: Object.freeze({
    planning: Object.freeze([textModels.anthropic]),
    layout: Object.freeze([]),
    multiview: Object.freeze([]),
    critique: Object.freeze([textModels.anthropic]),
    final_judge: Object.freeze([textModels.anthropic]),
  }),
});

export const PAPER_GENERATION_ATTEMPT_BUDGET = Object.freeze({
  accounting:
    "one durably recorded pre-dispatch paid-provider attempt equals one generation attempt",
  textModels,
  modelsByProviderAndStage,
  minimumByProviderAndStage,
  maximumByProviderAndStage,
  minimumByStage,
  maximumByStage,
  minimumTotal: Object.values(minimumByStage).reduce((total, value) => total + value, 0),
  // A run can incur one direct-Gemini billing denial followed by Gateway, but
  // the run-scoped circuit prevents that extra attempt from occurring in more
  // than one stage. Aggregate per-stage ceilings therefore sum to 48 while the
  // true cross-stage maximum is 46.
  maximumTotal: 46,
});

const RESPONSE_ID = /^[a-z0-9][a-z0-9._:/+=-]{0,255}$/i;

function expectedIdentityAttestation(provider, stage) {
  return ["layout", "multiview"].includes(stage) && ["xai", "openai"].includes(provider)
    ? "request-only"
    : "provider-response";
}

function emptyAttemptCounts() {
  return Object.fromEntries(
    Object.entries(maximumByProviderAndStage).map(([provider, stages]) => [
      provider,
      Object.fromEntries(Object.keys(stages).map((stage) => [stage, 0])),
    ]),
  );
}

function emptyObservedModelSets() {
  return Object.fromEntries(
    Object.entries(maximumByProviderAndStage).map(([provider, stages]) => [
      provider,
      Object.fromEntries(Object.keys(stages).map((stage) => [stage, new Set()])),
    ]),
  );
}

export function auditPaperGenerationLedger(ledger) {
  assert.ok(ledger && typeof ledger === "object", "Generation ledger must be an object");
  assert.equal(ledger.status, "retained", "Generation ledger status is not retained");
  assert.ok(Array.isArray(ledger.providers), "Generation ledger providers must be an array");
  const providerNames = ledger.providers.map((entry) => entry?.provider);
  const expectedProviders = Object.keys(textModels);
  assert.equal(
    new Set(providerNames).size,
    providerNames.length,
    "Generation ledger has duplicate providers",
  );
  assert.deepEqual(
    [...providerNames].sort(),
    [...expectedProviders].sort(),
    "Generation ledger provider roster drifted",
  );
  for (const provider of expectedProviders) {
    const entry = ledger.providers.find((candidate) => candidate.provider === provider);
    assert.equal(entry.model, textModels[provider], `${provider} provider status model drifted`);
    assert.equal(entry.configured, "true", `${provider} is not configured`);
    assert.equal(entry.authenticated, "true", `${provider} is not authenticated`);
    assert.equal(entry.available, "true", `${provider} is not available`);
  }

  assert.ok(Array.isArray(ledger.artifacts), "Generation ledger artifacts must be an array");
  const artifactIds = ledger.artifacts.map((artifact) => artifact?.id);
  assert.ok(
    artifactIds.every((id) => typeof id === "string" && id.length > 0),
    "Generation ledger artifact ID is missing",
  );
  assert.equal(
    new Set(artifactIds).size,
    artifactIds.length,
    "Generation ledger has duplicate artifact IDs",
  );

  const attemptedByProviderAndStage = emptyAttemptCounts();
  const attemptedByStage = Object.fromEntries(PAID_STAGES.map((stage) => [stage, 0]));
  const requestedModelsByProviderAndStage = emptyObservedModelSets();
  const providerResponseIds = new Set();
  let attemptedTotal = 0;
  const stagesSeen = new Set();
  for (const artifact of ledger.artifacts) {
    if (artifact.stage === "asset_variant") continue;
    assert.ok(
      PAID_STAGES.includes(artifact.stage),
      `Generation ledger has unknown stage ${artifact.stage}`,
    );
    const providerCounts = attemptedByProviderAndStage[artifact.provider];
    assert.ok(providerCounts, `Generation ledger has unknown paid provider ${artifact.provider}`);
    assert.ok(
      ["candidate", "selected", "rejected"].includes(artifact.status),
      `${artifact.provider} ${artifact.stage} paid artifact is not usable`,
    );
    const allowedModels = modelsByProviderAndStage[artifact.provider][artifact.stage];
    assert.ok(
      allowedModels.includes(artifact.model),
      `${artifact.provider} ${artifact.stage} model drifted`,
    );
    assert.ok(
      allowedModels.includes(artifact.requestedModel) && artifact.requestedModel === artifact.model,
      `${artifact.provider} ${artifact.stage} requested model drifted`,
    );
    const expectedAttestation = expectedIdentityAttestation(artifact.provider, artifact.stage);
    assert.equal(
      artifact.identityAttestation,
      expectedAttestation,
      expectedAttestation === "provider-response"
        ? `${artifact.provider} ${artifact.stage} identity is not provider-attested`
        : `${artifact.provider} ${artifact.stage} identity is not honestly request-only`,
    );
    if (expectedAttestation === "provider-response") {
      assert.match(
        artifact.responseId ?? "",
        RESPONSE_ID,
        `${artifact.provider} ${artifact.stage} response ID is invalid`,
      );
      const responseKey = `${artifact.provider}\u0000${artifact.responseId}`;
      assert.ok(
        !providerResponseIds.has(responseKey),
        "Generation ledger has duplicate provider response IDs",
      );
      providerResponseIds.add(responseKey);
    } else {
      assert.ok(
        artifact.responseId === null || artifact.responseId === undefined,
        `${artifact.provider} ${artifact.stage} request-only identity has a response ID`,
      );
    }
    requestedModelsByProviderAndStage[artifact.provider][artifact.stage].add(
      artifact.requestedModel,
    );
    providerCounts[artifact.stage]++;
    attemptedByStage[artifact.stage]++;
    attemptedTotal++;
    stagesSeen.add(artifact.stage);
    assert.ok(
      providerCounts[artifact.stage] <=
        maximumByProviderAndStage[artifact.provider][artifact.stage],
      `${artifact.provider} ${artifact.stage} attempt budget exceeded`,
    );
    assert.ok(
      attemptedByStage[artifact.stage] <= maximumByStage[artifact.stage],
      `${artifact.stage} aggregate attempt budget exceeded`,
    );
    assert.ok(
      attemptedTotal <= PAPER_GENERATION_ATTEMPT_BUDGET.maximumTotal,
      "Generation total attempt budget exceeded",
    );
  }
  for (const stage of PAID_STAGES) {
    assert.ok(stagesSeen.has(stage), `Generation ledger omitted the ${stage} paid stage`);
    assert.ok(
      attemptedByStage[stage] >= minimumByStage[stage],
      `${stage} aggregate required roster incomplete`,
    );
  }
  for (const [provider, stages] of Object.entries(minimumByProviderAndStage)) {
    for (const [stage, minimum] of Object.entries(stages)) {
      assert.ok(
        attemptedByProviderAndStage[provider][stage] >= minimum,
        `${provider} ${stage} required roster incomplete`,
      );
      for (const requiredModel of modelsByProviderAndStage[provider][stage]) {
        assert.ok(
          requestedModelsByProviderAndStage[provider][stage].has(requiredModel),
          `${provider} ${stage} requested model roster incomplete`,
        );
      }
    }
  }
  const critiqueCounts = Object.keys(textModels).map(
    (provider) => attemptedByProviderAndStage[provider].critique,
  );
  assert.equal(new Set(critiqueCounts).size, 1, "Generation critique provider rounds drifted");
  const adaptiveRepairAttempts = ["planning", "layout", "multiview"].reduce(
    (total, stage) => total + attemptedByStage[stage] - minimumByStage[stage],
    0,
  );
  assert.equal(
    critiqueCounts[0] - minimumByProviderAndStage.xai.critique,
    adaptiveRepairAttempts,
    "Generation adaptive repair and critique rounds drifted",
  );
  const requestedModelRoster = Object.fromEntries(
    Object.entries(requestedModelsByProviderAndStage).map(([provider, stages]) => [
      provider,
      Object.fromEntries(
        Object.entries(stages).map(([stage, models]) => [stage, [...models].sort()]),
      ),
    ]),
  );
  return {
    accounting: PAPER_GENERATION_ATTEMPT_BUDGET.accounting,
    attemptedByProviderAndStage,
    attemptedByStage,
    attemptedTotal,
    requestedModelsByProviderAndStage: requestedModelRoster,
    minimumByProviderAndStage,
    maximumByProviderAndStage,
    maximumTotal: PAPER_GENERATION_ATTEMPT_BUDGET.maximumTotal,
  };
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validatePaperCaseIdentity(binding, expected) {
  assert.ok(binding && typeof binding === "object", "Paper case identity is missing");
  assert.ok(expected && typeof expected === "object", "Expected paper case identity is missing");
  assert.deepEqual(binding, expected, "Paper case identity drifted");
  return binding;
}

export function validatePaperSuiteManifest(manifest) {
  assert.ok(manifest && typeof manifest === "object", "Paper suite manifest must be an object");
  assert.equal(manifest.version, PAPER_SUITE_CONTRACT.version, "Paper suite version drifted");
  assert.deepEqual(
    manifest.paper?.qualitativeFigures,
    PAPER_SUITE_CONTRACT.qualitativeFigures,
    "Paper qualitative figure roster drifted",
  );
  assert.ok(Array.isArray(manifest.cases), "Paper suite cases must be an array");
  const caseIds = manifest.cases.map((entry) => entry?.id);
  assert.equal(new Set(caseIds).size, caseIds.length, "Paper suite case IDs are not unique");
  assert.deepEqual(caseIds, PAPER_SUITE_CONTRACT.caseIds, "Paper suite case IDs drifted");
  for (const entry of manifest.cases) {
    assert.equal(typeof entry.prompt, "string", `${entry.id} prompt must be text`);
    assert.equal(
      sha256Text(entry.prompt),
      PAPER_SUITE_CONTRACT.casePromptSha256[entry.id],
      `${entry.id} prompt hash drifted`,
    );
    assert.ok(
      Array.isArray(entry.regionalReadability) &&
        entry.regionalReadability.length === 4 &&
        entry.regionalReadability.every(
          (role) => typeof role === "string" && role.trim().length >= 1 && role.length <= 120,
        ),
      `${entry.id} must define exactly four bounded regional roles`,
    );
    assert.equal(
      sha256Text(JSON.stringify(entry.regionalReadability)),
      PAPER_SUITE_CONTRACT.caseRegionalRolesSha256[entry.id],
      `${entry.id} regional role hash drifted`,
    );
  }
  assert.deepEqual(
    manifest.claimPolicy?.sharedAxes,
    PAPER_SUITE_CONTRACT.sharedAxes,
    "Paper suite shared axes drifted",
  );
  assert.equal(
    manifest.claimPolicy?.minimumIndependentReviewers,
    PAPER_SUITE_CONTRACT.minimumIndependentReviewers,
    "Paper suite reviewer count drifted",
  );
  assert.equal(
    manifest.claimPolicy?.reviewAggregation,
    PAPER_SUITE_CONTRACT.reviewAggregation,
    "Paper suite review aggregation drifted",
  );
  const threshold = manifest.claimPolicy?.strictWinAxesRequiredAtSuiteMedian;
  assert.ok(
    Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= PAPER_SUITE_CONTRACT.sharedAxes.length,
    "Paper suite strict-win threshold is out of bounds",
  );
  assert.equal(
    threshold,
    PAPER_SUITE_CONTRACT.strictWinAxesRequired,
    "Paper suite strict-win threshold drifted",
  );
  assert.equal(
    sha256Text(JSON.stringify(manifest)),
    PAPER_SUITE_CONTRACT.manifestContractSha256,
    "Paper suite manifest contract hash drifted",
  );
  return {
    caseCount: caseIds.length,
    caseIds: [...caseIds],
    sharedAxes: [...manifest.claimPolicy.sharedAxes],
    strictWinAxesRequired: threshold,
  };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { mergeCommitteeLedgerSnapshots } from "./worldclaw-committee-ledger.mjs";
import { persistPaidInferenceEvidence } from "./worldclaw-paid-benchmark-lib.mjs";
import {
  committeeStructuredOutputSetDigest,
  paperEvidenceSha256,
  prepareNormalizedScenePlanEvidence,
  preparePaperCaptureEvidence,
  prepareStructuredModelOutputEvidence,
} from "./worldclaw-paper-evidence.mjs";
import {
  PAPER_GENERATION_ATTEMPT_BUDGET,
  PAPER_GENERATION_PAID_RUN_CONFIG,
  PAPER_SUITE_TIMEOUTS_MS,
} from "./worldclaw-paper-suite-lib.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotsDir = join(workspaceRoot, "screenshots");
const referenceValidationDir = join(screenshotsDir, "reference-validation");
await mkdir(screenshotsDir, { recursive: true });
await mkdir(referenceValidationDir, { recursive: true });
const customPrompt = process.env.WORLDCLAW_QA_PROMPT?.trim();
const expectedPromptText = process.env.WORLDCLAW_QA_EXPECT?.trim();
const suiteId = process.env.WORLDCLAW_QA_SUITE_ID?.trim();
const caseId = process.env.WORLDCLAW_QA_CASE_ID?.trim();
const caseToken = process.env.WORLDCLAW_QA_CASE_TOKEN?.trim();
const regionalRolesInput = process.env.WORLDCLAW_QA_REGIONAL_ROLES?.trim();
const terrainRelationshipsInput = process.env.WORLDCLAW_QA_TERRAIN_RELATIONSHIPS?.trim();
const objectFamiliesInput = process.env.WORLDCLAW_QA_OBJECT_FAMILIES?.trim();
const resultPathInput = process.env.WORLDCLAW_QA_RESULT_PATH?.trim();
const qaRunIdInput = process.env.WORLDCLAW_QA_RUN_ID?.trim();
const paidRunIdInput = process.env.WORLDCLAW_QA_PAID_RUN_ID?.trim();
const paidRunTokenInput = process.env.WORLDCLAW_QA_PAID_RUN_TOKEN?.trim();
const paidSinkUrlInput = process.env.WORLDCLAW_QA_PAID_SINK_URL?.trim();
const paidSinkTokenInput = process.env.WORLDCLAW_QA_PAID_SINK_TOKEN?.trim();
const hasCaseBinding = Boolean(
  suiteId ||
  caseId ||
  caseToken ||
  regionalRolesInput ||
  terrainRelationshipsInput ||
  objectFamiliesInput ||
  resultPathInput,
);
if (customPrompt) {
  assert.ok(customPrompt.length <= 4_000, "WORLDCLAW_QA_PROMPT exceeds 4000 characters");
}
if (hasCaseBinding) {
  assert.match(suiteId ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.match(caseId ?? "", /^figure-\d{2}-[a-z0-9-]{1,100}$/);
  assert.match(caseToken ?? "", /^[a-f0-9]{32,64}$/);
  assert.ok(customPrompt, "A bound paper case requires WORLDCLAW_QA_PROMPT");
  assert.ok(resultPathInput, "A bound paper case requires WORLDCLAW_QA_RESULT_PATH");
  assert.ok(regionalRolesInput, "A bound paper case requires WORLDCLAW_QA_REGIONAL_ROLES");
  assert.ok(
    terrainRelationshipsInput,
    "A bound paper case requires WORLDCLAW_QA_TERRAIN_RELATIONSHIPS",
  );
  assert.ok(objectFamiliesInput, "A bound paper case requires WORLDCLAW_QA_OBJECT_FAMILIES");
  assert.match(qaRunIdInput ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.match(paidRunIdInput ?? "", /^[a-z0-9][a-z0-9._:-]{0,127}$/i);
  assert.match(paidRunTokenInput ?? "", /^[a-z0-9][a-z0-9._:-]{15,255}$/i);
  assert.match(paidSinkUrlInput ?? "", /^http:\/\/127\.0\.0\.1:\d{5}\/$/);
  const paidSinkPort = Number(new URL(paidSinkUrlInput).port);
  assert.ok(paidSinkPort >= 49_152 && paidSinkPort <= 65_535);
  assert.match(paidSinkTokenInput ?? "", /^[a-z0-9][a-z0-9._:-]{15,255}$/i);
}
const regionalReadability = regionalRolesInput ? JSON.parse(regionalRolesInput) : null;
const terrainRelationships = terrainRelationshipsInput
  ? JSON.parse(terrainRelationshipsInput)
  : null;
const objectFamilies = objectFamiliesInput ? JSON.parse(objectFamiliesInput) : null;
function assertBoundedContractList(value, label) {
  assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= 8, `${label} is invalid`);
  const normalized = value.map((item, index) => {
    assert.equal(typeof item, "string", `${label}[${index}] must be text`);
    const text = item.trim();
    assert.ok(text && text.length <= 120, `${label}[${index}] is invalid`);
    return text;
  });
  assert.equal(
    new Set(normalized.map((item) => item.toLowerCase())).size,
    normalized.length,
    `${label} entries must be distinct`,
  );
  return normalized;
}
if (hasCaseBinding) {
  assert.ok(Array.isArray(regionalReadability) && regionalReadability.length === 4);
  for (const [index, role] of regionalReadability.entries()) {
    assert.equal(typeof role, "string", `Regional role ${index + 1} must be text`);
    assert.ok(role.trim() && role.length <= 120, `Regional role ${index + 1} is invalid`);
  }
  assertBoundedContractList(terrainRelationships, "Benchmark terrain relationships");
  assertBoundedContractList(objectFamilies, "Benchmark object families");
}
const resultPath = resultPathInput ? resolve(resultPathInput) : undefined;
if (resultPath) {
  assert.ok(
    resultPath.startsWith(`${resolve(referenceValidationDir)}${sep}`),
    "WORLDCLAW_QA_RESULT_PATH must remain inside reference-validation",
  );
}
const caseBinding = hasCaseBinding
  ? Object.freeze({
      suiteId,
      caseId,
      caseToken,
      promptSha256: createHash("sha256").update(customPrompt, "utf8").digest("hex"),
      regionalReadability,
    })
  : null;
const benchmarkGenerationContract = hasCaseBinding
  ? Object.freeze({
      caseId,
      promptSha256: caseBinding.promptSha256,
      regionalReadability: Object.freeze([...regionalReadability]),
      terrainRelationships: Object.freeze([...terrainRelationships]),
      objectFamilies: Object.freeze([...objectFamilies]),
    })
  : null;
const PAID_COMMITTEE_STAGES = new Set([
  "planning",
  "layout",
  "multiview",
  "critique",
  "final_judge",
]);
const runStartedAt = new Date().toISOString();
const runId = caseBinding ? qaRunIdInput : runStartedAt.replace(/[:.]/g, "-");
const runEvidenceDir = join(referenceValidationDir, "runs", runId);
const generationStatusPath = join(runEvidenceDir, "generation_status.json");
const latestRunPath = join(referenceValidationDir, "latest_run.json");
const failureScreenshotPath = join(runEvidenceDir, "process_failure.png");
const paidAttemptLogPath = join(runEvidenceDir, "paid_inference_attempts.jsonl");
await mkdir(runEvidenceDir, { recursive: true });
let failureScreenshotRetained = false;
const paidRunId = caseBinding ? paidRunIdInput : null;
const paidRunToken = caseBinding ? paidRunTokenInput : null;
const paidSinkToken = caseBinding ? paidSinkTokenInput : null;
let paidRunCreated = false;
let paidRunClosedLedger = null;
let paidInferenceEvidence = null;

function paidRequestHeaders() {
  assert.ok(paidRunId && paidRunToken, "Paid inference request identity is unavailable");
  return {
    "x-worldclaw-paid-run-id": paidRunId,
    "x-worldclaw-paid-run-token": paidRunToken,
  };
}

async function callPaidControl(page, operation, data) {
  assert.ok(caseBinding, "Paid inference control is only available to a bound paper case");
  const headers = paidRequestHeaders();
  return page.evaluate(
    async ({ operation: requestedOperation, data: requestData, headers: requestHeaders }) => {
      const control = await import("/src/lib/worldclaw/paid-inference-control.ts");
      if (requestedOperation === "create") {
        return control.createPaidInferenceBenchmarkRun({
          data: requestData,
          headers: requestHeaders,
        });
      }
      if (requestedOperation === "get") {
        return control.getPaidInferenceBenchmarkLedger({ headers: requestHeaders });
      }
      if (requestedOperation === "finish") {
        return control.finishPaidInferenceBenchmarkRun({
          data: requestData,
          headers: requestHeaders,
        });
      }
      throw new Error(`Unknown paid inference control operation: ${requestedOperation}`);
    },
    { operation, data: data ?? null, headers },
  );
}

async function startBoundPaidRun(page) {
  if (!caseBinding) return null;
  assert.ok(paidSinkToken, "Paid inference sink token is unavailable");
  const ledger = await callPaidControl(page, "create", {
    ...PAPER_GENERATION_PAID_RUN_CONFIG,
    ledgerSink: {
      url: paidSinkUrlInput,
      token: paidSinkToken,
      timeoutMs: 2_000,
    },
  });
  assert.equal(ledger.runId, paidRunId, "Paid inference control created the wrong run");
  assert.equal(ledger.status, "open", "Paid inference control did not create an open run");
  const serialized = JSON.stringify(ledger);
  assert.equal(serialized.includes(paidRunToken), false, "Paid control returned its run token");
  assert.equal(serialized.includes(paidSinkToken), false, "Paid control returned its sink token");
  paidRunCreated = true;
  return ledger;
}

async function finalizeBoundPaidRun(page, status) {
  if (!caseBinding || !paidRunCreated) {
    return null;
  }
  if (!paidRunClosedLedger) {
    const openLedger = await callPaidControl(page, "get");
    assert.equal(openLedger.runId, paidRunId, "Paid inference ledger run id drifted");
    assert.equal(openLedger.status, "open", "Paid inference run closed before QA finalized it");
    const serialized = JSON.stringify(openLedger);
    assert.equal(serialized.includes(paidRunToken), false, "Paid ledger returned its run token");
    assert.equal(serialized.includes(paidSinkToken), false, "Paid ledger returned its sink token");
    paidRunClosedLedger = await callPaidControl(page, "finish", { status });
    assert.equal(paidRunClosedLedger.status, status, "Paid inference terminal status drifted");
    assert.equal(
      paidRunClosedLedger.attemptCount,
      openLedger.attemptCount,
      "Paid inference attempt count changed during finish",
    );
  }
  if (!paidInferenceEvidence) {
    paidInferenceEvidence = await persistPaidInferenceEvidence({
      directory: runEvidenceDir,
      ledger: paidRunClosedLedger,
      attemptLogPath: paidAttemptLogPath,
      ledgerFile: "paid_inference_ledger.json",
      attemptLogFile: "paid_inference_attempts.jsonl",
      expectedConfig: PAPER_GENERATION_PAID_RUN_CONFIG,
      expectedStatus: paidRunClosedLedger.status,
      forbiddenSecrets: [paidRunToken, paidSinkToken],
      completeAttemptLog: true,
    });
  }
  return paidInferenceEvidence;
}

async function writeGenerationStatus(status, extra = {}) {
  const payload = {
    runId,
    status,
    startedAt: runStartedAt,
    evidenceDirectory: `runs/${runId}`,
    binding: caseBinding,
    ...extra,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const writes = [
    writeFile(generationStatusPath, serialized),
    writeFile(latestRunPath, serialized),
  ];
  if (resultPath) writes.push(writeFile(resultPath, serialized));
  await Promise.all(writes);
}

await writeGenerationStatus("running");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertVisiblePixels(bytes, label) {
  const png = PNG.sync.read(bytes);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  // Sample the viewport half that contains the rendered world, not the control panel.
  for (let y = 0; y < png.height; y += 8) {
    for (let x = Math.floor(png.width * 0.35); x < png.width; x += 8) {
      const index = (y * png.width + x) * 4;
      const luminance =
        0.2126 * png.data[index] + 0.7152 * png.data[index + 1] + 0.0722 * png.data[index + 2];
      sum += luminance;
      sumSquares += luminance * luminance;
      count++;
    }
  }
  const mean = sum / count;
  const variance = sumSquares / count - mean * mean;
  assert.ok(mean > 8 && mean < 247, `${label} has implausible mean luminance ${mean}`);
  assert.ok(variance > 40, `${label} appears blank or flat (variance ${variance})`);
}

async function capture(page, filename) {
  const path = join(screenshotsDir, filename);
  const bytes = await page.screenshot({ path });
  assertVisiblePixels(bytes, filename);
  return digest(bytes);
}

async function requireButton(page, name) {
  const button = page.getByRole("button", { name, exact: true });
  assert.equal(await button.count(), 1, `Missing ${name} control`);
  return button;
}

async function waitForReady(page, expectedText) {
  const readinessTimeoutMs = Number(
    process.env.WORLDCLAW_QA_READY_TIMEOUT_MS ??
      (caseBinding ? PAPER_SUITE_TIMEOUTS_MS.generationReady : 900_000),
  );
  const minimumReadinessTimeout = caseBinding ? PAPER_SUITE_TIMEOUTS_MS.generationReady : 60_000;
  assert.ok(
    Number.isFinite(readinessTimeoutMs) && readinessTimeoutMs >= minimumReadinessTimeout,
    `WORLDCLAW_QA_READY_TIMEOUT_MS must be at least ${minimumReadinessTimeout}`,
  );
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    const alert = page.getByRole("alert");
    if ((await alert.count()) > 0 && (await alert.first().isVisible())) {
      const message = await alert.first().innerText();
      await retainGenerationFailure(page, message);
      throw new Error(`Generation failed: ${message}`);
    }
    const body = await page.locator("body").innerText();
    if (body.includes("World ready") && body.includes(expectedText)) break;
    await page.waitForTimeout(500);
  }
  const body = await page.locator("body").innerText();
  if (!(body.includes("World ready") && body.includes(expectedText))) {
    const message = `Generation did not become ready within ${Math.round(readinessTimeoutMs / 1000)}s. Tail: ${body.slice(-1_200)}`;
    await retainGenerationFailure(page, message);
    throw new Error(message);
  }
  await page.getByRole("button", { name: /Generate world/i }).waitFor({
    state: "visible",
    // WorldScene and the authored GLB library are lazy-loaded after the store
    // reports World ready. On software WebGL this Suspense boundary can keep
    // the application fallback visible for tens of seconds while more than a
    // thousand source meshes compile into runtime batches.
    timeout: 90_000,
  });
  const stableBody = await page.locator("body").innerText();
  assert.ok(
    stableBody.includes("World ready") && stableBody.includes(expectedText),
    "World state was not retained after the renderer finished loading",
  );
}

async function retainGenerationFailure(page, message) {
  // waitForReady retains once at the moment the alert is visible, then its
  // caller retains again from the outer catch. Snapshot the first, richest UI
  // state before any slower image/ledger persistence can trigger a remount;
  // the later sparse fallback must never overwrite it.
  if (!failureScreenshotRetained) {
    try {
      const bytes = await page.screenshot({ path: failureScreenshotPath });
      await writeFile(join(screenshotsDir, "worldclaw-process-failure.png"), bytes);
      failureScreenshotRetained = true;
    } catch {
      // Preserve the original generation failure if the page is already gone.
    }
  }
  await writeGenerationStatus("failed", {
    finishedAt: new Date().toISOString(),
    message,
  });
  await writeFile(
    join(runEvidenceDir, "generation_failure.json"),
    `${JSON.stringify({ status: "failed", message, capturedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  try {
    await persistPrebuildReferenceEvidence(page, undefined, false);
  } catch {
    // The failure can occur before one or more images exist; retain what is available.
  }
  try {
    await persistCommitteeEvidence(page, message);
  } catch {
    // Progressive committee evidence may not exist if planning itself failed.
  }
}

async function waitForFinalValidation(page) {
  const validation = page.getByTestId("final-render-validation");
  await validation.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="final-render-validation"]');
      const status = element?.getAttribute("data-status");
      return status && !["pending", "running"].includes(status);
    },
    undefined,
    {
      timeout: caseBinding ? PAPER_SUITE_TIMEOUTS_MS.finalValidation : 180_000,
    },
  );
  const status = await validation.getAttribute("data-status");
  return { status, text: await validation.innerText() };
}

function decodeDataUrl(dataUrl, label) {
  assert.ok(dataUrl, `Missing ${label} data URL`);
  const match = /^data:image\/(?:png|jpeg);base64,(.+)$/s.exec(dataUrl);
  assert.ok(match, `${label} is not an inline PNG/JPEG`);
  return Buffer.from(match[1], "base64");
}

async function persistPrebuildReferenceEvidence(
  page,
  generatedWorld,
  requireComplete = Boolean(caseBinding),
) {
  const sources = await page.evaluate(() => {
    const sourceFor = (alt) => document.querySelector(`img[alt="${alt}"]`)?.getAttribute("src");
    const normalizedPlan = document.querySelector(
      '[data-testid="normalized-scene-plan"]',
    )?.textContent;
    return {
      canonicalMap: sourceFor("Authoritative generated top-down layout map"),
      semanticMap: sourceFor("Semantic layout map"),
      appearanceConcept: sourceFor("Selected pre-build perspective and construction concept board"),
      normalizedPlan,
    };
  });
  if (requireComplete) {
    assert.ok(sources.normalizedPlan, "Bound paper case omitted its normalized scene plan");
    for (const key of ["canonicalMap", "semanticMap", "appearanceConcept"]) {
      assert.ok(sources[key], `Bound paper case omitted prebuild ${key} evidence`);
    }
  }
  const normalizedPlan = sources.normalizedPlan
    ? prepareNormalizedScenePlanEvidence(sources.normalizedPlan, customPrompt)
    : null;
  const normalizedPlanDescriptor = normalizedPlan
    ? {
        file: "normalized_scene_plan.json",
        bytes: normalizedPlan.bytes.length,
        sha256: normalizedPlan.sha256,
      }
    : null;
  if (normalizedPlan) {
    await writeFile(join(runEvidenceDir, normalizedPlanDescriptor.file), normalizedPlan.bytes);
  }
  const imageEvidence = {};
  for (const [key, source] of Object.entries(sources)) {
    if (key === "normalizedPlan") continue;
    if (!source) continue;
    const extension = source.startsWith("data:image/png") ? "png" : "jpg";
    const bytes = decodeDataUrl(source, `prebuild ${key}`);
    const imageFile = `prebuild-${key}.${extension}`;
    await writeFile(join(runEvidenceDir, imageFile), bytes);
    imageEvidence[key] = { imageFile, bytes: bytes.length, sha256: digest(bytes) };
  }
  if (requireComplete) {
    assert.deepEqual(
      Object.keys(imageEvidence).sort(),
      ["appearanceConcept", "canonicalMap", "semanticMap"],
      "Bound paper case prebuild image set is incomplete",
    );
    assert.ok(normalizedPlanDescriptor, "Bound paper case has no normalized plan descriptor");
    assert.ok(generatedWorld?.id, "Bound paper case has no generated world binding");
  }
  if (!normalizedPlanDescriptor && Object.keys(imageEvidence).length === 0) return null;
  const manifest = {
    version: 2,
    runId,
    binding: caseBinding,
    generatedWorld: generatedWorld ?? null,
    normalizedPlan: normalizedPlanDescriptor,
    images: imageEvidence,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestDescriptor = {
    file: "prebuild_reference_manifest.json",
    bytes: manifestBytes.length,
    sha256: paperEvidenceSha256(manifestBytes),
  };
  await writeFile(join(runEvidenceDir, manifestDescriptor.file), manifestBytes);
  return {
    manifest: manifestDescriptor,
    normalizedPlan: normalizedPlanDescriptor,
    images: imageEvidence,
  };
}

async function verifyGeneratedWorldBinding(page) {
  const actual = await page.evaluate(() => {
    const evidence = document.querySelector('[data-testid="generation-evidence"]');
    return {
      qa: window.__WORLDCLAW_QA__?.world ?? null,
      evidence: evidence
        ? {
            id: evidence.getAttribute("data-world-id"),
            seed: evidence.getAttribute("data-world-seed"),
            prompt: evidence.getAttribute("data-world-prompt"),
          }
        : null,
    };
  });
  assert.ok(actual.qa?.id, "Generated world QA id is unavailable");
  assert.ok(Number.isSafeInteger(actual.qa.seed), "Generated world QA seed is unavailable");
  assert.equal(
    actual.evidence?.id,
    actual.qa.id,
    "Evidence world id does not match renderer world id",
  );
  assert.equal(
    Number(actual.evidence?.seed),
    actual.qa.seed,
    "Evidence seed does not match renderer seed",
  );
  assert.equal(
    actual.evidence?.prompt,
    actual.qa.prompt,
    "Evidence prompt does not match renderer prompt",
  );
  if (customPrompt)
    assert.equal(actual.qa.prompt, customPrompt, "Generated world prompt is not exact");
  return {
    id: actual.qa.id,
    seed: actual.qa.seed,
    promptSha256: digest(Buffer.from(actual.qa.prompt ?? "", "utf8")),
  };
}

async function persistFinalReferenceEvidence(page, finalValidation) {
  const validation = page.getByTestId("final-render-validation");
  const reportText = await validation.getAttribute("data-report");
  const report = reportText
    ? JSON.parse(reportText)
    : {
        status: finalValidation.status,
        error: finalValidation.text,
        judgement: null,
        comparisonArtifacts: [],
      };
  await writeFile(
    join(runEvidenceDir, "map_mask_validation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const artifactFiles = {
    canonicalLandWaterMask: "canonical_land_water_mask.png",
    renderedLandWaterMask: "rendered_land_water_mask.png",
    shorelineOverlay: "map_overlay_reference.png",
    landWaterDifference: "land_water_difference.png",
  };
  // Snapshot all large inline images in one page evaluation. The evidence
  // component legitimately remounts while status changes; retaining a locator
  // handle across those commits made failed-but-complete runs time out before
  // their images could be written.
  const sources = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="final-render-validation"]');
    if (!root) return { artifacts: {}, captures: {} };
    const artifacts = {};
    for (const element of root.querySelectorAll('[data-testid^="comparison-"]')) {
      const key = element.getAttribute("data-testid")?.replace(/^comparison-/, "");
      const source = element.querySelector("img")?.getAttribute("src");
      if (key && source) artifacts[key] = source;
    }
    const captures = {};
    for (const image of root.querySelectorAll(
      "img[alt^='Final registered '][alt$=' renderer capture']",
    )) {
      const match = /^Final registered (map|isometric|oblique|walk) renderer capture$/.exec(
        image.getAttribute("alt") ?? "",
      );
      const source = image.getAttribute("src");
      if (match && source) captures[match[1]] = source;
    }
    return { artifacts, captures };
  });
  for (const [key, filename] of Object.entries(artifactFiles)) {
    const source = sources.artifacts[key];
    if (!source) continue;
    await writeFile(join(runEvidenceDir, filename), decodeDataUrl(source, key));
  }

  for (const view of ["map", "isometric", "oblique", "walk"]) {
    const source = sources.captures[view];
    if (!source) continue;
    await writeFile(
      join(runEvidenceDir, `final-${view}.png`),
      decodeDataUrl(source, `registered ${view}`),
    );
  }
}

async function persistPaperCaptureEvidence(page, generatedWorld) {
  await page.waitForFunction(
    () => typeof window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__ === "function",
    undefined,
    { timeout: 90_000 },
  );
  const matrix = await page.evaluate(
    async (binding) =>
      window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__(
        binding ? { binding, regionalRoles: binding.regionalReadability } : undefined,
      ),
    caseBinding,
  );
  const { manifest, images, manifestBytes, manifestSha256, imageSetSha256 } =
    preparePaperCaptureEvidence(matrix, {
      binding: caseBinding,
      generatedWorld,
      regionalRoles: regionalReadability,
    });
  await Promise.all(
    images.map(({ imageFile, bytes }) => writeFile(join(runEvidenceDir, imageFile), bytes)),
  );
  await writeFile(join(runEvidenceDir, "paper_capture_matrix.json"), manifestBytes);
  return {
    manifest,
    evidence: {
      manifest: {
        file: "paper_capture_matrix.json",
        bytes: manifestBytes.length,
        sha256: manifestSha256,
      },
      imageSetSha256,
      imageCount: images.length,
      capturedAt: manifest.capturedAt ?? null,
      worldFingerprint: manifest.worldFingerprint ?? null,
    },
  };
}

async function persistCommitteeEvidence(page, failureMessage, generatedWorld) {
  const ledger = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="model-committee"]');
    if (!root) return null;
    const selection = root.querySelector('[data-testid="model-committee-selection"]');
    const failure = root.querySelector('[data-testid="generation-failure-evidence"]');
    return {
      status: root.getAttribute("data-status"),
      completedIterations: root.getAttribute("data-completed-iterations"),
      maximumIterations: root.getAttribute("data-max-iterations"),
      providers: [...root.querySelectorAll("[data-provider][data-configured]")].map((entry) => ({
        provider: entry.getAttribute("data-provider"),
        model: entry.getAttribute("data-model"),
        configured: entry.getAttribute("data-configured"),
        authenticated: entry.getAttribute("data-authenticated"),
        available: entry.getAttribute("data-available"),
        text: (() => {
          const clone = entry.cloneNode(true);
          clone.querySelector("[data-model-structured-output]")?.remove();
          return clone.textContent?.replace(/\s+/g, " ").trim();
        })(),
      })),
      selection: selection
        ? {
            chosenLayoutArtifactId: selection.getAttribute("data-chosen-layout"),
            chosenMultiviewArtifactId: selection.getAttribute("data-chosen-multiview"),
            consensusScore: selection.getAttribute("data-consensus-score"),
            rationale: [...selection.querySelectorAll("[data-committee-rationale]")].map((entry) =>
              entry.textContent
                ?.replace(/^\s*\d+\s*/, "")
                .replace(/\s+/g, " ")
                .trim(),
            ),
          }
        : null,
      failure: failure
        ? {
            status: failure.getAttribute("data-status"),
            stage: failure.getAttribute("data-failed-stage"),
            progress: failure.getAttribute("data-failed-progress"),
            committeeRetained: failure.getAttribute("data-committee-retained"),
            providerCount: failure.getAttribute("data-provider-count"),
            artifactCount: failure.getAttribute("data-artifact-count"),
            imageArtifactCount: failure.getAttribute("data-image-artifact-count"),
          }
        : null,
      artifacts: [...root.querySelectorAll('[data-testid^="model-artifact-"]')].map((entry) => ({
        id: entry.getAttribute("data-artifact-id"),
        provider: entry.getAttribute("data-provider"),
        requestedModel: entry.getAttribute("data-requested-model"),
        model: entry.getAttribute("data-response-model") ?? entry.getAttribute("data-model"),
        responseId:
          entry.getAttribute("data-response-id") ?? entry.getAttribute("data-provider-response-id"),
        identityAttestation: entry.getAttribute("data-identity-attestation"),
        role: entry.getAttribute("data-role"),
        stage: entry.getAttribute("data-stage"),
        status: entry.getAttribute("data-status"),
        iteration: entry.getAttribute("data-iteration"),
        score: entry.getAttribute("data-score"),
        passed: entry.getAttribute("data-passed"),
        parentArtifactIds: JSON.parse(entry.getAttribute("data-parent-artifact-ids") ?? "[]"),
        imageRetained: entry.getAttribute("data-image-retained"),
        image: entry.querySelector("img")?.getAttribute("src") ?? null,
        structuredOutputRetained: entry.getAttribute("data-structured-output-retained"),
        structuredOutputValid: entry.getAttribute("data-structured-output-valid"),
        structuredOutput:
          entry.querySelector("[data-model-structured-output] pre")?.textContent ?? null,
        text: (() => {
          const clone = entry.cloneNode(true);
          clone.querySelector("[data-model-structured-output]")?.remove();
          return clone.textContent?.replace(/\s+/g, " ").trim();
        })(),
      })),
    };
  });
  assert.ok(ledger, "Model committee ledger was not rendered");
  for (const artifact of ledger.artifacts) {
    if (artifact.stage === "asset_variant") {
      assert.ok(artifact.provider, `Asset variant ${artifact.id} omitted its resolver provider`);
      assert.ok(artifact.model, `Asset variant ${artifact.id} omitted its resolved asset model`);
      assert.equal(
        artifact.requestedModel,
        null,
        `Asset variant ${artifact.id} claimed a paid request`,
      );
      assert.equal(
        artifact.responseId,
        null,
        `Asset variant ${artifact.id} claimed a provider response`,
      );
      assert.equal(
        artifact.identityAttestation,
        null,
        `Asset variant ${artifact.id} claimed a provider identity attestation`,
      );
      continue;
    }
    assert.ok(
      PAID_COMMITTEE_STAGES.has(artifact.stage),
      `Unknown committee stage ${artifact.stage}`,
    );
    assert.ok(artifact.requestedModel, `Artifact ${artifact.id} omitted requested model identity`);
    assert.ok(artifact.model, `Artifact ${artifact.id} omitted response model identity`);
    assert.ok(
      ["provider-response", "request-only", "unattested"].includes(artifact.identityAttestation),
      `Artifact ${artifact.id} omitted identity attestation`,
    );
    if (artifact.identityAttestation === "provider-response") {
      assert.ok(artifact.responseId, `Artifact ${artifact.id} omitted provider response ID`);
      assert.equal(
        artifact.model,
        artifact.requestedModel,
        `Artifact ${artifact.id} provider response model drifted`,
      );
    } else {
      assert.equal(
        artifact.responseId,
        null,
        `Artifact ${artifact.id} claimed a response ID without provider response attestation`,
      );
    }
    if (caseBinding && !failureMessage) {
      assert.notEqual(
        artifact.identityAttestation,
        "unattested",
        `Bound passed artifact ${artifact.id} is unattested`,
      );
    }
  }
  let structuredOutputCharacters = 0;
  let structuredOutputCount = 0;
  const structuredEvidence = new Map();
  const structuredFilenames = new Set();
  for (const artifact of ledger.artifacts) {
    if (artifact.structuredOutputRetained !== "true") {
      assert.equal(
        artifact.structuredOutput,
        null,
        `Artifact ${artifact.id} exposed unretained structured output`,
      );
      continue;
    }
    if (artifact.structuredOutputValid !== "true") {
      assert.equal(
        artifact.structuredOutput,
        null,
        `Artifact ${artifact.id} exposed malformed structured output`,
      );
      continue;
    }
    assert.ok(
      artifact.structuredOutput,
      `Artifact ${artifact.id} omitted valid normalized structured output`,
    );
    structuredOutputCharacters += artifact.structuredOutput.length;
    structuredOutputCount++;
    assert.ok(structuredOutputCount <= 64, "Committee structured-output artifact budget exceeded");
    assert.ok(
      structuredOutputCharacters <= 1_000_000,
      "Committee structured-output character budget exceeded",
    );
    const evidence = prepareStructuredModelOutputEvidence(artifact.structuredOutput);
    const basename = String(artifact.id)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .slice(0, 100);
    assert.ok(basename, `Artifact ${artifact.id} has no safe structured-output filename`);
    const structuredOutputFile = `committee-${basename}-structured.json`;
    assert.ok(
      !structuredFilenames.has(structuredOutputFile),
      `Artifact ${artifact.id} collides with another structured-output filename`,
    );
    structuredFilenames.add(structuredOutputFile);
    structuredEvidence.set(artifact.id, {
      ...evidence,
      structuredOutputFile,
    });
  }
  if (caseBinding && !failureMessage) {
    const selectedPlans = ledger.artifacts.filter(
      (artifact) => artifact.stage === "planning" && artifact.status === "selected",
    );
    assert.equal(
      selectedPlans.length,
      1,
      "Bound passed run needs exactly one selected planning artifact",
    );
    const selected = structuredEvidence.get(selectedPlans[0].id);
    assert.ok(selected, "Selected planning artifact omitted normalized structured JSON");
    assert.equal(
      selected.value?.plan?.prompt,
      customPrompt,
      "Selected planning JSON prompt drifted",
    );
  }
  const serializable = {
    version: 2,
    runId,
    binding: caseBinding,
    ...(generatedWorld ? { generatedWorld } : {}),
    ...ledger,
    artifacts: ledger.artifacts.map(
      ({ image, structuredOutput: _structuredOutput, ...artifact }) => ({
        ...artifact,
        imageFile: image
          ? `committee-${String(artifact.id)
              .replace(/[^a-z0-9._-]+/gi, "-")
              .slice(0, 100)}.${image.startsWith("data:image/png") ? "png" : "jpg"}`
          : null,
        structuredOutputFile: structuredEvidence.get(artifact.id)?.structuredOutputFile ?? null,
        structuredOutputBytes: structuredEvidence.get(artifact.id)?.bytes.length ?? null,
        structuredOutputSha256: structuredEvidence.get(artifact.id)?.sha256 ?? null,
      }),
    ),
  };
  const ledgerPath = join(runEvidenceDir, "model_committee_ledger.json");
  let previousLedger;
  try {
    previousLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch {
    previousLedger = undefined;
  }
  const retainedLedger = mergeCommitteeLedgerSnapshots(
    previousLedger,
    serializable,
    failureMessage,
  );
  const retainedArtifacts = new Map(
    retainedLedger.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const structuredWrites = [];
  for (const [artifactId, entry] of structuredEvidence) {
    const retained = retainedArtifacts.get(artifactId);
    const descriptorMatches =
      retained?.structuredOutputFile === entry.structuredOutputFile &&
      retained?.structuredOutputBytes === entry.bytes.length &&
      retained?.structuredOutputSha256 === entry.sha256;
    if (!descriptorMatches) {
      assert.ok(
        failureMessage,
        `Artifact ${artifactId} structured output changed under a stable artifact id`,
      );
      continue;
    }
    structuredWrites.push(writeFile(join(runEvidenceDir, entry.structuredOutputFile), entry.bytes));
  }
  await Promise.all(structuredWrites);
  const ledgerBytes = Buffer.from(`${JSON.stringify(retainedLedger, null, 2)}\n`, "utf8");
  await writeFile(ledgerPath, ledgerBytes);
  for (const artifact of ledger.artifacts) {
    if (!artifact.image) continue;
    const extension = artifact.image.startsWith("data:image/png") ? "png" : "jpg";
    const filename = `committee-${String(artifact.id)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .slice(0, 100)}.${extension}`;
    await writeFile(
      join(runEvidenceDir, filename),
      decodeDataUrl(artifact.image, `committee artifact ${artifact.id}`),
    );
  }
  const structuredOutputSet = committeeStructuredOutputSetDigest(retainedLedger.artifacts);
  return {
    ...retainedLedger,
    persistenceEvidence: {
      manifest: {
        file: "model_committee_ledger.json",
        bytes: ledgerBytes.length,
        sha256: paperEvidenceSha256(ledgerBytes),
      },
      structuredOutputSetSha256: structuredOutputSet.sha256,
      structuredOutputCount: structuredOutputSet.count,
    },
  };
}

const browser = await chromium.launch({ headless: true });
const errors = [];
let activePage;
let paidServerFnRequestCount = 0;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  activePage = page;
  if (caseBinding) {
    await page.route("**/*", async (route) => {
      const request = route.request();
      const headers = request.headers();
      if (headers["x-tsr-serverfn"] === "true") {
        paidServerFnRequestCount += 1;
        Object.assign(headers, paidRequestHeaders());
      }
      await route.continue({ headers });
    });
  }
  if (benchmarkGenerationContract) {
    await page.addInitScript((contract) => {
      const frozen = Object.freeze({
        ...contract,
        regionalReadability: Object.freeze([...contract.regionalReadability]),
        terrainRelationships: Object.freeze([...contract.terrainRelationships]),
        objectFamilies: Object.freeze([...contract.objectFamilies]),
      });
      Object.defineProperty(window, "__WORLDCLAW_BENCHMARK_GENERATION__", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: frozen,
      });
    }, benchmarkGenerationContract);
  }
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const response = await page.goto("http://127.0.0.1:8080/", {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  assert.ok(response?.ok(), `Initial navigation failed: ${response?.status()}`);
  const canvas = page.locator("canvas");
  assert.equal(await canvas.count(), 1, "Expected exactly one WebGL canvas");
  const panelResize = page.getByRole("separator", { name: "Resize controls panel" });
  assert.equal(await panelResize.count(), 1, "Missing resizable process-panel separator");
  await panelResize.focus();
  await page.keyboard.press("Home");
  assert.equal(await panelResize.getAttribute("aria-valuenow"), "340");
  await page.keyboard.press("ArrowRight");
  assert.equal(await panelResize.getAttribute("aria-valuenow"), "356");
  await page.keyboard.press("End");
  assert.ok(
    Number(await panelResize.getAttribute("aria-valuenow")) >= 600,
    "Process panel did not expand to its wide evidence workspace",
  );
  const bounds = await canvas.boundingBox();
  assert.ok(bounds && bounds.width > 400 && bounds.height > 400, "Canvas is not visible");

  const generate = page.getByRole("button", { name: /Generate world/i });
  assert.equal(await generate.count(), 1, "Missing Generate world control");
  if (customPrompt) {
    const promptInput = page.getByRole("textbox", { name: /Open-ended world prompt/i });
    assert.equal(await promptInput.count(), 1, "Missing open-world prompt input");
    await promptInput.fill(customPrompt);
  }
  await startBoundPaidRun(page);
  await generate.click();
  await waitForReady(
    page,
    expectedPromptText || (customPrompt ? customPrompt.slice(0, 48) : "tropical island stronghold"),
  );
  const generatedWorld = await verifyGeneratedWorldBinding(page);
  const prebuildEvidence = await persistPrebuildReferenceEvidence(page, generatedWorld);
  const finalValidation = await waitForFinalValidation(page);
  await page.getByTestId("final-render-validation").scrollIntoViewIfNeeded();
  await capture(page, "worldclaw-process-evidence.png");
  await persistFinalReferenceEvidence(page, finalValidation);
  const committee = await persistCommitteeEvidence(page, undefined, generatedWorld);
  const paperCapture = await persistPaperCaptureEvidence(page, generatedWorld);
  assert.equal(paperCapture.manifest.worldId, generatedWorld.id, "Paper capture world id drifted");
  assert.equal(paperCapture.manifest.seed, generatedWorld.seed, "Paper capture seed drifted");
  assert.equal(
    finalValidation.status,
    "passed",
    `Final renderer was not reference-certified (${finalValidation.status}): ${finalValidation.text}`,
  );

  const body = await page.locator("body").innerText();
  assert.match(body, /(grok-4\.6|gemini-3\.6-flash|gpt-5\.6-sol|claude-opus-5).*plan/i);
  assert.match(body, /visual (?:reference|judgement)/i);
  assert.doesNotMatch(body, /Plan:\s*template/i);
  assert.match(body, /seed 0x[0-9a-f]+/i);
  assert.match(body, /Blender GLB|browser assets/i);
  assert.equal(committee.status, "retained");
  assert.equal(paperCapture.manifest.capturePolicy.capturedViews.length, 9);
  assert.equal(committee.providers.length, 4, "Committee did not expose all four providers");
  for (const provider of committee.providers) {
    assert.equal(provider.configured, "true", `${provider.provider} is not configured`);
    assert.equal(provider.authenticated, "true", `${provider.provider} did not authenticate`);
    assert.equal(provider.available, "true", `${provider.provider} model is unavailable`);
  }
  assert.ok(
    committee.artifacts.filter((artifact) => artifact.image).length >= 6,
    "Committee did not retain enough map/multiview image variants",
  );
  for (const stage of [
    "planning",
    "layout",
    "multiview",
    "asset_variant",
    "critique",
    "final_judge",
  ]) {
    assert.ok(
      committee.artifacts.some((artifact) => artifact.stage === stage),
      `Committee ledger omitted the ${stage} stage`,
    );
  }
  const generatedHash = await capture(page, "worldclaw-generated.png");

  const mapCamera = await requireButton(page, "Map");
  await mapCamera.click();
  await page.waitForTimeout(450);
  await capture(page, "worldclaw-map-registered.png");
  const orbitCamera = await requireButton(page, "Orbit");
  await orbitCamera.click();

  const modeHashes = new Map();
  for (const mode of ["Instance", "Depth", "Normal", "Lit"]) {
    const button = await requireButton(page, mode);
    await button.click();
    await page.waitForTimeout(450);
    modeHashes.set(mode, await capture(page, `worldclaw-${mode.toLowerCase()}.png`));
  }
  assert.equal(
    new Set(modeHashes.values()).size,
    modeHashes.size,
    "Render diagnostic modes produced identical captures",
  );
  assert.notEqual(generatedHash, modeHashes.get("Depth"));

  const walk = await requireButton(page, "Walk");
  await walk.click();
  await page.waitForTimeout(500);
  await capture(page, "worldclaw-walk.png");

  const qaBefore = await page.evaluate(() => window.__WORLDCLAW_QA__ ?? null);
  assert.ok(qaBefore?.camera, "WorldScene QA camera snapshot is unavailable");
  assert.ok(qaBefore?.renderer?.triangles > 0, "Renderer reports no triangles");
  assert.ok(qaBefore?.renderer?.calls > 0, "Renderer reports no draw calls");

  await page.keyboard.down("KeyA");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyA");
  const qaAfterA = await page.evaluate(() => window.__WORLDCLAW_QA__);
  const aDelta = [qaAfterA.camera[0] - qaBefore.camera[0], qaAfterA.camera[2] - qaBefore.camera[2]];
  const aCross = qaBefore.forward[0] * aDelta[1] - qaBefore.forward[2] * aDelta[0];
  assert.ok(aCross < -0.05, `A did not move player-left (signed delta ${aCross})`);

  await page.keyboard.down("KeyD");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyD");
  const qaAfterD = await page.evaluate(() => window.__WORLDCLAW_QA__);
  const dDelta = [qaAfterD.camera[0] - qaAfterA.camera[0], qaAfterD.camera[2] - qaAfterA.camera[2]];
  const dCross = qaAfterA.forward[0] * dDelta[1] - qaAfterA.forward[2] * dDelta[0];
  assert.ok(dCross > 0.05, `D did not move player-right (signed delta ${dCross})`);

  const orbit = await requireButton(page, "Orbit");
  await orbit.click();
  await walk.click();
  await page.waitForTimeout(100);
  await orbit.click();

  if (!customPrompt) {
    const desert = await requireButton(page, "Desert battlefield");
    await desert.click();
    await generate.click();
    await waitForReady(page, "desert battlefield");
    await capture(page, "worldclaw-desert.png");
  }

  assert.deepEqual(errors, [], `Browser errors:\n${errors.join("\n")}`);
  const paidEvidence = await finalizeBoundPaidRun(page, "completed");
  if (caseBinding) {
    assert.ok(
      paidServerFnRequestCount >= 4,
      "Paid request headers did not cover planning, layout, multiview, and final judge",
    );
    assert.ok(
      paidEvidence?.attemptCount >= PAPER_GENERATION_ATTEMPT_BUDGET.minimumTotal &&
        paidEvidence.attemptCount <= PAPER_GENERATION_ATTEMPT_BUDGET.maximumTotal,
      "Paid inference ledger attempt total is outside the preregistered range",
    );
  }
  await writeGenerationStatus("passed", {
    finishedAt: new Date().toISOString(),
    generatedWorld,
    prebuildEvidence,
    committeeEvidence: committee.persistenceEvidence,
    paperCaptureEvidence: paperCapture.evidence,
    paidInferenceEvidence: paidEvidence,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        modes: Object.fromEntries(modeHashes),
        renderer: qaAfterD.renderer,
        controls: { aCross, dCross },
      },
      null,
      2,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (activePage) {
    await retainGenerationFailure(activePage, message);
  } else {
    await writeGenerationStatus("failed", {
      finishedAt: new Date().toISOString(),
      message,
    });
  }
  let paidFinalizationError = null;
  try {
    if (activePage) await finalizeBoundPaidRun(activePage, "failed");
    else paidFinalizationError = new Error("Paid run was created but its browser page is gone");
  } catch (finalizationError) {
    paidFinalizationError = finalizationError;
  }
  await writeGenerationStatus("failed", {
    finishedAt: new Date().toISOString(),
    message,
    paidInferenceEvidence,
    ...(paidFinalizationError
      ? {
          paidInferenceFinalizationError: (paidFinalizationError instanceof Error
            ? paidFinalizationError.message
            : String(paidFinalizationError)
          ).slice(0, 1_200),
        }
      : {}),
  });
  if (paidFinalizationError) {
    throw new AggregateError(
      [error, paidFinalizationError],
      `Generation failed and paid inference accounting could not finalize: ${message}`,
    );
  }
  throw error;
} finally {
  await browser.close();
}

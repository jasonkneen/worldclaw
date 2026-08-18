import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import {
  PAPER_CAPTURE_PASS_NAMES,
  PAPER_CAPTURE_VIEW_NAMES,
  committeeStructuredOutputSetDigest,
  paperCaptureImageSetDigest,
  prepareNormalizedScenePlanEvidence,
  prepareStructuredModelOutputEvidence,
  validatePersistedPaperImageBytes,
  validatePersistedPaperCaptureEvidence,
} from "./worldclaw-paper-evidence.mjs";

export const PAPER_REVIEW_OUTCOMES = ["loss", "tie", "win"];
export const PAPER_REVIEW_STATUS = ["scored", "unscorable"];
export const PAPER_REVIEW_MAX_CASES = 11;
export const PAPER_REVIEW_PROVIDER_ROSTER = [
  ["xai", "grok-4.6"],
  ["gemini", "gemini-3.6-flash"],
  ["openai", "gpt-5.6-sol"],
  ["anthropic", "anthropic/claude-opus-5"],
];
export const PAPER_REVIEW_IMAGE_LIMITS = Object.freeze({
  count: 4,
  maximumPerImageBytes: 6_000_000,
  maximumTotalBytes: 14_000_000,
  maximumTotalBase64Characters: 18_600_000,
  maximumSerializedInlineRequestBytes: 19_000_000,
  maximumDimensionPixels: 2_048,
  maximumPixelsPerImage: 2_250_000,
});
const OUTCOME_SCORE = { loss: -1, tie: 0, win: 1 };
const EXPECTED_CAPTURE_WIDTH = 640;
const EXPECTED_CAPTURE_HEIGHT = 360;
const LABEL_HEIGHT = 16;
const GLYPHS = Object.freeze({
  "-": ["000", "000", "111", "000", "000"],
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["111", "101", "101", "101", "111"],
  P: ["111", "101", "111", "100", "100"],
  R: ["110", "101", "110", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  W: ["101", "101", "111", "111", "101"],
  Y: ["101", "101", "010", "010", "010"],
});
const verifiedRunEvidence = new WeakMap();

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function promptSha256(prompt) {
  assert.equal(typeof prompt, "string");
  return sha256(Buffer.from(prompt, "utf8"));
}

export function validatePaperRunBinding({
  generationStatus,
  captureManifest,
  paperCase,
  suiteId,
  caseToken,
  runId,
  verifiedEvidence,
}) {
  assert.match(runId ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.match(suiteId ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.match(caseToken ?? "", /^[a-f0-9]{32,64}$/);
  assert.equal(generationStatus?.status, "passed", "Generation did not pass");
  assert.equal(generationStatus?.runId, runId, "Generation run id drifted");
  assert.equal(generationStatus?.binding?.suiteId, suiteId, "Generation suite id drifted");
  assert.equal(generationStatus?.binding?.caseId, paperCase.id, "Generation case id drifted");
  assert.equal(generationStatus?.binding?.caseToken, caseToken, "Generation case token drifted");
  assert.deepEqual(
    generationStatus?.binding?.regionalReadability,
    paperCase.regionalReadability,
    "Generation regional readability drifted",
  );
  const expectedPromptHash = promptSha256(paperCase.prompt);
  assert.equal(
    generationStatus?.binding?.promptSha256,
    expectedPromptHash,
    "Generation prompt binding drifted",
  );
  assert.equal(
    generationStatus?.generatedWorld?.promptSha256,
    expectedPromptHash,
    "Generated world prompt drifted",
  );
  const verified =
    (captureManifest && verifiedRunEvidence.get(captureManifest)) ?? verifiedEvidence;
  assert.ok(verified, "Capture manifest bytes and bound artifacts were not independently verified");
  assert.equal(
    generationStatus?.paperCaptureEvidence?.manifest?.sha256,
    verified.manifestSha256,
    "Capture manifest file hash drifted",
  );
  assert.equal(
    generationStatus?.paperCaptureEvidence?.imageSetSha256,
    verified.imageSetSha256,
    "Capture image-set digest drifted",
  );
  assert.equal(
    generationStatus?.paperCaptureEvidence?.imageCount,
    36,
    "Capture image count drifted",
  );
  assert.equal(
    generationStatus?.prebuildEvidence?.manifest?.sha256,
    verified.prebuildManifestSha256,
    "Prebuild manifest hash drifted",
  );
  assert.equal(
    generationStatus?.committeeEvidence?.manifest?.sha256,
    verified.committeeManifestSha256,
    "Committee manifest hash drifted",
  );
  assert.equal(
    generationStatus?.committeeEvidence?.structuredOutputSetSha256,
    verified.structuredOutputSetSha256,
    "Committee structured-output set digest drifted",
  );
  assert.deepEqual(
    captureManifest?.binding,
    generationStatus?.binding,
    "Capture case binding drifted",
  );
  assert.deepEqual(
    captureManifest?.regionalReadability,
    paperCase.regionalReadability,
    "Capture regional readability drifted",
  );
  assert.equal(captureManifest?.worldPromptSha256, expectedPromptHash, "Capture prompt drifted");
  assert.equal(
    captureManifest?.capturedAt,
    generationStatus?.paperCaptureEvidence?.capturedAt,
    "Capture timestamp drifted",
  );
  assert.equal(
    captureManifest?.worldFingerprint,
    generationStatus?.paperCaptureEvidence?.worldFingerprint,
    "Capture world fingerprint drifted",
  );
  assert.ok(
    captureManifest.capturedAt >= generationStatus.startedAt &&
      captureManifest.capturedAt <= generationStatus.finishedAt,
    "Capture timestamp falls outside the generation run",
  );
  assert.equal(
    captureManifest?.worldId,
    generationStatus?.generatedWorld?.id,
    "Capture world id is not bound to generation",
  );
  assert.equal(
    captureManifest?.seed,
    generationStatus?.generatedWorld?.seed,
    "Capture seed is not bound to generation",
  );
  return {
    suiteId,
    caseId: paperCase.id,
    caseToken,
    runId,
    promptSha256: expectedPromptHash,
    worldId: captureManifest.worldId,
    seed: captureManifest.seed,
  };
}

function boundedText(value, maximum = 600) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function assertPositiveInteger(value, label, maximum) {
  assert.ok(Number.isInteger(value) && value >= 1 && value <= maximum, `${label} is out of bounds`);
}

function decodePng(bytes, label) {
  let png;
  try {
    png = PNG.sync.read(bytes);
  } catch (error) {
    throw new Error(`${label} is not a decodable PNG`, { cause: error });
  }
  assertPositiveInteger(
    png.width,
    `${label} width`,
    PAPER_REVIEW_IMAGE_LIMITS.maximumDimensionPixels,
  );
  assertPositiveInteger(
    png.height,
    `${label} height`,
    PAPER_REVIEW_IMAGE_LIMITS.maximumDimensionPixels,
  );
  assert.ok(
    png.width * png.height <= PAPER_REVIEW_IMAGE_LIMITS.maximumPixelsPerImage,
    `${label} exceeds the pixel budget`,
  );
  return png;
}

function resizeNearest(source, width, height) {
  assertPositiveInteger(width, "Contact-sheet cell width", 640);
  assertPositiveInteger(height, "Contact-sheet cell height", 360);
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor((y / height) * source.height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(source.width - 1, Math.floor((x / width) * source.width));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const outputOffset = (y * width + x) * 4;
      output.data[outputOffset] = source.data[sourceOffset];
      output.data[outputOffset + 1] = source.data[sourceOffset + 1];
      output.data[outputOffset + 2] = source.data[sourceOffset + 2];
      output.data[outputOffset + 3] = source.data[sourceOffset + 3];
    }
  }
  return output;
}

function fillRect(png, x, y, width, height, color) {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const offset = (row * png.width + column) * 4;
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
    }
  }
}

function markerColor(index) {
  const colors = [
    [28, 160, 255, 255],
    [255, 139, 31, 255],
    [64, 200, 112, 255],
    [223, 80, 110, 255],
    [162, 104, 255, 255],
    [255, 205, 64, 255],
  ];
  return colors[index % colors.length];
}

function drawLabel(png, text, originX, originY, maximumWidth) {
  const normalized = text.toUpperCase().replace(/[^A-Z0-9-]/g, "-");
  const scale = 2;
  const advance = 4 * scale;
  const maximumCharacters = Math.max(1, Math.floor(maximumWidth / advance));
  for (const [characterIndex, character] of [...normalized.slice(0, maximumCharacters)].entries()) {
    const rows = GLYPHS[character] ?? GLYPHS["-"];
    for (const [rowIndex, row] of rows.entries()) {
      for (const [columnIndex, bit] of [...row].entries()) {
        if (bit !== "1") continue;
        fillRect(
          png,
          originX + characterIndex * advance + columnIndex * scale,
          originY + rowIndex * scale,
          scale,
          scale,
          [245, 245, 245, 255],
        );
      }
    }
  }
}

export function composePaperContactSheet(images, options = {}) {
  const columns = options.columns ?? 3;
  const cellWidth = options.cellWidth ?? 320;
  const cellHeight = options.cellHeight ?? 180;
  const gutter = options.gutter ?? 4;
  const labels = options.labels ?? images.map((_, index) => String(index + 1));
  assert.ok(images.length > 0 && images.length <= 18, "Contact sheet requires 1-18 images");
  assertPositiveInteger(columns, "Contact-sheet columns", 6);
  assertPositiveInteger(cellWidth, "Contact-sheet cell width", 640);
  assertPositiveInteger(cellHeight, "Contact-sheet cell height", 360);
  assert.ok(
    Number.isInteger(gutter) && gutter >= 2 && gutter <= 12,
    "Contact-sheet gutter is invalid",
  );
  assert.equal(labels.length, images.length, "Contact-sheet labels must match image count");
  assert.equal(new Set(labels).size, labels.length, "Contact-sheet labels must be unique");
  const rows = Math.ceil(images.length / columns);
  const sheet = new PNG({
    width: columns * cellWidth + (columns + 1) * gutter,
    height: rows * (cellHeight + LABEL_HEIGHT) + (rows + 1) * gutter,
  });
  sheet.data.fill(255);
  for (const [index, bytes] of images.entries()) {
    assert.ok(Buffer.isBuffer(bytes), `Contact-sheet image ${index + 1} must be bytes`);
    const decoded = decodePng(bytes, `Contact-sheet image ${index + 1}`);
    const image = resizeNearest(decoded, cellWidth, cellHeight);
    const originX = gutter + (index % columns) * (cellWidth + gutter);
    const originY = gutter + Math.floor(index / columns) * (cellHeight + LABEL_HEIGHT + gutter);
    fillRect(sheet, originX, originY, cellWidth, LABEL_HEIGHT, [20, 23, 28, 255]);
    fillRect(sheet, originX, originY, Math.min(10, cellWidth), LABEL_HEIGHT, markerColor(index));
    drawLabel(sheet, labels[index], originX + 14, originY + 3, cellWidth - 18);
    const imageOriginY = originY + LABEL_HEIGHT;
    for (let y = 0; y < cellHeight; y++) {
      const sourceStart = y * cellWidth * 4;
      const targetStart = ((imageOriginY + y) * sheet.width + originX) * 4;
      image.data.copy(sheet.data, targetStart, sourceStart, sourceStart + cellWidth * 4);
    }
  }
  return PNG.sync.write(sheet);
}

export function cropPaperReferenceMatrix(bytes, crop, expectedHash) {
  const source = decodePng(bytes, "Paper reference page");
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(
      Number.isInteger(crop?.[key]) && crop[key] >= 0,
      `Paper reference crop ${key} is invalid`,
    );
  }
  assert.ok(crop.width > 0 && crop.height > 0, "Paper reference crop is empty");
  assert.ok(crop.x + crop.width <= source.width, "Paper reference crop exceeds page width");
  assert.ok(crop.y + crop.height <= source.height, "Paper reference crop exceeds page height");
  const output = new PNG({ width: crop.width, height: crop.height });
  for (let row = 0; row < crop.height; row++) {
    const sourceStart = ((crop.y + row) * source.width + crop.x) * 4;
    const targetStart = row * crop.width * 4;
    source.data.copy(output.data, targetStart, sourceStart, sourceStart + crop.width * 4);
  }
  const encoded = PNG.sync.write(output, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  if (expectedHash)
    assert.equal(sha256(encoded), expectedHash, "Paper reference crop hash drifted");
  return encoded;
}

function safeCaptureFile(runDirectory, viewName, pass, evidence) {
  const expected = `paper-matrix-${viewName}-${pass}.png`;
  assert.equal(evidence?.imageFile, expected, `${viewName} ${pass} has an unexpected filename`);
  assert.equal(
    basename(evidence.imageFile),
    evidence.imageFile,
    `${viewName} ${pass} escaped its run`,
  );
  const runRoot = resolve(runDirectory);
  const path = resolve(runRoot, evidence.imageFile);
  assert.ok(path.startsWith(`${runRoot}${sep}`), `${viewName} ${pass} escaped its run directory`);
  return path;
}

function rescanInstancePixels(bytes, manifest, viewName) {
  const png = decodePng(bytes, `${viewName} instance rescan`);
  const logicalIdByEncodedId = new Map(
    manifest.logicalIds.mapping.map((entry) => [entry.encodedId24, entry.logicalId]),
  );
  const counts = Object.fromEntries(
    manifest.logicalIds.mapping.map((entry) => [entry.logicalId, 0]),
  );
  let invalidIdPixelCount = 0;
  let backgroundPixelCount = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const encodedId24 =
      ((png.data[offset] ?? 0) << 16) |
      ((png.data[offset + 1] ?? 0) << 8) |
      (png.data[offset + 2] ?? 0);
    if (encodedId24 === 0) {
      backgroundPixelCount++;
      continue;
    }
    const logicalId = logicalIdByEncodedId.get(encodedId24);
    if (!logicalId) invalidIdPixelCount++;
    else counts[logicalId]++;
  }
  const visibleLogicalIds = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([logicalId]) => logicalId)
    .sort();
  const objectIds = new Set(
    manifest.logicalIds.mapping
      .filter((entry) => entry.logicalType === "object")
      .map((entry) => entry.logicalId),
  );
  const visibleObjectIds = visibleLogicalIds.filter((logicalId) => objectIds.has(logicalId));
  const expected = manifest.views[viewName].instance.visibility;
  assert.equal(invalidIdPixelCount, 0, `${viewName} persisted instance PNG has invalid IDs`);
  assert.equal(
    backgroundPixelCount,
    expected.backgroundPixelCount,
    `${viewName} background drifted`,
  );
  assert.deepEqual(
    visibleLogicalIds,
    expected.visibleLogicalIds,
    `${viewName} logical IDs drifted`,
  );
  assert.deepEqual(visibleObjectIds, expected.visibleObjectIds, `${viewName} object IDs drifted`);
  assert.deepEqual(
    counts,
    expected.visiblePixelsByLogicalId,
    `${viewName} ID pixel counts drifted`,
  );
}

const WALK_VIEW_NAMES = PAPER_CAPTURE_VIEW_NAMES.filter((name) => name.startsWith("walk-"));
const PAID_COMMITTEE_STAGES = new Set([
  "planning",
  "layout",
  "multiview",
  "critique",
  "final_judge",
]);

export async function buildPaperReviewImages(runDirectory, paperCase) {
  const generationStatusBytes = await readFile(`${runDirectory}/generation_status.json`);
  const generationStatus = JSON.parse(generationStatusBytes.toString("utf8"));
  assert.equal(generationStatus?.status, "passed", "Generation did not pass");
  const manifestBytes = await readFile(`${runDirectory}/paper_capture_matrix.json`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validatePersistedPaperCaptureEvidence(manifest);
  const manifestSha256 = sha256(manifestBytes);
  assert.equal(
    generationStatus?.paperCaptureEvidence?.manifest?.file,
    "paper_capture_matrix.json",
    "Capture manifest filename drifted",
  );
  assert.equal(
    generationStatus?.paperCaptureEvidence?.manifest?.bytes,
    manifestBytes.length,
    "Capture manifest byte count drifted",
  );
  assert.equal(
    generationStatus?.paperCaptureEvidence?.manifest?.sha256,
    manifestSha256,
    "Capture manifest file hash drifted",
  );
  const expectedPromptHash = promptSha256(paperCase.prompt);
  assert.equal(manifest?.binding?.caseId, paperCase.id, "Capture case id drifted");
  assert.equal(
    manifest?.binding?.promptSha256,
    expectedPromptHash,
    "Capture prompt binding drifted",
  );
  assert.equal(manifest?.worldPromptSha256, expectedPromptHash, "Capture world prompt drifted");
  assert.deepEqual(
    manifest?.binding,
    generationStatus?.binding,
    "Capture/generation binding drifted",
  );
  assert.deepEqual(
    manifest?.regionalReadability,
    paperCase.regionalReadability,
    "Capture regional readability drifted",
  );
  assert.equal(manifest?.worldId, generationStatus?.generatedWorld?.id, "Capture world id drifted");
  assert.equal(manifest?.seed, generationStatus?.generatedWorld?.seed, "Capture seed drifted");
  assert.equal(
    manifest?.worldPromptSha256,
    generationStatus?.generatedWorld?.promptSha256,
    "Capture/generated prompt hash drifted",
  );
  const imageSetSha256 = paperCaptureImageSetDigest(manifest);
  assert.equal(
    generationStatus?.paperCaptureEvidence?.imageSetSha256,
    imageSetSha256,
    "Capture image-set digest drifted",
  );
  assert.equal(
    generationStatus?.paperCaptureEvidence?.imageCount,
    36,
    "Capture image count drifted",
  );

  const persistedImages = new Map();
  const persistedValidation = [];
  for (const viewName of PAPER_CAPTURE_VIEW_NAMES) {
    for (const pass of PAPER_CAPTURE_PASS_NAMES) {
      const evidence = manifest.views?.[viewName]?.[pass];
      const bytes = await readFile(safeCaptureFile(runDirectory, viewName, pass, evidence));
      persistedImages.set(`${viewName}:${pass}`, bytes);
      persistedValidation.push(validatePersistedPaperImageBytes(manifest, viewName, pass, bytes));
      if (pass === "instance") rescanInstancePixels(bytes, manifest, viewName);
    }
  }

  const prebuildDescriptor = generationStatus?.prebuildEvidence?.manifest;
  assert.equal(prebuildDescriptor?.file, "prebuild_reference_manifest.json");
  const prebuildManifestBytes = await readFile(`${runDirectory}/${prebuildDescriptor.file}`);
  assert.equal(
    prebuildManifestBytes.length,
    prebuildDescriptor.bytes,
    "Prebuild manifest size drifted",
  );
  const prebuildManifestSha256 = sha256(prebuildManifestBytes);
  assert.equal(prebuildManifestSha256, prebuildDescriptor.sha256, "Prebuild manifest hash drifted");
  const prebuild = JSON.parse(prebuildManifestBytes.toString("utf8"));
  assert.equal(prebuild?.runId, generationStatus.runId, "Prebuild run id drifted");
  assert.deepEqual(prebuild?.binding, generationStatus.binding, "Prebuild binding drifted");
  assert.deepEqual(
    prebuild?.generatedWorld,
    generationStatus.generatedWorld,
    "Prebuild world drifted",
  );
  assert.deepEqual(
    prebuild?.normalizedPlan,
    generationStatus?.prebuildEvidence?.normalizedPlan,
    "Normalized-plan status descriptor drifted",
  );
  assert.deepEqual(
    prebuild?.images,
    generationStatus?.prebuildEvidence?.images,
    "Prebuild image status descriptors drifted",
  );
  assert.deepEqual(
    Object.keys(prebuild?.images ?? {}).sort(),
    ["appearanceConcept", "canonicalMap", "semanticMap"],
    "Bound prebuild image set is incomplete",
  );
  for (const [key, descriptor] of Object.entries(prebuild.images)) {
    assert.match(descriptor?.imageFile ?? "", /^prebuild-[a-zA-Z]+\.(?:png|jpg)$/);
    assert.equal(
      basename(descriptor.imageFile),
      descriptor.imageFile,
      `${key} prebuild file escaped run`,
    );
    const bytes = await readFile(resolve(runDirectory, descriptor.imageFile));
    assert.equal(bytes.length, descriptor.bytes, `${key} prebuild byte count drifted`);
    assert.equal(sha256(bytes), descriptor.sha256, `${key} prebuild hash drifted`);
  }
  assert.equal(prebuild?.normalizedPlan?.file, "normalized_scene_plan.json");
  const normalizedPlanBytes = await readFile(`${runDirectory}/normalized_scene_plan.json`);
  assert.equal(
    normalizedPlanBytes.length,
    prebuild.normalizedPlan.bytes,
    "Normalized plan size drifted",
  );
  assert.equal(
    sha256(normalizedPlanBytes),
    prebuild.normalizedPlan.sha256,
    "Normalized plan hash drifted",
  );
  const normalizedPlan = prepareNormalizedScenePlanEvidence(
    normalizedPlanBytes.toString("utf8"),
    paperCase.prompt,
  );
  assert.deepEqual(
    normalizedPlan.bytes,
    normalizedPlanBytes,
    "Normalized plan encoding is not canonical",
  );

  const committeeLedgerBytes = await readFile(`${runDirectory}/model_committee_ledger.json`);
  const committeeDescriptor = generationStatus?.committeeEvidence?.manifest;
  assert.equal(committeeDescriptor?.file, "model_committee_ledger.json");
  assert.equal(
    committeeLedgerBytes.length,
    committeeDescriptor?.bytes,
    "Committee ledger byte count drifted",
  );
  const committeeManifestSha256 = sha256(committeeLedgerBytes);
  assert.equal(
    committeeManifestSha256,
    committeeDescriptor?.sha256,
    "Committee ledger hash drifted",
  );
  const committeeLedger = JSON.parse(committeeLedgerBytes.toString("utf8"));
  assert.equal(committeeLedger?.version, 2, "Committee ledger version drifted");
  assert.equal(committeeLedger?.runId, generationStatus.runId, "Committee run id drifted");
  assert.deepEqual(committeeLedger?.binding, generationStatus.binding, "Committee binding drifted");
  assert.deepEqual(
    committeeLedger?.generatedWorld,
    generationStatus.generatedWorld,
    "Committee world binding drifted",
  );
  assert.ok(Array.isArray(committeeLedger?.artifacts), "Committee ledger omitted artifacts");
  const structuredOutputSet = committeeStructuredOutputSetDigest(committeeLedger.artifacts);
  assert.equal(
    structuredOutputSet.count,
    generationStatus?.committeeEvidence?.structuredOutputCount,
    "Committee structured-output count drifted",
  );
  assert.equal(
    structuredOutputSet.sha256,
    generationStatus?.committeeEvidence?.structuredOutputSetSha256,
    "Committee structured-output set digest drifted",
  );
  let structuredOutputCount = 0;
  let structuredOutputBytes = 0;
  let selectedPlanningOutput = null;
  const structuredFilenames = new Set();
  const providerResponseIds = new Set();
  for (const artifact of committeeLedger.artifacts) {
    assert.match(artifact.provider ?? "", /^(?:xai|gemini|openai|anthropic)$/);
    assert.ok(artifact.model, `Artifact ${artifact.id} omitted its model`);
    if (artifact.stage === "asset_variant") {
      assert.ok(
        artifact.requestedModel === null || artifact.requestedModel === undefined,
        `Asset variant ${artifact.id} claimed a paid request`,
      );
      assert.ok(
        artifact.responseId === null || artifact.responseId === undefined,
        `Asset variant ${artifact.id} claimed a provider response`,
      );
      assert.ok(
        artifact.identityAttestation === null || artifact.identityAttestation === undefined,
        `Asset variant ${artifact.id} claimed a provider identity attestation`,
      );
    } else {
      assert.ok(
        PAID_COMMITTEE_STAGES.has(artifact.stage),
        `Artifact ${artifact.id} has unknown committee stage ${artifact.stage}`,
      );
      assert.ok(artifact.requestedModel, `Artifact ${artifact.id} omitted requested model identity`);
      assert.ok(
        artifact.identityAttestation === "provider-response" ||
          artifact.identityAttestation === "request-only",
        `Artifact ${artifact.id} is not provider-identity attested`,
      );
      if (artifact.identityAttestation === "provider-response") {
        assert.ok(artifact.responseId, `Artifact ${artifact.id} omitted provider response ID`);
        assert.equal(
          artifact.model,
          artifact.requestedModel,
          `Artifact ${artifact.id} provider response model drifted`,
        );
        const providerResponseKey = `${artifact.provider}\u0000${artifact.responseId}`;
        assert.ok(
          !providerResponseIds.has(providerResponseKey),
          `Provider response ID ${artifact.responseId} was replayed across ${artifact.provider} artifacts`,
        );
        providerResponseIds.add(providerResponseKey);
      } else {
        assert.ok(
          artifact.responseId === null || artifact.responseId === undefined,
          `Artifact ${artifact.id} claimed a response ID without provider-response attestation`,
        );
        assert.equal(
          artifact.model,
          artifact.requestedModel,
          `Artifact ${artifact.id} request-only model drifted`,
        );
      }
    }
    assert.equal(
      artifact.structuredOutput,
      undefined,
      "Committee ledger retained inline structured JSON",
    );
    const descriptors = [
      artifact.structuredOutputFile,
      artifact.structuredOutputBytes,
      artifact.structuredOutputSha256,
    ];
    const present = descriptors.filter((value) => value !== null && value !== undefined).length;
    assert.ok(
      present === 0 || present === 3,
      `Artifact ${artifact.id} has a partial structured descriptor`,
    );
    if (present === 0) continue;
    structuredOutputCount++;
    assert.ok(structuredOutputCount <= 64, "Committee structured-output artifact budget drifted");
    const expectedFile = `committee-${String(artifact.id)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .slice(0, 100)}-structured.json`;
    assert.equal(
      artifact.structuredOutputFile,
      expectedFile,
      `Artifact ${artifact.id} structured filename drifted`,
    );
    assert.equal(basename(artifact.structuredOutputFile), artifact.structuredOutputFile);
    assert.ok(
      !structuredFilenames.has(artifact.structuredOutputFile),
      `Artifact ${artifact.id} collides with another structured-output filename`,
    );
    structuredFilenames.add(artifact.structuredOutputFile);
    const bytes = await readFile(resolve(runDirectory, artifact.structuredOutputFile));
    assert.equal(
      bytes.length,
      artifact.structuredOutputBytes,
      `Artifact ${artifact.id} structured size drifted`,
    );
    assert.equal(
      sha256(bytes),
      artifact.structuredOutputSha256,
      `Artifact ${artifact.id} structured hash drifted`,
    );
    structuredOutputBytes += bytes.length;
    assert.ok(
      structuredOutputBytes <= 4_096_000,
      "Committee structured-output persisted byte budget drifted",
    );
    const structured = prepareStructuredModelOutputEvidence(bytes.toString("utf8"));
    assert.deepEqual(
      structured.bytes,
      bytes,
      `Artifact ${artifact.id} structured JSON is not canonical`,
    );
    if (artifact.stage === "planning" && artifact.status === "selected") {
      assert.equal(
        selectedPlanningOutput,
        null,
        "Committee has multiple selected planning artifacts",
      );
      selectedPlanningOutput = structured.value;
    }
  }
  assert.ok(selectedPlanningOutput, "Passed bound run omitted selected normalized planning JSON");
  assert.equal(
    selectedPlanningOutput?.plan?.prompt,
    paperCase.prompt,
    "Selected planning prompt drifted",
  );

  verifiedRunEvidence.set(manifest, {
    manifestSha256,
    imageSetSha256,
    prebuildManifestSha256,
    committeeManifestSha256,
    structuredOutputSetSha256: structuredOutputSet.sha256,
  });
  const loadPass = async (pass, viewNames) => {
    const images = [];
    for (const viewName of viewNames) {
      const bytes = persistedImages.get(`${viewName}:${pass}`);
      assert.ok(bytes, `${viewName} ${pass} was not independently loaded`);
      const png = decodePng(bytes, `${viewName} ${pass}`);
      assert.deepEqual([png.width, png.height], [EXPECTED_CAPTURE_WIDTH, EXPECTED_CAPTURE_HEIGHT]);
      images.push(bytes);
    }
    return images;
  };
  const referencePage = await readFile(paperCase.referenceImagePath);
  assert.equal(
    sha256(referencePage),
    paperCase.referenceSha256,
    "Paper reference page hash drifted",
  );
  const reference = cropPaperReferenceMatrix(
    referencePage,
    paperCase.referencePanelCrop,
    paperCase.referencePanelSha256,
  );
  const [beauty, instance, depth, normal] = await Promise.all([
    loadPass("beauty", PAPER_CAPTURE_VIEW_NAMES),
    loadPass("instance", WALK_VIEW_NAMES),
    loadPass("depth", WALK_VIEW_NAMES),
    loadPass("normal", WALK_VIEW_NAMES),
  ]);
  const viewLabels = ["global", "region-1", "region-2", "region-3", "region-4", ...WALK_VIEW_NAMES];
  const beautySheet = composePaperContactSheet(beauty, {
    columns: 3,
    cellWidth: 480,
    cellHeight: 270,
    labels: viewLabels,
  });
  const instanceSheet = composePaperContactSheet(instance, {
    columns: 4,
    cellWidth: 320,
    cellHeight: 180,
    labels: WALK_VIEW_NAMES.map((view) => `${view}-instance`),
  });
  const diagnosticSheet = composePaperContactSheet([...depth, ...normal], {
    columns: 4,
    cellWidth: 320,
    cellHeight: 180,
    labels: [
      ...WALK_VIEW_NAMES.map((view) => `${view}-depth`),
      ...WALK_VIEW_NAMES.map((view) => `${view}-normal`),
    ],
  });
  const images = {
    reference: { bytes: reference, mime: "image/png" },
    beauty: { bytes: beautySheet, mime: "image/png" },
    instance: { bytes: instanceSheet, mime: "image/png" },
    diagnostics: { bytes: diagnosticSheet, mime: "image/png" },
  };
  const budget = validatePaperReviewImageBudget(images);
  return {
    manifest,
    images,
    budget,
    persistedValidation,
    hashes: Object.fromEntries(
      Object.entries(images).map(([key, value]) => [key, sha256(value.bytes)]),
    ),
  };
}

export function validatePaperReviewImageBudget(images) {
  const entries = Object.entries(images);
  assert.equal(entries.length, PAPER_REVIEW_IMAGE_LIMITS.count, "Reviewer image count drifted");
  let totalBytes = 0;
  let totalBase64Characters = 0;
  for (const [key, value] of entries) {
    assert.equal(value?.mime, "image/png", `${key} reviewer image must be PNG`);
    assert.ok(Buffer.isBuffer(value.bytes), `${key} reviewer image is missing bytes`);
    assert.ok(
      value.bytes.length <= PAPER_REVIEW_IMAGE_LIMITS.maximumPerImageBytes,
      `${key} reviewer image exceeds the per-image byte budget`,
    );
    decodePng(value.bytes, `${key} reviewer image`);
    totalBytes += value.bytes.length;
    totalBase64Characters += value.bytes.toString("base64").length;
  }
  assert.ok(
    totalBytes <= PAPER_REVIEW_IMAGE_LIMITS.maximumTotalBytes,
    "Reviewer images exceed byte budget",
  );
  assert.ok(
    totalBase64Characters <= PAPER_REVIEW_IMAGE_LIMITS.maximumTotalBase64Characters,
    "Reviewer images exceed inline base64 budget",
  );
  const estimatedSerializedInlineRequestBytes = totalBase64Characters + 96_000;
  assert.ok(
    estimatedSerializedInlineRequestBytes <=
      PAPER_REVIEW_IMAGE_LIMITS.maximumSerializedInlineRequestBytes,
    "Reviewer images exceed the strict serialized inline request budget",
  );
  return {
    imageCount: entries.length,
    totalBytes,
    totalBase64Characters,
    estimatedSerializedInlineRequestBytes,
  };
}

export function deterministicPaperCaptureSummary(manifest) {
  validatePersistedPaperCaptureEvidence(manifest);
  const inventory = manifest.geometryInventory;
  const failures = [];
  if (inventory.renderedLogicalObjectCount !== inventory.expectedLogicalObjectCount) {
    failures.push("logical object inventory mismatch");
  }
  if (!inventory.geometryFinitePreflightPassed || inventory.nonFiniteGeometryValueCount !== 0) {
    failures.push("geometry finiteness preflight failed");
  }
  if (inventory.diagnosticsUseColliderProxies) failures.push("diagnostics used collider proxies");
  const views = PAPER_CAPTURE_VIEW_NAMES.map((viewName) => {
    const view = manifest.views[viewName];
    if (!view.camera.matrixSanity.passed || view.camera.matrixSanity.reflectionDetected) {
      failures.push(`${viewName} camera matrix failed`);
    }
    if (view.instance.visibility.invalidIdPixelCount !== 0) {
      failures.push(`${viewName} contains invalid instance IDs`);
    }
    if (
      view.depth.finiteDepthPixelCount <= 0 ||
      view.depth.nonFiniteDepthPixelCount !== 0 ||
      view.depth.outOfRangeDepthPixelCount !== 0
    ) {
      failures.push(`${viewName} runtime depth attestation failed`);
    }
    if (view.normal.coveredPixelCount <= 0) failures.push(`${viewName} normal pass is empty`);
    return {
      view: viewName,
      role: view.role,
      visibleObjects: view.instance.visibility.visibleObjectCount,
      invalidInstancePixels: view.instance.visibility.invalidIdPixelCount,
      finiteDepthPixels: view.depth.finiteDepthPixelCount,
      nonFiniteDepthPixels: view.depth.nonFiniteDepthPixelCount,
      outOfRangeDepthPixels: view.depth.outOfRangeDepthPixelCount,
      geometryNormalPixels: view.normal.coveredPixelCount,
      matrixPassed: view.camera.matrixSanity.passed,
      reflected: view.camera.matrixSanity.reflectionDetected,
    };
  });
  if (
    manifest.isolation.worldDataMutated !== false ||
    manifest.isolation.liveCameraMutated !== false ||
    manifest.isolation.liveMaterialsUsedForDiagnostics !== false ||
    !manifest.isolation.diagnosticPostprocessingBypassed ||
    !manifest.isolation.rendererStateRestored ||
    !manifest.isolation.uiViewModeRestored ||
    !manifest.isolation.uiSelectionRestored
  ) {
    failures.push("capture isolation failed");
  }
  if (
    !manifest.stateAudit.liveMaterialStateVerified ||
    !manifest.stateAudit.liveCameraStateVerified ||
    !manifest.stateAudit.worldFingerprintVerified
  ) {
    failures.push("capture state audit failed");
  }
  if (
    !manifest.materialAudit.liveMaterialReferencesUnchangedDuringDiagnostics ||
    !manifest.materialAudit.liveMaterialPropertiesUnchangedDuringDiagnostics ||
    !manifest.materialAudit.originalMaterialPropertiesRestored
  ) {
    failures.push("capture material audit failed");
  }
  return {
    passed: failures.length === 0,
    failures,
    inventory: {
      expectedLogicalObjectCount: inventory.expectedLogicalObjectCount,
      renderedLogicalObjectCount: inventory.renderedLogicalObjectCount,
      terrainMeshCount: inventory.terrainMeshCount,
      waterMeshCount: inventory.waterMeshCount,
      compiledBatchCount: inventory.compiledBatchCount,
      compiledSubmeshInstanceSlotCount: inventory.compiledSubmeshInstanceSlotCount,
      diagnosticsUseColliderProxies: inventory.diagnosticsUseColliderProxies,
      geometryFinitePreflightPassed: inventory.geometryFinitePreflightPassed,
      nonFiniteGeometryValueCount: inventory.nonFiniteGeometryValueCount,
    },
    views,
    isolation: manifest.isolation,
    stateAudit: manifest.stateAudit,
    materialAudit: manifest.materialAudit,
    validationBoundary: {
      independentlyRecomputedFromPng:
        "beauty luminance and opacity; normal alpha coverage; depth preview alpha coverage and quantized range; camera determinants; instance IDs",
      runtimeAttestedOnly:
        "float32 depth non-finite sentinel and unencoded out-of-range values before PNG preview encoding",
    },
  };
}

function normalizeEvidenceItem(item, axis) {
  assert.ok(item && typeof item === "object", `${axis} evidence must be structured`);
  const imageKey = boundedText(item.imageKey, 32);
  const view = boundedText(item.view, 32);
  const pass = boundedText(item.pass, 16);
  const observation = boundedText(item.observation, 400);
  assert.ok(["reference", "beauty", "instance", "diagnostics"].includes(imageKey));
  assert.ok(
    ["global", "region-1", "region-2", "region-3", "region-4", ...WALK_VIEW_NAMES].includes(view),
  );
  assert.ok(["beauty", "instance", "depth", "normal"].includes(pass));
  assert.ok(observation, `${axis} evidence has no observation`);
  const isWalk = WALK_VIEW_NAMES.includes(view);
  const isOverview = ["global", "region-1", "region-2", "region-3", "region-4"].includes(view);
  const compatible =
    (imageKey === "reference" && ((isOverview && pass === "beauty") || isWalk)) ||
    (imageKey === "beauty" && pass === "beauty") ||
    (imageKey === "instance" && isWalk && pass === "instance") ||
    (imageKey === "diagnostics" && isWalk && ["depth", "normal"].includes(pass));
  assert.ok(compatible, `${axis} evidence image/view/pass combination is impossible`);
  return { imageKey, view, pass, observation };
}

function normalizeRequiredTextArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length <= 12, `${label} exceeds its item budget`);
  return value.map((item, index) => {
    assert.equal(typeof item, "string", `${label} item ${index + 1} must be text`);
    const normalized = boundedText(item);
    assert.ok(normalized, `${label} item ${index + 1} must not be empty`);
    return normalized;
  });
}

export function normalizePaperReviewerResult(raw, axes) {
  assert.ok(raw && typeof raw === "object", "Reviewer result must be an object");
  assert.ok(Array.isArray(raw.axes), "Reviewer result must contain axes");
  const returnedAxes = raw.axes.map((entry) => entry?.axis);
  assert.equal(new Set(returnedAxes).size, raw.axes.length, "Reviewer returned duplicate axes");
  assert.deepEqual([...returnedAxes].sort(), [...axes].sort(), "Reviewer axis set is not exact");
  const normalizedAxes = axes.map((axis) => {
    const entry = raw.axes.find((candidate) => candidate.axis === axis);
    assert.ok(PAPER_REVIEW_STATUS.includes(entry.status), `${axis} has invalid status`);
    const confidence = Number(entry.confidence);
    assert.ok(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1);
    const rationale = boundedText(entry.rationale, 600);
    assert.ok(rationale, `${axis} has no rationale`);
    const evidence = (Array.isArray(entry.evidence) ? entry.evidence : [])
      .map((item) => normalizeEvidenceItem(item, axis))
      .slice(0, 8);
    if (entry.status === "unscorable") {
      assert.equal(entry.outcome ?? null, null, `${axis} unscorable outcome must be null`);
      assert.equal(evidence.length, 0, `${axis} unscorable result cannot claim visible evidence`);
      return {
        axis,
        status: "unscorable",
        outcome: null,
        score: null,
        confidence,
        evidence,
        rationale,
      };
    }
    assert.ok(PAPER_REVIEW_OUTCOMES.includes(entry.outcome), `${axis} has invalid outcome`);
    assert.ok(confidence >= 0.5, `${axis} confidence is below the scoring floor`);
    assert.ok(evidence.length >= 2, `${axis} needs paired visible evidence`);
    assert.ok(
      evidence.some((item) => item.imageKey === "reference"),
      `${axis} evidence omitted the paper reference`,
    );
    assert.ok(
      evidence.some((item) => item.imageKey !== "reference"),
      `${axis} evidence omitted the generated result`,
    );
    const referencePairs = new Set(
      evidence
        .filter((item) => item.imageKey === "reference")
        .map((item) => `${item.view}\0${item.pass}`),
    );
    assert.ok(
      evidence.some(
        (item) => item.imageKey !== "reference" && referencePairs.has(`${item.view}\0${item.pass}`),
      ),
      `${axis} evidence has no exact like-for-like reference/generated pair`,
    );
    return {
      axis,
      status: "scored",
      outcome: entry.outcome,
      score: OUTCOME_SCORE[entry.outcome],
      confidence,
      evidence,
      rationale,
    };
  });
  const blockingDefects = normalizeRequiredTextArray(raw.blockingDefects, "blockingDefects");
  const uncertainties = normalizeRequiredTextArray(raw.uncertainties, "uncertainties");
  return { axes: normalizedAxes, blockingDefects, uncertainties };
}

export function median(values) {
  assert.ok(values.length > 0, "Median requires values");
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) / 2)];
}

export function aggregatePaperReviewers(
  reviewers,
  axes,
  expectedRoster = PAPER_REVIEW_PROVIDER_ROSTER,
) {
  assert.equal(reviewers.length, expectedRoster.length, "Reviewer roster size drifted");
  const byProvider = new Map(reviewers.map((reviewer) => [reviewer.provider, reviewer]));
  assert.equal(byProvider.size, expectedRoster.length, "Reviewer roster has duplicate providers");
  for (const [provider, model] of expectedRoster) {
    const reviewer = byProvider.get(provider);
    assert.ok(reviewer, `Reviewer roster omitted ${provider}`);
    assert.equal(reviewer.model, model, `${provider} reviewer model drifted`);
    assert.equal(reviewer.status, "passed", `${provider} reviewer did not complete`);
    assert.equal(
      reviewer.result.blockingDefects.length,
      0,
      `${provider} reported blocking defects`,
    );
    assert.equal(reviewer.result.uncertainties.length, 0, `${provider} reported uncertainties`);
  }
  const axisMedians = Object.fromEntries(
    axes.map((axis) => {
      const entries = expectedRoster.map(([provider]) =>
        byProvider.get(provider).result.axes.find((entry) => entry.axis === axis),
      );
      assert.ok(
        entries.every((entry) => entry?.status === "scored"),
        `${axis} is unscorable`,
      );
      const values = entries.map((entry) => entry.score);
      const score = median(values);
      const wins = values.filter((value) => value === 1).length;
      const losses = values.filter((value) => value === -1).length;
      const outcome = wins >= 3 && losses === 0 ? "win" : losses === 0 ? "tie" : "loss";
      return [axis, { score, outcome, reviewerScores: values, wins, losses }];
    }),
  );
  return {
    reviewerCount: expectedRoster.length,
    axisMedians,
    passed: Object.values(axisMedians).every((entry) => entry.losses === 0),
    strictWinAxes: Object.entries(axisMedians)
      .filter(([, entry]) => entry.outcome === "win")
      .map(([axis]) => axis),
  };
}

export function aggregatePaperSuite(caseReviews, axes, strictWinAxesRequired) {
  assert.equal(caseReviews.length, PAPER_REVIEW_MAX_CASES, "Suite requires all eleven cases");
  const axisMedians = Object.fromEntries(
    axes.map((axis) => {
      const caseScores = caseReviews.map((review) => review.aggregate.axisMedians[axis].score);
      const score = median(caseScores);
      const wins = caseReviews.filter(
        (review) => review.aggregate.axisMedians[axis].outcome === "win",
      ).length;
      const losses = caseReviews.filter(
        (review) => review.aggregate.axisMedians[axis].outcome === "loss",
      ).length;
      return [
        axis,
        {
          score,
          outcome: wins >= 6 && losses === 0 ? "win" : losses === 0 ? "tie" : "loss",
          wins,
          losses,
        },
      ];
    }),
  );
  const strictWinAxes = Object.entries(axisMedians)
    .filter(([, result]) => result.outcome === "win")
    .map(([axis]) => axis);
  const everyCaseAndAxisNonLosing = caseReviews.every((review) =>
    Object.values(review.aggregate.axisMedians).every((axis) => axis.losses === 0),
  );
  return {
    caseCount: caseReviews.length,
    axisMedians,
    strictWinAxes,
    strictWinAxesRequired,
    everyCaseAndAxisNonLosing,
    passed: everyCaseAndAxisNonLosing && strictWinAxes.length >= strictWinAxesRequired,
    claimScope:
      "model-panel qualitative judgment on eleven selected WorldClaw figure pages and six preregistered axes",
  };
}

export function certificationExitStatus({ requestedCase, operationalPassed, superiority }) {
  if (requestedCase) return operationalPassed;
  return operationalPassed && superiority?.passed === true;
}

/**
 * WorldClaw server inference — real LLM planning + Imagine layout maps.
 * createServerFn entry points are client-callable; heavy deps load only in handlers.
 */

import { createServerFn } from "@tanstack/react-start";
import { paidInferenceRunMiddleware } from "./paid-inference-control";
import {
  boundaryF1WithinTolerance,
  compareMaskTransforms,
  measureMaskOverlap,
} from "./reference-metrics";
import { XAI_IMAGE_MODEL_DEFAULT } from "./model-ids";
import { WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS } from "./types";
import type {
  EnsembleArtifact,
  EnsembleEvidence,
  EnsembleProviderId,
  EnsembleProviderStatus,
  FinalRenderJudgement,
  ObjectRequirement,
  RegionSpec,
  ScenePlan,
  SceneTheme,
  TerrainCategory,
  VisualCameraReference,
  VisualContract,
  VisualStyle,
} from "./types";

const VALID_THEMES: SceneTheme[] = [
  "tropical",
  "canyon",
  "desert",
  "snow",
  "medieval",
  "volcanic",
  "island",
  "forest",
  "custom",
];

const VALID_STYLES: VisualStyle[] = [
  "realistic",
  "stylized",
  "cartoon",
  "game",
  "sci-fi",
  "fantasy",
];

export const WORLD_PROMPT_MAX_CHARS = 2_000;
const LAYOUT_PROMPT_MAX_CHARS = 2_000;
const REGION_NAME_MAX_CHARS = 80;
const REGION_ROLE_MAX_CHARS = 160;
const MAX_REGIONS = 12;
const MAX_LAYOUT_TARGET_RESOLUTION = 1_024;
const UINT8_REGION_CAPACITY = 0x100;
const MIN_LAYOUT_COMPONENT_PIXELS = 4;
const PLANNED_COMPONENT_AREA_RATIO = 0.0001;
const UNPLANNED_COMPONENT_AREA_RATIO = 0.001;
const MAX_MODEL_FRAGMENT_CHARS = 6_000;
const BENCHMARK_CASE_ID_MAX_CHARS = 120;
const BENCHMARK_CONTRACT_LIST_MAX_ITEMS = 8;
const BENCHMARK_CONTRACT_ITEM_MAX_CHARS = 120;
const BENCHMARK_REGIONAL_ROLE_COUNT = 4;

export interface BenchmarkGenerationContract {
  readonly caseId: string;
  readonly promptSha256: string;
  readonly regionalReadability: readonly [string, string, string, string];
  readonly terrainRelationships: readonly string[];
  readonly objectFamilies: readonly string[];
}

export const WORLDCLAW_COMMITTEE_DEADLINES_MS = {
  text: 150_000,
  vision: 150_000,
  image: 180_000,
} as const;

export const WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS = {
  planning: 0.82,
  layout: 0.78,
  appearance: 0.72,
} as const;

export function needsAdaptiveRepair(score: number, threshold: number): boolean {
  return !Number.isFinite(score) || score < threshold;
}

/**
 * Interactive generation keeps the first complete candidate set and exposes
 * its critique instead of spending another image round. The hash-bound paper
 * benchmark retains its preregistered repair behavior.
 */
export function shouldRunAdaptiveImageRepair(
  strictBenchmarkRun: boolean,
  score: number,
  threshold: number,
): boolean {
  return strictBenchmarkRun && needsAdaptiveRepair(score, threshold);
}

export function appearanceContractConflicts(
  providerFailures: readonly string[],
  judgeConflicts: readonly (readonly string[])[],
): string[] {
  return [...new Set([...providerFailures, ...judgeConflicts.flat()])];
}

async function strictPaidCommitteeRequired(): Promise<boolean> {
  const { benchmarkPaidInferenceEnforcementRequired } = await import("./paid-inference.server");
  return benchmarkPaidInferenceEnforcementRequired();
}

export interface WorldclawPlanningAvailability {
  mode: "committee" | "template";
  providers: Array<{
    provider: EnsembleProviderId;
    configured: boolean;
    model: string;
  }>;
}

export async function readWorldclawPlanningAvailability(): Promise<WorldclawPlanningAvailability> {
  const { hasXaiKey } = await import("./xai.server");
  const { hasGeminiKey } = await import("./gemini.server");
  const { hasOpenAIKey } = await import("./openai.server");
  const { hasClaudeKey } = await import("./claude.server");
  const { XAI_TEXT_MODEL_DEFAULT } = await import("./model-ids");
  const providers = [
    {
      provider: "xai" as const,
      configured: hasXaiKey(),
      model: process.env.XAI_TEXT_MODEL?.trim() || XAI_TEXT_MODEL_DEFAULT,
    },
    {
      provider: "gemini" as const,
      configured: hasGeminiKey(),
      model: process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash",
    },
    {
      provider: "openai" as const,
      configured: hasOpenAIKey(),
      model: process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-5.6-sol",
    },
    {
      provider: "anthropic" as const,
      configured: hasClaudeKey(),
      model: process.env.CLAUDE_MODEL?.trim() || "anthropic/claude-opus-5",
    },
  ];
  return {
    mode: providers.some((provider) => provider.configured) ? "committee" : "template",
    providers,
  };
}

export const getWorldclawPlanningAvailability = createServerFn({ method: "GET" }).handler(
  async () => readWorldclawPlanningAvailability(),
);

function assertExactCommitteeRoster(
  label: string,
  actual: readonly EnsembleProviderId[],
  expected: readonly EnsembleProviderId[],
): void {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (
    normalizedActual.length !== normalizedExpected.length ||
    normalizedActual.some((provider, index) => provider !== normalizedExpected[index])
  ) {
    throw new Error(
      `${label} requires ${normalizedExpected.join(", ")}; received ${normalizedActual.join(", ") || "none"}`,
    );
  }
}

function assertExactImageCommitteeRoster(
  label: string,
  candidates: readonly ImageCommitteeCandidate[],
): void {
  const expected = [
    `xai:${XAI_IMAGE_MODEL_DEFAULT}`,
    `gemini:${typeof process === "undefined" ? "gemini-3-pro-image" : process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3-pro-image"}`,
    `openai:${typeof process === "undefined" ? "gpt-image-2" : process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2"}`,
  ].sort();
  const actual = candidates.map((candidate) => `${candidate.provider}:${candidate.model}`).sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      `${label} requires ${expected.join(", ")}; received ${actual.join(", ") || "none"}`,
    );
  }
}

const VALID_CATS: TerrainCategory[] = [
  "ocean",
  "beach",
  "grass",
  "forest",
  "hill",
  "mountain",
  "rock",
  "desert",
  "sand",
  "canyon",
  "river",
  "snow",
  "ice",
  "lava",
  "road",
  "settlement",
  "cliff",
];

const CAT_COLORS: Record<TerrainCategory, string> = {
  ocean: "#1e5aa0",
  beach: "#e8d5a3",
  grass: "#5a9e4a",
  forest: "#2f6b35",
  hill: "#7ab05a",
  mountain: "#8a8a94",
  rock: "#9a9080",
  desert: "#d4b06a",
  sand: "#efd99a",
  canyon: "#c47a4a",
  river: "#3a8ab0",
  snow: "#f0f4f8",
  ice: "#c8e0f0",
  lava: "#5a2018",
  road: "#555558",
  settlement: "#a89060",
  cliff: "#6a6055",
};

const BASE_H: Record<TerrainCategory, number> = {
  ocean: -2.8,
  beach: 0.4,
  grass: 0.95,
  forest: 1.4,
  hill: 3.0,
  mountain: 7.5,
  rock: 4.0,
  desert: 0.95,
  sand: 0.75,
  canyon: 4.5,
  river: -1.0,
  snow: 1.8,
  ice: 0.1,
  lava: -1.2,
  road: 1.0,
  settlement: 1.1,
  cliff: 5.0,
};

/**
 * Image references already encode most of their relief through painted light,
 * shade, foliage and linework.  Reusing the procedural bases verbatim makes
 * every dark brush stroke become a several-metre ridge, so image-guided terrain
 * deliberately uses a quieter elevation vocabulary.
 */
const IMAGE_BASE_H: Record<TerrainCategory, number> = {
  ocean: -2.6,
  beach: 0.18,
  grass: 0.62,
  forest: 0.82,
  hill: 2.2,
  mountain: 4.8,
  rock: 2.7,
  desert: 0.58,
  sand: 0.36,
  canyon: 3.2,
  river: -1.15,
  snow: 1.35,
  ice: 0.02,
  lava: -1.2,
  road: 0.55,
  settlement: 0.64,
  cliff: 3.7,
};

const DEFAULT_WATER_LEVEL_METERS = -0.35;

const ROUGH: Record<TerrainCategory, number> = {
  ocean: 0.04,
  beach: 0.08,
  grass: 0.15,
  forest: 0.28,
  hill: 0.4,
  mountain: 0.75,
  rock: 0.6,
  desert: 0.22,
  sand: 0.3,
  canyon: 0.65,
  river: 0.05,
  snow: 0.35,
  ice: 0.1,
  lava: 0.25,
  road: 0.05,
  settlement: 0.08,
  cliff: 0.7,
};

interface LlmPlanRaw {
  sceneType?: string;
  theme?: string;
  visualStyle?: string;
  atmosphere?: string;
  regions?: {
    name?: string;
    category?: string;
    center?: number[];
    radius?: number;
    role?: string;
    baseElevation?: number;
    roughness?: number;
    peakStrength?: number;
  }[];
  terrainAssets?: string[];
  objectRequirements?: Record<
    string,
    { category?: string; count?: number; appearance?: string; scale?: number }[]
  >;
  spatialNotes?: string[];
  mainObjects?: string[];
  layoutPrompt?: string;
}

interface VisualContractRaw {
  terrainReliefScale?: number;
  terrainMicroDetailScale?: number;
  vegetationDensityScale?: number;
  objectDensityScale?: number;
  waterLevelMeters?: number;
  palette?: unknown[];
  dominantSilhouettes?: unknown[];
  compositionNotes?: unknown[];
  cameras?: {
    view?: string;
    azimuthDegrees?: number;
    elevationDegrees?: number;
    target?: number[];
    distanceScale?: number;
    projection?: string;
    fovDegrees?: number;
    orthographicScale?: number;
    panelCropNormalized?: number[];
    description?: string;
  }[];
  judgement?: {
    passed?: boolean;
    agreementScore?: number;
    missingSubjects?: unknown[];
    conflicts?: unknown[];
  };
}

interface FinalRenderJudgementRaw {
  passed?: boolean;
  agreementScore?: number;
  metrics?: {
    mapRegistration?: number;
    referenceAgreement?: number;
    heroObjectCoverage?: number;
    constructionFidelity?: number;
    waterIntegrity?: number;
  };
  missingSubjects?: unknown[];
  conflicts?: unknown[];
  observations?: unknown[];
}

interface FinalRenderDeterministicChecksRaw {
  objectSatisfactionRatio?: number;
  heroRequiredByKind?: Record<string, number>;
  missingHeroKinds?: unknown[];
  heroCountFailures?: unknown[];
  heroVisibilityFailures?: unknown[];
  constructionConflicts?: unknown[];
  materialFamilyMacroF1?: number;
  waterMaxMeters?: number | null;
  landMinMeters?: number | null;
  waterLevelMeters?: number;
  mapNorthUp?: boolean;
  cameraMatricesPassed?: boolean;
  compiledSlotsMatched?: boolean;
  depthPassesFinite?: boolean;
  landWaterIoU?: number;
  landIoU?: number;
  waterIoU?: number;
  shorelineBoundaryF1?: number;
  shorelineP95DistancePixels?: number;
  maskSize?: number;
  orientationSuspicious?: boolean;
  bestAlternateOrientation?: string;
  alternateOrientationImprovement?: number;
  leakageBoundaryTolerancePixels?: number;
  rawFalseWaterOnLandRatio?: number;
  falseWaterOnLandRatio?: number;
  rawMissingCanonicalWaterRatio?: number;
  missingCanonicalWaterRatio?: number;
  referenceWaterComponents?: number;
  renderedWaterComponents?: number;
  failures?: unknown[];
}

interface CommitteeCandidateScoreRaw {
  candidateId?: string;
  score?: number;
  passed?: boolean;
  observations?: unknown[];
  conflicts?: unknown[];
}

interface CommitteeCandidateJudgementRaw {
  candidates?: CommitteeCandidateScoreRaw[];
  preferredCandidateId?: string;
  observations?: unknown[];
  conflicts?: unknown[];
}

interface PlanCommitteeCandidate {
  id: string;
  provider: EnsembleProviderId;
  model: string;
  raw: LlmPlanRaw;
  plan: ScenePlan;
  layoutPrompt: string;
  artifact: EnsembleArtifact;
}

interface ImageCommitteeCandidate {
  id: string;
  provider: Exclude<EnsembleProviderId, "anthropic">;
  model: string;
  image: { b64: string; mime: string };
  artifact: EnsembleArtifact;
}

function boundedText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return (text || fallback).slice(0, max);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function assertModelFragment(label: string, value: string): void {
  if (value.length > MAX_MODEL_FRAGMENT_CHARS) {
    throw new Error(`${label} exceeds the model context budget`);
  }
}

const DEFAULT_REFERENCE_CAMERAS: VisualCameraReference[] = [
  {
    view: "isometric",
    azimuthDegrees: 45,
    elevationDegrees: 35.264,
    target: [0.5, 0.5],
    distanceScale: 1.28,
    projection: "orthographic",
    orthographicScale: 1.15,
    panelCropNormalized: [0, 0, 1 / 3, 1],
    description: "Map-conditioned orthographic isometric overview",
  },
  {
    view: "oblique",
    azimuthDegrees: 135,
    elevationDegrees: 26,
    target: [0.5, 0.5],
    distanceScale: 1.05,
    projection: "perspective",
    fovDegrees: 50,
    panelCropNormalized: [1 / 3, 0, 1 / 3, 1],
    description: "Elevated perspective composition check",
  },
  {
    view: "walk",
    azimuthDegrees: 225,
    elevationDegrees: 5,
    target: [0.5, 0.5],
    distanceScale: 0.18,
    projection: "perspective",
    fovDegrees: 58,
    panelCropNormalized: [2 / 3, 0, 1 / 3, 1],
    description: "Human eye-level material and scale check",
  },
];

function boundedStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .slice(0, maxItems)
    .map((item) => boundedText(item, maxChars))
    .filter(Boolean);
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight32(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Synchronous browser-safe SHA-256 for validator code shared with client bundles. */
function sha256Utf8(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const previous = words[index - 15]!;
      const prior = words[index - 2]!;
      const sigma0 = rotateRight32(previous, 7) ^ rotateRight32(previous, 18) ^ (previous >>> 3);
      const sigma1 = rotateRight32(prior, 17) ^ rotateRight32(prior, 19) ^ (prior >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight32(e, 6) ^ rotateRight32(e, 11) ^ rotateRight32(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight32(a, 2) ^ rotateRight32(a, 13) ^ rotateRight32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function validateContractStringList(
  value: unknown,
  label: string,
  options: { exactItems?: number; maxItems?: number },
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Benchmark ${label} must be an array of strings`);
  }
  if (options.exactItems !== undefined && value.length !== options.exactItems) {
    throw new Error(`Benchmark ${label} must contain exactly ${options.exactItems} strings`);
  }
  if (options.maxItems !== undefined && (value.length < 1 || value.length > options.maxItems)) {
    throw new Error(`Benchmark ${label} must contain 1-${options.maxItems} bounded strings`);
  }
  const normalized = value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Benchmark ${label}[${index}] must be text`);
    }
    const text = item.trim();
    if (!text || text.length > BENCHMARK_CONTRACT_ITEM_MAX_CHARS) {
      throw new Error(
        `Benchmark ${label}[${index}] must be 1-${BENCHMARK_CONTRACT_ITEM_MAX_CHARS} characters`,
      );
    }
    return text;
  });
  if (new Set(normalized.map((item) => item.toLocaleLowerCase())).size !== normalized.length) {
    throw new Error(`Benchmark ${label} entries must be distinct`);
  }
  return normalized;
}

export function validateBenchmarkGenerationContract(
  input: unknown,
  prompt: string,
): BenchmarkGenerationContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Benchmark generation contract must be an object");
  }
  if (typeof prompt !== "string") {
    throw new Error("Benchmark planning prompt must be text");
  }
  const raw = input as Record<string, unknown>;
  const caseId = typeof raw.caseId === "string" ? raw.caseId.trim() : "";
  if (
    !caseId ||
    caseId.length > BENCHMARK_CASE_ID_MAX_CHARS ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(caseId)
  ) {
    throw new Error(
      `Benchmark caseId must be a bounded ${BENCHMARK_CASE_ID_MAX_CHARS}-character identifier`,
    );
  }
  const promptSha256 = typeof raw.promptSha256 === "string" ? raw.promptSha256 : "";
  if (!/^[a-f0-9]{64}$/.test(promptSha256)) {
    throw new Error("Benchmark prompt SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (sha256Utf8(prompt) !== promptSha256) {
    throw new Error("Benchmark prompt SHA-256 does not match the planning prompt");
  }
  const regionalReadability = validateContractStringList(
    raw.regionalReadability,
    "regionalReadability",
    { exactItems: BENCHMARK_REGIONAL_ROLE_COUNT },
  );
  const terrainRelationships = validateContractStringList(
    raw.terrainRelationships,
    "terrainRelationships",
    { maxItems: BENCHMARK_CONTRACT_LIST_MAX_ITEMS },
  );
  const objectFamilies = validateContractStringList(raw.objectFamilies, "objectFamilies", {
    maxItems: BENCHMARK_CONTRACT_LIST_MAX_ITEMS,
  });

  return Object.freeze({
    caseId,
    promptSha256,
    regionalReadability: Object.freeze([...regionalReadability]) as unknown as readonly [
      string,
      string,
      string,
      string,
    ],
    terrainRelationships: Object.freeze([...terrainRelationships]),
    objectFamilies: Object.freeze([...objectFamilies]),
  });
}

function unitScore(value: unknown, fallback = 0): number {
  return Math.min(1, Math.max(0, finiteNumber(value, fallback)));
}

function evidenceId(
  stage: EnsembleArtifact["stage"],
  iteration: number,
  provider: EnsembleProviderId,
  suffix: string,
): string {
  return `${stage}-i${iteration}-${provider}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 120);
}

function committeeArtifact(input: {
  id: string;
  iteration: number;
  stage: EnsembleArtifact["stage"];
  provider: EnsembleProviderId;
  model: string;
  requestedModel?: string;
  responseId?: string;
  identityAttestation?: "provider-response" | "request-only" | "unattested";
  role: string;
  status?: EnsembleArtifact["status"];
  imageDataUrl?: string;
  structuredOutput?: string;
  parentArtifactIds?: string[];
  score?: number;
  passed?: boolean;
  metrics?: Record<string, number>;
  observations?: string[];
  conflicts?: string[];
  error?: string;
}): EnsembleArtifact {
  return {
    id: boundedText(input.id, 120),
    iteration: Math.min(8, Math.max(1, Math.round(input.iteration))),
    stage: input.stage,
    provider: input.provider,
    model: boundedText(input.model, 160, "unknown"),
    requestedModel: input.requestedModel
      ? boundedText(input.requestedModel, 160, "unknown")
      : undefined,
    responseId: input.responseId
      ? boundedText(
          input.responseId,
          WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.responseIdentifierCharacters,
        )
      : undefined,
    identityAttestation: input.identityAttestation,
    role: boundedText(input.role, 240, input.stage),
    status: input.status ?? "candidate",
    imageDataUrl: input.imageDataUrl?.slice(0, 5_500_000),
    structuredOutput: boundedStructuredOutput(input.structuredOutput),
    parentArtifactIds: (input.parentArtifactIds ?? []).slice(0, 12),
    score: input.score === undefined ? undefined : unitScore(input.score),
    passed: input.passed,
    metrics: Object.fromEntries(
      Object.entries(input.metrics ?? {})
        .slice(0, 24)
        .filter(([, value]) => Number.isFinite(value)),
    ),
    observations: (input.observations ?? []).slice(0, 12).map((value) => value.slice(0, 600)),
    conflicts: (input.conflicts ?? []).slice(0, 12).map((value) => value.slice(0, 600)),
    error: input.error?.slice(0, 600),
  };
}

function committeeCallIdentity(call: {
  requestedModel: string;
  responseId?: string;
  identityAttestation: "provider-response" | "request-only" | "unattested";
}): Pick<EnsembleArtifact, "requestedModel" | "responseId" | "identityAttestation"> {
  return {
    requestedModel: call.requestedModel,
    responseId: call.responseId,
    identityAttestation: call.identityAttestation,
  };
}

function boundedStructuredOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/data:image\//i.test(text)) {
    throw new Error("Structured committee output cannot retain inline image data");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Structured committee output must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Structured committee output must be a JSON object");
  }
  const normalized = JSON.stringify(parsed);
  if (normalized.length > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputCharacters) {
    throw new Error(
      `Structured committee output exceeds ${WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputCharacters} characters`,
    );
  }
  return normalized;
}

function deterministicPlanScore(plan: ScenePlan): number {
  const requirementCount = Object.values(plan.objectRequirements).reduce(
    (sum, requirements) => sum + requirements.length,
    0,
  );
  const namedRegions = new Set(plan.regions.map((region) => region.name));
  const orphanRequirementKeys = Object.keys(plan.objectRequirements).filter(
    (name) => !namedRegions.has(name),
  ).length;
  const regionScore = plan.regions.length >= 5 && plan.regions.length <= 9 ? 1 : 0.65;
  const requirementScore = Math.min(1, requirementCount / Math.max(3, plan.regions.length * 0.6));
  const layoutScore = plan.regions.every(
    (region) =>
      region.center.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
      Number.isFinite(region.radius),
  )
    ? 1
    : 0;
  return unitScore(
    regionScore * 0.32 +
      requirementScore * 0.32 +
      layoutScore * 0.24 +
      (orphanRequirementKeys === 0 ? 0.12 : 0),
  );
}

const EXACT_COUNT_WORDS = new Map<string, number>([
  ["single", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);

const HARBOR_VOCABULARY = /\b(?:fishing\s+cove|harbou?r|marina|port|quay|wharf|dockyard)\b/i;
const TOWN_VOCABULARY = /\btowns?\b/i;
const MULTIPLE_TOWNS_VOCABULARY =
  /\b(?:(?:multiple|several|various|distinct|separate|scattered|distributed)\s+(?:[a-z-]+\s+){0,3}towns|towns\s+(?:scattered|distributed|separated))\b/i;
const SCATTERED_TOWNS_VOCABULARY = /\b(?:scattered|distributed|separated|distinct)\b/i;
const NON_TOWN_VOCABULARY = /\bnon[- ]town\b/i;
const WATER_BASIN_CATEGORIES = new Set<TerrainCategory>(["ocean", "river"]);
const DRY_HARBOR_CATEGORIES = new Set<TerrainCategory>([
  "beach",
  "sand",
  "road",
  "rock",
  "grass",
  "hill",
  "cliff",
]);
const UNDERLAY_VOCABULARY =
  /\b(?:underlay|base\s+layer|substrate|background\s+terrain|non[- ]competing|beneath|foundation\s+layer)\b/i;
const BROAD_BASE_VOCABULARY =
  /\b(?:main\s+island|island\s+(?:body|interior)|landmass|uplands?|base(?:\s+terrain)?|ground|terrain)\b/i;

function planRegionVocabulary(region: RegionSpec): string {
  return `${region.name} ${region.role}`;
}

function isSemanticTownRegion(region: RegionSpec): boolean {
  if (region.category === "settlement") return true;
  const vocabulary = planRegionVocabulary(region);
  return TOWN_VOCABULARY.test(vocabulary) && !NON_TOWN_VOCABULARY.test(vocabulary);
}

function exactPromptCount(prompt: string, noun: string): number | undefined {
  const candidates: { count: number; distance: number; index: number }[] = [];
  const nounExpression = new RegExp(`\\b${noun}s?\\b`, "gi");
  for (const nounMatch of prompt.matchAll(nounExpression)) {
    const precedingWords = [
      ...prompt.slice(0, nounMatch.index).matchAll(/\b(?:[a-z][a-z'-]*|\d{1,2})\b/gi),
    ].slice(-4);
    for (let index = precedingWords.length - 1; index >= 0; index--) {
      const token = precedingWords[index]?.[0].toLocaleLowerCase();
      if (!token) continue;
      const numeric = Number(token);
      const count = Number.isFinite(numeric) ? numeric : EXACT_COUNT_WORDS.get(token);
      if (count === undefined) continue;
      candidates.push({
        count,
        distance: precedingWords.length - 1 - index,
        index: nounMatch.index,
      });
      break;
    }
  }
  candidates.sort((left, right) => left.distance - right.distance || right.index - left.index);
  return candidates[0]?.count;
}

function regionRequirementTotal(
  plan: ScenePlan,
  region: RegionSpec,
  categories: readonly string[],
): number {
  const allowed = new Set(categories.map((category) => category.toLocaleLowerCase()));
  return (plan.objectRequirements[region.name] ?? []).reduce(
    (sum, requirement) =>
      allowed.has(requirement.category.toLocaleLowerCase()) ? sum + requirement.count : sum,
    0,
  );
}

function regionTownStructureCount(plan: ScenePlan, region: RegionSpec): number {
  return (plan.objectRequirements[region.name] ?? []).reduce((sum, requirement) => {
    return /\b(?:buildings?|houses?|huts?|barns?|markets?|watchtowers?)\b/i.test(
      requirement.category,
    )
      ? sum + requirement.count
      : sum;
  }, 0);
}

function minimumPromptTownCount(prompt: string): number | undefined {
  const exact = exactPromptCount(prompt, "town");
  if (exact !== undefined) return exact;
  if (MULTIPLE_TOWNS_VOCABULARY.test(prompt)) return 2;
  return undefined;
}

function regionsTouch(left: RegionSpec, right: RegionSpec): boolean {
  const dx = left.center[0] - right.center[0];
  const dy = left.center[1] - right.center[1];
  return Math.hypot(dx, dy) <= left.radius + right.radius + 0.04;
}

const SEMANTIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "around",
  "at",
  "by",
  "for",
  "from",
  "in",
  "including",
  "of",
  "on",
  "the",
  "through",
  "to",
  "with",
  "style",
]);

const SEMANTIC_TOKEN_ALIASES = new Map<string, string>([
  ["town", "settlement"],
  ["village", "settlement"],
  ["residential", "settlement"],
  ["district", "settlement"],
  ["precinct", "settlement"],
  ["quarter", "settlement"],
  ["coastal", "waterside"],
  ["coast", "waterside"],
  ["coastline", "waterside"],
  ["shore", "waterside"],
  ["shoreline", "waterside"],
  ["waterfront", "waterside"],
  ["riverbank", "waterside"],
  ["bank", "waterside"],
  ["hilltop", "hill"],
  ["hillside", "hill"],
  ["upland", "hill"],
  ["foothill", "hill"],
  ["slope", "hill"],
  ["temple", "shrine"],
  ["pagoda", "shrine"],
  ["torii", "shrine"],
  ["vegetated", "vegetation"],
  ["forest", "vegetation"],
  ["forested", "vegetation"],
  ["grove", "vegetation"],
  ["woodland", "vegetation"],
  ["jungle", "vegetation"],
  ["tree", "vegetation"],
  ["cedar", "vegetation"],
  ["bamboo", "vegetation"],
  ["sakura", "vegetation"],
  ["harbour", "harbor"],
  ["marina", "harbor"],
  ["port", "harbor"],
  ["anchorage", "harbor"],
  ["mooring", "harbor"],
  ["vessel", "ship"],
  ["boat", "ship"],
  ["fortification", "fortified"],
  ["fortress", "fortified"],
  ["defensive", "fortified"],
  ["defense", "fortified"],
  ["stronghold", "fortified"],
  ["communications", "communication"],
  ["comms", "communication"],
  ["antenna", "communication"],
  ["satellite", "communication"],
  ["radar", "communication"],
  ["mountainous", "mountain"],
  ["alpine", "mountain"],
  ["snowy", "snow"],
  ["icy", "frozen"],
  ["stream", "river"],
  ["waterway", "river"],
  ["bridge", "crossing"],
  ["ford", "crossing"],
  ["plain", "grassland"],
  ["meadow", "grassland"],
  ["pasture", "grassland"],
  ["sandy", "desert"],
  ["arid", "desert"],
  ["channel", "flow"],
  ["tiered", "terraced"],
  ["layer", "level"],
  ["formation", "landform"],
  ["rocky", "rock"],
  ["crystal", "gemstone"],
  ["deposit", "gemstone"],
  ["seam", "gemstone"],
  ["quarry", "pit"],
  ["excavation", "pit"],
  ["facility", "facility"],
  ["outpost", "facility"],
  ["compound", "facility"],
  ["station", "facility"],
  ["base", "facility"],
  ["depot", "staging"],
  ["yard", "staging"],
  ["path", "route"],
  ["corridor", "route"],
  ["rim", "edge"],
]);

function singularSemanticToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("sses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function semanticConcepts(value: string): Set<string> {
  const concepts = new Set<string>();
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
  for (const match of normalized.matchAll(/[a-z0-9]+/g)) {
    const token = singularSemanticToken(match[0]);
    if (!token || SEMANTIC_STOP_WORDS.has(token)) continue;
    concepts.add(SEMANTIC_TOKEN_ALIASES.get(token) ?? token);
  }
  return concepts;
}

function allSemanticConceptsMatch(requiredText: string, candidateText: string): boolean {
  const required = semanticConcepts(requiredText);
  if (required.size === 0) return false;
  const candidate = semanticConcepts(candidateText);
  return [...required].every((concept) => candidate.has(concept));
}

function regionSemanticVocabulary(plan: ScenePlan, region: RegionSpec): string {
  const requirements = (plan.objectRequirements[region.name] ?? [])
    .map((requirement) => `${requirement.category} ${requirement.appearance ?? ""}`)
    .join(" ");
  return `${region.name} ${region.role} ${region.category} ${requirements}`;
}

interface BenchmarkRegionalAssignment {
  roleToRegion: Map<number, number>;
  candidateRegions: number[][];
}

function assignBenchmarkRegionalRoles(
  plan: ScenePlan,
  roles: readonly string[],
): BenchmarkRegionalAssignment {
  const candidateRegions = roles.map((role) =>
    plan.regions
      .map((region, index) =>
        allSemanticConceptsMatch(role, regionSemanticVocabulary(plan, region)) ? index : -1,
      )
      .filter((index) => index >= 0),
  );
  const regionToRole = new Map<number, number>();
  const assign = (roleIndex: number, visited: Set<number>): boolean => {
    for (const regionIndex of candidateRegions[roleIndex] ?? []) {
      if (visited.has(regionIndex)) continue;
      visited.add(regionIndex);
      const incumbent = regionToRole.get(regionIndex);
      if (incumbent === undefined || assign(incumbent, visited)) {
        regionToRole.set(regionIndex, roleIndex);
        return true;
      }
    }
    return false;
  };
  for (let roleIndex = 0; roleIndex < roles.length; roleIndex++) {
    assign(roleIndex, new Set());
  }
  return {
    roleToRegion: new Map(
      [...regionToRole].map(([regionIndex, roleIndex]) => [roleIndex, regionIndex]),
    ),
    candidateRegions,
  };
}

interface PlanObjectEvidence {
  category?: string;
  appearance?: string;
  count: number;
  text: string;
  concepts: Set<string>;
  source: "requirement" | "mainObject";
}

function planObjectEvidence(plan: ScenePlan): PlanObjectEvidence[] {
  const requirements = Object.values(plan.objectRequirements)
    .flat()
    .map((requirement) => {
      const text = `${requirement.category} ${requirement.appearance ?? ""}`.trim();
      return {
        category: singularSemanticToken(requirement.category.toLocaleLowerCase()),
        appearance: requirement.appearance,
        count: requirement.count,
        text,
        concepts: semanticConcepts(text),
        source: "requirement" as const,
      };
    });
  const mainObjects = plan.mainObjects.map((text) => ({
    count: 1,
    text,
    concepts: semanticConcepts(text),
    source: "mainObject" as const,
  }));
  return [...requirements, ...mainObjects];
}

function objectEvidenceHasKind(evidence: PlanObjectEvidence, kinds: readonly string[]): boolean {
  if (evidence.category && kinds.includes(evidence.category)) return true;
  return kinds.some((kind) =>
    [...semanticConcepts(kind)].some((concept) => evidence.concepts.has(concept)),
  );
}

function objectEvidenceHasAny(evidence: PlanObjectEvidence, concepts: readonly string[]): boolean {
  return concepts.some((candidate) =>
    [...semanticConcepts(candidate)].some((concept) => evidence.concepts.has(concept)),
  );
}

interface ObjectFamilyAssessment {
  supported: boolean;
  satisfied: boolean;
}

const SUPPORTED_OBJECT_KINDS = [
  "hut",
  "house",
  "tower",
  "dock",
  "ship",
  "tree",
  "palm",
  "pine",
  "rock",
  "boulder",
  "cactus",
  "vehicle",
  "tank",
  "building",
  "antenna",
  "fence",
  "campfire",
  "tent",
  "bridge",
  "statue",
  "crystal",
  "mine",
  "dragon",
  "windmill",
  "well",
  "crate",
  "watchtower",
  "satellite",
  "bunker",
  "boat",
  "pagoda",
  "torii",
  "barn",
  "market",
] as const;

function assessObjectFamily(
  family: string,
  evidence: readonly PlanObjectEvidence[],
): ObjectFamilyAssessment {
  const key = family
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const hasKind = (kinds: readonly string[]) =>
    evidence.some((entry) => objectEvidenceHasKind(entry, kinds));
  const hasAuthoredKind = (kinds: readonly string[], cues: readonly string[]) =>
    evidence.some(
      (entry) =>
        objectEvidenceHasKind(entry, kinds) &&
        (entry.source === "mainObject" || Boolean(entry.appearance)) &&
        objectEvidenceHasAny(entry, cues),
    );
  const explicitMainObject = evidence.some(
    (entry) => entry.source === "mainObject" && allSemanticConceptsMatch(family, entry.text),
  );
  const result = (satisfied: boolean): ObjectFamilyAssessment => ({
    supported: true,
    satisfied: satisfied || explicitMainObject,
  });

  switch (key) {
    case "dense tropical vegetation":
      return result(
        evidence.some(
          (entry) =>
            objectEvidenceHasKind(entry, ["palm"]) ||
            (objectEvidenceHasKind(entry, ["tree", "pine"]) &&
              entry.count >= 4 &&
              objectEvidenceHasAny(entry, ["dense", "tropical", "jungle", "palm"])),
        ),
      );
    case "settlements":
      return result(hasKind(["hut", "house", "building", "barn", "market"]));
    case "docks":
      return result(hasKind(["dock"]));
    case "ships":
      return result(hasKind(["ship", "boat"]));
    case "tribal huts":
      return result(
        hasAuthoredKind(["hut", "house"], ["tribal", "primitive", "thatch", "vernacular"]),
      );
    case "village props":
    case "town props":
      return result(hasKind(["well", "fence", "campfire", "crate", "market"]));
    case "vegetation":
      return result(hasKind(["tree", "palm", "pine", "cactus"]));
    case "bridges":
      return result(hasKind(["bridge"]));
    case "buildings":
      return result(hasKind(["hut", "house", "building", "barn", "bunker"]));
    case "defensive structures":
      return result(hasKind(["bunker", "watchtower", "tower", "fence", "tank"]));
    case "watchtowers":
      return result(hasKind(["watchtower", "tower"]));
    case "vehicles":
      return result(hasKind(["vehicle", "tank"]));
    case "futuristic facilities":
      return result(
        hasAuthoredKind(
          ["building", "bunker"],
          ["futuristic", "high", "tech", "scifi", "industrial"],
        ),
      );
    case "communication structures":
      return result(hasKind(["antenna", "satellite", "tower"]));
    case "village buildings":
    case "village structures":
      return result(hasKind(["hut", "house", "building", "barn", "market", "well"]));
    case "windmills":
      return result(hasKind(["windmill"]));
    case "timber houses":
      return result(hasAuthoredKind(["hut", "house", "building"], ["timber", "wood", "log"]));
    case "wells":
      return result(hasKind(["well"]));
    case "snow vegetation":
      return result(
        hasKind(["pine"]) ||
          hasAuthoredKind(["tree"], ["snow", "frozen", "frost", "conifer", "spruce"]),
      );
    case "tents":
      return result(hasKind(["tent"]));
    case "massive dragons":
      return result(
        hasAuthoredKind(["dragon"], ["massive", "giant", "colossal", "large", "coiling"]),
      );
    case "japanese houses":
      return result(
        evidence.some((entry) => {
          if (!objectEvidenceHasKind(entry, ["hut", "house", "building"])) return false;
          if (entry.source !== "mainObject" && !entry.appearance) return false;
          return (
            objectEvidenceHasAny(entry, ["japanese", "machiya", "shoji"]) ||
            (entry.concepts.has("timber") &&
              objectEvidenceHasAny(entry, ["tile", "slate", "plaster"]))
          );
        }),
      );
    case "shrines":
      return result(
        hasKind(["pagoda", "torii"]) || evidence.some((entry) => entry.concepts.has("shrine")),
      );
    case "demonic structures":
      return result(
        hasAuthoredKind(
          ["building", "bunker", "statue"],
          ["demon", "demonic", "infernal", "hell", "lair"],
        ),
      );
    case "ritual monuments":
      return result(hasAuthoredKind(["statue"], ["ritual", "monument", "demon", "altar"]));
    case "fortifications":
      return result(hasKind(["bunker", "fence", "watchtower", "tower"]));
    case "lava props":
      return result(
        hasAuthoredKind(["statue", "campfire", "rock"], ["lava", "molten", "volcanic"]),
      );
    case "gemstone deposits":
      return result(hasKind(["crystal"]));
    case "excavation equipment":
      return result(
        hasAuthoredKind(["vehicle", "tank"], ["excavator", "excavation", "digger", "mining"]),
      );
    case "mine structures":
      return result(hasKind(["mine"]) || hasAuthoredKind(["building"], ["mine", "mining"]));
    case "construction machinery":
      return result(
        hasAuthoredKind(
          ["vehicle", "tank"],
          ["construction", "machinery", "excavator", "excavation"],
        ),
      );
    case "round door hillside homes":
      return result(
        evidence.some(
          (entry) =>
            objectEvidenceHasKind(entry, ["hut", "house", "building"]) &&
            (entry.source === "mainObject" || Boolean(entry.appearance)) &&
            objectEvidenceHasAny(entry, ["round", "circular"]) &&
            objectEvidenceHasAny(entry, ["hill", "hobbit", "earth", "burrow"]),
        ),
      );
    case "waterfront props":
      return result(hasKind(["dock", "crate", "boat", "ship"]));
    case "animals":
    case "animal":
    case "wildlife":
    case "livestock":
      return { supported: false, satisfied: false };
  }

  const familyConcepts = semanticConcepts(family);
  const supportedConcepts = new Set(
    SUPPORTED_OBJECT_KINDS.flatMap((kind) => [...semanticConcepts(kind)]),
  );
  const supported = [...familyConcepts].some((concept) => supportedConcepts.has(concept));
  return {
    supported,
    satisfied:
      supported &&
      evidence.some((entry) => [...familyConcepts].every((concept) => entry.concepts.has(concept))),
  };
}

function planTerrainClauses(plan: ScenePlan): string[] {
  return [
    ...plan.regions.map((region) => regionSemanticVocabulary(plan, region)),
    ...plan.spatialNotes,
    ...plan.terrainAssets,
  ];
}

function settlementRegionsAreSeparated(regions: readonly RegionSpec[]): boolean {
  if (regions.length < 2) return false;
  for (let left = 0; left < regions.length; left++) {
    for (let right = left + 1; right < regions.length; right++) {
      const a = regions[left]!;
      const b = regions[right]!;
      const distance = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
      const requiredSeparation = Math.max(0.12, Math.min(0.22, (a.radius + b.radius) * 0.6));
      if (distance < requiredSeparation) return false;
    }
  }
  return true;
}

function terrainRelationshipSatisfied(relationship: string, plan: ScenePlan): boolean {
  const key = relationship
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const waterRegions = plan.regions.filter((region) => WATER_BASIN_CATEGORIES.has(region.category));
  const settlementRegions = plan.regions.filter(isSemanticTownRegion);
  const clauses = planTerrainClauses(plan);
  const explicitClause = clauses.some((clause) => allSemanticConceptsMatch(relationship, clause));

  switch (key) {
    case "multiple separated settlements":
      return settlementRegionsAreSeparated(settlementRegions);
    case "two populated riverbanks": {
      const leftBank = settlementRegions.some((region) =>
        allSemanticConceptsMatch("left waterside", regionSemanticVocabulary(plan, region)),
      );
      const rightBank = settlementRegions.some((region) =>
        allSemanticConceptsMatch("right waterside", regionSemanticVocabulary(plan, region)),
      );
      return plan.regions.some((region) => region.category === "river") && leftBank && rightBank;
    }
    case "substantial elevation changes": {
      const elevations = plan.regions.map((region) => region.baseElevation);
      return elevations.length > 1 && Math.max(...elevations) - Math.min(...elevations) >= 2;
    }
    case "bodies of water":
    case "water":
      return waterRegions.length > 0;
    case "mountainous landscape":
      return plan.regions.some((region) => region.category === "mountain");
    case "desert region":
      return plan.regions.some(
        (region) => region.category === "desert" || region.category === "sand",
      );
    case "multiple functional regions":
      return (
        plan.regions.filter(
          (region) =>
            (plan.objectRequirements[region.name]?.length ?? 0) > 0 ||
            semanticConcepts(region.role).size >= 2,
        ).length >= 4
      );
    case "central lair":
      return plan.regions.some(
        (region) =>
          semanticConcepts(regionSemanticVocabulary(plan, region)).has("lair") &&
          Math.hypot(region.center[0] - 0.5, region.center[1] - 0.5) <= 0.28,
      );
    default:
      return explicitClause;
  }
}

function benchmarkPlanConflicts(plan: ScenePlan, contract: BenchmarkGenerationContract): string[] {
  const conflicts: string[] = [];
  const assignment = assignBenchmarkRegionalRoles(plan, contract.regionalReadability);
  if (assignment.roleToRegion.size !== contract.regionalReadability.length) {
    const unmatched = contract.regionalReadability
      .map((role, index) => ({ role, index }))
      .filter(({ index }) => !assignment.roleToRegion.has(index));
    const diagnostics = unmatched.map(({ role, index }) => {
      const candidates = (assignment.candidateRegions[index] ?? []).map(
        (regionIndex) => plan.regions[regionIndex]?.name ?? `region ${regionIndex}`,
      );
      return `"${role}"=>${candidates.join("/") || "no semantic match"}`;
    });
    conflicts.push(
      `Benchmark requires all four regional roles (${contract.regionalReadability.map((role) => `"${role}"`).join(", ")}) to map one-to-one to 4 distinct semantic regions; matched ${assignment.roleToRegion.size}/4. Missing or region-reused assignments: ${diagnostics.join(", ")}.`,
    );
  }

  const objectEvidence = planObjectEvidence(plan);
  for (const family of contract.objectFamilies) {
    const assessment = assessObjectFamily(family, objectEvidence);
    if (!assessment.supported) {
      conflicts.push(
        `Benchmark object family "${family}" is unsupported by the explicit WorldClaw object ontology; planning fails closed.`,
      );
    } else if (!assessment.satisfied) {
      conflicts.push(
        `Benchmark object family "${family}" is missing from explicit objectRequirements/mainObjects or lacks identifying appearance vocabulary.`,
      );
    }
  }

  for (const relationship of contract.terrainRelationships) {
    if (!terrainRelationshipSatisfied(relationship, plan)) {
      conflicts.push(
        `Benchmark terrain relationship "${relationship}" is not demonstrated by a complete deterministic predicate or explicit multi-token plan statement.`,
      );
    }
  }
  return conflicts;
}

interface PlanFeasibilityAssessment {
  passed: boolean;
  criticalConflicts: string[];
}

/**
 * Machine-authoritative planning invariants. Model-judge prose is useful
 * critique, but it cannot waive prompt counts or make an unbuildable mixed
 * land/water region feasible merely by assigning it a high score.
 */
function assessPlanFeasibility(
  prompt: string,
  plan: ScenePlan,
  benchmarkContract?: BenchmarkGenerationContract,
): PlanFeasibilityAssessment {
  const criticalConflicts: string[] = [];
  const explicitTownCount = exactPromptCount(prompt, "town");
  const minimumTownCount = minimumPromptTownCount(prompt);
  const harborRegions = plan.regions.filter((region) =>
    HARBOR_VOCABULARY.test(planRegionVocabulary(region)),
  );
  const semanticTownRegions = plan.regions.filter(isSemanticTownRegion);

  if (explicitTownCount !== undefined && semanticTownRegions.length !== explicitTownCount) {
    criticalConflicts.push(
      `Prompt requires exactly ${explicitTownCount} town regions; normalized plan defines ${semanticTownRegions.length} settlement/town regions (${semanticTownRegions.map((region) => region.name).join(", ") || "none"}).`,
    );
  } else if (
    explicitTownCount === undefined &&
    minimumTownCount !== undefined &&
    semanticTownRegions.length < minimumTownCount
  ) {
    criticalConflicts.push(
      `Prompt requires multiple distinct town regions (at least ${minimumTownCount}); normalized plan defines ${semanticTownRegions.length} settlement/town region${semanticTownRegions.length === 1 ? "" : "s"} (${semanticTownRegions.map((region) => region.name).join(", ") || "none"}). A single broad region with internal clusters is not an auditable substitute.`,
    );
  }

  if (minimumTownCount !== undefined) {
    const programmedTowns = semanticTownRegions.filter(
      (region) => regionTownStructureCount(plan, region) > 0,
    );
    if (programmedTowns.length < minimumTownCount) {
      criticalConflicts.push(
        `Prompt requires at least ${minimumTownCount} independently buildable towns; only ${programmedTowns.length} town region${programmedTowns.length === 1 ? " has" : "s have"} an explicit house/building program.`,
      );
    }
    if (SCATTERED_TOWNS_VOCABULARY.test(prompt) && semanticTownRegions.length >= 2) {
      const crowdedPairs: string[] = [];
      for (let left = 0; left < semanticTownRegions.length; left++) {
        for (let right = left + 1; right < semanticTownRegions.length; right++) {
          const a = semanticTownRegions[left]!;
          const b = semanticTownRegions[right]!;
          const distance = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
          const requiredSeparation = Math.max(0.12, Math.min(0.22, (a.radius + b.radius) * 0.6));
          if (distance < requiredSeparation) crowdedPairs.push(`${a.name}/${b.name}`);
        }
      }
      if (crowdedPairs.length > 0) {
        criticalConflicts.push(
          `Prompt requires scattered towns, but these town-region centers are not distinctly separated: ${crowdedPairs.join(", ")}.`,
        );
      }
    }
  }

  if (HARBOR_VOCABULARY.test(prompt)) {
    const settlementHarbors = harborRegions.filter((region) => region.category === "settlement");
    if (settlementHarbors.length > 0) {
      criticalConflicts.push(
        `Fishing harbor cannot be a settlement or third town (${settlementHarbors.map((region) => region.name).join(", ")}); keep prompt-authoritative towns separate from harbor support.`,
      );
    }

    const waterBasins = harborRegions.filter((region) =>
      WATER_BASIN_CATEGORIES.has(region.category),
    );
    const drySupports = harborRegions.filter(
      (region) =>
        DRY_HARBOR_CATEGORIES.has(region.category) &&
        region.category !== "settlement" &&
        !isSemanticTownRegion(region),
    );
    if (waterBasins.length === 0) {
      criticalConflicts.push(
        "Fishing harbor needs a distinct usable water basin region (ocean or river) for its boats.",
      );
    }
    if (drySupports.length === 0) {
      criticalConflicts.push(
        "Fishing harbor needs a separate dry non-town support region (for shore, quay, piers or docks).",
      );
    }

    const requiredBoatCount = exactPromptCount(prompt, "boat");
    if (waterBasins.length > 0) {
      const basinBoatCount = waterBasins.reduce(
        (sum, region) => sum + regionRequirementTotal(plan, region, ["boat", "ship"]),
        0,
      );
      if (requiredBoatCount !== undefined && basinBoatCount !== requiredBoatCount) {
        criticalConflicts.push(
          `Prompt requires exactly ${requiredBoatCount} harbor boats in the water basin; normalized plan assigns ${basinBoatCount}.`,
        );
      } else if (
        requiredBoatCount === undefined &&
        basinBoatCount === 0 &&
        /\bboats?\b/i.test(prompt)
      ) {
        criticalConflicts.push(
          "Prompt-required harbor boats must be assigned to the usable water basin, not its dry support.",
        );
      }
    }

    if (
      waterBasins.length > 0 &&
      drySupports.length > 0 &&
      !waterBasins.some((basin) => drySupports.some((support) => regionsTouch(basin, support)))
    ) {
      criticalConflicts.push(
        "Fishing harbor water basin and dry support are spatially disconnected; make one adjacent buildable harbor pair.",
      );
    }
  }

  for (const candidate of plan.regions) {
    const vocabulary = planRegionVocabulary(candidate);
    if (
      WATER_BASIN_CATEGORIES.has(candidate.category) ||
      candidate.radius < 0.28 ||
      !(BROAD_BASE_VOCABULARY.test(vocabulary) || candidate.radius >= 0.4)
    ) {
      continue;
    }
    const coveredSemanticRegions = plan.regions.filter((region) => {
      if (region === candidate || WATER_BASIN_CATEGORIES.has(region.category)) return false;
      const dx = region.center[0] - candidate.center[0];
      const dy = region.center[1] - candidate.center[1];
      return Math.hypot(dx, dy) <= candidate.radius;
    });
    if (coveredSemanticRegions.length >= 2 && !UNDERLAY_VOCABULARY.test(vocabulary)) {
      criticalConflicts.push(
        `Broad base region ${candidate.name} overlaps ${coveredSemanticRegions.map((region) => region.name).join(", ")}; mark it as a non-competing terrain underlay or shrink/split it.`,
      );
    }
  }

  if (benchmarkContract) {
    criticalConflicts.unshift(...benchmarkPlanConflicts(plan, benchmarkContract));
  }

  const uniqueConflicts = [
    ...new Set(criticalConflicts.map((conflict) => boundedText(conflict, 600))),
  ]
    .filter(Boolean)
    .slice(0, 12);
  return { passed: uniqueConflicts.length === 0, criticalConflicts: uniqueConflicts };
}

interface PlanningAdaptiveRepairDecision extends PlanFeasibilityAssessment {
  required: boolean;
  scoreTriggered: boolean;
  feasibilityTriggered: boolean;
}

export function planningAdaptiveRepairDecision(
  consensusScore: number,
  prompt: string,
  plan: ScenePlan,
  benchmarkContract?: BenchmarkGenerationContract,
): PlanningAdaptiveRepairDecision {
  const assessment = assessPlanFeasibility(prompt, plan, benchmarkContract);
  const scoreTriggered = needsAdaptiveRepair(
    consensusScore,
    WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS.planning,
  );
  const feasibilityTriggered = !assessment.passed;
  return {
    ...assessment,
    required: scoreTriggered || feasibilityTriggered,
    scoreTriggered,
    feasibilityTriggered,
  };
}

export function normalizeCommitteeJudgement(
  raw: CommitteeCandidateJudgementRaw,
  candidateIds: readonly string[],
): {
  scores: Map<string, CommitteeCandidateScoreRaw & { score: number }>;
  preferredCandidateId?: string;
  observations: string[];
  conflicts: string[];
} {
  const allowed = new Set(candidateIds);
  if (allowed.size === 0 || allowed.size !== candidateIds.length) {
    throw new Error("Committee candidate roster must be non-empty and unique");
  }
  const scores = new Map<string, CommitteeCandidateScoreRaw & { score: number }>();
  const entries = Array.isArray(raw.candidates) ? raw.candidates.slice(0, 12) : [];
  for (const entry of entries) {
    const candidateId = boundedText(entry.candidateId, 120);
    if (!allowed.has(candidateId)) {
      throw new Error(`Committee scored unknown candidate ${candidateId || "(empty)"}`);
    }
    if (scores.has(candidateId)) {
      throw new Error(`Committee scored candidate ${candidateId} more than once`);
    }
    scores.set(candidateId, {
      ...entry,
      candidateId,
      score: unitScore(entry.score),
      observations: boundedStringList(entry.observations, 8, 240),
      conflicts: boundedStringList(entry.conflicts, 8, 240),
    });
  }
  if (scores.size !== candidateIds.length) {
    const missing = candidateIds.filter((candidateId) => !scores.has(candidateId));
    throw new Error(`Committee omitted candidate scores: ${missing.join(", ")}`);
  }
  const preferredCandidateId = boundedText(raw.preferredCandidateId, 120);
  if (!preferredCandidateId || !allowed.has(preferredCandidateId)) {
    throw new Error("Committee preferred candidate is missing or outside the candidate roster");
  }
  return {
    scores,
    preferredCandidateId,
    observations: boundedStringList(raw.observations, 8, 240),
    conflicts: boundedStringList(raw.conflicts, 8, 240),
  };
}

function mergeProviderStatuses(
  current: EnsembleProviderStatus[],
  next: EnsembleProviderStatus[],
): EnsembleProviderStatus[] {
  const providers: EnsembleProviderId[] = ["xai", "gemini", "openai", "anthropic"];
  return providers.map((provider) => {
    const entries = [...current, ...next].filter((entry) => entry.provider === provider);
    const latest = entries.at(-1);
    const available = entries.some((entry) => entry.available);
    const skipped = entries.length > 0 && entries.every((entry) => entry.skipped === true);
    return {
      provider,
      configured: entries.some((entry) => entry.configured),
      authenticated: entries.some((entry) => entry.authenticated),
      available,
      model: latest?.model ?? "not configured",
      skipped,
      error: available ? undefined : latest?.error,
    };
  });
}

export function mergeEnsembleEvidence(
  ...evidenceItems: Array<EnsembleEvidence | undefined>
): EnsembleEvidence | undefined {
  const items = evidenceItems.filter((item): item is EnsembleEvidence => Boolean(item));
  if (items.length === 0) return undefined;
  const providers = items.reduce<EnsembleProviderStatus[]>(
    (merged, item) => mergeProviderStatuses(merged, item.providers),
    [],
  );
  const artifacts = boundEnsembleArtifacts(items.flatMap((item) => item.artifacts).slice(-128));
  const selections = items
    .map((item) => item.selection)
    .filter((selection): selection is NonNullable<EnsembleEvidence["selection"]> =>
      Boolean(selection),
    );
  const latestSelection = selections.at(-1);
  const selection = latestSelection
    ? {
        chosenLayoutArtifactId: [...selections]
          .reverse()
          .find((entry) => entry.chosenLayoutArtifactId)?.chosenLayoutArtifactId,
        chosenMultiviewArtifactId: [...selections]
          .reverse()
          .find((entry) => entry.chosenMultiviewArtifactId)?.chosenMultiviewArtifactId,
        consensusScore: Math.min(...selections.map((entry) => entry.consensusScore)),
        rationale: [...new Set(selections.flatMap((entry) => entry.rationale))].slice(
          0,
          WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.rationaleItems,
        ),
      }
    : undefined;
  return {
    providers,
    artifacts,
    selection,
    completedIterations: Math.max(...items.map((item) => item.completedIterations)),
    maxIterations: Math.max(...items.map((item) => item.maxIterations)),
  };
}

function boundEnsembleArtifacts(artifacts: EnsembleArtifact[]): EnsembleArtifact[] {
  let imageCount = 0;
  let imageCharacters = 0;
  let structuredOutputCount = 0;
  let structuredOutputCharacters = 0;
  return artifacts.slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.artifacts).map((artifact) => {
    let boundedArtifact = artifact;
    if (artifact.structuredOutput) {
      const nextStructuredCharacters =
        structuredOutputCharacters + artifact.structuredOutput.length;
      if (
        structuredOutputCount >= WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputArtifacts ||
        nextStructuredCharacters >
          WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputCharactersTotal
      ) {
        boundedArtifact = {
          ...boundedArtifact,
          structuredOutput: undefined,
          observations: [
            ...boundedArtifact.observations,
            "Structured output omitted from the retained world payload by the evidence budget",
          ].slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.observationsPerArtifact),
        };
      } else {
        structuredOutputCount += 1;
        structuredOutputCharacters = nextStructuredCharacters;
      }
    }
    if (!boundedArtifact.imageDataUrl) return boundedArtifact;
    const nextCharacters = imageCharacters + boundedArtifact.imageDataUrl.length;
    if (
      imageCount >= WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageArtifacts ||
      nextCharacters > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageDataUrlCharactersTotal
    ) {
      return {
        ...boundedArtifact,
        imageDataUrl: undefined,
        observations: [
          ...boundedArtifact.observations,
          "Image preview omitted from the retained world payload by the evidence budget",
        ].slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.observationsPerArtifact),
      };
    }
    imageCount += 1;
    imageCharacters = nextCharacters;
    return boundedArtifact;
  });
}

function compatibleInlineImage(image: { b64: string; mime: string }): {
  b64: string;
  mime: "image/png" | "image/jpeg";
} {
  const mime = image.mime.toLowerCase() === "image/jpg" ? "image/jpeg" : image.mime.toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg") {
    throw new Error(`Committee image must be PNG or JPEG, received ${mime}`);
  }
  return { b64: image.b64, mime };
}

function inlineImageDataUrl(image: { b64: string; mime: string }): string {
  return `data:${image.mime};base64,${image.b64}`;
}

async function evidenceImageDataUrl(image: { b64: string; mime: string }): Promise<string> {
  const { createEvidenceThumbnail } = await import("./image-compose.server");
  const thumbnail = await createEvidenceThumbnail(compatibleInlineImage(image), 640, 82);
  return inlineImageDataUrl(thumbnail);
}

async function judgeImageCandidates(input: {
  prompt: string;
  stage: "layout" | "multiview";
  iteration: number;
  role: string;
  candidates: ImageCommitteeCandidate[];
  signal: AbortSignal;
}): Promise<{
  winner: ImageCommitteeCandidate;
  consensusScore: number;
  conflicts: string[];
  observations: string[];
  artifacts: EnsembleArtifact[];
  providers: EnsembleProviderStatus[];
}> {
  const { parseJsonFromLlm } = await import("./xai.server");
  const { committeeStatuses, runVisionCommittee, runVisionCommitteeQuorum } =
    await import("./ensemble.server");
  const ids = input.candidates.map((candidate) => candidate.id);
  const dispatchRole =
    input.stage === "layout"
      ? input.iteration === 1
        ? "Canonical semantic-layout cross-model visual judge"
        : "Adaptive semantic-layout cross-model visual judge"
      : input.iteration === 1
        ? "Pre-build appearance-board cross-model visual judge"
        : "Adaptive appearance-board cross-model visual judge";
  const judgeSystem =
    input.stage === "layout"
      ? `You are a strict WorldClaw canonical-map committee member. Compare every ordered candidate against the stated world contract. Require a straight-down north-up orthographic square map, distinct requested semantic regions, exact hero cues, coherent water/land topology, no text, and no painterly ambiguity. Penalize mirroring, missing regions, duplicate heroes, procedural-looking filler, tropical substitutions, unreadable piles, and weak semantic separation. Output ONLY JSON: {"candidates":[{"candidateId":string,"score":number 0..1,"passed":boolean,"observations":string[],"conflicts":string[]}],"preferredCandidateId":string,"observations":string[],"conflicts":string[]}. Score each candidate exactly once.`
      : `You are a strict WorldClaw pre-build appearance committee member. The canonical top-down map remains the sole authority for shoreline, X/Z structure, landmark positions, and object counts. These candidates are perspective concept boards, not registered geometry. Rank them for useful three-dimensional silhouette evidence, architectural construction, material vocabulary, believable scale, terrain restraint, vegetation species, water treatment, atmosphere, and coverage of isometric, oblique, and human-eye visual roles. The same hero may be visible again across panels; do not count those repeated depictions as duplicate world objects, and do not require a distant hero to be visible in a human-eye panel. Penalize theme or species substitution, wrong construction/materials, object piles, procedural terrain spikes, flat or painterly non-buildable forms, missing requested visual vocabulary, and unreadable panels. Do not fail solely because concept-board topology differs from the canonical map; structure will be validated deterministically against the final WebGL build. Output ONLY JSON: {"candidates":[{"candidateId":string,"score":number 0..1,"passed":boolean,"observations":string[],"conflicts":string[]}],"preferredCandidateId":string,"observations":string[],"conflicts":string[]}. Score each candidate exactly once.`;
  const strictCommittee = await strictPaidCommitteeRequired();
  const visionOptions = {
    system: judgeSystem,
    user: [
      `Stage=${input.stage}; responsibility=${input.role}`,
      `World contract=${input.prompt}`,
      `Ordered image candidate IDs=${ids.join(", ")}`,
      "The inline images follow that exact order.",
    ].join("\n"),
    images: input.candidates.map((candidate) => compatibleInlineImage(candidate.image)),
    maxTokens: 10_000,
    signal: input.signal,
    timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.vision,
    dispatch: { stage: "critique", iteration: input.iteration, role: dispatchRole },
  } as const;
  const calls = strictCommittee
    ? await runVisionCommittee(visionOptions)
    : await runVisionCommitteeQuorum(visionOptions, {
        minimumUsable: 2,
        isUsable: (call) => {
          if (!call.ok || !call.value) return false;
          try {
            normalizeCommitteeJudgement(
              parseJsonFromLlm<CommitteeCandidateJudgementRaw>(call.value.text),
              ids,
            );
            return true;
          } catch {
            return false;
          }
        },
      });
  const artifacts: EnsembleArtifact[] = [];
  const scores = new Map<string, number[]>();
  const conflicts = new Map<string, string[]>();
  const observations = new Map<string, string[]>();
  const successfulJudges: EnsembleProviderId[] = [];
  for (const candidate of input.candidates) {
    scores.set(candidate.id, []);
    conflicts.set(candidate.id, []);
    observations.set(candidate.id, []);
  }
  for (const call of calls) {
    const id = evidenceId("critique", input.iteration, call.provider, `${input.stage}-judge`);
    if (!call.ok || !call.value) {
      if (call.configured) {
        artifacts.push(
          committeeArtifact({
            id,
            iteration: input.iteration,
            stage: "critique",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: `${input.role} cross-model visual judge`,
            status: "error",
            parentArtifactIds: ids,
            error: call.error,
          }),
        );
      }
      continue;
    }
    try {
      const judgement = normalizeCommitteeJudgement(
        parseJsonFromLlm<CommitteeCandidateJudgementRaw>(call.value.text),
        ids,
      );
      successfulJudges.push(call.provider);
      for (const [candidateId, score] of judgement.scores) {
        scores.get(candidateId)?.push(score.score);
        conflicts.get(candidateId)?.push(...boundedStringList(score.conflicts, 8, 240));
        observations.get(candidateId)?.push(...boundedStringList(score.observations, 8, 240));
      }
      const preferred = judgement.preferredCandidateId;
      const preferredScore = preferred ? judgement.scores.get(preferred) : undefined;
      artifacts.push(
        committeeArtifact({
          id,
          iteration: input.iteration,
          stage: "critique",
          provider: call.provider,
          model: call.model,
          ...committeeCallIdentity(call),
          role: `${input.role} cross-model visual judge`,
          parentArtifactIds: ids,
          structuredOutput: JSON.stringify({
            preferredCandidateId: judgement.preferredCandidateId,
            candidates: [...judgement.scores.entries()].map(([candidateId, entry]) => ({
              candidateId,
              ...entry,
            })),
            observations: judgement.observations,
            conflicts: judgement.conflicts,
          }),
          score: preferredScore?.score,
          passed: preferredScore?.passed === true,
          observations: judgement.observations,
          conflicts: judgement.conflicts,
        }),
      );
    } catch (error) {
      artifacts.push(
        committeeArtifact({
          id,
          iteration: input.iteration,
          stage: "critique",
          provider: call.provider,
          model: call.model,
          ...committeeCallIdentity(call),
          role: `${input.role} cross-model visual judge`,
          status: "error",
          parentArtifactIds: ids,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (strictCommittee) {
    assertExactCommitteeRoster(
      `${input.stage} visual committee iteration ${input.iteration}`,
      successfulJudges,
      ["xai", "gemini", "openai", "anthropic"],
    );
  }
  const ranked = [...input.candidates].sort((a, b) => {
    const valuesA = scores.get(a.id) ?? [];
    const valuesB = scores.get(b.id) ?? [];
    const scoreA = valuesA.length
      ? valuesA.reduce((sum, value) => sum + value, 0) / valuesA.length
      : 0;
    const scoreB = valuesB.length
      ? valuesB.reduce((sum, value) => sum + value, 0) / valuesB.length
      : 0;
    return scoreB - scoreA || a.id.localeCompare(b.id);
  });
  const winner = ranked[0]!;
  const winnerScores = scores.get(winner.id) ?? [];
  if (winnerScores.length === 0) {
    throw new Error(`Every configured ${input.role} visual judge failed`);
  }
  return {
    winner,
    consensusScore: unitScore(
      winnerScores.reduce((sum, value) => sum + value, 0) / winnerScores.length,
    ),
    conflicts: [...new Set(conflicts.get(winner.id) ?? [])].slice(0, 12),
    observations: [...new Set(observations.get(winner.id) ?? [])].slice(0, 12),
    artifacts,
    providers: committeeStatuses(calls),
  };
}

export function localVisualContract(theme: SceneTheme): VisualContract {
  return {
    source: "local-defaults",
    terrainReliefScale: 0.46,
    terrainMicroDetailScale: 0.16,
    vegetationDensityScale: 0.42,
    objectDensityScale: 0.9,
    waterLevelMeters: theme === "canyon" ? -0.85 : -0.35,
    palette: [],
    dominantSilhouettes: [],
    compositionNotes: [
      "Local conservative contract; no Gemini 3.6 visual comparison was available.",
    ],
    cameras: DEFAULT_REFERENCE_CAMERAS.map((camera) => ({ ...camera })),
    judgement: {
      passed: false,
      agreementScore: 0,
      missingSubjects: [],
      conflicts: ["No model-based reference judgement"],
    },
  };
}

export function normalizeVisualContract(raw: VisualContractRaw, theme: SceneTheme): VisualContract {
  const fallback = localVisualContract(theme);
  const cameraByView = new Map<VisualCameraReference["view"], VisualCameraReference>();
  for (const [index, camera] of (Array.isArray(raw.cameras) ? raw.cameras : [])
    .slice(0, 6)
    .entries()) {
    const view = ["isometric", "oblique", "walk"].includes(camera.view ?? "")
      ? (camera.view as VisualCameraReference["view"])
      : DEFAULT_REFERENCE_CAMERAS[index % DEFAULT_REFERENCE_CAMERAS.length]!.view;
    if (cameraByView.has(view)) continue;
    const cameraFallback = DEFAULT_REFERENCE_CAMERAS.find((candidate) => candidate.view === view)!;
    const projection =
      camera.projection === "orthographic" || camera.projection === "perspective"
        ? camera.projection
        : cameraFallback.projection;
    const rawCrop = camera.panelCropNormalized;
    const crop = (
      Array.isArray(rawCrop) && rawCrop.length >= 4
        ? rawCrop
            .slice(0, 4)
            .map((value, cropIndex) =>
              Math.min(
                1,
                Math.max(
                  0,
                  finiteNumber(value, cameraFallback.panelCropNormalized[cropIndex] ?? 0),
                ),
              ),
            )
        : [...cameraFallback.panelCropNormalized]
    ) as [number, number, number, number];
    cameraByView.set(view, {
      view,
      azimuthDegrees: ((finiteNumber(camera.azimuthDegrees, 45) % 360) + 360) % 360,
      elevationDegrees: Math.min(90, Math.max(0, finiteNumber(camera.elevationDegrees, 30))),
      target: [
        Math.min(1, Math.max(0, finiteNumber(camera.target?.[0], 0.5))),
        Math.min(1, Math.max(0, finiteNumber(camera.target?.[1], 0.5))),
      ],
      distanceScale: Math.min(3, Math.max(0.05, finiteNumber(camera.distanceScale, 1))),
      projection,
      fovDegrees:
        projection === "perspective"
          ? Math.min(
              100,
              Math.max(18, finiteNumber(camera.fovDegrees, cameraFallback.fovDegrees ?? 50)),
            )
          : undefined,
      orthographicScale:
        projection === "orthographic"
          ? Math.min(
              3,
              Math.max(
                0.25,
                finiteNumber(camera.orthographicScale, cameraFallback.orthographicScale ?? 1.15),
              ),
            )
          : undefined,
      panelCropNormalized: crop,
      description: boundedText(camera.description, 200, `${view} reference`),
    });
  }
  for (const camera of DEFAULT_REFERENCE_CAMERAS) {
    if (!cameraByView.has(camera.view)) {
      cameraByView.set(camera.view, { ...camera });
    }
  }

  const palette = boundedStringList(raw.palette, 12, 32).filter((color) =>
    /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]{1,28}\))$/i.test(color),
  );
  const rawCameraViews = new Set(
    (Array.isArray(raw.cameras) ? raw.cameras : [])
      .map((camera) => camera.view)
      .filter((view): view is string => typeof view === "string"),
  );
  const schemaConflicts: string[] = [];
  for (const requiredView of ["isometric", "oblique", "walk"]) {
    if (!rawCameraViews.has(requiredView)) {
      schemaConflicts.push(`Reference sheet lacks a registered ${requiredView} view`);
    }
  }
  for (const camera of Array.isArray(raw.cameras) ? raw.cameras : []) {
    if (
      !Array.isArray(camera.target) ||
      camera.target.length < 2 ||
      !camera.target.slice(0, 2).every((value) => Number.isFinite(Number(value)))
    ) {
      schemaConflicts.push(
        `Registered ${camera.view ?? "unknown"} camera lacks a numeric [u,v] target`,
      );
    }
    if (camera.projection !== "orthographic" && camera.projection !== "perspective") {
      schemaConflicts.push(
        `Registered ${camera.view ?? "unknown"} camera lacks a valid projection`,
      );
    }
    const expectedProjection = camera.view === "isometric" ? "orthographic" : "perspective";
    if (camera.projection && camera.projection !== expectedProjection) {
      schemaConflicts.push(
        `Registered ${camera.view ?? "unknown"} must use ${expectedProjection} projection`,
      );
    }
    if (
      !Array.isArray(camera.panelCropNormalized) ||
      camera.panelCropNormalized.length < 4 ||
      !camera.panelCropNormalized.slice(0, 4).every((value) => Number.isFinite(Number(value)))
    ) {
      schemaConflicts.push(
        `Registered ${camera.view ?? "unknown"} camera lacks a numeric panel crop`,
      );
    }
    if (camera.projection === "perspective" && !Number.isFinite(Number(camera.fovDegrees))) {
      schemaConflicts.push(
        `Registered ${camera.view ?? "unknown"} perspective lacks a field of view`,
      );
    }
    if (
      camera.projection === "orthographic" &&
      !Number.isFinite(Number(camera.orthographicScale))
    ) {
      schemaConflicts.push(
        `Registered ${camera.view ?? "unknown"} orthographic view lacks a framing scale`,
      );
    }
  }
  if (palette.length < 4) {
    schemaConflicts.push("Reference palette lacks four or more CSS color values");
  }
  if (boundedStringList(raw.dominantSilhouettes, 24, 120).length < 3) {
    schemaConflicts.push("Reference judgement lacks dominant silhouette evidence");
  }
  const score = Math.min(1, Math.max(0, finiteNumber(raw.judgement?.agreementScore, 0)));
  const missingSubjects = boundedStringList(raw.judgement?.missingSubjects, 24, 120);
  const conflicts = [...boundedStringList(raw.judgement?.conflicts, 24, 200), ...schemaConflicts];

  return {
    source: "gemini-3.6-flash",
    terrainReliefScale: Math.min(
      1,
      Math.max(0.08, finiteNumber(raw.terrainReliefScale, fallback.terrainReliefScale)),
    ),
    terrainMicroDetailScale: Math.min(
      1,
      Math.max(0, finiteNumber(raw.terrainMicroDetailScale, fallback.terrainMicroDetailScale)),
    ),
    vegetationDensityScale: Math.min(
      1.5,
      Math.max(0.05, finiteNumber(raw.vegetationDensityScale, fallback.vegetationDensityScale)),
    ),
    objectDensityScale: Math.min(
      1.5,
      Math.max(0.1, finiteNumber(raw.objectDensityScale, fallback.objectDensityScale)),
    ),
    waterLevelMeters: Math.min(
      0.5,
      Math.max(-2, finiteNumber(raw.waterLevelMeters, fallback.waterLevelMeters)),
    ),
    palette,
    dominantSilhouettes: boundedStringList(raw.dominantSilhouettes, 24, 120),
    compositionNotes: boundedStringList(raw.compositionNotes, 24, 240),
    cameras: [...cameraByView.values()],
    judgement: {
      passed:
        raw.judgement?.passed === true &&
        score >= 0.72 &&
        missingSubjects.length === 0 &&
        conflicts.length === 0,
      agreementScore: score,
      missingSubjects,
      conflicts,
    },
  };
}

export function validatePromptInput(input: {
  prompt: string;
  benchmarkContract?: BenchmarkGenerationContract;
}): { prompt: string; benchmarkContract?: BenchmarkGenerationContract } {
  if (!input || typeof input.prompt !== "string") {
    throw new Error("Prompt must be text");
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Empty prompt");
  if (prompt.length > WORLD_PROMPT_MAX_CHARS) {
    throw new Error(`Prompt must be ${WORLD_PROMPT_MAX_CHARS} characters or fewer`);
  }
  if (input.benchmarkContract === undefined) return { prompt };
  return {
    prompt,
    benchmarkContract: validateBenchmarkGenerationContract(input.benchmarkContract, prompt),
  };
}

function benchmarkPlanningContractMessage(contract: BenchmarkGenerationContract): string {
  const modelContract = {
    caseId: contract.caseId,
    promptSha256: contract.promptSha256,
    regionalReadability: [...contract.regionalReadability],
    terrainRelationships: [...contract.terrainRelationships],
    objectFamilies: [...contract.objectFamilies],
  };
  return [
    "Hash-verified benchmark generation contract (mandatory):",
    JSON.stringify(modelContract),
    "Map the four regionalReadability roles one-to-one onto four distinct named semantic regions. Encode every objectFamilies entry explicitly in objectRequirements/mainObjects with identifying appearance where relevant. Encode every terrainRelationships entry as buildable region structure and explicit spatial text. Do not merge roles or substitute generic mentions.",
  ].join("\n");
}

const PLAN_SYSTEM = `You are WorldClaw IntentAnalysisAgent + ScenePlanningAgent from the paper "WorldClaw: Agentic 3D Open-World Generation at Scale".

Convert an open-ended user prompt q into a structured scene specification P = (R, C_terrain, C_object).

Rules:
- Output ONLY valid JSON (no markdown, no commentary).
- 5–9 regions covering the full layout in normalized [0,1]x[0,1] coordinates (center + radius).
- Regions must tile the world: oceans/water at edges for islands, mountains framing valleys, etc.
- Exact user counts are authority. If the prompt requests N towns, emit exactly N settlement/town regions; a separate harbor is not an additional settlement unless the user explicitly calls it a town.
- If the prompt says multiple, several, scattered, distributed, or otherwise plural unnumbered towns, emit at least two distinct settlement regions (normally 2–4), never one broad settlement disk with internal clusters. Every town region must own its own explicit house/building requirement group, and scattered towns must have visibly separated centers and non-overlapping build envelopes.
- A harbor that mixes boats and shore infrastructure MUST be represented as two adjacent regions: a usable water basin (ocean or river) owning every boat/ship requirement, plus a dry non-town shore/quay region owning docks or piers. Never assign boats to a settlement region.
- A broad landmass/base region may geometrically cover named forests, groves, ridges or towns only when its role explicitly calls it a non-competing terrain underlay. Otherwise shrink or split it so it does not compete with semantic regions.
- category MUST be one of: ocean, beach, grass, forest, hill, mountain, rock, desert, sand, canyon, river, snow, ice, lava, road, settlement, cliff
- theme MUST be one of: tropical, canyon, desert, snow, medieval, volcanic, island, forest, custom
- visualStyle: realistic | stylized | cartoon | game | sci-fi | fantasy
- Default visualStyle to stylized unless the user explicitly asks for realistic, photorealistic or photographic rendering. The browser renderer uses authored geometric PBR assets, so do not invent a realism requirement that the prompt did not request.
- objectRequirements keys MUST match region names exactly. Only detail-demanding regions need objects.
- object category kinds: hut, house, tower, dock, ship, tree, palm, pine, rock, boulder, cactus, vehicle, tank, building, antenna, fence, campfire, tent, bridge, statue, crystal, mine, dragon, windmill, well, crate, watchtower, satellite, bunker, boat, pagoda, torii, barn, market
- Use hut only for small hut/thatch vernacular. Use building (or house) for authored post-and-beam, plaster, brick, slate, tile, recessed-door/window, or multi-storey architecture so its construction variant can be resolved.
- Every named main subject or landmark MUST also appear in objectRequirements with an explicit count. Never leave tanks, ships, buildings, monuments, wrecks, bridges, gates, or other visible subjects solely painted into layoutPrompt.
- appearance MUST describe the visually identifying form and construction language. For architecture include wall system, structural frame, roof form/covering, openings, trim, materials and weathering when the prompt implies them (for example: true thatch with thick eaves, exposed timber beams with infill, brick returns and lintels, or overlapping slate courses).
- Named vegetation biomes must use tree requirements with species-specific appearance. A bamboo forest needs segmented culms and narrow lance leaves; a cherry/sakura grove needs branching trunks and clearly visible blossom canopies. Never substitute tropical palms for either.
- Preserve the user's composition: distinguish hero landmarks from repeated dressing and give hero objects enough spacing to remain legible from the map camera.
- layoutPrompt: a detailed TOP-DOWN orthographic satellite map prompt for image generation of I_layout (colorful distinct terrain regions, no text/labels/UI).

JSON schema:
{
  "sceneType": string,
  "theme": string,
  "visualStyle": string,
  "atmosphere": string,
  "regions": [{"name":string,"category":string,"center":[u,v],"radius":number,"role":string,"baseElevation":number,"roughness":number,"peakStrength":number}],
  "terrainAssets": string[],
  "objectRequirements": { "RegionName": [{"category":string,"count":number,"appearance":string,"scale":number}] },
  "spatialNotes": string[],
  "mainObjects": string[],
  "layoutPrompt": string
}`;

export function normalizePlan(raw: LlmPlanRaw, prompt: string): ScenePlan {
  const theme = (
    VALID_THEMES.includes(raw.theme as SceneTheme) ? raw.theme : "custom"
  ) as SceneTheme;

  const regions: RegionSpec[] = (Array.isArray(raw.regions) ? raw.regions : [])
    .slice(0, MAX_REGIONS)
    .map((r, i) => {
      let cat = (r.category ?? "grass") as TerrainCategory;
      if (!VALID_CATS.includes(cat)) cat = "grass";
      const cx = Math.min(1, Math.max(0, finiteNumber(r.center?.[0], 0.5)));
      const cy = Math.min(1, Math.max(0, finiteNumber(r.center?.[1], 0.5)));
      const radius = Math.min(0.55, Math.max(0.05, finiteNumber(r.radius, 0.15)));
      return {
        id: `r${i}`,
        name: boundedText(r.name, REGION_NAME_MAX_CHARS, `Region ${i + 1}`),
        category: cat,
        center: [cx, cy],
        radius,
        role: boundedText(r.role, REGION_ROLE_MAX_CHARS, cat),
        baseElevation: Math.min(20, Math.max(-10, finiteNumber(r.baseElevation, BASE_H[cat] ?? 1))),
        roughness: Math.min(1, Math.max(0, finiteNumber(r.roughness, ROUGH[cat] ?? 0.2))),
        peakStrength: Math.min(
          1,
          Math.max(
            0,
            finiteNumber(
              r.peakStrength,
              cat === "mountain" || cat === "rock" || cat === "cliff" ? 0.7 : 0.1,
            ),
          ),
        ),
        color: CAT_COLORS[cat],
      };
    });

  if (regions.length < 3) {
    const defaults: RegionSpec[] = [
      {
        id: "",
        name: "Ocean",
        category: "ocean",
        center: [0.2, 0.5],
        radius: 0.4,
        role: "water",
        baseElevation: -2.5,
        roughness: 0.1,
        peakStrength: 0,
        color: CAT_COLORS.ocean,
      },
      {
        id: "",
        name: "Land",
        category: "grass",
        center: [0.55, 0.5],
        radius: 0.28,
        role: "landmass",
        baseElevation: 1.2,
        roughness: 0.3,
        peakStrength: 0.2,
        color: CAT_COLORS.grass,
      },
      {
        id: "",
        name: "Settlement",
        category: "settlement",
        center: [0.55, 0.55],
        radius: 0.1,
        role: "habitation",
        baseElevation: 1.0,
        roughness: 0.15,
        peakStrength: 0.05,
        color: CAT_COLORS.settlement,
      },
    ];
    for (const fallback of defaults) {
      if (regions.length >= 3) break;
      if (!regions.some((region) => region.name === fallback.name)) {
        regions.push(fallback);
      }
    }
  }
  regions.forEach((region, index) => {
    region.id = `r${index}`;
  });

  const objectRequirements: Record<string, ObjectRequirement[]> = {};
  for (const [rawName, list] of Object.entries(raw.objectRequirements ?? {}).slice(
    0,
    MAX_REGIONS,
  )) {
    const name = boundedText(rawName, REGION_NAME_MAX_CHARS);
    if (!regions.some((region) => region.name === name) || !Array.isArray(list)) continue;
    objectRequirements[name] = list
      .slice(0, 24)
      .filter((o) => o.category && (o.count ?? 0) > 0)
      .map((o) => ({
        category: boundedText(o.category, 48, "object"),
        count: Math.min(40, Math.max(1, Math.round(finiteNumber(o.count, 1)))),
        appearance: boundedText(o.appearance, 240) || undefined,
        scale:
          o.scale === undefined ? undefined : Math.min(10, Math.max(0.1, finiteNumber(o.scale, 1))),
      }));
  }

  for (const [regionName, requirements] of Object.entries(objectRequirements)) {
    const region = regions.find((candidate) => candidate.name === regionName);
    const regionalVocabulary = `${regionName} ${region?.role ?? ""}`.toLocaleLowerCase();
    for (const requirement of requirements) {
      if (!/^(?:tree|palm|pine)$/i.test(requirement.category)) continue;
      const requestedAppearance = requirement.appearance ?? "";
      const vocabulary = `${requestedAppearance} ${regionalVocabulary}`.toLocaleLowerCase();
      if (/\bbamboo\b/.test(vocabulary)) {
        requirement.category = "tree";
        requirement.appearance = boundedText(
          `Japanese bamboo cluster with multiple segmented green culms, visible nodes and narrow lance leaves; ${requestedAppearance}`,
          240,
        );
      } else if (/\b(?:cherry|sakura|blossom)\b/.test(vocabulary)) {
        requirement.category = "tree";
        requirement.appearance = boundedText(
          `Japanese cherry blossom tree with a branching trunk and cloud-like pale pink blossom canopy; ${requestedAppearance}`,
          240,
        );
      }
    }
  }

  const normalizedVisualStyle = VALID_STYLES.includes(raw.visualStyle as VisualStyle)
    ? (raw.visualStyle as VisualStyle)
    : "stylized";
  const visualStyle =
    normalizedVisualStyle === "realistic" &&
    !/\b(?:photo(?:realistic)?|photographic|realistic|lifelike)\b/i.test(prompt)
      ? "stylized"
      : normalizedVisualStyle;

  return {
    prompt,
    sceneType: boundedText(raw.sceneType, 160, "open world scene"),
    theme,
    visualStyle,
    atmosphere: boundedText(raw.atmosphere, 240, "natural daylight"),
    regions,
    terrainAssets: (Array.isArray(raw.terrainAssets) ? raw.terrainAssets : [])
      .slice(0, 32)
      .map((asset) => boundedText(asset, 120))
      .filter(Boolean),
    objectRequirements,
    spatialNotes: (Array.isArray(raw.spatialNotes) ? raw.spatialNotes : [])
      .slice(0, 24)
      .map((note) => boundedText(note, 240))
      .filter(Boolean),
    mainObjects: (Array.isArray(raw.mainObjects) ? raw.mainObjects : [])
      .slice(0, 24)
      .map((object) => boundedText(object, 120))
      .filter(Boolean),
  };
}

function boxBlur(data: Float32Array, res: number, k: number): Float32Array {
  const kernel = new Float32Array(k).fill(1 / k);
  const pad = Math.floor(k / 2);
  const tmp = new Float32Array(res * res);
  const out = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let s = 0;
      for (let i = 0; i < k; i++) {
        const xx = Math.min(res - 1, Math.max(0, x + i - pad));
        s += data[y * res + xx]! * kernel[i]!;
      }
      tmp[y * res + x] = s;
    }
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let s = 0;
      for (let i = 0; i < k; i++) {
        const yy = Math.min(res - 1, Math.max(0, y + i - pad));
        s += tmp[yy * res + x]! * kernel[i]!;
      }
      out[y * res + x] = s;
    }
  }
  return out;
}

function classifyPixel(
  r: number,
  g: number,
  b: number,
  theme: SceneTheme,
  allowWater = true,
): TerrainCategory {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const water = allowWater && b > r + 8 && b > g - 8 && b > 45;
  const green = g > r + 3 && g > b && g > 40;
  const sand = r > 140 && g > 110 && b < 175 && sat < 100 && !water;
  const rockGray = sat < 50 && lum > 50 && lum < 200 && Math.abs(r - g) < 35 && !water;
  const settle =
    r > 40 && g < 120 && b < 110 && lum < 140 && sat > 16 && r > b + 6 && r >= g * 0.9 && !water;
  const snow = lum > 175 && sat < 60;
  const ice = b > r && b > 115 && g > 95 && lum > 85 && lum < 220;
  const canyonRock = r > 90 && g < r * 0.92 && b < g * 0.92 && lum < 175 && sat > 20;
  const lava = r > 80 && g < 50 && b < 40 && lum < 100;

  if (theme === "snow") {
    if (ice) return "ice";
    if (green && lum < 120) return "forest";
    if (settle) return "settlement";
    if (snow) return "snow";
    if (rockGray || lum < 160) return "mountain";
    return "snow";
  }
  if (theme === "desert" || theme === "canyon") {
    if (settle) return "settlement";
    if (canyonRock || rockGray) return theme === "canyon" ? "canyon" : "rock";
    if (sand || (r > 150 && g > 100)) return "sand";
    if (water) return "river";
    return "desert";
  }
  if (theme === "volcanic") {
    if (lava) return "lava";
    if (rockGray || canyonRock) return "rock";
    if (settle) return "settlement";
    return "cliff";
  }
  if (water) return "ocean";
  if (settle) return "settlement";
  if (green && g > 70) return "forest";
  if (sand) return "beach";
  if (rockGray) return "rock";
  if (green) return "grass";
  return "beach";
}

/** Broad raw-pixel test used only as input to border-connected segmentation. */
function isWaterCandidate(r: number, g: number, b: number): boolean {
  const blueOrTeal = b >= r + 6 && g >= r - 8 && Math.max(g, b) >= 30 && g + b >= r * 1.7 + 22;
  // Dark volcanic rock often contains a weak blue cast and can touch the sea.
  // Requiring both blue and green separation keeps genuinely navy/teal water
  // while preventing the border flood-fill from tunnelling through basalt.
  const deepNavy = b >= 28 && b >= r + 10 && g >= r + 4 && g + b >= r * 2 + 28 && b >= g * 0.72;
  return blueOrTeal || deepNavy;
}

/**
 * Find water that is connected to the image boundary.  This distinguishes the
 * surrounding sea from blue roofs, boat paint and other small illustrated
 * details. Two conservative closing passes absorb dark wave/ink strokes that
 * would otherwise become thin spikes inside the ocean.
 */
function edgeConnectedWaterMask(
  red: Float32Array,
  green: Float32Array,
  blue: Float32Array,
  res: number,
): Uint8Array {
  const count = res * res;
  const candidates = new Uint8Array(count);
  const water = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  for (let index = 0; index < count; index++) {
    candidates[index] = isWaterCandidate(red[index] ?? 0, green[index] ?? 0, blue[index] ?? 0)
      ? 1
      : 0;
  }

  const enqueue = (index: number) => {
    if (!candidates[index] || water[index]) return;
    water[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < res; x++) {
    enqueue(x);
    enqueue((res - 1) * res + x);
  }
  for (let y = 1; y < res - 1; y++) {
    enqueue(y * res);
    enqueue(y * res + res - 1);
  }

  while (head < tail) {
    const index = queue[head++]!;
    const x = index % res;
    const y = Math.floor(index / res);
    for (let oy = -1; oy <= 1; oy++) {
      const ny = y + oy;
      if (ny < 0 || ny >= res) continue;
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = x + ox;
        if (nx < 0 || nx >= res) continue;
        enqueue(ny * res + nx);
      }
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    const next = water.slice();
    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const index = y * res + x;
        if (water[index]) continue;
        let neighbours = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            neighbours += water[(y + oy) * res + x + ox] ?? 0;
          }
        }
        if (neighbours >= 5) next[index] = 1;
      }
    }
    water.set(next);
  }

  return water;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

interface SemanticComponent {
  categoryIndex: number;
  category: TerrainCategory;
  firstPixel: number;
  area: number;
  center: [number, number];
}

interface SemanticRegionPartition {
  regionId: Uint8Array;
  categories: TerrainCategory[];
  regions: RegionSpec[];
}

const COMPONENT_NEIGHBOR_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function semanticComponents(
  categoryByPixel: Uint8Array,
  categoryCatalog: TerrainCategory[],
  res: number,
): { components: SemanticComponent[]; componentByPixel: Int32Array } {
  const pixelCount = res * res;
  const componentByPixel = new Int32Array(pixelCount);
  componentByPixel.fill(-1);
  const queue = new Int32Array(pixelCount);
  const components: SemanticComponent[] = [];

  for (let start = 0; start < pixelCount; start++) {
    if (componentByPixel[start] !== -1) continue;
    const componentIndex = components.length;
    const categoryIndex = categoryByPixel[start] ?? 0;
    let head = 0;
    let tail = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    queue[0] = start;
    componentByPixel[start] = componentIndex;

    while (head < tail) {
      const index = queue[head++]!;
      const x = index % res;
      const y = Math.floor(index / res);
      area++;
      sumX += x;
      sumY += y;

      for (const [offsetX, offsetY] of COMPONENT_NEIGHBOR_OFFSETS) {
        const nextX = x + offsetX;
        const nextY = y + offsetY;
        if (nextX < 0 || nextX >= res || nextY < 0 || nextY >= res) continue;
        const next = nextY * res + nextX;
        if (componentByPixel[next] !== -1 || categoryByPixel[next] !== categoryIndex) continue;
        componentByPixel[next] = componentIndex;
        queue[tail++] = next;
      }
    }

    components.push({
      categoryIndex,
      category: categoryCatalog[categoryIndex] ?? "grass",
      firstPixel: start,
      area,
      center: [sumX / area / (res - 1), sumY / area / (res - 1)],
    });
  }

  return { components, componentByPixel };
}

function componentRegionDistanceSquared(component: SemanticComponent, region: RegionSpec): number {
  const centerX = Number.isFinite(region.center[0]) ? region.center[0] : 0.5;
  const centerY = Number.isFinite(region.center[1]) ? region.center[1] : 0.5;
  const dx = component.center[0] - centerX;
  const dy = component.center[1] - centerY;
  return dx * dx + dy * dy;
}

/** Greedy nearest-pair matching with stable tie breakers and one use per side. */
function matchPlanRegionsToComponents(
  components: SemanticComponent[],
  componentIndices: readonly number[],
  planRegions: readonly RegionSpec[],
): Map<number, RegionSpec> {
  const boundedPlans = planRegions.slice(0, MAX_REGIONS);
  const pairs: {
    componentIndex: number;
    planIndex: number;
    distanceSquared: number;
  }[] = [];
  for (const componentIndex of componentIndices) {
    const component = components[componentIndex]!;
    for (let planIndex = 0; planIndex < boundedPlans.length; planIndex++) {
      const planRegion = boundedPlans[planIndex]!;
      if (planRegion.category !== component.category) continue;
      pairs.push({
        componentIndex,
        planIndex,
        distanceSquared: componentRegionDistanceSquared(component, planRegion),
      });
    }
  }
  pairs.sort(
    (left, right) =>
      left.distanceSquared - right.distanceSquared ||
      left.planIndex - right.planIndex ||
      components[left.componentIndex]!.firstPixel - components[right.componentIndex]!.firstPixel,
  );

  const matchedComponents = new Set<number>();
  const matchedPlans = new Set<number>();
  const matches = new Map<number, RegionSpec>();
  for (const pair of pairs) {
    if (matchedComponents.has(pair.componentIndex) || matchedPlans.has(pair.planIndex)) continue;
    matchedComponents.add(pair.componentIndex);
    matchedPlans.add(pair.planIndex);
    matches.set(pair.componentIndex, boundedPlans[pair.planIndex]!);
  }
  return matches;
}

function uniqueRegionName(preferred: string, usedNames: Set<string>): string {
  const base = boundedText(preferred, REGION_NAME_MAX_CHARS, "Region");
  if (!usedNames.has(base.toLowerCase())) {
    usedNames.add(base.toLowerCase());
    return base;
  }
  for (let ordinal = 2; ordinal <= MAX_REGIONS; ordinal++) {
    const suffix = ` ${ordinal}`;
    const candidate = `${base.slice(0, REGION_NAME_MAX_CHARS - suffix.length)}${suffix}`;
    if (usedNames.has(candidate.toLowerCase())) continue;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }
  return `Region ${usedNames.size + 1}`;
}

function categoryTitle(category: TerrainCategory): string {
  return category.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Turn the semantic class raster into a bounded region graph. Four-connected
 * components remain separate when they are material or when authored plan
 * regions can claim them. Tiny fragments merge into the nearest kept component
 * of the same category, and only fall back across categories when the hard
 * region-id cap leaves no kept component of their category.
 */
function partitionSemanticRegions(
  categoryByPixel: Uint8Array,
  categoryCatalog: TerrainCategory[],
  res: number,
  planRegions: readonly RegionSpec[],
): SemanticRegionPartition {
  const pixelCount = res * res;
  const { components, componentByPixel } = semanticComponents(
    categoryByPixel,
    categoryCatalog,
    res,
  );
  const regionLimit = Math.min(MAX_REGIONS, UINT8_REGION_CAPACITY);
  const plannedAreaFloor = Math.max(
    MIN_LAYOUT_COMPONENT_PIXELS,
    Math.ceil(pixelCount * PLANNED_COMPONENT_AREA_RATIO),
  );
  const unplannedAreaFloor = Math.max(
    plannedAreaFloor,
    Math.ceil(pixelCount * UNPLANNED_COMPONENT_AREA_RATIO),
  );

  const primaryByCategory = new Map<number, number>();
  for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
    const component = components[componentIndex]!;
    const currentIndex = primaryByCategory.get(component.categoryIndex);
    if (currentIndex === undefined || component.area > components[currentIndex]!.area) {
      primaryByCategory.set(component.categoryIndex, componentIndex);
    }
  }
  const primaryIndices = new Set(primaryByCategory.values());
  const planEligible = components
    .map((component, index) => ({ component, index }))
    .filter(
      ({ component, index }) => component.area >= plannedAreaFloor || primaryIndices.has(index),
    )
    .map(({ index }) => index);
  const provisionalMatches = matchPlanRegionsToComponents(components, planEligible, planRegions);
  const essential = new Set<number>([...primaryIndices, ...provisionalMatches.keys()]);
  const byImportance = (leftIndex: number, rightIndex: number) => {
    const left = components[leftIndex]!;
    const right = components[rightIndex]!;
    return (
      right.area - left.area ||
      Number(provisionalMatches.has(rightIndex)) - Number(provisionalMatches.has(leftIndex)) ||
      left.firstPixel - right.firstPixel
    );
  };
  const selected = [...essential].sort(byImportance).slice(0, regionLimit);
  if (selected.length < regionLimit) {
    const selectedSet = new Set(selected);
    const significant = components
      .map((component, index) => ({ component, index }))
      .filter(
        ({ component, index }) => !selectedSet.has(index) && component.area >= unplannedAreaFloor,
      )
      .map(({ index }) => index)
      .sort(byImportance);
    selected.push(...significant.slice(0, regionLimit - selected.length));
  }
  if (selected.length === 0 && components.length > 0) selected.push(0);
  selected.sort(
    (leftIndex, rightIndex) =>
      components[leftIndex]!.firstPixel - components[rightIndex]!.firstPixel,
  );

  const finalMatches = matchPlanRegionsToComponents(components, selected, planRegions);
  const selectedCountsByCategory = new Map<TerrainCategory, number>();
  for (const componentIndex of selected) {
    const category = components[componentIndex]!.category;
    selectedCountsByCategory.set(category, (selectedCountsByCategory.get(category) ?? 0) + 1);
  }
  const ordinalsByCategory = new Map<TerrainCategory, number>();
  const usedNames = new Set<string>();
  const categories: TerrainCategory[] = [];
  const regions: RegionSpec[] = selected.map((componentIndex, regionIndex) => {
    const component = components[componentIndex]!;
    const match = finalMatches.get(componentIndex);
    const ordinal = (ordinalsByCategory.get(component.category) ?? 0) + 1;
    ordinalsByCategory.set(component.category, ordinal);
    const title = categoryTitle(component.category);
    const preferredName =
      match?.name ??
      ((selectedCountsByCategory.get(component.category) ?? 0) > 1 ? `${title} ${ordinal}` : title);
    const coverage = component.area / pixelCount;
    const radius = Math.max(0.06, Math.min(0.45, Math.sqrt(coverage) * 0.6));
    categories.push(component.category);
    return {
      id: `r${regionIndex}`,
      name: uniqueRegionName(preferredName, usedNames),
      category: component.category,
      center: [Number(component.center[0].toFixed(3)), Number(component.center[1].toFixed(3))],
      radius: Number(radius.toFixed(3)),
      role: boundedText(match?.role, REGION_ROLE_MAX_CHARS, component.category),
      baseElevation: BASE_H[component.category] ?? 1,
      roughness: ROUGH[component.category] ?? 0.2,
      peakStrength:
        component.category === "mountain" ||
        component.category === "rock" ||
        component.category === "cliff" ||
        component.category === "canyon"
          ? 0.55
          : 0.1,
      color: CAT_COLORS[component.category],
    };
  });

  const componentToRegion = new Int16Array(components.length);
  componentToRegion.fill(-1);
  for (let regionIndex = 0; regionIndex < selected.length; regionIndex++) {
    componentToRegion[selected[regionIndex]!] = regionIndex;
  }
  for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
    if (componentToRegion[componentIndex] !== -1) continue;
    const component = components[componentIndex]!;
    let bestRegionIndex = -1;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    for (let regionIndex = 0; regionIndex < selected.length; regionIndex++) {
      const candidate = components[selected[regionIndex]!]!;
      if (candidate.category !== component.category) continue;
      const dx = candidate.center[0] - component.center[0];
      const dy = candidate.center[1] - component.center[1];
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestRegionIndex = regionIndex;
      }
    }
    if (bestRegionIndex === -1) {
      for (let regionIndex = 0; regionIndex < selected.length; regionIndex++) {
        const candidate = components[selected[regionIndex]!]!;
        const dx = candidate.center[0] - component.center[0];
        const dy = candidate.center[1] - component.center[1];
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < bestDistanceSquared) {
          bestDistanceSquared = distanceSquared;
          bestRegionIndex = regionIndex;
        }
      }
    }
    componentToRegion[componentIndex] = Math.max(0, bestRegionIndex);
  }

  const regionId = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) {
    regionId[index] = componentToRegion[componentByPixel[index] ?? 0] ?? 0;
  }
  return { regionId, categories, regions };
}

export function heightFromLayout(
  rgba: Uint8Array,
  width: number,
  height: number,
  theme: SceneTheme,
  targetRes: number,
  planRegions: RegionSpec[],
  options: {
    waterLevelMeters?: number;
    reliefScale?: number;
  } = {},
) {
  if (!Number.isSafeInteger(width) || width < 2 || !Number.isSafeInteger(height) || height < 2) {
    throw new RangeError("Layout dimensions must be safe integers of at least 2 pixels");
  }
  const expectedRgbaLength = width * height * 4;
  if (!Number.isSafeInteger(expectedRgbaLength) || rgba.length !== expectedRgbaLength) {
    throw new RangeError(
      `Layout RGBA length must equal width * height * 4 (${expectedRgbaLength})`,
    );
  }
  if (
    !Number.isSafeInteger(targetRes) ||
    targetRes < 2 ||
    targetRes > MAX_LAYOUT_TARGET_RESOLUTION
  ) {
    throw new RangeError(
      `Target layout resolution must be an integer from 2 through ${MAX_LAYOUT_TARGET_RESOLUTION}`,
    );
  }
  const side = Math.min(width, height);
  const ox = Math.floor((width - side) / 2);
  const oy = Math.floor((height - side) / 2);
  const res = targetRes;
  const categoryCatalog: TerrainCategory[] = [];
  const categoryByPixel = new Uint8Array(res * res);
  const heightArr = new Float32Array(res * res);
  const lumArr = new Float32Array(res * res);
  const redArr = new Float32Array(res * res);
  const greenArr = new Float32Array(res * res);
  const blueArr = new Float32Array(res * res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const sx = ox + Math.floor((x / (res - 1)) * (side - 1));
      const sy = oy + Math.floor((y / (res - 1)) * (side - 1));
      const i = (sy * width + sx) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const index = y * res + x;
      redArr[index] = r;
      greenArr[index] = g;
      blueArr[index] = b;
      lumArr[index] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  const edgeOceanThemes: SceneTheme[] = ["tropical", "island", "forest", "medieval", "custom"];
  const useEdgeOcean = edgeOceanThemes.includes(theme);
  const edgeWater = useEdgeOcean
    ? edgeConnectedWaterMask(redArr, greenArr, blueArr, res)
    : new Uint8Array(res * res);
  // Semantic classification works on a softened image. This removes tiny
  // illustrated roofs, trees and ink marks while retaining biome-scale areas.
  const semanticRed = boxBlur(redArr, res, 11);
  const semanticGreen = boxBlur(greenArr, res, 11);
  const semanticBlue = boxBlur(blueArr, res, 11);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const index = y * res + x;
      const cat = edgeWater[index]
        ? "ocean"
        : classifyPixel(
            semanticRed[index] ?? 0,
            semanticGreen[index] ?? 0,
            semanticBlue[index] ?? 0,
            theme,
            !useEdgeOcean,
          );
      let ci = categoryCatalog.indexOf(cat);
      if (ci < 0) {
        categoryCatalog.push(cat);
        ci = categoryCatalog.length - 1;
      }
      categoryByPixel[index] = ci;
    }
  }

  const semanticRegions = partitionSemanticRegions(
    categoryByPixel,
    categoryCatalog,
    res,
    planRegions,
  );
  const { regionId, categories, regions } = semanticRegions;
  const semanticWater = new Uint8Array(res * res);
  const sourceLand = new Uint8Array(res * res);
  const semanticLand = new Uint8Array(res * res);
  let matchingLandWaterPixels = 0;
  for (let index = 0; index < semanticWater.length; index++) {
    const category = categories[regionId[index]!]!;
    semanticWater[index] = category === "ocean" || category === "river" ? 1 : 0;
    sourceLand[index] = edgeWater[index] ? 0 : 1;
    semanticLand[index] = semanticWater[index] ? 0 : 1;
    if (edgeWater[index] === semanticWater[index]) matchingLandWaterPixels++;
  }
  const sourceToSemanticWater = measureMaskOverlap(
    { width: res, height: res, data: edgeWater },
    { width: res, height: res, data: semanticWater },
  );
  const sourceToSemanticLand = measureMaskOverlap(
    { width: res, height: res, data: sourceLand },
    { width: res, height: res, data: semanticLand },
  );
  const sourceToSemanticShoreline = boundaryF1WithinTolerance(
    { width: res, height: res, data: sourceLand },
    { width: res, height: res, data: semanticLand },
    Math.max(1, 4 * (res / 1024)),
  );
  const sourceToSemanticOrientation = compareMaskTransforms(
    { width: res, height: res, data: sourceLand },
    { width: res, height: res, data: semanticLand },
    0.02,
  );
  const layoutMaskProvenance = {
    available: useEdgeOcean,
    source: "selected-layout-image-border-connected-water",
    target: "derived-semantic-heightfield-mask",
    waterIoU: sourceToSemanticWater.iou,
    landIoU: sourceToSemanticLand.iou,
    landWaterIoU: (sourceToSemanticWater.iou + sourceToSemanticLand.iou) * 0.5,
    pixelAgreement: matchingLandWaterPixels / semanticWater.length,
    shorelineBoundaryF1: sourceToSemanticShoreline.f1,
    orientationSuspicious: sourceToSemanticOrientation.suspicious,
    passed:
      !useEdgeOcean ||
      ((sourceToSemanticWater.iou + sourceToSemanticLand.iou) * 0.5 >= 0.95 &&
        sourceToSemanticShoreline.f1 >= 0.95 &&
        !sourceToSemanticOrientation.suspicious),
  } as const;

  const lowFrequencyLum = boxBlur(lumArr, res, 21);
  const reliefScale = Number.isFinite(options.reliefScale)
    ? Math.max(0, Math.min(1, options.reliefScale!))
    : 0.58;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const idx = y * res + x;
      const cat = categories[regionId[idx]!]!;
      const lowLum = lowFrequencyLum[idx]!;
      const macroDarkness = clampUnit((150 - lowLum) / 105);
      const base = IMAGE_BASE_H[cat] ?? 0.6;
      const rough = ROUGH[cat] ?? 0.2;
      let h = base;
      if (cat === "mountain" || cat === "rock" || cat === "cliff" || cat === "canyon") {
        h = base + macroDarkness * 1.45 * Math.max(rough, 0.4) * reliefScale;
      } else if (cat === "ocean" || cat === "river") {
        h = base;
      } else if (cat === "ice") {
        h = base + macroDarkness * 0.3 * reliefScale;
      } else if (cat === "settlement" || cat === "road") {
        h = base + macroDarkness * 0.08 * reliefScale;
      } else if (cat === "forest" || cat === "grass") {
        h = base + macroDarkness * 0.38 * reliefScale;
      } else if (cat === "sand" || cat === "desert" || cat === "beach") {
        h = base + macroDarkness * 0.18 * reliefScale;
      } else if (cat === "snow") {
        h = base + macroDarkness * 0.72 * reliefScale;
      } else if (cat === "lava") {
        h = base;
      } else {
        h = base + macroDarkness * rough * 0.55 * reliefScale;
      }
      heightArr[idx] = h;
    }
  }
  const smoothed = boxBlur(heightArr, res, 7);
  const waterLevelMeters = Number.isFinite(options.waterLevelMeters)
    ? Math.max(-3, Math.min(1, options.waterLevelMeters!))
    : DEFAULT_WATER_LEVEL_METERS;
  const waterCeiling = waterLevelMeters - 0.38;
  // Smoothing may blend a shoreline upward. Reassert this invariant after
  // every height operation so no water-classified vertex can pierce the sea.
  for (let index = 0; index < smoothed.length; index++) {
    const cat = categories[regionId[index]!]!;
    if (cat === "ocean" || cat === "river") {
      smoothed[index] = Math.min(smoothed[index]!, waterCeiling);
    } else {
      const shorelineFloor =
        cat === "beach" || cat === "sand" || cat === "ice"
          ? waterLevelMeters + 0.08
          : waterLevelMeters + 0.16;
      smoothed[index] = Math.max(smoothed[index]!, shorelineFloor);
    }
  }

  return {
    resolution: res,
    worldSize: 120,
    height: Array.from(smoothed).map((v) => Math.round(v * 1000) / 1000),
    regionId: Array.from(regionId),
    categories,
    regions,
    layoutMaskProvenance,
  };
}

export const checkInferenceAvailable = createServerFn({ method: "GET" }).handler(async () => {
  const { hasXaiKey } = await import("./xai.server");
  const { hasGeminiKey } = await import("./gemini.server");
  const { hasOpenAIKey } = await import("./openai.server");
  const { hasClaudeKey } = await import("./claude.server");
  return { available: hasXaiKey() || hasGeminiKey() || hasOpenAIKey() || hasClaudeKey() };
});

export const planSceneWithLlm = createServerFn({ method: "POST" })
  .middleware([paidInferenceRunMiddleware])
  .validator(validatePromptInput)
  .handler(async ({ data }) => {
    const prompt = data.prompt;
    const benchmarkContract = data.benchmarkContract;
    const { getRequest } = await import("@tanstack/react-start/server");
    const requestSignal = getRequest().signal;
    const { parseJsonFromLlm } = await import("./xai.server");
    const { committeeStatuses, runTextCommittee, runTextCommitteeQuorum, runTextProvider } =
      await import("./ensemble.server");
    const strictCommittee = await strictPaidCommitteeRequired();

    const benchmarkMessage = benchmarkContract
      ? `\n\n${benchmarkPlanningContractMessage(benchmarkContract)}`
      : "";
    const user = `User prompt q:\n"""${prompt}"""${benchmarkMessage}\n\nProduce the complete scene specification P as JSON.`;
    assertModelFragment("Planning prompt", user);
    const initialOptions = {
      system: PLAN_SYSTEM,
      user,
      maxTokens: 16_384,
      signal: requestSignal,
      timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.text,
      dispatch: { stage: "planning", iteration: 1, role: "Independent scene-plan candidate" },
    } satisfies import("./ensemble.server").CommitteeTextOptions;
    const initialCalls = strictCommittee
      ? await runTextCommittee(initialOptions)
      : await runTextCommitteeQuorum(initialOptions, {
          minimumUsable: 2,
          isUsable: (call) => {
            if (!call.ok || !call.value) return false;
            try {
              normalizePlan(parseJsonFromLlm<LlmPlanRaw>(call.value.text), prompt);
              return true;
            } catch {
              return false;
            }
          },
        });
    let providers = committeeStatuses(initialCalls);
    const artifacts: EnsembleArtifact[] = [];
    const candidates: PlanCommitteeCandidate[] = [];

    for (const call of initialCalls) {
      const id = evidenceId("planning", 1, call.provider, "candidate");
      if (!call.ok || !call.value) {
        if (call.configured) {
          artifacts.push(
            committeeArtifact({
              id,
              iteration: 1,
              stage: "planning",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Independent scene-plan candidate",
              status: "error",
              error: call.error,
              conflicts: ["Provider did not produce a usable planning candidate"],
            }),
          );
        }
        continue;
      }
      try {
        const raw = parseJsonFromLlm<LlmPlanRaw>(call.value.text);
        const plan = normalizePlan(raw, prompt);
        const layoutPrompt = boundedText(
          raw.layoutPrompt,
          LAYOUT_PROMPT_MAX_CHARS,
          `Top-down orthographic satellite map of ${plan.sceneType}, ${plan.atmosphere}, distinct terrain regions, no text labels, game world map quality`,
        );
        const score = deterministicPlanScore(plan);
        const artifact = committeeArtifact({
          id,
          iteration: 1,
          stage: "planning",
          provider: call.provider,
          model: call.model,
          ...committeeCallIdentity(call),
          role: "Independent scene-plan candidate",
          structuredOutput: JSON.stringify({ plan, layoutPrompt }),
          score,
          metrics: {
            deterministicCompleteness: score,
            regionCount: plan.regions.length,
            requirementGroups: Object.keys(plan.objectRequirements).length,
          },
          observations: [
            `${plan.sceneType}; ${plan.regions.length} regions; theme ${plan.theme}; style ${plan.visualStyle}`,
          ],
        });
        artifacts.push(artifact);
        candidates.push({
          id,
          provider: call.provider,
          model: call.model,
          raw,
          plan,
          layoutPrompt,
          artifact,
        });
      } catch (error) {
        artifacts.push(
          committeeArtifact({
            id,
            iteration: 1,
            stage: "planning",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: "Independent scene-plan candidate",
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            conflicts: ["Provider response was not a valid normalized scene plan"],
          }),
        );
      }
    }

    if (strictCommittee) {
      assertExactCommitteeRoster(
        "Initial scene-plan committee",
        candidates.map((candidate) => candidate.provider),
        ["xai", "gemini", "openai", "anthropic"],
      );
    }

    if (candidates.length === 0) {
      return {
        ok: false as const,
        error: initialCalls.some((call) => call.configured)
          ? "Every configured planning model failed or returned malformed JSON"
          : "No inference key available (XAI_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / AI_GATEWAY_API_KEY)",
        plan: null as ScenePlan | null,
        layoutPrompt: "",
        raw: "",
        provider: "none",
        ensemble: {
          providers,
          artifacts,
          completedIterations: 1,
          maxIterations: 2,
        } satisfies EnsembleEvidence,
      };
    }

    const judgeCandidates = async (
      judgedCandidates: PlanCommitteeCandidate[],
      iteration: number,
    ): Promise<{ winner: PlanCommitteeCandidate; consensusScore: number; conflicts: string[] }> => {
      const compactCandidates = judgedCandidates.map((candidate) => ({
        candidateId: candidate.id,
        provider: candidate.provider,
        sceneType: candidate.plan.sceneType,
        theme: candidate.plan.theme,
        visualStyle: candidate.plan.visualStyle,
        regions: candidate.plan.regions.map((region) => ({
          name: region.name,
          category: region.category,
          center: region.center,
          radius: region.radius,
          role: region.role,
        })),
        objectRequirements: Object.entries(candidate.plan.objectRequirements)
          .flatMap(([regionName, requirements]) =>
            requirements
              .slice(0, 10)
              .map(
                (requirement) =>
                  `${regionName}:${requirement.category} x${requirement.count}; ${boundedText(requirement.appearance, 120)}`,
              ),
          )
          .slice(0, 64),
        spatialNotes: candidate.plan.spatialNotes.slice(0, 8),
        mainObjects: candidate.plan.mainObjects.slice(0, 16),
        layoutPrompt: candidate.layoutPrompt,
      }));
      const criticSystem = `You are a conservative WorldClaw scene-plan committee member. Cross-check every candidate against the original user prompt. Reward exact subject counts, distinct semantic regions, explicit construction/material vocabulary, navigable spatial composition, map-generatable coordinates, and complete object requirements. Penalize invented themes, duplicate/missing heroes, generic procedural filler, tropical substitutions, impossible layouts, and contradictions. Output ONLY JSON: {"candidates":[{"candidateId":string,"score":number 0..1,"passed":boolean,"observations":string[],"conflicts":string[]}],"preferredCandidateId":string,"observations":string[],"conflicts":string[]}. Score every listed candidate exactly once.`;
      const criticOptions = {
        system: criticSystem,
        user: `Original user prompt: ${prompt}${benchmarkMessage}\nCandidates: ${JSON.stringify(compactCandidates)}`,
        maxTokens: 12_000,
        signal: requestSignal,
        timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.text,
        dispatch: { stage: "critique", iteration, role: "Cross-model scene-plan judge" },
      } as const;
      const criticCalls = strictCommittee
        ? await runTextCommittee(criticOptions)
        : await runTextCommitteeQuorum(criticOptions, {
            minimumUsable: 2,
            isUsable: (call) => {
              if (!call.ok || !call.value) return false;
              try {
                normalizeCommitteeJudgement(
                  parseJsonFromLlm<CommitteeCandidateJudgementRaw>(call.value.text),
                  judgedCandidates.map((candidate) => candidate.id),
                );
                return true;
              } catch {
                return false;
              }
            },
          });
      providers = mergeProviderStatuses(providers, committeeStatuses(criticCalls));
      const scores = new Map<string, number[]>();
      const conflicts = new Map<string, string[]>();
      const feasibility = new Map<string, PlanFeasibilityAssessment>();
      const successfulCritics: EnsembleProviderId[] = [];
      for (const candidate of judgedCandidates) {
        const assessment = assessPlanFeasibility(prompt, candidate.plan, benchmarkContract);
        feasibility.set(candidate.id, assessment);
        scores.set(candidate.id, [deterministicPlanScore(candidate.plan)]);
        conflicts.set(candidate.id, [...assessment.criticalConflicts]);
        candidate.artifact.passed = assessment.passed;
        candidate.artifact.metrics = {
          ...candidate.artifact.metrics,
          planFeasibilityCriticalConflicts: assessment.criticalConflicts.length,
        };
        candidate.artifact.conflicts = [
          ...new Set([...candidate.artifact.conflicts, ...assessment.criticalConflicts]),
        ].slice(0, 12);
      }
      for (const call of criticCalls) {
        const criticId = evidenceId("critique", iteration, call.provider, "plan-judge");
        if (!call.ok || !call.value) {
          if (call.configured) {
            artifacts.push(
              committeeArtifact({
                id: criticId,
                iteration,
                stage: "critique",
                provider: call.provider,
                model: call.model,
                ...committeeCallIdentity(call),
                role: "Cross-model scene-plan judge",
                status: "error",
                parentArtifactIds: judgedCandidates.map((candidate) => candidate.id),
                error: call.error,
              }),
            );
          }
          continue;
        }
        try {
          const judgement = normalizeCommitteeJudgement(
            parseJsonFromLlm<CommitteeCandidateJudgementRaw>(call.value.text),
            judgedCandidates.map((candidate) => candidate.id),
          );
          successfulCritics.push(call.provider);
          for (const [candidateId, entry] of judgement.scores) {
            scores.get(candidateId)?.push(entry.score);
            conflicts.get(candidateId)?.push(...boundedStringList(entry.conflicts, 8, 240));
          }
          const preferred = judgement.preferredCandidateId;
          const preferredScore = preferred ? judgement.scores.get(preferred) : undefined;
          artifacts.push(
            committeeArtifact({
              id: criticId,
              iteration,
              stage: "critique",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Cross-model scene-plan judge",
              parentArtifactIds: judgedCandidates.map((candidate) => candidate.id),
              structuredOutput: JSON.stringify({
                preferredCandidateId: judgement.preferredCandidateId,
                candidates: [...judgement.scores.entries()].map(([candidateId, entry]) => ({
                  candidateId,
                  ...entry,
                })),
                observations: judgement.observations,
                conflicts: judgement.conflicts,
              }),
              score: preferredScore?.score,
              passed: preferredScore?.passed === true,
              observations: judgement.observations,
              conflicts: judgement.conflicts,
            }),
          );
        } catch (error) {
          artifacts.push(
            committeeArtifact({
              id: criticId,
              iteration,
              stage: "critique",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Cross-model scene-plan judge",
              status: "error",
              parentArtifactIds: judgedCandidates.map((candidate) => candidate.id),
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (strictCommittee) {
        assertExactCommitteeRoster(
          `Scene-plan committee iteration ${iteration}`,
          successfulCritics,
          ["xai", "gemini", "openai", "anthropic"],
        );
      }
      const ranked = [...judgedCandidates].sort((a, b) => {
        const feasibilityA = feasibility.get(a.id)?.passed === true;
        const feasibilityB = feasibility.get(b.id)?.passed === true;
        if (feasibilityA !== feasibilityB) return Number(feasibilityB) - Number(feasibilityA);
        const scoreA =
          (scores.get(a.id) ?? [0]).reduce((sum, value) => sum + value, 0) /
          (scores.get(a.id)?.length ?? 1);
        const scoreB =
          (scores.get(b.id) ?? [0]).reduce((sum, value) => sum + value, 0) /
          (scores.get(b.id)?.length ?? 1);
        return scoreB - scoreA || a.id.localeCompare(b.id);
      });
      const winner = ranked[0]!;
      const winnerScores = scores.get(winner.id) ?? [0];
      const consensusScore = unitScore(
        winnerScores.reduce((sum, value) => sum + value, 0) / winnerScores.length,
      );
      return {
        winner,
        consensusScore,
        conflicts: [...new Set(conflicts.get(winner.id) ?? [])].slice(0, 12),
      };
    };

    let judged = await judgeCandidates(candidates, 1);
    let completedIterations = 1;
    let finalCandidates = candidates;
    const repairDecision = planningAdaptiveRepairDecision(
      judged.consensusScore,
      prompt,
      judged.winner.plan,
      benchmarkContract,
    );
    if (repairDecision.required && (strictCommittee || repairDecision.feasibilityTriggered)) {
      requestSignal.throwIfAborted();
      const repairUser = [
        user,
        `The first committee selected ${judged.winner.id} at ${judged.consensusScore.toFixed(3)}.`,
        `Repair these concrete issues without changing exact prompt counts: ${
          [...repairDecision.criticalConflicts, ...judged.conflicts]
            .filter((conflict, index, values) => values.indexOf(conflict) === index)
            .join("; ") ||
          "increase semantic specificity, spatial legibility, and construction fidelity"
        }.`,
        `Previous candidate: ${JSON.stringify({
          sceneType: judged.winner.plan.sceneType,
          theme: judged.winner.plan.theme,
          visualStyle: judged.winner.plan.visualStyle,
          atmosphere: judged.winner.plan.atmosphere,
          regions: judged.winner.plan.regions,
          objectRequirements: Object.entries(judged.winner.plan.objectRequirements)
            .flatMap(([regionName, requirements]) =>
              requirements.slice(0, 10).map((requirement) => ({
                regionName,
                category: requirement.category,
                count: requirement.count,
                appearance: boundedText(requirement.appearance, 120),
              })),
            )
            .slice(0, 64),
          layoutPrompt: judged.winner.layoutPrompt,
        })}`,
        "Return a complete replacement JSON plan, not a patch.",
      ].join("\n");
      const repairCall = await runTextProvider(judged.winner.provider, {
        system: PLAN_SYSTEM,
        user: repairUser,
        maxTokens: 16_384,
        signal: requestSignal,
        timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.text,
        dispatch: {
          stage: "planning",
          iteration: 2,
          role: "Adaptive scene-plan repair from committee feedback",
        },
      });
      providers = mergeProviderStatuses(providers, committeeStatuses([repairCall]));
      let repairAccepted = false;
      if (repairCall.ok && repairCall.value) {
        try {
          const raw = parseJsonFromLlm<LlmPlanRaw>(repairCall.value.text);
          const plan = normalizePlan(raw, prompt);
          const id = evidenceId("planning", 2, repairCall.provider, "adaptive-repair");
          const artifact = committeeArtifact({
            id,
            iteration: 2,
            stage: "planning",
            provider: repairCall.provider,
            model: repairCall.model,
            ...committeeCallIdentity(repairCall),
            role: "Adaptive scene-plan repair from committee feedback",
            parentArtifactIds: [judged.winner.id],
            structuredOutput: JSON.stringify({
              plan,
              layoutPrompt: boundedText(
                raw.layoutPrompt,
                LAYOUT_PROMPT_MAX_CHARS,
                judged.winner.layoutPrompt,
              ),
            }),
            score: deterministicPlanScore(plan),
            metrics: { deterministicCompleteness: deterministicPlanScore(plan) },
            observations: ["Second-pass plan generated from cross-model conflicts"],
          });
          artifacts.push(artifact);
          const repaired: PlanCommitteeCandidate = {
            id,
            provider: repairCall.provider,
            model: repairCall.model,
            raw,
            plan,
            layoutPrompt: boundedText(
              raw.layoutPrompt,
              LAYOUT_PROMPT_MAX_CHARS,
              judged.winner.layoutPrompt,
            ),
            artifact,
          };
          finalCandidates = [judged.winner, repaired];
          judged = await judgeCandidates(finalCandidates, 2);
          completedIterations = 2;
          repairAccepted = true;
        } catch (error) {
          artifacts.push(
            committeeArtifact({
              id: evidenceId("planning", 2, repairCall.provider, "adaptive-repair"),
              iteration: 2,
              stage: "planning",
              provider: repairCall.provider,
              model: repairCall.model,
              ...committeeCallIdentity(repairCall),
              role: "Adaptive scene-plan repair from committee feedback",
              status: "error",
              parentArtifactIds: [judged.winner.id],
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (strictCommittee && !repairAccepted) {
        throw new Error(
          `Adaptive scene-plan repair failed under benchmark enforcement: ${repairCall.error ?? "invalid replacement plan"}`,
        );
      }
    }

    const finalFeasibility = assessPlanFeasibility(prompt, judged.winner.plan, benchmarkContract);
    if (!finalFeasibility.passed) {
      for (const candidate of finalCandidates) {
        candidate.artifact.status = "rejected";
        candidate.artifact.passed = false;
        candidate.artifact.conflicts = [
          ...new Set([...candidate.artifact.conflicts, ...finalFeasibility.criticalConflicts]),
        ].slice(0, 12);
      }
      return {
        ok: false as const,
        error: `Planning feasibility gate failed after ${completedIterations} bounded committee iteration${completedIterations === 1 ? "" : "s"}: ${finalFeasibility.criticalConflicts.join("; ")}`,
        plan: null as ScenePlan | null,
        layoutPrompt: "",
        raw: "",
        provider: "none",
        ensemble: {
          providers,
          artifacts: boundEnsembleArtifacts(artifacts.slice(-128)),
          selection: {
            consensusScore: judged.consensusScore,
            rationale: [
              `No planning candidate was selected: deterministic feasibility remained red after ${completedIterations} bounded committee iteration${completedIterations === 1 ? "" : "s"}`,
              ...finalFeasibility.criticalConflicts,
            ].slice(0, 12),
          },
          completedIterations,
          maxIterations: 2,
        } satisfies EnsembleEvidence,
      };
    }

    for (const candidate of candidates) {
      candidate.artifact.status = candidate.id === judged.winner.id ? "selected" : "rejected";
      if (candidate.id === judged.winner.id) candidate.artifact.score = judged.consensusScore;
    }
    for (const candidate of finalCandidates) {
      candidate.artifact.status = candidate.id === judged.winner.id ? "selected" : "rejected";
      if (candidate.id === judged.winner.id) candidate.artifact.score = judged.consensusScore;
    }

    const plan = judged.winner.plan;
    return {
      ok: true as const,
      plan,
      layoutPrompt: judged.winner.layoutPrompt,
      raw: JSON.stringify(judged.winner.raw).slice(0, 500),
      error: null as string | null,
      provider: `${judged.winner.model} committee-selected`,
      ensemble: {
        providers,
        artifacts: boundEnsembleArtifacts(artifacts.slice(-128)),
        selection: {
          consensusScore: judged.consensusScore,
          rationale: [
            `Selected ${judged.winner.id} after ${completedIterations} bounded committee iteration${completedIterations === 1 ? "" : "s"}`,
            ...judged.conflicts.map((conflict) => `Remaining planning concern: ${conflict}`),
          ].slice(0, 12),
        },
        completedIterations,
        maxIterations: 2,
      } satisfies EnsembleEvidence,
    };
  });

export const generateLayoutTerrain = createServerFn({ method: "POST" })
  .middleware([paidInferenceRunMiddleware])
  .validator(
    (input: {
      prompt: string;
      layoutPrompt: string;
      theme: SceneTheme;
      regions: RegionSpec[];
      quality?: boolean;
    }) => {
      const prompt = validatePromptInput({ prompt: input.prompt }).prompt;
      const layoutPrompt = boundedText(input.layoutPrompt, LAYOUT_PROMPT_MAX_CHARS);
      if (!layoutPrompt) throw new Error("Layout prompt must be text");
      const theme = VALID_THEMES.includes(input.theme) ? input.theme : "custom";
      const regions = (Array.isArray(input.regions) ? input.regions : [])
        .slice(0, MAX_REGIONS)
        .map((region, index) => ({
          ...region,
          id: `r${index}`,
          name: boundedText(region.name, REGION_NAME_MAX_CHARS, `Region ${index + 1}`),
          role: boundedText(region.role, REGION_ROLE_MAX_CHARS, region.category),
        }));
      return { ...input, prompt, layoutPrompt, theme, regions };
    },
  )
  .handler(async ({ data }) => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const requestSignal = getRequest().signal;
    const { committeeStatuses, runImageCommittee, runImageCommitteeQuorum, runImageProvider } =
      await import("./ensemble.server");
    const strictCommittee = await strictPaidCommitteeRequired();

    const layoutPrompt = [
      "Strict top-down orthographic aerial view, camera looking straight down, square composition.",
      "AAA open-world game satellite map, high contrast distinct terrain biomes, no text, no UI, no labels, no watermark.",
      data.layoutPrompt,
      `Theme: ${data.theme}. Scene: ${data.prompt.slice(0, 200)}.`,
      `Regions present: ${data.regions.map((r) => `${r.name}(${r.category})`).join(", ")}.`,
    ].join(" ");
    assertModelFragment("Terrain layout prompt", layoutPrompt);

    const imageOptions = {
      prompt: layoutPrompt,
      aspectRatio: "1:1",
      signal: requestSignal,
      timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.image,
      dispatch: {
        stage: "layout",
        iteration: 1,
        role: "Canonical top-down semantic-map candidate",
      },
    } satisfies import("./ensemble.server").CommitteeImageOptions;
    const imageCalls = strictCommittee
      ? await runImageCommittee(imageOptions)
      : await runImageCommitteeQuorum(imageOptions, {
          minimumUsable: 2,
          isUsable: (call) => {
            if (!call.ok || !call.value) return false;
            try {
              compatibleInlineImage(call.value);
              return true;
            } catch {
              return false;
            }
          },
        });
    let providers = committeeStatuses(imageCalls);
    const artifacts: EnsembleArtifact[] = [];
    const candidates: ImageCommitteeCandidate[] = [];
    for (const call of imageCalls) {
      const id = evidenceId("layout", 1, call.provider, `candidate-${call.model}`);
      if (!call.ok || !call.value || call.provider === "anthropic") {
        if (call.configured) {
          artifacts.push(
            committeeArtifact({
              id,
              iteration: 1,
              stage: "layout",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Canonical top-down semantic-map candidate",
              status: "error",
              error: call.error,
            }),
          );
        }
        continue;
      }
      try {
        const image = compatibleInlineImage(call.value);
        const artifact = committeeArtifact({
          id,
          iteration: 1,
          stage: "layout",
          provider: call.provider,
          model: call.model,
          ...committeeCallIdentity(call),
          role: "Canonical top-down semantic-map candidate",
          imageDataUrl: await evidenceImageDataUrl(image),
          observations: ["Independent square north-up map proposal"],
        });
        artifacts.push(artifact);
        candidates.push({
          id,
          provider: call.provider,
          model: call.model,
          image,
          artifact,
        });
      } catch (error) {
        artifacts.push(
          committeeArtifact({
            id,
            iteration: 1,
            stage: "layout",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: "Canonical top-down semantic-map candidate",
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (strictCommittee) {
      assertExactImageCommitteeRoster("Canonical layout image committee", candidates);
    }
    if (candidates.length === 0) {
      throw new Error("Every configured image model failed to produce a usable layout candidate");
    }

    let judged = await judgeImageCandidates({
      prompt: `${data.prompt}\n${layoutPrompt}`,
      stage: "layout",
      iteration: 1,
      role: "canonical semantic layout",
      candidates,
      signal: requestSignal,
    });
    providers = mergeProviderStatuses(providers, judged.providers);
    artifacts.push(...judged.artifacts);
    let completedIterations = 1;
    let finalCandidates = candidates;
    if (
      shouldRunAdaptiveImageRepair(
        strictCommittee,
        judged.consensusScore,
        WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS.layout,
      )
    ) {
      const repairPrompt = [
        layoutPrompt,
        "Produce a corrected complete replacement map using the selected candidate as visual context when supported.",
        "Keep north up and camera exactly straight down. Do not add text or perspective.",
        `Cross-model repair findings: ${judged.conflicts.join("; ") || judged.observations.join("; ") || "increase semantic clarity and exact prompt fidelity"}.`,
      ].join("\n");
      const repairCall = await runImageProvider(judged.winner.provider, {
        prompt: repairPrompt,
        referenceImages: [judged.winner.image],
        aspectRatio: "1:1",
        signal: requestSignal,
        timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.image,
        dispatch: {
          stage: "layout",
          iteration: 2,
          role: "Adaptive canonical-map repair from committee feedback",
        },
      });
      providers = mergeProviderStatuses(providers, committeeStatuses([repairCall]));
      if (repairCall.ok && repairCall.value) {
        const image = compatibleInlineImage(repairCall.value);
        const id = evidenceId("layout", 2, repairCall.provider, "adaptive-repair");
        const artifact = committeeArtifact({
          id,
          iteration: 2,
          stage: "layout",
          provider: repairCall.provider,
          model: repairCall.model,
          ...committeeCallIdentity(repairCall),
          role: "Adaptive canonical-map repair from committee feedback",
          imageDataUrl: await evidenceImageDataUrl(image),
          parentArtifactIds: [judged.winner.id],
          observations: ["Second-pass image produced from cross-model critique"],
        });
        artifacts.push(artifact);
        const repaired: ImageCommitteeCandidate = {
          id,
          provider: repairCall.provider as Exclude<EnsembleProviderId, "anthropic">,
          model: repairCall.model,
          image,
          artifact,
        };
        finalCandidates = [judged.winner, repaired];
        judged = await judgeImageCandidates({
          prompt: `${data.prompt}\n${layoutPrompt}`,
          stage: "layout",
          iteration: 2,
          role: "adaptive canonical semantic layout",
          candidates: finalCandidates,
          signal: requestSignal,
        });
        providers = mergeProviderStatuses(providers, judged.providers);
        artifacts.push(...judged.artifacts);
        completedIterations = 2;
      } else if (repairCall.configured) {
        artifacts.push(
          committeeArtifact({
            id: evidenceId("layout", 2, repairCall.provider, "adaptive-repair"),
            iteration: 2,
            stage: "layout",
            provider: repairCall.provider,
            model: repairCall.model,
            ...committeeCallIdentity(repairCall),
            role: "Adaptive canonical-map repair from committee feedback",
            status: "error",
            parentArtifactIds: [judged.winner.id],
            error: repairCall.error,
          }),
        );
      }
      if (strictCommittee && (!repairCall.ok || !repairCall.value)) {
        throw new Error(
          `Adaptive canonical-map repair failed under benchmark enforcement: ${repairCall.error ?? "no usable response"}`,
        );
      }
    }

    for (const candidate of candidates) {
      candidate.artifact.status = candidate.id === judged.winner.id ? "selected" : "rejected";
      candidate.artifact.score =
        candidate.id === judged.winner.id ? judged.consensusScore : candidate.artifact.score;
    }
    for (const candidate of finalCandidates) {
      candidate.artifact.status = candidate.id === judged.winner.id ? "selected" : "rejected";
      candidate.artifact.score =
        candidate.id === judged.winner.id ? judged.consensusScore : candidate.artifact.score;
    }

    const { b64, mime } = judged.winner.image;
    const provider = judged.winner.model;

    const buf = Buffer.from(b64, "base64");
    const isPng = mime.includes("png") || buf.subarray(1, 4).toString() === "PNG";

    let rgba: Uint8Array;
    let width: number;
    let height: number;
    if (isPng) {
      const { PNG } = await import("pngjs");
      const png = PNG.sync.read(buf);
      rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
      width = png.width;
      height = png.height;
    } else {
      const jpeg = await import("jpeg-js");
      const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      rgba = decoded.data as Uint8Array;
      width = decoded.width;
      height = decoded.height;
    }

    const terrain = heightFromLayout(rgba, width, height, data.theme, 256, data.regions);
    if (!terrain.layoutMaskProvenance.passed) {
      throw new Error(
        `Selected canonical map failed source-to-semantic registration (land/water IoU ${terrain.layoutMaskProvenance.landWaterIoU.toFixed(3)}, shoreline F1 ${terrain.layoutMaskProvenance.shorelineBoundaryF1.toFixed(3)})`,
      );
    }

    const layoutImageDataUrl = `data:${isPng ? "image/png" : "image/jpeg"};base64,${b64}`;
    return {
      ...terrain,
      layoutImageDataUrl,
      layoutImageUrl: layoutImageDataUrl,
      sourcePixels: width * height,
      provider,
      ensemble: {
        providers,
        artifacts: boundEnsembleArtifacts(artifacts.slice(-128)),
        selection: {
          chosenLayoutArtifactId: judged.winner.id,
          consensusScore: judged.consensusScore,
          rationale: [
            `Selected ${judged.winner.id} from ${candidates.length} independent image-model candidates`,
            `Completed ${completedIterations} bounded layout iteration${completedIterations === 1 ? "" : "s"}`,
            terrain.layoutMaskProvenance.available
              ? `Canonical image → semantic mask provenance passed at ${(terrain.layoutMaskProvenance.landWaterIoU * 100).toFixed(1)}% land/water IoU and ${(terrain.layoutMaskProvenance.shorelineBoundaryF1 * 100).toFixed(1)}% shoreline F1`
              : "Canonical image → semantic mask provenance is not applicable to this non-water layout",
            ...judged.observations,
            ...judged.conflicts.map((conflict) => `Remaining concern: ${conflict}`),
          ].slice(0, 12),
        },
        completedIterations,
        maxIterations: 2,
      } satisfies EnsembleEvidence,
    };
  });

function parseInlineImageDataUrl(value: string): { b64: string; mime: string } {
  if (value.length > 8_000_000) {
    throw new Error("Reference image exceeds the inline evidence budget");
  }
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("Reference image must be an inline PNG/JPEG/WebP");
  return { mime: match[1]!, b64: match[2]!.replace(/\s+/g, "") };
}

const VISUAL_CONTRACT_SYSTEM = `You are WorldClaw's VisualReferenceJudge. Compare a canonical top-down map with a pre-build perspective and construction concept board for the planned world.

The map is the sole authority for X/Z shoreline, region layout, landmark locations and object counts. The concept board is evidence only for silhouette, visible scale, construction language, material appearance, density, relief restraint, vegetation species, water treatment, atmosphere and camera roles. It is not registered geometry. The same landmark may appear in several panels because each panel depicts another camera; a human-eye view need not contain distant world landmarks. Never copy changed topology or counts from the concept board into the structural contract.

Output ONLY valid JSON with this schema:
{
  "terrainReliefScale": number 0.08..1,
  "terrainMicroDetailScale": number 0..1,
  "vegetationDensityScale": number 0.05..1.5,
  "objectDensityScale": number 0.1..1.5,
  "waterLevelMeters": number -2..0.5,
  "palette": string[] containing at least four CSS hex colors,
  "dominantSilhouettes": string[],
  "compositionNotes": string[],
  "cameras": exactly three entries [{"view":"isometric"|"oblique"|"walk","azimuthDegrees":number,"elevationDegrees":number,"target":[u,v],"distanceScale":number,"projection":"orthographic"|"perspective","fovDegrees":number for perspective,"orthographicScale":number for orthographic visible vertical span/world width,"panelCropNormalized":[x,y,width,height],"description":string}],
  "judgement": {"passed":boolean,"agreementScore":number 0..1,"missingSubjects":string[],"conflicts":string[]}
}

Camera roles are mandatory: isometric MUST be orthographic and include orthographicScale; oblique and walk MUST be perspective and include fovDegrees. Suggest useful crops when the board has clean panels; otherwise use the full normalized frame.

Set passed=false for a material or construction substitution, wrong vegetation species, implausible density or relief, unreadable object piles, flat/painterly non-buildable forms, or a concept board that does not provide useful three-dimensional evidence. Do not fail for map-to-board topology drift or a hero hidden by a camera; the final registered WebGL gate owns those checks. Put minor non-blocking observations in compositionNotes, not conflicts.`;

export function exactHeroLedgerFromSceneSummary(sceneSummary: string): string[] {
  return sceneSummary
    .split("\n")
    .map((line) =>
      /^hero subject=([a-z][a-z0-9 _-]{0,40}) x(\d{1,3}); count authority=user prompt exact$/i.exec(
        line.trim(),
      ),
    )
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => `${match[1]!.trim().toLowerCase()} x${Number(match[2])}`);
}

const FINAL_RENDER_JUDGE_SYSTEM = `You are WorldClaw's FinalRenderJudge. You receive four ordered images of one planned world:
1. canonical top-down layout map (authoritative for shoreline, X/Z region arrangement, landmarks and requested counts),
2. approved pre-build multi-angle reference sheet (guidance for silhouette, construction, materials, density and atmosphere),
3. final renderer north-up orthographic map capture,
4. deterministic contact sheet of the final renderer's registered isometric, oblique and human eye-level walk captures, in that left-to-right order.

Judge the BUILT result, not the attractiveness of the reference. The supplied deterministic checks are the sole authority for map projection/orientation, binary land-water shoreline registration, water leakage/connectivity/vertical separation, camera-matrix validity, exact instance counts, and material-family gates. Never contradict those measurements from visual impression. Score mapRegistration from the deterministic shoreline/camera evidence; judge semantic region and landmark composition under referenceAgreement instead. Score waterIntegrity from the deterministic water evidence; judge boats, docks, and harbor composition under referenceAgreement or heroObjectCoverage instead. Fail mirrored/rotated/cropped map registration, changed semantic regions, missing or duplicated hero subjects, severe count disagreement, substituted construction/materials, unreadable object piles, terrain spikes/tears, or water defects only when the corresponding authoritative evidence supports that claim.

Output ONLY valid JSON:
{
  "passed": boolean,
  "agreementScore": number 0..1,
  "metrics": {
    "mapRegistration": number 0..1,
    "referenceAgreement": number 0..1,
    "heroObjectCoverage": number 0..1,
    "constructionFidelity": number 0..1,
    "waterIntegrity": number 0..1
  },
  "missingSubjects": string[],
  "conflicts": string[],
  "observations": string[]
}

Use missingSubjects only when no recognizable instance of that subject exists in any final view. A present but sparse, flattened, simplified, poorly framed, or materially weak subject belongs in conflicts, not missingSubjects; never repeat the same requirement in both arrays. Construction evidence uses explicit wording such as "1 of 7 fail; 6 pass". Preserve that direction exactly and never reinterpret the passing count as the failing count. Use conflicts only for concrete build defects; use observations for non-blocking differences. Be conservative and do not pass from style similarity alone.`;

export const FINAL_RENDER_AGREEMENT_THRESHOLD = 0.78;

interface DeterministicAuthorityVerdict {
  readonly available: boolean;
  readonly passed: boolean;
  readonly score: number;
}

function finiteField(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The registered masks and camera matrices are stronger evidence than a VLM's
 * visual guess. Keep semantic-region composition in the model's remit, but do
 * not let it relitigate a measured shoreline, orientation, or projection.
 */
function deterministicMapAuthority(
  raw: FinalRenderDeterministicChecksRaw | undefined,
  checks: FinalRenderJudgement["deterministicChecks"],
): DeterministicAuthorityVerdict {
  const available = Boolean(
    raw &&
    typeof raw.mapNorthUp === "boolean" &&
    typeof raw.cameraMatricesPassed === "boolean" &&
    finiteField(raw.landWaterIoU) &&
    finiteField(raw.shorelineBoundaryF1) &&
    finiteField(raw.shorelineP95DistancePixels) &&
    finiteField(raw.maskSize) &&
    typeof raw.orientationSuspicious === "boolean",
  );
  if (!available || !checks) return { available: false, passed: false, score: 0 };

  const shorelineTolerance = 6 * (checks.maskSize / 1024);
  const distanceScore =
    checks.shorelineP95DistancePixels <= shorelineTolerance
      ? 1
      : Math.max(0, shorelineTolerance / Math.max(1, checks.shorelineP95DistancePixels));
  const binaryValidity =
    checks.mapNorthUp && checks.cameraMatricesPassed && !checks.orientationSuspicious ? 1 : 0;
  const score = Math.min(
    checks.landWaterIoU,
    checks.shorelineBoundaryF1,
    distanceScore,
    binaryValidity,
  );
  return {
    available: true,
    passed:
      checks.mapNorthUp &&
      checks.cameraMatricesPassed &&
      !checks.orientationSuspicious &&
      checks.landWaterIoU >= 0.95 &&
      checks.shorelineBoundaryF1 >= 0.95 &&
      checks.shorelineP95DistancePixels <= shorelineTolerance,
    score,
  };
}

/** Water topology and vertical separation are measured from registered data. */
function deterministicWaterAuthority(
  raw: FinalRenderDeterministicChecksRaw | undefined,
  checks: FinalRenderJudgement["deterministicChecks"],
): DeterministicAuthorityVerdict {
  const available = Boolean(
    raw &&
    finiteField(raw.waterMaxMeters) &&
    finiteField(raw.landMinMeters) &&
    finiteField(raw.waterLevelMeters) &&
    finiteField(raw.waterIoU) &&
    finiteField(raw.falseWaterOnLandRatio) &&
    finiteField(raw.missingCanonicalWaterRatio) &&
    finiteField(raw.referenceWaterComponents) &&
    finiteField(raw.renderedWaterComponents),
  );
  if (!available || !checks) return { available: false, passed: false, score: 0 };

  const verticallySeparated =
    checks.waterMaxMeters !== null &&
    checks.landMinMeters !== null &&
    checks.waterMaxMeters <= checks.waterLevelMeters - 0.2 &&
    checks.landMinMeters >= checks.waterLevelMeters;
  const topologyPassed =
    checks.referenceWaterComponents === checks.renderedWaterComponents &&
    checks.falseWaterOnLandRatio <= 0.005 &&
    checks.missingCanonicalWaterRatio <= 0.01;
  const score = Math.min(
    checks.waterIoU,
    1 - checks.falseWaterOnLandRatio,
    1 - checks.missingCanonicalWaterRatio,
    verticallySeparated && topologyPassed ? 1 : 0,
  );
  return {
    available: true,
    passed: verticallySeparated && topologyPassed && checks.waterIoU >= 0.95,
    score,
  };
}

const MAP_AUTHORITY_CLAIM_PATTERNS = [
  /\b(?:map|capture|shoreline|coastline|island silhouette|land[- /]?water)\b.{0,100}\b(?:mismatch|does not match|wrong|drift|registration|mirror|reflection|rotat|crop|north[- ]?up|changed|failure)\b/i,
  /\b(?:mismatch|does not match|wrong|drift|registration|mirror|reflection|rotat|crop|changed)\w*\b.{0,100}\b(?:map|capture|shoreline|coastline|island silhouette|land[- /]?water)\b/i,
];
const WATER_AUTHORITY_CLAIM_PATTERNS = [
  /\bwater\b.{0,100}\b(?:climb|wall|jagged|disconnect|disappear|leak|integrity|component|tear)\w*\b/i,
  /\b(?:false|missing|disconnected|jagged)\s+water\b/i,
  /\bterrain\b.{0,80}\b(?:below|penetrat)\w*\b.{0,40}\bwater\b/i,
];
const SEMANTIC_COMPOSITION_PATTERN =
  /\b(?:region|town|settlement|harbou?r|boat|berth|landmark|forest|grove|ridge|building|pagoda|torii|dock|beach|bamboo|cherry|volcanic|object|islet)\w*\b/i;

function claimMatches(claim: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(claim));
}

export function normalizeConstructionEvidenceStatement(statement: string): string {
  const match = /^(.{1,100}?):\s*(\d{1,4})\s*\/\s*(\d{1,4})\s+resolve\s+required\s+(.+)$/i.exec(
    statement.trim(),
  );
  if (!match) return statement.trim();
  const passed = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(passed) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    passed > total
  ) {
    return statement.trim();
  }
  const prefix = `${match[1]!.trim()}: ${total - passed} of ${total} fail required `;
  const suffix = `; ${passed} pass`;
  const requirement = match[4]!.trim().slice(0, Math.max(0, 240 - prefix.length - suffix.length));
  return `${prefix}${requirement}${suffix}`;
}

function normalizeConstructionEvidenceList(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  return boundedStringList(value, maxItems, maxChars).map((statement) =>
    boundedText(normalizeConstructionEvidenceStatement(statement), maxChars),
  );
}

function normalizeDeterministicChecksForJudge(
  checks: FinalRenderDeterministicChecksRaw,
): FinalRenderDeterministicChecksRaw {
  return {
    ...checks,
    constructionConflicts: normalizeConstructionEvidenceList(checks.constructionConflicts, 32, 240),
    failures: boundedStringList(checks.failures, 96, 240).map((statement) =>
      boundedText(normalizeConstructionEvidenceStatement(statement), 240),
    ),
  };
}

function canonicalConstructionSubject(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\bbuildings\b/g, "building")
    .replace(/\bhuts\b/g, "hut")
    .replace(/\bwatchtowers\b/g, "watchtower")
    .replace(/\bpagodas\b/g, "pagoda")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

interface ConstructionCountEvidence {
  readonly subject: string;
  readonly total: number;
  readonly failed: number;
  readonly passed: number;
}

function constructionCountEvidence(statements: readonly string[]): ConstructionCountEvidence[] {
  const evidence: ConstructionCountEvidence[] = [];
  for (const statement of statements) {
    const match =
      /^(.{1,100}?):\s*(\d{1,4})\s+of\s+(\d{1,4})\s+fail\s+required\s+.+;\s*(\d{1,4})\s+pass$/i.exec(
        statement,
      );
    if (!match) continue;
    evidence.push({
      subject: canonicalConstructionSubject(match[1]!),
      failed: Number(match[2]),
      total: Number(match[3]),
      passed: Number(match[4]),
    });
  }
  return evidence;
}

function filterInvertedConstructionClaims(
  claims: readonly string[],
  deterministicConstructionConflicts: readonly string[],
): { blocking: string[]; observations: string[] } {
  const evidence = constructionCountEvidence(deterministicConstructionConflicts);
  if (evidence.length === 0) return { blocking: [...claims], observations: [] };
  const blocking: string[] = [];
  const observations: string[] = [];
  for (const claim of claims) {
    const match = /^(.{1,100}?):\s*(?:only\s+)?(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})\s+fail\b/i.exec(
      claim,
    );
    if (!match) {
      blocking.push(claim);
      continue;
    }
    const subject = canonicalConstructionSubject(match[1]!);
    const statedFailed = Number(match[2]);
    const total = Number(match[3]);
    const authoritative = evidence.find(
      (entry) =>
        entry.total === total &&
        (entry.subject.includes(subject) || subject.includes(entry.subject)),
    );
    if (!authoritative || authoritative.failed === statedFailed) {
      blocking.push(claim);
      continue;
    }
    observations.push(
      `VLM construction-count inversion superseded by deterministic evidence: ${authoritative.failed} of ${authoritative.total} fail; ${authoritative.passed} pass for ${match[1]!.trim()}`,
    );
  }
  return { blocking, observations };
}

const SEMANTIC_TOKEN_STOP_WORDS = new Set([
  "with",
  "from",
  "that",
  "this",
  "required",
  "clearly",
  "formed",
  "terrain",
  "final",
  "render",
  "planned",
  "canonical",
  "reference",
]);

function semanticTokens(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !SEMANTIC_TOKEN_STOP_WORDS.has(token)),
  );
}

function semanticClaimsOverlap(subject: string, claim: string): boolean {
  const subjectTokens = semanticTokens(subject);
  const claimTokens = semanticTokens(claim);
  if (subjectTokens.size === 0 || claimTokens.size === 0) return false;
  let overlap = 0;
  for (const token of subjectTokens) {
    if (claimTokens.has(token)) overlap++;
  }
  return overlap >= Math.min(2, subjectTokens.size);
}

function consolidateMissingSubjectClaims(
  missingSubjects: readonly string[],
  conflicts: readonly string[],
): { missingSubjects: string[]; observations: string[] } {
  const retained: string[] = [];
  const observations: string[] = [];
  for (const subject of missingSubjects) {
    if (conflicts.some((conflict) => semanticClaimsOverlap(subject, conflict))) {
      observations.push(
        `Missing-subject label consolidated into its semantic quality conflict: ${subject}`,
      );
    } else {
      retained.push(subject);
    }
  }
  return { missingSubjects: retained, observations };
}

function authorityFilteredClaims(
  claims: readonly string[],
  mapAuthorityPassed: boolean,
  waterAuthorityPassed: boolean,
): { blocking: string[]; observations: string[] } {
  const blocking: string[] = [];
  const observations: string[] = [];
  for (const claim of claims) {
    const contradictsMap = mapAuthorityPassed && claimMatches(claim, MAP_AUTHORITY_CLAIM_PATTERNS);
    const contradictsWater =
      waterAuthorityPassed && claimMatches(claim, WATER_AUTHORITY_CLAIM_PATTERNS);
    if (!contradictsMap && !contradictsWater) {
      blocking.push(claim);
      continue;
    }

    const domain =
      contradictsMap && contradictsWater ? "map/water" : contradictsMap ? "map" : "water";
    observations.push(
      `Non-blocking ${domain} claim superseded by registered deterministic evidence: ${claim}`,
    );
    if (SEMANTIC_COMPOSITION_PATTERN.test(claim)) {
      blocking.push(
        `Vision judge reports a semantic region/composition disagreement independent of the deterministically verified ${domain} facts`,
      );
    }
  }
  return {
    blocking: [...new Set(blocking)],
    observations: [...new Set(observations)],
  };
}

export function normalizeFinalRenderJudgement(
  raw: FinalRenderJudgementRaw,
  checksRaw?: FinalRenderDeterministicChecksRaw,
): FinalRenderJudgement {
  const score = (value: unknown): number => Math.min(1, Math.max(0, finiteNumber(value, 0)));
  const rawMetrics = {
    mapRegistration: score(raw.metrics?.mapRegistration),
    referenceAgreement: score(raw.metrics?.referenceAgreement),
    heroObjectCoverage: score(raw.metrics?.heroObjectCoverage),
    constructionFidelity: score(raw.metrics?.constructionFidelity),
    waterIntegrity: score(raw.metrics?.waterIntegrity),
  };
  const rawConflicts = boundedStringList(raw.conflicts, 32, 240).map((statement) =>
    boundedText(normalizeConstructionEvidenceStatement(statement), 240),
  );
  const consolidatedMissingSubjects = consolidateMissingSubjectClaims(
    boundedStringList(raw.missingSubjects, 32, 160),
    rawConflicts,
  );
  const rawMissingSubjects = consolidatedMissingSubjects.missingSubjects;
  const deterministicChecks = checksRaw
    ? {
        objectSatisfactionRatio: score(checksRaw.objectSatisfactionRatio),
        heroRequiredByKind: Object.fromEntries(
          Object.entries(checksRaw.heroRequiredByKind ?? {})
            .slice(0, 32)
            .map(([kind, count]) => [
              boundedText(kind, 80),
              Math.min(64, Math.max(0, Math.round(finiteNumber(count, 0)))),
            ])
            .filter(([kind]) => Boolean(kind)),
        ),
        missingHeroKinds: boundedStringList(checksRaw.missingHeroKinds, 32, 80),
        heroCountFailures: boundedStringList(checksRaw.heroCountFailures, 32, 160),
        heroVisibilityFailures: boundedStringList(checksRaw.heroVisibilityFailures, 64, 200),
        constructionConflicts: normalizeConstructionEvidenceList(
          checksRaw.constructionConflicts,
          32,
          240,
        ),
        materialFamilyMacroF1: score(checksRaw.materialFamilyMacroF1),
        waterMaxMeters:
          checksRaw.waterMaxMeters === null || checksRaw.waterMaxMeters === undefined
            ? null
            : finiteNumber(checksRaw.waterMaxMeters, 0),
        landMinMeters:
          checksRaw.landMinMeters === null || checksRaw.landMinMeters === undefined
            ? null
            : finiteNumber(checksRaw.landMinMeters, 0),
        waterLevelMeters: finiteNumber(checksRaw.waterLevelMeters, -0.35),
        mapNorthUp: checksRaw.mapNorthUp === true,
        cameraMatricesPassed: checksRaw.cameraMatricesPassed === true,
        compiledSlotsMatched: checksRaw.compiledSlotsMatched === true,
        depthPassesFinite: checksRaw.depthPassesFinite === true,
        landWaterIoU: score(checksRaw.landWaterIoU),
        landIoU: score(checksRaw.landIoU),
        waterIoU: score(checksRaw.waterIoU),
        shorelineBoundaryF1: score(checksRaw.shorelineBoundaryF1),
        shorelineP95DistancePixels: Math.max(
          0,
          finiteNumber(checksRaw.shorelineP95DistancePixels, Number.MAX_SAFE_INTEGER),
        ),
        maskSize: Math.min(4096, Math.max(1, Math.round(finiteNumber(checksRaw.maskSize, 1)))),
        orientationSuspicious: checksRaw.orientationSuspicious === true,
        bestAlternateOrientation: boundedText(checksRaw.bestAlternateOrientation, 40, "unknown"),
        alternateOrientationImprovement: Math.max(
          -1,
          Math.min(1, finiteNumber(checksRaw.alternateOrientationImprovement, 0)),
        ),
        leakageBoundaryTolerancePixels: Math.max(
          0,
          finiteNumber(checksRaw.leakageBoundaryTolerancePixels, 0),
        ),
        rawFalseWaterOnLandRatio: score(checksRaw.rawFalseWaterOnLandRatio),
        falseWaterOnLandRatio: score(checksRaw.falseWaterOnLandRatio),
        rawMissingCanonicalWaterRatio: score(checksRaw.rawMissingCanonicalWaterRatio),
        missingCanonicalWaterRatio: score(checksRaw.missingCanonicalWaterRatio),
        referenceWaterComponents: Math.max(
          0,
          Math.round(finiteNumber(checksRaw.referenceWaterComponents, 0)),
        ),
        renderedWaterComponents: Math.max(
          0,
          Math.round(finiteNumber(checksRaw.renderedWaterComponents, 0)),
        ),
        failures: boundedStringList(checksRaw.failures, 96, 240).map((statement) =>
          boundedText(normalizeConstructionEvidenceStatement(statement), 240),
        ),
      }
    : undefined;
  const mapAuthority = deterministicMapAuthority(checksRaw, deterministicChecks);
  const waterAuthority = deterministicWaterAuthority(checksRaw, deterministicChecks);
  const metrics = {
    ...rawMetrics,
    mapRegistration: mapAuthority.available ? mapAuthority.score : rawMetrics.mapRegistration,
    waterIntegrity: waterAuthority.available ? waterAuthority.score : rawMetrics.waterIntegrity,
  };
  const constructionClaimFilter = filterInvertedConstructionClaims(
    rawConflicts,
    deterministicChecks?.constructionConflicts ?? [],
  );
  const rawClaimFilter = authorityFilteredClaims(
    constructionClaimFilter.blocking,
    mapAuthority.passed,
    waterAuthority.passed,
  );
  const missingSubjectFilter = authorityFilteredClaims(
    rawMissingSubjects,
    mapAuthority.passed,
    waterAuthority.passed,
  );
  const missingSubjects = missingSubjectFilter.blocking;
  const deterministicConflicts: string[] = [];
  if (deterministicChecks) {
    deterministicConflicts.push(...deterministicChecks.failures);
    if (deterministicChecks.missingHeroKinds.length > 0) {
      deterministicConflicts.push(
        `Deterministic object coverage is missing hero kinds: ${deterministicChecks.missingHeroKinds.join(", ")}`,
      );
    }
    deterministicConflicts.push(...deterministicChecks.heroCountFailures);
    deterministicConflicts.push(...deterministicChecks.heroVisibilityFailures);
    deterministicConflicts.push(...deterministicChecks.constructionConflicts);
    if (deterministicChecks.objectSatisfactionRatio < 0.95) {
      deterministicConflicts.push(
        `Requested-object satisfaction is only ${Math.round(deterministicChecks.objectSatisfactionRatio * 100)}%`,
      );
    }
    if (deterministicChecks.materialFamilyMacroF1 < 0.9) {
      deterministicConflicts.push(
        "Required construction material families do not match the resolved GLB variants",
      );
    }
    if (
      deterministicChecks.waterMaxMeters !== null &&
      deterministicChecks.waterMaxMeters > deterministicChecks.waterLevelMeters - 0.2
    ) {
      deterministicConflicts.push(
        "Water terrain rises too close to or above the visible water plane",
      );
    }
    if (
      deterministicChecks.landMinMeters !== null &&
      deterministicChecks.landMinMeters < deterministicChecks.waterLevelMeters
    ) {
      deterministicConflicts.push("Land terrain penetrates below the visible water plane");
    }
    if (!deterministicChecks.mapNorthUp) {
      deterministicConflicts.push("Registered map camera is not verified north-up");
    }
    if (!deterministicChecks.cameraMatricesPassed) {
      deterministicConflicts.push(
        "One or more registered camera matrices failed handedness/finite checks",
      );
    }
    if (!deterministicChecks.compiledSlotsMatched) {
      deterministicConflicts.push("Compiled GLB instance slots do not match the expected objects");
    }
    if (!deterministicChecks.depthPassesFinite) {
      deterministicConflicts.push("One or more registered depth passes is empty or non-finite");
    }
    if (deterministicChecks.landWaterIoU < 0.95) {
      deterministicConflicts.push(
        "Canonical and rendered land/water masks fall below 0.95 macro IoU",
      );
    }
    if (deterministicChecks.shorelineBoundaryF1 < 0.95) {
      deterministicConflicts.push("Rendered shoreline boundary F1 falls below 0.95");
    }
    if (
      deterministicChecks.shorelineP95DistancePixels >
      6 * (deterministicChecks.maskSize / 1024)
    ) {
      deterministicConflicts.push(
        "Rendered shoreline P95 distance exceeds the registered tolerance",
      );
    }
    if (deterministicChecks.orientationSuspicious) {
      deterministicConflicts.push(
        `A ${deterministicChecks.bestAlternateOrientation} map transform matches better than identity`,
      );
    }
    if (deterministicChecks.falseWaterOnLandRatio > 0.005) {
      deterministicConflicts.push("Rendered water exceeds the 0.5% canonical-land tolerance");
    }
    if (deterministicChecks.missingCanonicalWaterRatio > 0.01) {
      deterministicConflicts.push("Rendered terrain misses more than 1% of canonical water");
    }
    if (
      deterministicChecks.referenceWaterComponents !== deterministicChecks.renderedWaterComponents
    ) {
      deterministicConflicts.push(
        "Rendered water connected components differ from the canonical map",
      );
    }
  }
  const conflicts = [...new Set([...rawClaimFilter.blocking, ...deterministicConflicts])];
  // Once structural axes are normalized to registered evidence, recompute the
  // aggregate from those explicit axes. Otherwise an opaque low overall score
  // can double-count the same map/water hallucination and still veto the run.
  const agreementScore =
    mapAuthority.available || waterAuthority.available
      ? Object.values(metrics).reduce((sum, value) => sum + value, 0) /
        Object.values(metrics).length
      : score(raw.agreementScore);
  const passed =
    (!checksRaw || mapAuthority.available || waterAuthority.available || raw.passed === true) &&
    agreementScore >= FINAL_RENDER_AGREEMENT_THRESHOLD &&
    metrics.mapRegistration >= 0.82 &&
    metrics.referenceAgreement >= 0.74 &&
    metrics.heroObjectCoverage >= 0.85 &&
    metrics.constructionFidelity >= 0.7 &&
    metrics.waterIntegrity >= 0.88 &&
    missingSubjects.length === 0 &&
    conflicts.length === 0;

  return {
    source: "gemini-3.6-flash",
    passed,
    agreementScore,
    metrics,
    missingSubjects,
    conflicts,
    observations: [
      ...new Set([
        ...boundedStringList(raw.observations, 32, 240),
        ...constructionClaimFilter.observations,
        ...consolidatedMissingSubjects.observations,
        ...rawClaimFilter.observations,
        ...missingSubjectFilter.observations,
      ]),
    ].slice(0, 32),
    deterministicChecks,
  };
}

export const generateVisualReferenceContract = createServerFn({ method: "POST" })
  .middleware([paidInferenceRunMiddleware])
  .validator(
    (input: {
      prompt: string;
      theme: SceneTheme;
      visualStyle: VisualStyle;
      sceneSummary: string;
      layoutImageDataUrl: string;
    }) => {
      const prompt = validatePromptInput({ prompt: input.prompt }).prompt;
      const theme = VALID_THEMES.includes(input.theme) ? input.theme : "custom";
      const visualStyle = VALID_STYLES.includes(input.visualStyle) ? input.visualStyle : "stylized";
      const sceneSummary = boundedText(input.sceneSummary, 5_000);
      if (!sceneSummary) throw new Error("Visual reference needs a scene summary");
      // Validate before crossing the provider boundary; keep the original URL
      // because createServerFn serialization still needs it in the handler.
      parseInlineImageDataUrl(input.layoutImageDataUrl);
      return {
        prompt,
        theme,
        visualStyle,
        sceneSummary,
        layoutImageDataUrl: input.layoutImageDataUrl,
      };
    },
  )
  .handler(async ({ data }) => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const requestSignal = getRequest().signal;
    const {
      committeeStatuses,
      runImageCommitteeQuorum,
      runImageProvider,
      runVisionCommittee,
      runVisionCommitteeQuorum,
    } = await import("./ensemble.server");
    const { parseJsonFromLlm } = await import("./xai.server");
    const strictCommittee = await strictPaidCommitteeRequired();

    const layout = parseInlineImageDataUrl(data.layoutImageDataUrl);
    const exactHeroLedger = exactHeroLedgerFromSceneSummary(data.sceneSummary);
    const exactHeroConstraint =
      exactHeroLedger.length > 0
        ? `STRUCTURAL HERO LEDGER FROM THE MAP: ${exactHeroLedger.join(", ")}. Show these hero designs clearly somewhere in the board. The same world landmark may reappear across camera panels; those repeated depictions are not extra objects.`
        : "Show the planned hero silhouettes clearly without inventing unrelated landmarks.";
    const basePrompt = [
      "Use the attached top-down map as the immutable structural reference; do not reinterpret its object inventory.",
      "Create ONE clean 16:9 pre-build perspective and construction concept board. Include a useful orthographic isometric overview, an elevated oblique perspective, and a human eye-level architectural/material view. A three-panel strip is preferred, but a clean technical board layout is acceptable. Do not add labels.",
      "Preserve the map's identity and requested architectural language as closely as possible, while prioritizing actionable 3D silhouette, material, construction, scale, water, vegetation, and atmosphere evidence. The map remains authoritative wherever a perspective concept drifts.",
      exactHeroConstraint,
      data.visualStyle === "realistic"
        ? "Use materially grounded realistic PBR lighting while keeping every planned silhouette and construction system explicit."
        : "Use premium stylized geometric PBR game art: clean faceted landforms, authored three-dimensional vegetation and architecture, strong material contrast and readable silhouettes. Do not make it photographic or painterly.",
      "Make walls, openings, frames and roofs visibly constructed: honor specified thatch, exposed timber beams, plaster infill, brick, stone, slate or tile, recessed doors and windows. Keep objects separated and readable.",
      "Respect traversability and physical construction: bridges span water between dry banks, boats remain separated in navigable water, settlements have streets/plazas rather than object piles, and terrain does not form noisy spikes.",
      "No text, captions, labels, UI, borders or watermark.",
      `Theme=${data.theme}; visual style=${data.visualStyle}; user prompt=${boundedText(data.prompt, 700)}`,
      `Authoritative scene contract=${data.sceneSummary}`,
    ].join("\n");
    assertModelFragment("Multi-angle reference prompt", basePrompt);

    const producers = [
      { provider: "xai" as const, model: undefined },
      {
        provider: "gemini" as const,
        model: process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3-pro-image",
      },
      {
        provider: "openai" as const,
        model: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
      },
    ];
    const artifacts: EnsembleArtifact[] = [];
    let providers: EnsembleProviderStatus[] = [];
    const sheetCandidates: ImageCommitteeCandidate[] = [];

    const triptychOptions = {
      prompt: basePrompt,
      referenceImages: [layout],
      aspectRatio: "16:9",
      signal: requestSignal,
      timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.image,
      dispatch: {
        stage: "multiview",
        iteration: 1,
        role: "Provider-authored pre-build perspective and construction concept board",
      },
    } satisfies import("./ensemble.server").CommitteeImageOptions;
    const triptychCalls = strictCommittee
      ? await Promise.all(
          producers.map((producer) =>
            runImageProvider(producer.provider, {
              ...triptychOptions,
              model: producer.model,
            }),
          ),
        )
      : await runImageCommitteeQuorum(triptychOptions, {
          minimumUsable: 2,
          isUsable: (call) => {
            if (!call.ok || !call.value) return false;
            try {
              compatibleInlineImage(call.value);
              return true;
            } catch {
              return false;
            }
          },
        });
    providers = mergeProviderStatuses(providers, committeeStatuses(triptychCalls));
    for (const call of triptychCalls) {
      if (!call.ok || !call.value || call.provider === "anthropic") {
        if (call.configured) {
          artifacts.push(
            committeeArtifact({
              id: evidenceId("multiview", 1, call.provider, `${call.model}-contact-sheet`),
              iteration: 1,
              stage: "multiview",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Provider-authored pre-build perspective and construction concept board",
              status: "error",
              error: call.error,
            }),
          );
        }
        continue;
      }
      const image = compatibleInlineImage(call.value);
      const provider = call.provider as Exclude<EnsembleProviderId, "anthropic">;
      const id = evidenceId("multiview", 1, provider, `${call.model}-concept-board`);
      const artifact = committeeArtifact({
        id,
        iteration: 1,
        stage: "multiview",
        provider,
        model: call.model,
        ...committeeCallIdentity(call),
        role: "Provider-authored pre-build perspective and construction concept board",
        imageDataUrl: await evidenceImageDataUrl(image),
        observations: [
          "Full provider output retained without assuming a strip, grid, or crop layout",
          "Canonical map remains the structural source of truth",
        ],
      });
      artifacts.push(artifact);
      sheetCandidates.push({ id, provider, model: call.model, image, artifact });
    }
    if (strictCommittee) {
      assertExactImageCommitteeRoster("Pre-build appearance image committee", sheetCandidates);
    }
    if (sheetCandidates.length === 0) {
      const error = "No image model produced a usable pre-build perspective concept board";
      const visualContract = localVisualContract(data.theme);
      return {
        ok: false as const,
        error,
        perspectiveImageDataUrl: null,
        perspectiveProvider: null,
        visualAnalysisProvider: null,
        visualContract: {
          ...visualContract,
          source: "model-committee" as const,
          judgement: {
            passed: false,
            agreementScore: 0,
            missingSubjects: [],
            conflicts: [error],
          },
        },
        ensemble: {
          providers,
          artifacts: boundEnsembleArtifacts(artifacts.slice(-128)),
          selection: {
            consensusScore: 0,
            rationale: [error],
          },
          completedIterations: 1,
          maxIterations: 2,
        } satisfies EnsembleEvidence,
      };
    }

    let judged = await judgeImageCandidates({
      prompt: `${data.sceneSummary}\n${basePrompt}`,
      stage: "multiview",
      iteration: 1,
      role: "pre-build perspective, construction, material, and atmosphere concept",
      candidates: sheetCandidates,
      signal: requestSignal,
    });
    providers = mergeProviderStatuses(providers, judged.providers);
    artifacts.push(...judged.artifacts);
    let completedIterations = 1;
    let finalSheets = sheetCandidates;

    if (
      shouldRunAdaptiveImageRepair(
        strictCommittee,
        judged.consensusScore,
        WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS.appearance,
      )
    ) {
      const repairPrompt = [
        basePrompt,
        "This is bounded repair iteration 2 of 2. Produce one complete replacement 16:9 concept board, not annotations and not separate files.",
        "Keep the top-down map authoritative. Repair only the concrete silhouette, construction, material, species, scale, terrain, water, atmosphere, and viewpoint defects identified by the committee.",
        `Cross-model findings: ${judged.conflicts.join("; ") || judged.observations.join("; ") || "increase buildable construction and material specificity"}.`,
      ].join("\n");
      const repairCall = await runImageProvider(judged.winner.provider, {
        prompt: repairPrompt,
        model: judged.winner.model,
        referenceImages: [layout, judged.winner.image],
        aspectRatio: "16:9",
        signal: requestSignal,
        timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.image,
        dispatch: {
          stage: "multiview",
          iteration: 2,
          role: "Adaptive pre-build perspective and construction concept board",
        },
      });
      providers = mergeProviderStatuses(providers, committeeStatuses([repairCall]));
      const id = evidenceId(
        "multiview",
        2,
        repairCall.provider,
        `${repairCall.model}-adaptive-concept-board`,
      );
      if (repairCall.ok && repairCall.value && repairCall.provider !== "anthropic") {
        const repairedImage = compatibleInlineImage(repairCall.value);
        const artifact = committeeArtifact({
          id,
          iteration: 2,
          stage: "multiview",
          provider: repairCall.provider,
          model: repairCall.model,
          ...committeeCallIdentity(repairCall),
          role: "Adaptive pre-build perspective and construction concept board",
          imageDataUrl: await evidenceImageDataUrl(repairedImage),
          parentArtifactIds: [judged.winner.id],
          observations: [
            "Full replacement concept board generated from cross-model critique",
            "Canonical map remains structurally authoritative",
          ],
        });
        artifacts.push(artifact);
        const repairedSheet: ImageCommitteeCandidate = {
          id,
          provider: repairCall.provider as Exclude<EnsembleProviderId, "anthropic">,
          model: repairCall.model,
          image: repairedImage,
          artifact,
        };
        finalSheets = [judged.winner, repairedSheet];
        judged = await judgeImageCandidates({
          prompt: `${data.sceneSummary}\n${basePrompt}`,
          stage: "multiview",
          iteration: 2,
          role: "adaptive pre-build perspective and construction concept",
          candidates: finalSheets,
          signal: requestSignal,
        });
        providers = mergeProviderStatuses(providers, judged.providers);
        artifacts.push(...judged.artifacts);
        completedIterations = 2;
      } else if (repairCall.configured) {
        artifacts.push(
          committeeArtifact({
            id,
            iteration: 2,
            stage: "multiview",
            provider: repairCall.provider,
            model: repairCall.model,
            ...committeeCallIdentity(repairCall),
            role: "Adaptive pre-build perspective and construction concept board",
            status: "error",
            parentArtifactIds: [judged.winner.id],
            error: repairCall.error,
          }),
        );
      }
      if (strictCommittee && (!repairCall.ok || !repairCall.value)) {
        throw new Error(
          `Adaptive appearance-board repair failed under benchmark enforcement: ${repairCall.error ?? "no usable response"}`,
        );
      }
    }

    for (const sheet of sheetCandidates) {
      sheet.artifact.status = sheet.id === judged.winner.id ? "selected" : "rejected";
      if (sheet.id === judged.winner.id) sheet.artifact.score = judged.consensusScore;
    }
    for (const sheet of finalSheets) {
      sheet.artifact.status = sheet.id === judged.winner.id ? "selected" : "rejected";
      if (sheet.id === judged.winner.id) sheet.artifact.score = judged.consensusScore;
    }
    const contractOptions = {
      system: VISUAL_CONTRACT_SYSTEM,
      user: [
        "Image 1 is the authoritative top-down structural map. Image 2 is the committee-selected pre-build appearance and perspective concept board.",
        `Planned scene: ${data.sceneSummary}`,
        "Extract a conservative visual/build contract without copying structural drift from Image 2. Final WebGL map registration and exact counts are validated later from deterministic captures.",
      ].join("\n"),
      images: [layout, compatibleInlineImage(judged.winner.image)],
      maxTokens: 12_000,
      signal: requestSignal,
      timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.vision,
      dispatch: {
        stage: "critique",
        iteration: completedIterations,
        role: "Selected pre-build appearance-contract judge",
      },
    } satisfies import("./ensemble.server").CommitteeVisionOptions;
    const contractCalls = strictCommittee
      ? await runVisionCommittee(contractOptions)
      : await runVisionCommitteeQuorum(contractOptions, {
          minimumUsable: 2,
          isUsable: (call) => {
            if (!call.ok || !call.value) return false;
            try {
              normalizeVisualContract(
                parseJsonFromLlm<VisualContractRaw>(call.value.text),
                data.theme,
              );
              return true;
            } catch {
              return false;
            }
          },
        });
    providers = mergeProviderStatuses(providers, committeeStatuses(contractCalls));
    const contracts: Array<{
      contract: VisualContract;
      provider: EnsembleProviderId;
      model: string;
    }> = [];
    const contractFailures: string[] = [];
    for (const call of contractCalls) {
      const id = evidenceId("critique", completedIterations, call.provider, "visual-contract");
      if (!call.ok || !call.value) {
        if (call.configured) {
          const failure = `${call.model} visual contract unavailable: ${call.error ?? "unknown error"}`;
          contractFailures.push(failure);
          artifacts.push(
            committeeArtifact({
              id,
              iteration: completedIterations,
              stage: "critique",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Selected pre-build appearance-contract judge",
              status: "error",
              parentArtifactIds: [judged.winner.id],
              error: call.error,
              conflicts: [failure],
            }),
          );
        }
        continue;
      }
      try {
        const contract = {
          ...normalizeVisualContract(
            parseJsonFromLlm<VisualContractRaw>(call.value.text),
            data.theme,
          ),
          source: "model-committee" as const,
        };
        contracts.push({ contract, provider: call.provider, model: call.model });
        artifacts.push(
          committeeArtifact({
            id,
            iteration: completedIterations,
            stage: "critique",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: "Selected pre-build appearance-contract judge",
            parentArtifactIds: [judged.winner.id],
            structuredOutput: JSON.stringify(contract),
            score: contract.judgement?.agreementScore,
            passed: contract.judgement?.passed,
            observations: contract.compositionNotes,
            conflicts: [
              ...(contract.judgement?.missingSubjects ?? []),
              ...(contract.judgement?.conflicts ?? []),
            ],
          }),
        );
      } catch (error) {
        const failure = `${call.model} returned an invalid visual contract`;
        contractFailures.push(failure);
        artifacts.push(
          committeeArtifact({
            id,
            iteration: completedIterations,
            stage: "critique",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: "Selected pre-build appearance-contract judge",
            status: "error",
            parentArtifactIds: [judged.winner.id],
            error: error instanceof Error ? error.message : String(error),
            conflicts: [failure],
          }),
        );
      }
    }
    if (strictCommittee) {
      assertExactCommitteeRoster(
        "Selected pre-build appearance-contract committee",
        contracts.map((entry) => entry.provider),
        ["xai", "gemini", "openai", "anthropic"],
      );
    }
    if (contracts.length < 2) {
      const error = "Fewer than two independent vision models produced a valid visual contract";
      const strongestAvailable = contracts[0]?.contract ?? localVisualContract(data.theme);
      return {
        ok: false as const,
        error,
        perspectiveImageDataUrl: inlineImageDataUrl(judged.winner.image),
        perspectiveProvider: `${judged.winner.model} committee-selected`,
        visualAnalysisProvider:
          contracts.map((entry) => entry.model).join(" + ") || "model committee unavailable",
        visualContract: {
          ...strongestAvailable,
          source: "model-committee" as const,
          judgement: {
            passed: false,
            agreementScore: Math.min(
              0.77,
              ...contracts.map((entry) => entry.contract.judgement?.agreementScore ?? 0),
            ),
            missingSubjects: [
              ...new Set(
                contracts.flatMap((entry) => entry.contract.judgement?.missingSubjects ?? []),
              ),
            ],
            conflicts: [...new Set([error, ...contractFailures, ...judged.conflicts])],
          },
        },
        ensemble: {
          providers,
          artifacts: boundEnsembleArtifacts(artifacts.slice(-128)),
          selection: {
            chosenMultiviewArtifactId: judged.winner.id,
            consensusScore: 0,
            rationale: [error, ...judged.observations].slice(0, 12),
          },
          completedIterations,
          maxIterations: 2,
        } satisfies EnsembleEvidence,
      };
    }
    const median = (values: number[]): number => {
      const ordered = [...values].sort((a, b) => a - b);
      const middle = Math.floor(ordered.length / 2);
      return ordered.length % 2
        ? ordered[middle]!
        : (ordered[middle - 1]! + ordered[middle]!) * 0.5;
    };
    const missingSubjects = [
      ...new Set(contracts.flatMap((entry) => entry.contract.judgement?.missingSubjects ?? [])),
    ];
    const contractConflicts = appearanceContractConflicts(
      contractFailures,
      contracts.map((entry) => entry.contract.judgement?.conflicts ?? []),
    );
    const agreementScore = Math.min(
      ...contracts.map((entry) => entry.contract.judgement?.agreementScore ?? 0),
    );
    const contract: VisualContract = {
      source: "model-committee",
      terrainReliefScale: median(contracts.map((entry) => entry.contract.terrainReliefScale)),
      terrainMicroDetailScale: median(
        contracts.map((entry) => entry.contract.terrainMicroDetailScale),
      ),
      vegetationDensityScale: median(
        contracts.map((entry) => entry.contract.vegetationDensityScale),
      ),
      objectDensityScale: median(contracts.map((entry) => entry.contract.objectDensityScale)),
      waterLevelMeters: median(contracts.map((entry) => entry.contract.waterLevelMeters)),
      palette: [...new Set(contracts.flatMap((entry) => entry.contract.palette))].slice(0, 12),
      dominantSilhouettes: [
        ...new Set(contracts.flatMap((entry) => entry.contract.dominantSilhouettes)),
      ].slice(0, 24),
      compositionNotes: [
        ...new Set(contracts.flatMap((entry) => entry.contract.compositionNotes)),
      ].slice(0, 24),
      // Model boards can use strips, grids, crops, or repeated views. Runtime
      // registration therefore uses the fixed WorldClaw camera contract rather
      // than treating a generated board's inferred crop as geometry.
      cameras: DEFAULT_REFERENCE_CAMERAS.map((camera) => ({ ...camera })),
      judgement: {
        passed:
          contractFailures.length === 0 &&
          contracts.every((entry) => entry.contract.judgement?.passed === true) &&
          agreementScore >= 0.78 &&
          missingSubjects.length === 0 &&
          contractConflicts.length === 0,
        agreementScore,
        missingSubjects,
        conflicts: contractConflicts,
      },
    };

    const referenceEnsemble: EnsembleEvidence = {
      providers,
      artifacts: boundEnsembleArtifacts(artifacts.slice(-128)),
      selection: {
        chosenMultiviewArtifactId: judged.winner.id,
        consensusScore: Math.min(judged.consensusScore, agreementScore),
        rationale: [
          `Retained ${sheetCandidates.length} full image-model perspective and construction concept variants without assuming a panel layout`,
          `Selected ${judged.winner.id} after ${completedIterations} bounded concept iteration${completedIterations === 1 ? "" : "s"}`,
          `All ${contracts.length} successful vision judges passed the appearance contract; canonical map structure remains independent`,
          ...judged.observations,
        ].slice(0, 12),
      },
      completedIterations,
      maxIterations: 2,
    };
    const contractJudgement = contract.judgement;
    if (!contractJudgement?.passed) {
      const issues = [
        ...(contractJudgement?.missingSubjects ?? []),
        ...(contractJudgement?.conflicts ?? []),
      ];
      const error = `Pre-build appearance contract rejected the selected concept: ${issues.join("; ").slice(0, 480) || "one or more appearance judges rejected it"}`;
      return {
        ok: false as const,
        error,
        perspectiveImageDataUrl: inlineImageDataUrl(judged.winner.image),
        perspectiveProvider: `${judged.winner.model} committee-selected`,
        visualAnalysisProvider: contracts.map((entry) => entry.model).join(" + "),
        visualContract: contract,
        ensemble: referenceEnsemble,
      };
    }

    return {
      ok: true as const,
      error: null,
      perspectiveImageDataUrl: inlineImageDataUrl(judged.winner.image),
      perspectiveProvider: `${judged.winner.model} committee-selected`,
      visualAnalysisProvider: contracts.map((entry) => entry.model).join(" + "),
      visualContract: contract,
      ensemble: referenceEnsemble,
    };
  });

/**
 * Post-build model gate. Unlike the pre-build VisualContract, these images are
 * captured from the actual WebGL world after terrain, placement, refinement,
 * asset compilation and composition have completed.
 */
export const evaluateFinalWorldRender = createServerFn({ method: "POST" })
  .middleware([paidInferenceRunMiddleware])
  .validator(
    (input: {
      prompt: string;
      sceneSummary: string;
      layoutImageDataUrl: string;
      perspectiveImageDataUrl: string;
      captures: {
        map: string;
        isometric: string;
        oblique: string;
        walk: string;
      };
      captureMetadata: string;
      deterministicChecks: FinalRenderDeterministicChecksRaw;
      parentArtifactIds?: string[];
    }) => {
      const prompt = validatePromptInput({ prompt: input.prompt }).prompt;
      const sceneSummary = boundedText(input.sceneSummary, 3_000);
      const captureMetadata = boundedText(input.captureMetadata, 6_000);
      if (!sceneSummary) throw new Error("Final render judge needs a scene summary");
      if (!captureMetadata) throw new Error("Final render judge needs registered camera metadata");
      for (const image of [
        input.layoutImageDataUrl,
        input.perspectiveImageDataUrl,
        input.captures.map,
        input.captures.isometric,
        input.captures.oblique,
        input.captures.walk,
      ]) {
        parseInlineImageDataUrl(image);
      }
      return {
        prompt,
        sceneSummary,
        layoutImageDataUrl: input.layoutImageDataUrl,
        perspectiveImageDataUrl: input.perspectiveImageDataUrl,
        captures: input.captures,
        captureMetadata,
        deterministicChecks: input.deterministicChecks,
        parentArtifactIds: (input.parentArtifactIds ?? [])
          .map((value) => boundedText(value, 120))
          .filter(Boolean)
          .slice(0, 12),
      };
    },
  )
  .handler(async ({ data }) => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const requestSignal = getRequest().signal;
    const { committeeStatuses, runVisionCommittee, runVisionCommitteeQuorum } =
      await import("./ensemble.server");
    const strictCommittee = await strictPaidCommitteeRequired();
    const { composeHorizontalImageStrip } = await import("./image-compose.server");
    const { parseJsonFromLlm } = await import("./xai.server");
    const deterministicChecks = normalizeDeterministicChecksForJudge(data.deterministicChecks);
    const finalPerspectiveSheet = await composeHorizontalImageStrip(
      [data.captures.isometric, data.captures.oblique, data.captures.walk].map((image) =>
        compatibleInlineImage(parseInlineImageDataUrl(image)),
      ),
      512,
      512,
    );
    const images = [
      parseInlineImageDataUrl(data.layoutImageDataUrl),
      parseInlineImageDataUrl(data.perspectiveImageDataUrl),
      parseInlineImageDataUrl(data.captures.map),
      finalPerspectiveSheet,
    ].map(compatibleInlineImage);
    const finalJudgeOptions = {
      system: FINAL_RENDER_JUDGE_SYSTEM,
      user: [
        `Planned world: ${data.sceneSummary}`,
        `Original user intent: ${boundedText(data.prompt, 700)}`,
        `Registered camera metadata: ${data.captureMetadata}`,
        `Deterministic geometry/count/material checks: ${JSON.stringify(deterministicChecks)}`,
        "The four inline images follow the exact order declared by the system. Score every metric and report concrete conflicts. Deterministic failures cannot be overridden, and deterministically proven map/water/camera facts cannot be contradicted or rescored from visual impression.",
      ].join("\n"),
      images,
      maxTokens: 10_000,
      signal: requestSignal,
      timeoutMs: WORLDCLAW_COMMITTEE_DEADLINES_MS.vision,
      dispatch: {
        stage: "final_judge",
        iteration: 1,
        role: "Independent built-world renderer judge",
      },
    } as const;
    const calls = strictCommittee
      ? await runVisionCommittee(finalJudgeOptions)
      : await runVisionCommitteeQuorum(finalJudgeOptions, {
          minimumUsable: 2,
          isUsable: (call) => {
            if (!call.ok || !call.value) return false;
            try {
              normalizeFinalRenderJudgement(
                parseJsonFromLlm<FinalRenderJudgementRaw>(call.value.text),
                deterministicChecks,
              );
              return true;
            } catch {
              return false;
            }
          },
        });
    const artifacts: EnsembleArtifact[] = [];
    const judgements: Array<{
      judgement: FinalRenderJudgement;
      provider: EnsembleProviderId;
      model: string;
    }> = [];
    const providerFailures: string[] = [];
    for (const call of calls) {
      const id = evidenceId("final_judge", 1, call.provider, "built-world");
      if (!call.ok || !call.value) {
        if (call.configured) {
          const failure = `${call.model} final judge unavailable: ${call.error ?? "unknown error"}`;
          providerFailures.push(failure);
          artifacts.push(
            committeeArtifact({
              id,
              iteration: 1,
              stage: "final_judge",
              provider: call.provider,
              model: call.model,
              ...committeeCallIdentity(call),
              role: "Independent built-world renderer judge",
              status: "error",
              parentArtifactIds: data.parentArtifactIds,
              error: call.error,
              conflicts: [failure],
            }),
          );
        }
        continue;
      }
      try {
        const judgement = {
          ...normalizeFinalRenderJudgement(
            parseJsonFromLlm<FinalRenderJudgementRaw>(call.value.text),
            deterministicChecks,
          ),
          source: "model-committee" as const,
        };
        judgements.push({ judgement, provider: call.provider, model: call.model });
        artifacts.push(
          committeeArtifact({
            id,
            iteration: 1,
            stage: "final_judge",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: "Independent built-world renderer judge",
            status: judgement.passed ? "selected" : "rejected",
            parentArtifactIds: data.parentArtifactIds,
            structuredOutput: JSON.stringify(judgement),
            score: judgement.agreementScore,
            passed: judgement.passed,
            metrics: judgement.metrics,
            observations: judgement.observations,
            conflicts: [...judgement.missingSubjects, ...judgement.conflicts],
          }),
        );
      } catch (error) {
        const failure = `${call.model} returned an invalid final judgement`;
        providerFailures.push(failure);
        artifacts.push(
          committeeArtifact({
            id,
            iteration: 1,
            stage: "final_judge",
            provider: call.provider,
            model: call.model,
            ...committeeCallIdentity(call),
            role: "Independent built-world renderer judge",
            status: "error",
            parentArtifactIds: data.parentArtifactIds,
            error: error instanceof Error ? error.message : String(error),
            conflicts: [failure],
          }),
        );
      }
    }
    if (strictCommittee) {
      assertExactCommitteeRoster(
        "Built-world renderer committee",
        judgements.map((entry) => entry.provider),
        ["xai", "gemini", "openai", "anthropic"],
      );
    }

    const fallback = normalizeFinalRenderJudgement(
      {
        passed: false,
        agreementScore: 0,
        metrics: {},
        conflicts: providerFailures,
        observations: [],
      },
      deterministicChecks,
    );
    const metricNames = [
      "mapRegistration",
      "referenceAgreement",
      "heroObjectCoverage",
      "constructionFidelity",
      "waterIntegrity",
    ] as const;
    const aggregate: FinalRenderJudgement = judgements.length
      ? {
          source: "model-committee",
          passed:
            (!strictCommittee || providerFailures.length === 0) &&
            judgements.length >= 2 &&
            judgements.every((entry) => entry.judgement.passed),
          agreementScore: Math.min(...judgements.map((entry) => entry.judgement.agreementScore)),
          metrics: Object.fromEntries(
            metricNames.map((name) => [
              name,
              Math.min(...judgements.map((entry) => entry.judgement.metrics[name])),
            ]),
          ) as FinalRenderJudgement["metrics"],
          missingSubjects: [
            ...new Set(judgements.flatMap((entry) => entry.judgement.missingSubjects)),
          ].slice(0, 32),
          conflicts: [
            ...new Set([
              ...(strictCommittee ? providerFailures : []),
              ...judgements.flatMap((entry) => entry.judgement.conflicts),
            ]),
          ].slice(0, 32),
          observations: [
            ...new Set(judgements.flatMap((entry) => entry.judgement.observations)),
          ].slice(0, 32),
          deterministicChecks: judgements[0]!.judgement.deterministicChecks,
        }
      : { ...fallback, source: "model-committee" };
    if (aggregate.conflicts.length > 0 || aggregate.missingSubjects.length > 0) {
      aggregate.passed = false;
    }

    return {
      ...aggregate,
      ensemble: {
        providers: committeeStatuses(calls),
        artifacts,
        selection: {
          consensusScore: aggregate.agreementScore,
          rationale: [
            `${judgements.length} independent final-render judgements completed`,
            providerFailures.length === 0
              ? "Every configured final judge returned a valid result"
              : `${providerFailures.length} configured final judge failure(s) retained`,
            aggregate.passed
              ? "All successful judges and deterministic gates passed"
              : "Final build remains rejected until every deterministic and model gate passes",
          ],
        },
        completedIterations: 1,
        maxIterations: 1,
      } satisfies EnsembleEvidence,
    };
  });

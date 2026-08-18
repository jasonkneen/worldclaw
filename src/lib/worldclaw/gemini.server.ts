/**
 * Server-only Gemini client for WorldClaw agents — companion provider to
 * xAI. Text planning uses GEMINI_TEXT_MODEL (default gemini-3.6-flash);
 * quality images use GEMINI_IMAGE_MODEL (default gemini-3-pro-image).
 * Direct requests use process.env.GEMINI_API_KEY. If direct Gemini billing is
 * unavailable, Gemini 3.6 Flash text/vision can use the explicitly attested
 * Vercel AI Gateway transport through AI_GATEWAY_API_KEY. Structured billing
 * denials open a bounded process-local cooldown for ordinary calls, preventing
 * repeated known-doomed direct attempts while allowing automatic recovery.
 * Gemini 3 Pro Image remains direct-only because Gateway's wire response does
 * not expose the raw Google model/version identity required for certification.
 * Neither key is ever exposed to the client.
 */

import { createHash } from "node:crypto";
import {
  accountPaidProviderDispatch,
  currentPaidInferenceRunScope,
  type PaidDispatchContext,
  type PaidModality,
  type PaidInferenceRunScope,
} from "./paid-inference.server";

const API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GATEWAY_REST_API = "https://ai-gateway.vercel.sh/v1";
const GATEWAY_MODEL_PREFIX = "google/";
const EXACT_TEXT_MODEL = "gemini-3.6-flash";
const EXACT_IMAGE_MODEL = "gemini-3-pro-image";
const CHAT_TIMEOUT_MS = 45_000;
const IMAGE_TIMEOUT_MS = 120_000;
const VISION_TIMEOUT_MS = 90_000;
const MAX_VISION_IMAGE_COUNT = 4;
const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 14 * 1024 * 1024;
const MAX_SYSTEM_CHARS = 32_000;
const MAX_USER_CHARS = 64_000;
const MAX_TOTAL_TEXT_CHARS = 80_000;
const MAX_IMAGE_PROMPT_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_GATEWAY_TEXT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GATEWAY_TEXT_CHARS = 512 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_GENERATED_IMAGE_DIMENSION = 4_096;
const MAX_GENERATED_IMAGE_PIXELS = 16_777_216;
const MAX_TIMEOUT_MS = 180_000;
export const GEMINI_ORDINARY_BILLING_COOLDOWN_MS = 5 * 60_000;
const VISION_IMAGE_MIMES = new Set(["image/png", "image/jpeg"]);
const IMAGE_REFERENCE_MIMES = new Set(["image/png", "image/jpeg"]);
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const RESPONSE_ID = /^[a-z0-9][a-z0-9._:/+=-]{0,255}$/i;

const TEXT_MODEL = () => process.env.GEMINI_TEXT_MODEL?.trim() || EXACT_TEXT_MODEL;
const IMAGE_MODEL = () => process.env.GEMINI_IMAGE_MODEL?.trim() || EXACT_IMAGE_MODEL;

function directKey(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

function gatewayKey(): string | undefined {
  return process.env.AI_GATEWAY_API_KEY?.trim() || undefined;
}

export function hasGeminiKey(): boolean {
  return Boolean(directKey() || gatewayKey());
}

export function hasGeminiImageKey(): boolean {
  return Boolean(directKey());
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { finishReason?: unknown; content?: { parts?: GeminiPart[] } }[];
  modelVersion?: unknown;
  responseId?: unknown;
  error?: { code?: unknown; message?: unknown; status?: unknown; details?: unknown };
}

interface GatewayChatCompletionResponse {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  error?: unknown;
}

interface GeminiGatewayRequest {
  system: string;
  user: string;
  images: { b64: string; mime: string }[];
  maxTokens: number;
  thinkingLevel: "minimal" | "low" | "medium" | "high";
}

interface GeminiOperationDeadline {
  callerSignal?: AbortSignal;
  timeoutSignal: AbortSignal;
  signal: AbortSignal;
  timeoutMs: number;
}

class DirectGeminiBillingDeniedError extends Error {}

/**
 * A billing/dunning denial is project-wide, so remember it only for the
 * current paid task. WeakSet identity prevents cross-run leakage and does not
 * retain completed runs beyond the paid-run registry/context lifetime.
 */
const directBillingDeniedRunScopes = new WeakSet<PaidInferenceRunScope>();

interface OrdinaryBillingCooldown {
  credentialFingerprint: string;
  openedAtMs: number;
  lastObservedAtMs: number;
  expiresAtMs: number;
}

/** One bounded process-local entry; paid benchmark runs keep independent state. */
let ordinaryBillingCooldown: OrdinaryBillingCooldown | undefined;

function directCredentialFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("base64url");
}

function ordinaryBillingCooldownOpen(key: string): boolean {
  const state = ordinaryBillingCooldown;
  if (!state) return false;
  const now = Date.now();
  const fingerprint = directCredentialFingerprint(key);
  if (
    state.credentialFingerprint !== fingerprint ||
    now < state.lastObservedAtMs ||
    now >= state.expiresAtMs
  ) {
    ordinaryBillingCooldown = undefined;
    return false;
  }
  state.lastObservedAtMs = now;
  return true;
}

function openOrdinaryBillingCooldown(key: string): void {
  const openedAtMs = Date.now();
  ordinaryBillingCooldown = {
    credentialFingerprint: directCredentialFingerprint(key),
    openedAtMs,
    lastObservedAtMs: openedAtMs,
    expiresAtMs: openedAtMs + GEMINI_ORDINARY_BILLING_COOLDOWN_MS,
  };
}

export interface GeminiJsonResult {
  text: string;
  provider: "gemini";
  /** Model identity reported by Gemini and matched to the requested model. */
  model: string;
  /** Bounded Gemini response identifier used to attest this exact call. */
  responseId: string;
}

export interface GeminiChatOptions {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

export interface GeminiVisionJsonOptions extends GeminiChatOptions {
  images: { b64: string; mime: string }[];
}

export interface GeminiImageResult {
  b64: string;
  mime: string;
  provider: "gemini";
  model: string;
  responseId: string;
}

function boundedText(label: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > maximum) throw new Error(`${label} exceeds its character budget`);
  return text;
}

function boundedInteger(
  label: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function validatePrompts(system: string, user: string): { system: string; user: string } {
  const cleanSystem = boundedText("Gemini system prompt", system, MAX_SYSTEM_CHARS);
  const cleanUser = boundedText("Gemini user prompt", user, MAX_USER_CHARS);
  if (cleanSystem.length + cleanUser.length > MAX_TOTAL_TEXT_CHARS) {
    throw new Error("Gemini prompts exceed the combined character budget");
  }
  return { system: cleanSystem, user: cleanUser };
}

function requestedModel(value: string): string {
  const model = value.trim();
  if (!MODEL_ID.test(model)) throw new Error("Gemini model identifier is invalid");
  return model;
}

function exactModelForModality(model: string, modality: PaidModality): string {
  const expected = modality === "image" ? EXACT_IMAGE_MODEL : EXACT_TEXT_MODEL;
  if (model !== expected) {
    throw new Error(
      modality === "image"
        ? `Gemini image generation requires ${expected}; ${model} is not an image-output model`
        : `Gemini ${modality} inference requires ${expected}; ${model} is not permitted`,
    );
  }
  return model;
}

function credentialFreeHttpsUrl(label: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function gatewayRestApi(): string {
  return credentialFreeHttpsUrl(
    "AI_GATEWAY_BASE_URL",
    process.env.AI_GATEWAY_BASE_URL?.trim() || DEFAULT_GATEWAY_REST_API,
  );
}

function gatewayRequestedModel(canonicalModel: string): string {
  return `${GATEWAY_MODEL_PREFIX}${canonicalModel}`;
}

function responseAttestation(
  data: GeminiResponse,
  expectedModel: string,
  label: string,
): { model: string; responseId: string } {
  if (typeof data.modelVersion !== "string") {
    throw new Error(`${label} returned no valid provider model identity`);
  }
  // GenerateContentResponse may spell the same resource as `models/<id>`.
  // Strip only that documented resource prefix; aliases or version drift remain mismatches.
  const reportedModel = data.modelVersion.startsWith("models/")
    ? data.modelVersion.slice("models/".length)
    : data.modelVersion;
  if (!MODEL_ID.test(reportedModel)) {
    throw new Error(`${label} returned no valid provider model identity`);
  }
  if (reportedModel !== expectedModel) {
    throw new Error(
      `${label} provider model mismatch: requested ${expectedModel}, received ${reportedModel}`,
    );
  }
  if (typeof data.responseId !== "string" || !RESPONSE_ID.test(data.responseId)) {
    throw new Error(`${label} returned no valid response identifier`);
  }
  return { model: reportedModel, responseId: data.responseId };
}

function gatewayChatAttestation(
  data: GatewayChatCompletionResponse,
  expectedModel: string,
  label: string,
): { model: string; responseId: string } {
  const gatewayModel = gatewayRequestedModel(expectedModel);
  if (typeof data.model !== "string" || !MODEL_ID.test(data.model)) {
    throw new Error(`${label} returned no valid provider model identity`);
  }
  if (data.model !== gatewayModel) {
    throw new Error(
      `${label} provider model mismatch: requested ${gatewayModel}, received ${data.model}`,
    );
  }
  if (typeof data.id !== "string" || !RESPONSE_ID.test(data.id)) {
    throw new Error(`${label} returned no valid response identifier`);
  }
  // AI Gateway uses its documented creator/model namespace. Strip exactly the
  // `google/` transport prefix after an exact comparison; never accept aliases.
  return { model: expectedModel, responseId: data.id };
}

function gatewayCompletionText(data: GatewayChatCompletionResponse, label: string): string {
  if (!Array.isArray(data.choices) || !data.choices[0] || typeof data.choices[0] !== "object") {
    throw new Error(`${label} returned no completion choice`);
  }
  const choice = data.choices[0] as { finish_reason?: unknown; message?: unknown };
  if (choice.finish_reason !== "stop") {
    throw new Error(
      choice.finish_reason === "length"
        ? `${label} returned a truncated response`
        : `${label} did not return a complete answer`,
    );
  }
  if (!choice.message || typeof choice.message !== "object") {
    throw new Error(`${label} returned no completion message`);
  }
  const message = choice.message as { content?: unknown; refusal?: unknown };
  if (typeof message.refusal === "string" && message.refusal.trim()) {
    throw new Error(`${label} was refused`);
  }
  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    text = message.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const item = block as { type?: unknown; text?: unknown };
        return item.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .join("");
  }
  text = text.trim();
  if (!text) throw new Error(`${label} returned no answer text`);
  if (text.length > MAX_GATEWAY_TEXT_CHARS) {
    throw new Error(`${label} answer exceeds the text output budget`);
  }
  return text;
}

function normalizedOutputBase64(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} returned no inline image data`);
  }
  if (value.length > Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 4) {
    throw new Error(`${label} output exceeds its image byte budget`);
  }
  const unpadded = value.replace(/=+$/, "");
  const paddingLength = value.length - unpadded.length;
  const invalidPadding =
    paddingLength > 2 ||
    (paddingLength > 0 && value.length % 4 !== 0) ||
    (paddingLength === 1 && unpadded.length % 4 !== 3) ||
    (paddingLength === 2 && unpadded.length % 4 !== 2);
  if (!/^[a-z0-9+/]*={0,2}$/i.test(value) || unpadded.length % 4 === 1 || invalidPadding) {
    throw new Error(`${label} output contains malformed base64 data`);
  }
  const b64 = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const bytes = Buffer.from(b64, "base64").length;
  if (bytes < 1 || bytes > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(`${label} output exceeds its image byte budget`);
  }
  return b64;
}

function imageDimensions(
  label: string,
  bytes: Buffer,
): { mime: "image/png" | "image/jpeg"; width: number; height: number } {
  if (
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(bytes.length - 12) === 0 &&
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND"
  ) {
    return {
      mime: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  ) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        segmentLength >= 7
      ) {
        return {
          mime: "image/jpeg",
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
  }
  throw new Error(`${label} is not a supported PNG or JPEG image`);
}

async function validatedImage(
  label: string,
  value: unknown,
  declaredMime?: unknown,
): Promise<{ b64: string; mime: "image/png" | "image/jpeg" }> {
  const b64 = normalizedOutputBase64(label, value);
  const bytes = Buffer.from(b64, "base64");
  const dimensions = imageDimensions(label, bytes);
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_GENERATED_IMAGE_DIMENSION ||
    dimensions.height > MAX_GENERATED_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_GENERATED_IMAGE_PIXELS
  ) {
    throw new Error(`${label} exceeds the image dimension budget`);
  }
  if (
    declaredMime !== undefined &&
    declaredMime !== dimensions.mime &&
    !(declaredMime === "image/jpg" && dimensions.mime === "image/jpeg")
  ) {
    throw new Error(`${label} MIME type does not match its encoded bytes`);
  }
  try {
    if (dimensions.mime === "image/png") {
      const { PNG } = await import("pngjs");
      const decoded = PNG.sync.read(bytes, { checkCRC: true });
      if (
        decoded.width !== dimensions.width ||
        decoded.height !== dimensions.height ||
        decoded.data.length !== decoded.width * decoded.height * 4
      ) {
        throw new Error("decoded dimensions are inconsistent");
      }
    } else {
      const jpeg = (await import("jpeg-js")).default;
      const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      if (
        decoded.width !== dimensions.width ||
        decoded.height !== dimensions.height ||
        decoded.data.length !== decoded.width * decoded.height * 4
      ) {
        throw new Error("decoded dimensions are inconsistent");
      }
    }
  } catch (error) {
    throw new Error(`${label} is invalid or corrupt image data`, { cause: error });
  }
  return { b64, mime: dimensions.mime };
}

async function validateInlineImages(
  label: string,
  input: { b64: string; mime: string }[],
  allowedMimes: ReadonlySet<string>,
  requireOne: boolean,
): Promise<{ b64: string; mime: string }[]> {
  if (!Array.isArray(input) || (requireOne && input.length === 0)) {
    throw new Error(`${label} requires at least one reference image`);
  }
  if (input.length > MAX_VISION_IMAGE_COUNT) {
    throw new Error(`${label} accepts at most ${MAX_VISION_IMAGE_COUNT} reference images`);
  }
  let totalImageBytes = 0;
  const normalized = input.map((image, index) => {
    const mime =
      image.mime.trim().toLowerCase() === "image/jpg"
        ? "image/jpeg"
        : image.mime.trim().toLowerCase();
    if (!allowedMimes.has(mime)) {
      throw new Error(`${label} image ${index + 1} has an unsupported MIME type`);
    }
    if (
      typeof image.b64 !== "string" ||
      image.b64.length > Math.ceil((MAX_VISION_IMAGE_BYTES * 4) / 3) + 4 ||
      !/^[a-z0-9+/]*={0,2}$/i.test(image.b64) ||
      image.b64.length % 4 !== 0
    ) {
      throw new Error(`${label} image ${index + 1} contains malformed base64 data`);
    }
    const bytes = Buffer.from(image.b64, "base64").length;
    if (bytes < 1 || bytes > MAX_VISION_IMAGE_BYTES) {
      throw new Error(`${label} image ${index + 1} exceeds its image byte budget`);
    }
    totalImageBytes += bytes;
    if (totalImageBytes > MAX_VISION_TOTAL_BYTES) {
      throw new Error(`${label} images exceed the combined inline byte budget`);
    }
    return { mime, b64: image.b64 };
  });
  for (let index = 0; index < normalized.length; index += 1) {
    const image = normalized[index];
    await validatedImage(`${label} image ${index + 1}`, image.b64, image.mime);
  }
  return normalized;
}

async function readBoundedResponse(
  response: Response,
  label = "Gemini",
  maximumBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} response exceeds the output budget`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} response exceeds the output budget`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseJson<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function directBillingDenied(status: number, responseText: string): boolean {
  if (![400, 402, 403, 429].includes(status)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; message?: unknown; details?: unknown };
  const providerStatus = typeof candidate.status === "string" ? candidate.status : "";
  if (
    !new Set(["RESOURCE_EXHAUSTED", "PERMISSION_DENIED", "FAILED_PRECONDITION"]).has(providerStatus)
  ) {
    return false;
  }
  const boundedError = JSON.stringify(error).slice(0, 16_384).toLowerCase();
  return /\b(billing|dunning|payment|credits?|paid plan|quota[^.]{0,80}(?:plan|billing))\b/.test(
    boundedError,
  );
}

function paidDescriptor(
  model: string,
  controls: {
    modality: PaidModality;
    timeoutMs: number;
    dispatch?: PaidDispatchContext;
  },
) {
  return controls.dispatch
    ? {
        provider: "gemini" as const,
        modality: controls.modality,
        model,
        timeoutMs: controls.timeoutMs,
        ...controls.dispatch,
      }
    : undefined;
}

function createOperationDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): GeminiOperationDeadline {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    callerSignal,
    timeoutSignal,
    signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
    timeoutMs,
  };
}

function throwIfDeadlineExpired(label: string, deadline: GeminiOperationDeadline): void {
  if (deadline.callerSignal?.aborted) throw new Error(`${label} cancelled`);
  if (deadline.timeoutSignal.aborted) {
    throw new Error(`${label} timed out after ${deadline.timeoutMs}ms`);
  }
}

async function withinOperationDeadline<T>(
  label: string,
  deadline: GeminiOperationDeadline,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfDeadlineExpired(label, deadline);
  try {
    const result = await operation();
    throwIfDeadlineExpired(label, deadline);
    return result;
  } catch (error) {
    if (deadline.callerSignal?.aborted) {
      throw new Error(`${label} cancelled`, { cause: error });
    }
    if (deadline.timeoutSignal.aborted) {
      throw new Error(`${label} timed out after ${deadline.timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}

async function generateContent(
  model: string,
  body: Record<string, unknown>,
  controls: {
    signal?: AbortSignal;
    timeoutMs: number;
    label: string;
    modality: PaidModality;
    dispatch?: PaidDispatchContext;
    gateway?: GeminiGatewayRequest;
  },
): Promise<{ parts: GeminiPart[]; model: string; responseId: string }> {
  const exactModel = exactModelForModality(requestedModel(model), controls.modality);
  const timeoutMs = boundedInteger(
    "Gemini timeoutMs",
    controls.timeoutMs,
    controls.timeoutMs,
    1,
    MAX_TIMEOUT_MS,
  );
  const direct = directKey();
  const gateway = gatewayKey();
  const deadline = createOperationDeadline(controls.signal, timeoutMs);
  const paidRunScope = currentPaidInferenceRunScope();
  const paidDirectBillingCircuitOpen = Boolean(
    paidRunScope && directBillingDeniedRunScopes.has(paidRunScope),
  );
  const ordinaryDirectBillingCircuitOpen = Boolean(
    !paidRunScope && direct && ordinaryBillingCooldownOpen(direct),
  );
  const directBillingCircuitOpen = paidDirectBillingCircuitOpen || ordinaryDirectBillingCircuitOpen;

  if (directBillingCircuitOpen) {
    throwIfDeadlineExpired(controls.label, deadline);
    if (controls.modality === "image") {
      throw new Error(
        `${controls.label} direct Google billing ${paidRunScope ? "circuit is open for this paid run" : "cooldown is active"}; no certifiable image Gateway transport is available`,
      );
    }
    if (!gateway || !controls.gateway) {
      throw new Error(
        `${controls.label} direct Google billing ${paidRunScope ? "circuit is open for this paid run" : "cooldown is active"} and AI Gateway is unavailable`,
      );
    }
    throwIfDeadlineExpired(`${controls.label} Gateway`, deadline);
    return requestGatewayJson(
      exactModel,
      controls.gateway,
      { ...controls, timeoutMs, deadline },
      gateway,
    );
  }

  if (direct) {
    try {
      return await requestDirectGenerateContent(
        exactModel,
        body,
        { ...controls, timeoutMs, deadline },
        direct,
      );
    } catch (error) {
      if (!(error instanceof DirectGeminiBillingDeniedError)) {
        throw error;
      }
      if (paidRunScope) directBillingDeniedRunScopes.add(paidRunScope);
      else openOrdinaryBillingCooldown(direct);
      if (!gateway || !controls.gateway) throw error;
    }
  }
  if (gateway && controls.gateway) {
    throwIfDeadlineExpired(`${controls.label} Gateway`, deadline);
    return requestGatewayJson(
      exactModel,
      controls.gateway,
      { ...controls, timeoutMs, deadline },
      gateway,
    );
  }
  if (controls.modality === "image") {
    throw new Error(
      "Gemini 3 Pro Image requires direct GEMINI_API_KEY access; AI Gateway does not expose certifiable raw Google response identity",
    );
  }
  throw new Error(
    "Gemini inference is not configured. Set GEMINI_API_KEY or AI_GATEWAY_API_KEY on the server.",
  );
}

async function requestDirectGenerateContent(
  exactModel: string,
  body: Record<string, unknown>,
  controls: {
    signal?: AbortSignal;
    timeoutMs: number;
    label: string;
    modality: PaidModality;
    dispatch?: PaidDispatchContext;
    deadline: GeminiOperationDeadline;
  },
  key: string,
): Promise<{ parts: GeminiPart[]; model: string; responseId: string }> {
  return accountPaidProviderDispatch(
    paidDescriptor(exactModel, controls),
    () =>
      withinOperationDeadline(controls.label, controls.deadline, async () => {
        const response = await fetch(`${API}/models/${exactModel}:generateContent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify(body),
          signal: controls.deadline.signal,
        });
        if (!response.ok) {
          const errorText = await readBoundedResponse(response, controls.label).catch(() => "");
          throwIfDeadlineExpired(controls.label, controls.deadline);
          if (directBillingDenied(response.status, errorText)) {
            throw new DirectGeminiBillingDeniedError(
              `${controls.label} direct billing is unavailable (HTTP ${response.status})`,
            );
          }
          throw new Error(`${controls.label} failed with HTTP ${response.status}`);
        }
        const responseText = await readBoundedResponse(response, controls.label);
        const data = parseJson<GeminiResponse>(controls.label, responseText);
        const attestation = responseAttestation(data, exactModel, controls.label);
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason !== "STOP") {
          throw new Error(`${controls.label} did not return a complete answer`);
        }
        const parts = candidate.content?.parts;
        if (!parts?.length) {
          throw new Error(`${controls.label} returned no content`);
        }
        if (controls.modality === "image") {
          const imageParts = parts.filter((part) => part.inlineData?.data);
          if (imageParts.length !== 1 || !imageParts[0].inlineData) {
            throw new Error(`${controls.label} must return exactly one inline image`);
          }
          const image = await validatedImage(
            controls.label,
            imageParts[0].inlineData.data,
            imageParts[0].inlineData.mimeType,
          );
          imageParts[0].inlineData = { mimeType: image.mime, data: image.b64 };
        }
        return { parts, ...attestation };
      }),
    (value) => value.responseId,
  );
}

async function requestGatewayJson(
  exactModel: string,
  request: GeminiGatewayRequest,
  controls: {
    signal?: AbortSignal;
    timeoutMs: number;
    label: string;
    modality: PaidModality;
    dispatch?: PaidDispatchContext;
    deadline: GeminiOperationDeadline;
  },
  key: string,
): Promise<{ parts: GeminiPart[]; model: string; responseId: string }> {
  const gatewayModel = gatewayRequestedModel(exactModel);
  const userContent = request.images.length
    ? [
        { type: "text", text: request.user },
        ...request.images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mime};base64,${image.b64}`, detail: "high" },
        })),
      ]
    : request.user;
  return accountPaidProviderDispatch(
    paidDescriptor(exactModel, controls),
    () =>
      withinOperationDeadline(`${controls.label} Gateway`, controls.deadline, async () => {
        const response = await fetch(`${gatewayRestApi()}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: gatewayModel,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: userContent },
            ],
            max_tokens: request.maxTokens,
            reasoning_effort: request.thinkingLevel,
            stream: false,
          }),
          signal: controls.deadline.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`${controls.label} Gateway failed with HTTP ${response.status}`);
        }
        const responseText = await readBoundedResponse(
          response,
          `${controls.label} Gateway`,
          MAX_GATEWAY_TEXT_RESPONSE_BYTES,
        );
        const data = parseJson<GatewayChatCompletionResponse>(
          `${controls.label} Gateway`,
          responseText,
        );
        const attestation = gatewayChatAttestation(data, exactModel, `${controls.label} Gateway`);
        return {
          parts: [{ text: gatewayCompletionText(data, `${controls.label} Gateway`) }],
          ...attestation,
        };
      }),
    (value) => value.responseId,
  );
}

export async function geminiChatResult(opts: GeminiChatOptions): Promise<GeminiJsonResult> {
  const prompts = validatePrompts(opts.system, opts.user);
  const maxTokens = boundedInteger("Gemini maxTokens", opts.maxTokens, 4096, 1, MAX_OUTPUT_TOKENS);
  const thinkingLevel = opts.thinkingLevel ?? "high";
  const result = await generateContent(
    opts.model ?? TEXT_MODEL(),
    {
      system_instruction: { parts: [{ text: prompts.system }] },
      contents: [{ role: "user", parts: [{ text: prompts.user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        thinkingConfig: {
          thinkingLevel,
        },
      },
    },
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
      label: "Gemini chat",
      modality: "text",
      dispatch: opts.dispatch,
      gateway: {
        system: prompts.system,
        user: prompts.user,
        images: [],
        maxTokens,
        thinkingLevel,
      },
    },
  );
  // Thinking models may interleave thought parts — keep answer text only.
  // maxOutputTokens includes thinking tokens, so a thought-only response is
  // possible; surface it as an error so callers can fall back or retry.
  const text = result.parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error(
      "Gemini returned no answer text (output budget may have been consumed by thinking tokens)",
    );
  }
  return { text, provider: "gemini", model: result.model, responseId: result.responseId };
}

/** Compatibility API for existing string-only callers. */
export async function geminiChat(opts: GeminiChatOptions): Promise<string> {
  return (await geminiChatResult(opts)).text;
}

export async function geminiVisionJsonResult(
  opts: GeminiVisionJsonOptions,
): Promise<GeminiJsonResult> {
  const prompts = validatePrompts(opts.system, opts.user);
  const images = await validateInlineImages("Gemini vision", opts.images, VISION_IMAGE_MIMES, true);
  const maxTokens = boundedInteger("Gemini maxTokens", opts.maxTokens, 8192, 1, MAX_OUTPUT_TOKENS);
  const thinkingLevel = opts.thinkingLevel ?? "high";
  const result = await generateContent(
    opts.model ?? TEXT_MODEL(),
    {
      system_instruction: { parts: [{ text: prompts.system }] },
      contents: [
        {
          role: "user",
          // Google recommends putting the instruction before inline images.
          parts: [
            { text: prompts.user },
            ...images.map((image) => ({
              inlineData: { mimeType: image.mime, data: image.b64 },
            })),
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
        thinkingConfig: {
          thinkingLevel,
        },
      },
    },
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? VISION_TIMEOUT_MS,
      label: "Gemini vision",
      modality: "vision",
      dispatch: opts.dispatch,
      gateway: {
        system: prompts.system,
        user: prompts.user,
        images,
        maxTokens,
        thinkingLevel,
      },
    },
  );
  const text = result.parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini vision returned no JSON answer text");
  return { text, provider: "gemini", model: result.model, responseId: result.responseId };
}

/** Compatibility API for existing string-only callers. */
export async function geminiVisionJson(opts: GeminiVisionJsonOptions): Promise<string> {
  return (await geminiVisionJsonResult(opts)).text;
}

export async function geminiImage(opts: {
  prompt: string;
  model?: string;
  referenceImages?: { b64: string; mime: string }[];
  aspectRatio?: "1:1" | "16:9" | "4:3" | "3:2";
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}): Promise<GeminiImageResult> {
  const prompt = boundedText("Gemini image prompt", opts.prompt, MAX_IMAGE_PROMPT_CHARS);
  const referenceImages = await validateInlineImages(
    "Gemini image",
    opts.referenceImages ?? [],
    IMAGE_REFERENCE_MIMES,
    false,
  );
  const model = requestedModel(opts.model ?? IMAGE_MODEL());
  const aspectRatio = opts.aspectRatio ?? "1:1";
  if (model !== "gemini-3-pro-image") {
    throw new Error(
      `Gemini image generation requires gemini-3-pro-image; ${model} is not an image-output model`,
    );
  }
  const result = await generateContent(
    model,
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...referenceImages.map((image) => ({
              inlineData: { mimeType: image.mime, data: image.b64 },
            })),
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio },
      },
    },
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? IMAGE_TIMEOUT_MS,
      label: "Gemini image",
      modality: "image",
      dispatch: opts.dispatch,
    },
  );
  const img = result.parts.find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) {
    throw new Error("Gemini image returned no inline image data");
  }
  const image = await validatedImage("Gemini image", img.inlineData.data, img.inlineData.mimeType);
  return {
    ...image,
    provider: "gemini",
    model: result.model,
    responseId: result.responseId,
  };
}

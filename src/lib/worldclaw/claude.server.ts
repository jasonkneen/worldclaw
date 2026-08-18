/**
 * Server-only Claude adapters routed through Vercel AI Gateway's
 * OpenAI-compatible Chat Completions endpoint.
 *
 * Direct Anthropic credentials are intentionally not read here. Authentication
 * comes exclusively from AI_GATEWAY_API_KEY and is sent only as a Bearer header.
 */

import {
  accountPaidProviderDispatch,
  type PaidDispatchContext,
} from "./paid-inference.server";

const DEFAULT_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_CLAUDE_MODEL = "anthropic/claude-opus-5";
const TEXT_TIMEOUT_MS = 90_000;
const VISION_TIMEOUT_MS = 120_000;
const MAX_TEXT_TIMEOUT_MS = 180_000;
const MAX_VISION_TIMEOUT_MS = 180_000;
const MAX_SYSTEM_CHARS = 32_000;
const MAX_USER_CHARS = 64_000;
const MAX_TOTAL_TEXT_CHARS = 80_000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_TEXT_CHARS = 512 * 1024;
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_JSON_OUTPUT_TOKENS = 16_384;

const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const REQUEST_ID = /^[a-z0-9._:-]{1,128}$/i;
const VISION_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface ClaudeImageInput {
  b64: string;
  mime: string;
}

export interface ClaudeJsonResult {
  text: string;
  provider: "anthropic";
  /** Model identity reported by AI Gateway and matched to the requested model. */
  model: string;
  /** Bounded Gateway response identifier used to attest this exact call. */
  responseId: string;
}

export interface ClaudeTextJsonOptions {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

export interface ClaudeVisionJsonOptions extends ClaudeTextJsonOptions {
  images: ClaudeImageInput[];
  imageDetail?: "low" | "high" | "auto";
}

class SafeAdapterError extends Error {}

interface ValidatedImage extends ClaudeImageInput {
  bytes: number;
}

interface ChatCompletionBody {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  error?: unknown;
}

function getGatewayKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!key) {
    throw new SafeAdapterError(
      "AI_GATEWAY_API_KEY is not configured. Claude inference requires a server Gateway key.",
    );
  }
  return key;
}

export function hasClaudeKey(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY?.trim());
}

/** Explicit transport-named alias for availability checks. */
export const hasAiGatewayKey = hasClaudeKey;

function gatewayBase(): string {
  const configured = process.env.AI_GATEWAY_BASE_URL?.trim() || DEFAULT_GATEWAY_BASE;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new SafeAdapterError("AI_GATEWAY_BASE_URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SafeAdapterError("AI_GATEWAY_BASE_URL must be a credential-free HTTPS URL");
  }
  return url.toString().replace(/\/$/, "");
}

function modelId(value: string | undefined): string {
  const model = value?.trim() || process.env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
  if (!MODEL_ID.test(model) || !model.startsWith("anthropic/claude-")) {
    throw new SafeAdapterError("CLAUDE_MODEL must be an anthropic/claude-* model identifier");
  }
  return model;
}

function boundedText(label: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw new SafeAdapterError(`${label} must be text`);
  const text = value.trim();
  if (!text) throw new SafeAdapterError(`${label} must not be empty`);
  if (text.length > maxChars) {
    throw new SafeAdapterError(`${label} exceeds the ${maxChars}-character budget`);
  }
  return text;
}

function validateTextInputs(
  system: string,
  user: string,
): {
  system: string;
  user: string;
} {
  const cleanSystem = boundedText("Claude system prompt", system, MAX_SYSTEM_CHARS);
  const cleanUser = boundedText("Claude user prompt", user, MAX_USER_CHARS);
  if (cleanSystem.length + cleanUser.length > MAX_TOTAL_TEXT_CHARS) {
    throw new SafeAdapterError(
      `Claude prompts exceed the ${MAX_TOTAL_TEXT_CHARS}-character combined budget`,
    );
  }
  return { system: cleanSystem, user: cleanUser };
}

function boundedInteger(
  label: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new SafeAdapterError(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function timeoutMs(
  label: string,
  requested: number | undefined,
  fallback: number,
  hardMax: number,
): number {
  return boundedInteger(label, requested, fallback, 1, hardMax);
}

function normalizeMime(value: string): string {
  return value.trim().toLowerCase() === "image/jpg" ? "image/jpeg" : value.trim().toLowerCase();
}

function normalizeBase64(
  label: string,
  value: unknown,
  maxBytes: number,
): {
  b64: string;
  bytes: number;
} {
  if (typeof value !== "string" || value.length === 0) {
    throw new SafeAdapterError(`${label} must contain base64 image data`);
  }
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new SafeAdapterError(`${label} exceeds the ${maxBytes}-byte budget`);
  }
  const paddingLength = value.length - value.replace(/=+$/, "").length;
  const unpaddedLength = value.length - paddingLength;
  const invalidPadding =
    (paddingLength > 0 && value.length % 4 !== 0) ||
    (paddingLength === 1 && unpaddedLength % 4 !== 3) ||
    (paddingLength === 2 && unpaddedLength % 4 !== 2);
  if (!/^[a-z0-9+/]*={0,2}$/i.test(value) || unpaddedLength % 4 === 1 || invalidPadding) {
    throw new SafeAdapterError(`${label} contains malformed base64 image data`);
  }
  const unpadded = value.replace(/=+$/, "");
  const padding = (4 - (unpadded.length % 4)) % 4;
  const b64 = unpadded + "=".repeat(padding);
  const bytes = Math.floor((unpadded.length * 3) / 4);
  if (bytes < 1) throw new SafeAdapterError(`${label} must not be empty`);
  if (bytes > maxBytes) {
    throw new SafeAdapterError(`${label} exceeds the ${maxBytes}-byte budget`);
  }
  return { b64, bytes };
}

function validateImages(images: ClaudeImageInput[]): ValidatedImage[] {
  if (!Array.isArray(images) || images.length === 0) {
    throw new SafeAdapterError("Claude vision requires at least one image");
  }
  if (images.length > MAX_IMAGE_COUNT) {
    throw new SafeAdapterError(`Claude vision accepts at most ${MAX_IMAGE_COUNT} images`);
  }
  let totalBytes = 0;
  return images.map((image, index) => {
    if (!image || typeof image !== "object") {
      throw new SafeAdapterError(`Claude vision image ${index + 1} is invalid`);
    }
    const mime = normalizeMime(image.mime);
    if (!VISION_IMAGE_MIMES.has(mime)) {
      throw new SafeAdapterError(`Claude vision image ${index + 1} has an unsupported MIME type`);
    }
    const normalized = normalizeBase64(
      `Claude vision image ${index + 1}`,
      image.b64,
      MAX_IMAGE_BYTES,
    );
    totalBytes += normalized.bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new SafeAdapterError(
        `Claude vision images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte combined budget`,
      );
    }
    return { mime, b64: normalized.b64, bytes: normalized.bytes };
  });
}

async function readBoundedResponse(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new SafeAdapterError(`${label} response exceeds the output budget`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SafeAdapterError(`${label} response exceeds the output budget`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function safeRequestId(response: Response): string {
  const requestId =
    response.headers.get("x-vercel-ai-gateway-request-id")?.trim() ||
    response.headers.get("x-request-id")?.trim() ||
    "";
  return REQUEST_ID.test(requestId) ? ` (${requestId})` : "";
}

async function fetchBounded(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<string> {
  if (signal?.aborted) throw new SafeAdapterError(`${label} cancelled`);
  const deadline = AbortSignal.timeout(deadlineMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(url, { ...init, signal: requestSignal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SafeAdapterError(
        `${label} failed with HTTP ${response.status}${safeRequestId(response)}`,
      );
    }
    return await readBoundedResponse(response, label, MAX_JSON_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof SafeAdapterError) throw error;
    if (signal?.aborted) throw new SafeAdapterError(`${label} cancelled`);
    if (deadline.aborted) {
      throw new SafeAdapterError(`${label} timed out after ${deadlineMs}ms`);
    }
    throw new SafeAdapterError(`${label} request failed`);
  }
}

function parseBody(text: string, label: string): ChatCompletionBody {
  try {
    return JSON.parse(text) as ChatCompletionBody;
  } catch {
    throw new SafeAdapterError(`${label} returned malformed JSON`);
  }
}

function normalizedJsonObject(label: string, text: string): string {
  if (text.length > MAX_JSON_TEXT_CHARS) {
    throw new SafeAdapterError(`${label} JSON output exceeds the text budget`);
  }
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new SafeAdapterError(`${label} returned invalid JSON output`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SafeAdapterError(`${label} must return one JSON object`);
  }
  const normalized = JSON.stringify(parsed);
  if (normalized.length > MAX_JSON_TEXT_CHARS) {
    throw new SafeAdapterError(`${label} JSON output exceeds the text budget`);
  }
  return normalized;
}

function responseAttestation(
  body: ChatCompletionBody,
  expectedModel: string,
  label: string,
): { model: string; responseId: string } {
  if (typeof body.model !== "string" || !MODEL_ID.test(body.model)) {
    throw new SafeAdapterError(`${label} returned no valid provider model identity`);
  }
  if (body.model !== expectedModel) {
    throw new SafeAdapterError(
      `${label} provider model mismatch: requested ${expectedModel}, received ${body.model}`,
    );
  }
  if (typeof body.id !== "string" || !REQUEST_ID.test(body.id)) {
    throw new SafeAdapterError(`${label} returned no valid response identifier`);
  }
  return { model: body.model, responseId: body.id };
}

function completionText(body: ChatCompletionBody, label: string): string {
  if (!Array.isArray(body.choices) || !body.choices[0] || typeof body.choices[0] !== "object") {
    throw new SafeAdapterError(`${label} returned no completion choice`);
  }
  const choice = body.choices[0] as {
    finish_reason?: unknown;
    message?: unknown;
  };
  if (choice.finish_reason === "length") {
    throw new SafeAdapterError(`${label} returned a truncated response`);
  }
  if (!choice.message || typeof choice.message !== "object") {
    throw new SafeAdapterError(`${label} returned no completion message`);
  }
  const message = choice.message as { content?: unknown; refusal?: unknown };
  if (typeof message.refusal === "string" && message.refusal.trim()) {
    throw new SafeAdapterError(`${label} was refused`);
  }
  if (typeof message.content === "string") {
    if (!message.content.trim()) throw new SafeAdapterError(`${label} returned no JSON text`);
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const item = block as { type?: unknown; text?: unknown };
        return item.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .join("")
      .trim();
    if (text) return text;
  }
  throw new SafeAdapterError(`${label} returned no JSON text`);
}

async function requestJson(
  options: ClaudeTextJsonOptions,
  images: ClaudeImageInput[] | undefined,
): Promise<ClaudeJsonResult> {
  const prompts = validateTextInputs(options.system, options.user);
  const model = modelId(options.model);
  const maxTokens = boundedInteger(
    "Claude maxTokens",
    options.maxTokens,
    8_192,
    1,
    MAX_JSON_OUTPUT_TOKENS,
  );
  const visionImages = images ? validateImages(images) : [];
  const label = images ? "Claude Gateway vision" : "Claude Gateway text";
  const deadlineMs = timeoutMs(
    images ? "Claude vision timeoutMs" : "Claude text timeoutMs",
    options.timeoutMs,
    images ? VISION_TIMEOUT_MS : TEXT_TIMEOUT_MS,
    images ? MAX_VISION_TIMEOUT_MS : MAX_TEXT_TIMEOUT_MS,
  );
  const userContent = images
    ? [
        { type: "text", text: prompts.user },
        ...visionImages.map((image) => ({
          type: "image_url",
          image_url: {
            url: `data:${image.mime};base64,${image.b64}`,
            detail: (options as ClaudeVisionJsonOptions).imageDetail ?? "high",
          },
        })),
      ]
    : prompts.user;
  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: `${prompts.system}\n\nReturn exactly one valid JSON object and no prose or markdown.`,
      },
      { role: "user", content: userContent },
    ],
    // Claude Opus 5 through AI Gateway rejects OpenAI's response_format field.
    // The system instruction requests JSON and normalizedJsonObject below
    // still parses and rejects any non-object response locally.
    max_tokens: maxTokens,
    stream: false,
  });
  const base = gatewayBase();
  const key = getGatewayKey();
  return accountPaidProviderDispatch(
    options.dispatch
      ? {
          provider: "anthropic",
          modality: images ? "vision" : "text",
          model,
          timeoutMs: deadlineMs,
          ...options.dispatch,
        }
      : undefined,
    async () => {
      const text = await fetchBounded(
        label,
        `${base}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: requestBody,
        },
        options.signal,
        deadlineMs,
      );
      const parsed = parseBody(text, label);
      const attestation = responseAttestation(parsed, model, label);
      return {
        text: normalizedJsonObject(label, completionText(parsed, label)),
        provider: "anthropic" as const,
        ...attestation,
      };
    },
    (value) => value.responseId,
  );
}

export async function claudeTextJson(options: ClaudeTextJsonOptions): Promise<ClaudeJsonResult> {
  return requestJson(options, undefined);
}

export async function claudeVisionJson(
  options: ClaudeVisionJsonOptions,
): Promise<ClaudeJsonResult> {
  return requestJson(options, options.images);
}

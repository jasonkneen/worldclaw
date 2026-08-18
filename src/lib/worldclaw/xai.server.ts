/**
 * Server-only xAI client for WorldClaw agents.
 * Uses process.env.XAI_API_KEY — never expose to the client.
 */

import {
  accountPaidProviderDispatch,
  type PaidDispatchContext,
} from "./paid-inference.server";
import { resolvedXaiTextModel, XAI_IMAGE_MODEL_DEFAULT } from "./model-ids";

const API = "https://api.x.ai/v1";
const CHAT_TIMEOUT_MS = 45_000;
const IMAGE_TIMEOUT_MS = 120_000;
const VISION_TIMEOUT_MS = 90_000;
const MAX_VISION_IMAGES = 8;
const MAX_SYSTEM_CHARS = 32_000;
const MAX_USER_CHARS = 64_000;
const MAX_TOTAL_TEXT_CHARS = 80_000;
const MAX_IMAGE_PROMPT_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_TIMEOUT_MS = 180_000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_TEXT_CHARS = 512 * 1024;
const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_IMAGE_DIMENSION = 4_096;
const MAX_GENERATED_IMAGE_PIXELS = 16_777_216;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const RESPONSE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export interface XaiJsonResult {
  text: string;
  provider: "xai";
  /** Model identity reported by xAI and matched to the requested model. */
  model: string;
  /** Bounded xAI response identifier used to attest this exact call. */
  responseId: string;
}

export interface XaiChatOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  responseFormat?: "text" | "json_object";
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

export interface XaiVisionJsonOptions {
  system: string;
  user: string;
  images: { b64: string; mime: string }[];
  maxTokens?: number;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
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
  const cleanSystem = boundedText("xAI system prompt", system, MAX_SYSTEM_CHARS);
  const cleanUser = boundedText("xAI user prompt", user, MAX_USER_CHARS);
  if (cleanSystem.length + cleanUser.length > MAX_TOTAL_TEXT_CHARS) {
    throw new Error("xAI prompts exceed the combined character budget");
  }
  return { system: cleanSystem, user: cleanUser };
}

function normalizedBase64(
  label: string,
  value: unknown,
  maximumBytes: number,
): { b64: string; bytes: Buffer } {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must contain base64 data`);
  }
  if (value.length > Math.ceil((maximumBytes * 4) / 3) + 4) {
    throw new Error(`${label} exceeds its decoded byte budget`);
  }
  const compact = value;
  const paddingLength = compact.length - compact.replace(/=+$/, "").length;
  const unpadded = compact.replace(/=+$/, "");
  const invalidPadding =
    paddingLength > 2 ||
    (paddingLength > 0 && compact.length % 4 !== 0) ||
    (paddingLength === 1 && unpadded.length % 4 !== 3) ||
    (paddingLength === 2 && unpadded.length % 4 !== 2);
  if (!/^[a-z0-9+/]*={0,2}$/i.test(compact) || unpadded.length % 4 === 1 || invalidPadding) {
    throw new Error(`${label} contains malformed base64 data`);
  }
  const canonical = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const bytes = Buffer.from(canonical, "base64");
  if (bytes.length < 1) throw new Error(`${label} must not be empty`);
  if (bytes.length > maximumBytes) throw new Error(`${label} exceeds its decoded byte budget`);
  return { b64: canonical, bytes };
}

async function readBoundedResponse(
  response: Response,
  label: string,
  maximumBytes: number,
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

function parseResponseJson<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function imageDimensions(
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
  throw new Error("xAI image output is not a supported PNG or JPEG image");
}

function validatedGeneratedImage(value: unknown): { b64: string; mime: string } {
  const normalized = normalizedBase64(
    "xAI image output",
    value,
    MAX_GENERATED_IMAGE_BYTES,
  );
  const dimensions = imageDimensions(normalized.bytes);
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_GENERATED_IMAGE_DIMENSION ||
    dimensions.height > MAX_GENERATED_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_GENERATED_IMAGE_PIXELS
  ) {
    throw new Error("xAI image output exceeds the image dimension budget");
  }
  return { b64: normalized.b64, mime: dimensions.mime };
}

async function fetchWithDeadline(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal: requestSignal });
  } catch (error) {
    if (signal?.aborted) {
      throw new Error(`${label} cancelled`, { cause: error });
    }
    if (timeoutSignal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

function getKey(): string {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error("XAI_API_KEY is not configured. WorldClaw inference requires an xAI API key.");
  }
  return key;
}

function requestedModel(value: string | undefined): string {
  const model = resolvedXaiTextModel(value);
  if (!MODEL_ID.test(model)) throw new Error("xAI model identifier is invalid");
  return model;
}

function responseAttestation(
  body: { id?: unknown; model?: unknown },
  expectedModel: string,
  label: string,
): { model: string; responseId: string } {
  if (typeof body.model !== "string" || !MODEL_ID.test(body.model)) {
    throw new Error(`${label} returned no valid provider model identity`);
  }
  if (body.model !== expectedModel) {
    throw new Error(
      `${label} provider model mismatch: requested ${expectedModel}, received ${body.model}`,
    );
  }
  if (typeof body.id !== "string" || !RESPONSE_ID.test(body.id)) {
    throw new Error(`${label} returned no valid response identifier`);
  }
  return { model: body.model, responseId: body.id };
}

export async function xaiChatResult(opts: XaiChatOptions): Promise<XaiJsonResult> {
  const prompts = validatePrompts(opts.system, opts.user);
  const model = requestedModel(opts.model);
  const timeoutMs = boundedInteger(
    "xAI chat timeoutMs",
    opts.timeoutMs,
    CHAT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const maxTokens = boundedInteger(
    "xAI chat maxTokens",
    opts.maxTokens,
    4_096,
    1,
    MAX_OUTPUT_TOKENS,
  );
  const key = getKey();
  return accountPaidProviderDispatch(
    opts.dispatch
      ? { provider: "xai", modality: "text", model, timeoutMs, ...opts.dispatch }
      : undefined,
    async () => {
      const res = await fetchWithDeadline(
        "xAI chat",
        `${API}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            temperature: opts.temperature ?? 0.4,
            max_tokens: maxTokens,
            reasoning_effort: opts.reasoningEffort ?? "high",
            ...(opts.responseFormat ? { response_format: { type: opts.responseFormat } } : {}),
            messages: [
              { role: "system", content: prompts.system },
              { role: "user", content: prompts.user },
            ],
          }),
        },
        opts.signal,
        timeoutMs,
      );
      if (!res.ok) {
        const err = await readBoundedResponse(res, "xAI chat", MAX_JSON_RESPONSE_BYTES).catch(
          () => "",
        );
        throw new Error(`xAI chat failed ${res.status}: ${err.slice(0, 240)}`);
      }
      const body = parseResponseJson<{
        id?: unknown;
        model?: unknown;
        choices?: { message?: { content?: string } }[];
      }>("xAI chat", await readBoundedResponse(res, "xAI chat", MAX_JSON_RESPONSE_BYTES));
      const attestation = responseAttestation(body, model, "xAI chat");
      const text = body.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error("xAI chat returned no answer text");
      if (text.length > MAX_JSON_TEXT_CHARS) {
        throw new Error("xAI chat answer exceeds the text budget");
      }
      return { text, provider: "xai" as const, ...attestation };
    },
    (value) => value.responseId,
  );
}

/** Compatibility API for existing string-only callers. */
export async function xaiChat(opts: XaiChatOptions): Promise<string> {
  return (await xaiChatResult(opts)).text;
}

export async function xaiImage(opts: {
  prompt: string;
  model?: string;
  quality?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}): Promise<{ b64: string; mime: string }> {
  const prompt = boundedText("xAI image prompt", opts.prompt, MAX_IMAGE_PROMPT_CHARS);
  const model = opts.model?.trim() ||
    (opts.quality ? XAI_IMAGE_MODEL_DEFAULT : "grok-imagine-image");
  if (!MODEL_ID.test(model)) throw new Error("xAI image model identifier is invalid");
  const timeoutMs = boundedInteger(
    "xAI image timeoutMs",
    opts.timeoutMs,
    IMAGE_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const key = getKey();
  return accountPaidProviderDispatch(
    opts.dispatch
      ? { provider: "xai", modality: "image", model, timeoutMs, ...opts.dispatch }
      : undefined,
    async () => {
      const res = await fetchWithDeadline(
        "xAI image",
        `${API}/images/generations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            response_format: "b64_json",
          }),
        },
        opts.signal,
        timeoutMs,
      );
      if (!res.ok) {
        const err = await readBoundedResponse(res, "xAI image", MAX_JSON_RESPONSE_BYTES).catch(
          () => "",
        );
        throw new Error(`xAI image failed ${res.status}: ${err.slice(0, 240)}`);
      }
      const body = parseResponseJson<{
        data?: { b64_json?: unknown; url?: unknown }[];
      }>("xAI image", await readBoundedResponse(res, "xAI image", MAX_IMAGE_RESPONSE_BYTES));
      return validatedGeneratedImage(body.data?.[0]?.b64_json);
    },
  );
}

export async function xaiVisionJsonResult(
  opts: XaiVisionJsonOptions,
): Promise<XaiJsonResult> {
  const prompts = validatePrompts(opts.system, opts.user);
  if (opts.images.length === 0 || opts.images.length > MAX_VISION_IMAGES) {
    throw new Error(`xAI vision requires 1-${MAX_VISION_IMAGES} images`);
  }
  let totalImageBytes = 0;
  const imageParts = opts.images.map((image, index) => {
    if (!/^image\/(?:png|jpeg)$/i.test(image.mime)) {
      throw new Error(`xAI vision image ${index + 1} must be PNG or JPEG`);
    }
    let normalized: { b64: string; bytes: Buffer };
    try {
      normalized = normalizedBase64(
        `xAI vision image ${index + 1}`,
        image.b64,
        MAX_VISION_IMAGE_BYTES,
      );
    } catch (error) {
      throw new Error(`xAI vision image ${index + 1} exceeds the inline image budget`, {
        cause: error,
      });
    }
    totalImageBytes += normalized.bytes.length;
    return {
      type: "image_url",
      image_url: { url: `data:${image.mime.toLowerCase()};base64,${normalized.b64}` },
    };
  });
  if (totalImageBytes > MAX_VISION_TOTAL_BYTES) {
    throw new Error("xAI vision images exceed the combined inline image budget");
  }

  const model = requestedModel(opts.model);
  const timeoutMs = boundedInteger(
    "xAI vision timeoutMs",
    opts.timeoutMs,
    VISION_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const maxTokens = boundedInteger(
    "xAI vision maxTokens",
    opts.maxTokens,
    8_192,
    1,
    MAX_OUTPUT_TOKENS,
  );
  const key = getKey();
  return accountPaidProviderDispatch(
    opts.dispatch
      ? { provider: "xai", modality: "vision", model, timeoutMs, ...opts.dispatch }
      : undefined,
    async () => {
      const res = await fetchWithDeadline(
        "xAI vision",
        `${API}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            reasoning_effort: opts.reasoningEffort ?? "high",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: prompts.system },
              {
                role: "user",
                content: [{ type: "text", text: prompts.user }, ...imageParts],
              },
            ],
          }),
        },
        opts.signal,
        timeoutMs,
      );
      if (!res.ok) {
        const err = await readBoundedResponse(res, "xAI vision", MAX_JSON_RESPONSE_BYTES).catch(
          () => "",
        );
        throw new Error(`xAI vision failed ${res.status}: ${err.slice(0, 240)}`);
      }
      const body = parseResponseJson<{
        id?: unknown;
        model?: unknown;
        choices?: { message?: { content?: string } }[];
      }>(
        "xAI vision",
        await readBoundedResponse(res, "xAI vision", MAX_JSON_RESPONSE_BYTES),
      );
      const attestation = responseAttestation(body, model, "xAI vision");
      const text = body.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error("xAI vision returned no JSON answer text");
      if (text.length > MAX_JSON_TEXT_CHARS) {
        throw new Error("xAI vision answer exceeds the text budget");
      }
      // Parsing here fails closed before an invalid response reaches committee logic.
      parseJsonFromLlm<unknown>(text);
      return { text, provider: "xai" as const, ...attestation };
    },
    (value) => value.responseId,
  );
}

/** Compatibility API for existing string-only callers. */
export async function xaiVisionJson(opts: XaiVisionJsonOptions): Promise<string> {
  return (await xaiVisionJsonResult(opts)).text;
}

export function parseJsonFromLlm<T>(text: string): T {
  // strip markdown fences if present
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // try direct parse
  try {
    return JSON.parse(s) as T;
  } catch {
    // extract first {...}
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as T;
    }
    throw new Error("LLM did not return valid JSON");
  }
}

export function hasXaiKey(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

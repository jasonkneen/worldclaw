/**
 * Server-only OpenAI adapters for WorldClaw.
 *
 * Authentication is read exclusively from OPENAI_API_KEY at request time. The
 * key is sent in the Authorization header and is never placed in a URL, body,
 * return value, or provider error.
 */

import {
  accountPaidProviderDispatch,
  type PaidDispatchContext,
} from "./paid-inference.server";

const OPENAI_API = "https://api.openai.com/v1";
const DEFAULT_TEXT_MODEL = "gpt-5.6-sol";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";

const JSON_TIMEOUT_MS = 90_000;
const VISION_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 150_000;
const MAX_JSON_TIMEOUT_MS = 180_000;
const MAX_VISION_TIMEOUT_MS = 180_000;
const MAX_IMAGE_TIMEOUT_MS = 240_000;

const MAX_SYSTEM_CHARS = 32_000;
const MAX_USER_CHARS = 64_000;
const MAX_TOTAL_TEXT_CHARS = 80_000;
const MAX_IMAGE_PROMPT_CHARS = 20_000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_TEXT_CHARS = 512 * 1024;
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_JSON_OUTPUT_TOKENS = 16_384;

const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const REQUEST_ID = /^[a-z0-9._:-]{1,128}$/i;
const EDIT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VISION_IMAGE_MIMES = new Set([...EDIT_IMAGE_MIMES, "image/gif"]);

export interface OpenAIImageInput {
  b64: string;
  mime: string;
}

export interface OpenAIJsonResult {
  text: string;
  provider: "openai";
  /** Model identity reported by OpenAI and matched to the requested model. */
  model: string;
  /** Bounded OpenAI response identifier used to attest this exact call. */
  responseId: string;
}

export interface OpenAIImageResult {
  b64: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  provider: "openai";
  /** Requested image model; Images responses do not provide response-model attestation. */
  model: string;
}

export type OpenAIReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAITextJsonOptions {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  reasoningEffort?: OpenAIReasoningEffort;
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

export interface OpenAIVisionJsonOptions extends OpenAITextJsonOptions {
  images: OpenAIImageInput[];
  imageDetail?: "low" | "high" | "auto" | "original";
}

export interface OpenAIImageOptions {
  prompt: string;
  model?: string;
  referenceImages?: OpenAIImageInput[];
  mask?: OpenAIImageInput;
  size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "auto" | "low" | "medium" | "high";
  outputFormat?: "png" | "jpeg" | "webp";
  outputCompression?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

class SafeAdapterError extends Error {}

interface BoundedResponse {
  response: Response;
  text: string;
}

interface ValidatedImage extends OpenAIImageInput {
  bytes: number;
}

interface OpenAIResponsesBody {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  incomplete_details?: unknown;
  output_text?: unknown;
  output?: unknown;
  error?: unknown;
}

interface OpenAIImageBody {
  data?: unknown;
}

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new SafeAdapterError(
      "OPENAI_API_KEY is not configured. OpenAI inference requires a server API key.",
    );
  }
  return key;
}

export function hasOpenAIKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** Compatibility alias for callers that prefer conventional word casing. */
export const hasOpenAiKey = hasOpenAIKey;

function modelId(value: string | undefined, envName: string, fallback: string): string {
  const model = value?.trim() || process.env[envName]?.trim() || fallback;
  if (!MODEL_ID.test(model)) {
    throw new SafeAdapterError(`${envName} contains an invalid model identifier`);
  }
  return model;
}

function boundedText(label: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    throw new SafeAdapterError(`${label} must be text`);
  }
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
  const cleanSystem = boundedText("OpenAI system prompt", system, MAX_SYSTEM_CHARS);
  const cleanUser = boundedText("OpenAI user prompt", user, MAX_USER_CHARS);
  if (cleanSystem.length + cleanUser.length > MAX_TOTAL_TEXT_CHARS) {
    throw new SafeAdapterError(
      `OpenAI prompts exceed the ${MAX_TOTAL_TEXT_CHARS}-character combined budget`,
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
  if (bytes < 1) {
    throw new SafeAdapterError(`${label} must not be empty`);
  }
  if (bytes > maxBytes) {
    throw new SafeAdapterError(`${label} exceeds the ${maxBytes}-byte budget`);
  }
  return { b64, bytes };
}

function validateImages(
  label: string,
  images: OpenAIImageInput[],
  allowedMimes: Set<string>,
  options: { requireOne: boolean },
): ValidatedImage[] {
  if (!Array.isArray(images)) {
    throw new SafeAdapterError(`${label} must be an image array`);
  }
  if (options.requireOne && images.length === 0) {
    throw new SafeAdapterError(`${label} requires at least one image`);
  }
  if (images.length > MAX_IMAGE_COUNT) {
    throw new SafeAdapterError(`${label} accepts at most ${MAX_IMAGE_COUNT} images`);
  }

  let totalBytes = 0;
  return images.map((image, index) => {
    if (!image || typeof image !== "object") {
      throw new SafeAdapterError(`${label} image ${index + 1} is invalid`);
    }
    const mime = normalizeMime(image.mime);
    if (!allowedMimes.has(mime)) {
      throw new SafeAdapterError(`${label} image ${index + 1} has an unsupported MIME type`);
    }
    const normalized = normalizeBase64(`${label} image ${index + 1}`, image.b64, MAX_IMAGE_BYTES);
    totalBytes += normalized.bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new SafeAdapterError(
        `${label} images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte combined budget`,
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
  const requestId = response.headers.get("x-request-id")?.trim() ?? "";
  return REQUEST_ID.test(requestId) ? ` (${requestId})` : "";
}

async function fetchBounded(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  deadlineMs: number,
  responseBudget: number,
): Promise<BoundedResponse> {
  if (signal?.aborted) {
    throw new SafeAdapterError(`${label} cancelled`);
  }
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
    return {
      response,
      text: await readBoundedResponse(response, label, responseBudget),
    };
  } catch (error) {
    if (error instanceof SafeAdapterError) throw error;
    if (signal?.aborted) {
      throw new SafeAdapterError(`${label} cancelled`);
    }
    if (deadline.aborted) {
      throw new SafeAdapterError(`${label} timed out after ${deadlineMs}ms`);
    }
    throw new SafeAdapterError(`${label} request failed`);
  }
}

function parseBody<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
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
  body: OpenAIResponsesBody,
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

function responseText(body: OpenAIResponsesBody, label: string): string {
  if (body.status === "incomplete") {
    throw new SafeAdapterError(`${label} returned an incomplete response`);
  }
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }
  if (!Array.isArray(body.output)) {
    throw new SafeAdapterError(`${label} returned no output message`);
  }

  const text: string[] = [];
  for (const item of body.output) {
    if (!item || typeof item !== "object") continue;
    const outputItem = item as { type?: unknown; content?: unknown };
    if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) continue;
    for (const content of outputItem.content) {
      if (!content || typeof content !== "object") continue;
      const block = content as { type?: unknown; text?: unknown; refusal?: unknown };
      if (block.type === "refusal" || typeof block.refusal === "string") {
        throw new SafeAdapterError(`${label} was refused`);
      }
      if (block.type === "output_text" && typeof block.text === "string") {
        text.push(block.text);
      }
    }
  }
  const joined = text.join("").trim();
  if (!joined) throw new SafeAdapterError(`${label} returned no JSON text`);
  return joined;
}

async function requestJson(
  options: OpenAITextJsonOptions,
  images: OpenAIImageInput[] | undefined,
): Promise<OpenAIJsonResult> {
  const prompts = validateTextInputs(options.system, options.user);
  const model = modelId(options.model, "OPENAI_TEXT_MODEL", DEFAULT_TEXT_MODEL);
  const maxTokens = boundedInteger(
    "OpenAI maxTokens",
    options.maxTokens,
    8_192,
    1,
    MAX_JSON_OUTPUT_TOKENS,
  );
  const visionImages = images
    ? validateImages("OpenAI vision", images, VISION_IMAGE_MIMES, { requireOne: true })
    : [];
  const body = JSON.stringify({
    model,
    instructions: `${prompts.system}\n\nReturn exactly one valid JSON object and no prose or markdown.`,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            // Responses JSON mode requires the word "JSON" in an input
            // message; instructions alone do not satisfy that live contract.
            text: `Return the requested result as one JSON object.\n\n${prompts.user}`,
          },
          ...visionImages.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mime};base64,${image.b64}`,
            detail: (options as OpenAIVisionJsonOptions).imageDetail ?? "high",
          })),
        ],
      },
    ],
    text: { format: { type: "json_object" } },
    reasoning: { effort: options.reasoningEffort ?? "medium" },
    max_output_tokens: maxTokens,
    store: false,
  });
  const deadlineMs = timeoutMs(
    images ? "OpenAI vision timeoutMs" : "OpenAI text timeoutMs",
    options.timeoutMs,
    images ? VISION_TIMEOUT_MS : JSON_TIMEOUT_MS,
    images ? MAX_VISION_TIMEOUT_MS : MAX_JSON_TIMEOUT_MS,
  );
  const label = images ? "OpenAI vision" : "OpenAI text";
  const key = getOpenAIKey();
  return accountPaidProviderDispatch(
    options.dispatch
      ? {
          provider: "openai",
          modality: images ? "vision" : "text",
          model,
          timeoutMs: deadlineMs,
          ...options.dispatch,
        }
      : undefined,
    async () => {
      const result = await fetchBounded(
        label,
        `${OPENAI_API}/responses`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body,
        },
        options.signal,
        deadlineMs,
        MAX_JSON_RESPONSE_BYTES,
      );
      const parsed = parseBody<OpenAIResponsesBody>(label, result.text);
      const attestation = responseAttestation(parsed, model, label);
      return {
        text: normalizedJsonObject(label, responseText(parsed, label)),
        provider: "openai" as const,
        ...attestation,
      };
    },
    (value) => value.responseId,
  );
}

export async function openaiTextJson(options: OpenAITextJsonOptions): Promise<OpenAIJsonResult> {
  return requestJson(options, undefined);
}

export async function openaiVisionJson(
  options: OpenAIVisionJsonOptions,
): Promise<OpenAIJsonResult> {
  return requestJson(options, options.images);
}

function imageExtension(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  return mime.slice("image/".length);
}

function imageBlob(image: ValidatedImage): Blob {
  const bytes = Buffer.from(image.b64, "base64");
  return new Blob([bytes], { type: image.mime });
}

function appendImageSettings(
  form: FormData,
  options: OpenAIImageOptions,
  outputFormat: "png" | "jpeg" | "webp",
): void {
  form.append("n", "1");
  form.append("size", options.size ?? "1024x1024");
  form.append("quality", options.quality ?? "high");
  form.append("output_format", outputFormat);
  if (options.outputCompression !== undefined) {
    const compression = boundedInteger(
      "OpenAI outputCompression",
      options.outputCompression,
      100,
      0,
      100,
    );
    form.append("output_compression", String(compression));
  }
}

function generatedImage(
  label: string,
  body: OpenAIImageBody,
  model: string,
  outputFormat: "png" | "jpeg" | "webp",
): OpenAIImageResult {
  if (!Array.isArray(body.data) || !body.data[0] || typeof body.data[0] !== "object") {
    throw new SafeAdapterError(`${label} returned no image data`);
  }
  const encoded = (body.data[0] as { b64_json?: unknown }).b64_json;
  const normalized = normalizeBase64(`${label} output`, encoded, MAX_GENERATED_IMAGE_BYTES);
  return {
    b64: normalized.b64,
    mime: `image/${outputFormat}` as OpenAIImageResult["mime"],
    provider: "openai",
    model,
  };
}

export async function openaiImage(options: OpenAIImageOptions): Promise<OpenAIImageResult> {
  const prompt = boundedText("OpenAI image prompt", options.prompt, MAX_IMAGE_PROMPT_CHARS);
  const model = modelId(options.model, "OPENAI_IMAGE_MODEL", DEFAULT_IMAGE_MODEL);
  const references = validateImages(
    "OpenAI image references",
    options.referenceImages ?? [],
    EDIT_IMAGE_MIMES,
    { requireOne: false },
  );
  const mask = options.mask
    ? validateImages("OpenAI image mask", [options.mask], new Set(["image/png"]), {
        requireOne: true,
      })[0]
    : undefined;
  if (mask && references.length === 0) {
    throw new SafeAdapterError("OpenAI image masks require a reference image");
  }
  const imageInputBytes =
    references.reduce((sum, image) => sum + image.bytes, 0) + (mask?.bytes ?? 0);
  if (imageInputBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new SafeAdapterError(
      `OpenAI image inputs exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte combined budget`,
    );
  }
  const outputFormat = options.outputFormat ?? "png";
  const deadlineMs = timeoutMs(
    "OpenAI image timeoutMs",
    options.timeoutMs,
    IMAGE_TIMEOUT_MS,
    MAX_IMAGE_TIMEOUT_MS,
  );
  const label = references.length > 0 ? "OpenAI image edit" : "OpenAI image generation";
  const key = getOpenAIKey();

  let body: BodyInit;
  let headers: HeadersInit;
  let endpoint: string;
  if (references.length > 0) {
    endpoint = `${OPENAI_API}/images/edits`;
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    references.forEach((image, index) => {
      form.append(
        "image[]",
        imageBlob(image),
        `reference-${index + 1}.${imageExtension(image.mime)}`,
      );
    });
    if (mask) form.append("mask", imageBlob(mask), "mask.png");
    appendImageSettings(form, options, outputFormat);
    body = form;
    headers = { Authorization: `Bearer ${key}` };
  } else {
    endpoint = `${OPENAI_API}/images/generations`;
    body = JSON.stringify({
      model,
      prompt,
      n: 1,
      size: options.size ?? "1024x1024",
      quality: options.quality ?? "high",
      output_format: outputFormat,
      ...(options.outputCompression === undefined
        ? {}
        : {
            output_compression: boundedInteger(
              "OpenAI outputCompression",
              options.outputCompression,
              100,
              0,
              100,
            ),
          }),
    });
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
  }

  return accountPaidProviderDispatch(
    options.dispatch
      ? {
          provider: "openai",
          modality: "image",
          model,
          timeoutMs: deadlineMs,
          ...options.dispatch,
        }
      : undefined,
    async () => {
      const result = await fetchBounded(
        label,
        endpoint,
        { method: "POST", headers, body },
        options.signal,
        deadlineMs,
        MAX_IMAGE_RESPONSE_BYTES,
      );
      return generatedImage(
        label,
        parseBody<OpenAIImageBody>(label, result.text),
        model,
        outputFormat,
      );
    },
  );
}

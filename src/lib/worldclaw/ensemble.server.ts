/**
 * Bounded, server-only access to the WorldClaw model committee.
 *
 * This module deliberately returns failures as evidence instead of silently
 * substituting another provider. Callers decide whether a stage has enough
 * independent candidates to continue.
 */

import type { EnsembleProviderId, EnsembleProviderStatus } from "./types";
import type { OpenAIImageInput } from "./openai.server";
import type { PaidDispatchContext } from "./paid-inference.server";
import { resolvedXaiTextModel, XAI_IMAGE_MODEL_DEFAULT } from "./model-ids";

export interface CommitteeImageInput {
  b64: string;
  mime: string;
}

export interface CommitteeCallResult<T> {
  provider: EnsembleProviderId;
  /** Exact model identifier placed on the request. */
  requestedModel: string;
  /** Provider-reported model when attested; otherwise the requested model. */
  model: string;
  /** Provider-issued call identifier, present only after successful attestation. */
  responseId?: string;
  /** Whether model identity came back from the provider, is request-only, or could not be attested. */
  identityAttestation: "provider-response" | "request-only" | "unattested";
  configured: boolean;
  authenticated: boolean;
  available: boolean;
  ok: boolean;
  value?: T;
  error?: string;
}

export interface CommitteeTextValue {
  text: string;
  requestedModel: string;
  model: string;
  responseId: string;
}

export interface CommitteeImageValue extends CommitteeImageInput {
  /** Provider-reported values when the image endpoint exposes them. */
  model?: string;
  responseId?: string;
}

export interface CommitteeTextOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Interactive previews use medium; strict benchmark callers keep high. */
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

export interface CommitteeVisionOptions extends CommitteeTextOptions {
  images: CommitteeImageInput[];
}

export interface CommitteeImageOptions {
  prompt: string;
  /** Optional explicit image-model variant for a single-provider call. */
  model?: string;
  referenceImages?: CommitteeImageInput[];
  aspectRatio?: "1:1" | "16:9" | "4:3";
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatch?: PaidDispatchContext;
}

const PROVIDERS: EnsembleProviderId[] = ["xai", "gemini", "openai", "anthropic"];
const IMAGE_PROVIDERS = ["xai", "gemini", "openai"] as const;
const RESPONSE_ID = /^[a-z0-9][a-z0-9._:/+=-]{0,255}$/i;

export interface CommitteeQuorumOptions<T> {
  /** Number of independently usable results needed before slower calls stop. */
  minimumUsable: number;
  /** Transport success is the default; callers may additionally validate parsed output. */
  isUsable?: (result: CommitteeCallResult<T>) => boolean;
}

async function runCommitteeQuorum<P, T>(
  providers: readonly P[],
  parentSignal: AbortSignal | undefined,
  quorum: CommitteeQuorumOptions<T>,
  run: (provider: P, signal: AbortSignal) => Promise<CommitteeCallResult<T>>,
): Promise<CommitteeCallResult<T>[]> {
  const minimumUsable = Math.max(1, Math.min(providers.length, Math.trunc(quorum.minimumUsable)));
  const isUsable = quorum.isUsable ?? ((result: CommitteeCallResult<T>) => result.ok);
  parentSignal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const controllers = providers.map(() => new AbortController());
    const results = new Map<number, CommitteeCallResult<T>>();
    let settled = 0;
    let usable = 0;
    let finished = false;

    const abortPending = (reason: unknown) => {
      for (let index = 0; index < controllers.length; index++) {
        if (!results.has(index)) controllers[index]!.abort(reason);
      }
    };
    const cleanup = () => parentSignal?.removeEventListener("abort", onParentAbort);
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      abortPending(new DOMException("Interactive committee quorum satisfied", "AbortError"));
      resolve(
        providers.flatMap((_, index) => {
          const result = results.get(index);
          return result ? [result] : [];
        }),
      );
    };
    const onParentAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const reason = parentSignal?.reason ?? new DOMException("Aborted", "AbortError");
      abortPending(reason);
      reject(reason);
    };
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    providers.forEach((provider, index) => {
      const childSignal = parentSignal
        ? AbortSignal.any([parentSignal, controllers[index]!.signal])
        : controllers[index]!.signal;
      void run(provider, childSignal).then(
        (result) => {
          if (finished) return;
          results.set(index, result);
          settled++;
          if (isUsable(result)) usable++;
          if (usable >= minimumUsable || settled === providers.length) finish();
        },
        (error) => {
          if (finished) return;
          if (parentSignal?.aborted) {
            onParentAbort();
            return;
          }
          // Provider adapters normally retain failures as evidence. Preserve
          // legacy committee rejection semantics for an unexpected throw.
          finished = true;
          cleanup();
          abortPending(error);
          reject(error);
        },
      );
    });
  });
}

function providerModel(provider: EnsembleProviderId): string {
  switch (provider) {
    case "xai":
      return resolvedXaiTextModel();
    case "gemini":
      return process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash";
    case "openai":
      return process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-5.6-sol";
    case "anthropic":
      return process.env.CLAUDE_MODEL?.trim() || "anthropic/claude-opus-5";
  }
}

function imageModel(provider: Exclude<EnsembleProviderId, "anthropic">): string {
  switch (provider) {
    case "xai":
      return XAI_IMAGE_MODEL_DEFAULT;
    case "gemini":
      return process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3-pro-image";
    case "openai":
      return process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2";
  }
}

async function configured(provider: EnsembleProviderId): Promise<boolean> {
  switch (provider) {
    case "xai": {
      const { hasXaiKey } = await import("./xai.server");
      return hasXaiKey();
    }
    case "gemini": {
      const { hasGeminiKey } = await import("./gemini.server");
      return hasGeminiKey();
    }
    case "openai": {
      const { hasOpenAIKey } = await import("./openai.server");
      return hasOpenAIKey();
    }
    case "anthropic": {
      const { hasClaudeKey } = await import("./claude.server");
      return hasClaudeKey();
    }
  }
}

async function imageConfigured(
  provider: Exclude<EnsembleProviderId, "anthropic">,
): Promise<boolean> {
  if (provider === "gemini") {
    const { hasGeminiImageKey } = await import("./gemini.server");
    return hasGeminiImageKey();
  }
  return configured(provider);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:sk|xai|AIza|Bearer)[-_a-z0-9]{12,}/gi, "[credential redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function unavailable<T>(provider: EnsembleProviderId, model: string): CommitteeCallResult<T> {
  return {
    provider,
    requestedModel: model,
    model,
    identityAttestation: "unattested",
    configured: false,
    authenticated: false,
    available: false,
    ok: false,
    error: "Provider credentials are not configured",
  };
}

async function capture<T>(
  provider: EnsembleProviderId,
  model: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<CommitteeCallResult<T>> {
  if (!(await configured(provider))) return unavailable(provider, model);
  try {
    const value = await operation();
    return {
      provider,
      requestedModel: model,
      model,
      identityAttestation: "request-only",
      configured: true,
      authenticated: true,
      available: true,
      ok: true,
      value,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      provider,
      requestedModel: model,
      model,
      identityAttestation: "unattested",
      configured: true,
      authenticated: false,
      available: false,
      ok: false,
      error: safeError(error),
    };
  }
}

async function captureAttested<T extends { model: string; responseId: string }>(
  provider: EnsembleProviderId,
  requestedModel: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<CommitteeCallResult<T>> {
  if (!(await configured(provider))) return unavailable(provider, requestedModel);
  try {
    const value = await operation();
    if (value.model !== requestedModel) {
      throw new Error(
        `${provider} provider model mismatch: requested ${requestedModel}, received ${value.model}`,
      );
    }
    if (!RESPONSE_ID.test(value.responseId)) {
      throw new Error(`${provider} returned no valid response identifier`);
    }
    return {
      provider,
      requestedModel,
      model: value.model,
      responseId: value.responseId,
      identityAttestation: "provider-response",
      configured: true,
      authenticated: true,
      available: true,
      ok: true,
      value,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      provider,
      requestedModel,
      model: requestedModel,
      identityAttestation: "unattested",
      configured: true,
      authenticated: false,
      available: false,
      ok: false,
      error: safeError(error),
    };
  }
}

async function captureAttestedImage<T extends { model: string; responseId: string }>(
  provider: Exclude<EnsembleProviderId, "anthropic">,
  requestedModel: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<CommitteeCallResult<T>> {
  if (!(await imageConfigured(provider))) return unavailable(provider, requestedModel);
  return captureAttested(provider, requestedModel, signal, operation);
}

export async function runTextProvider(
  provider: EnsembleProviderId,
  options: CommitteeTextOptions,
): Promise<CommitteeCallResult<CommitteeTextValue>> {
  const model = providerModel(provider);
  return captureAttested(provider, model, options.signal, async () => {
    switch (provider) {
      case "xai": {
        const { xaiChatResult } = await import("./xai.server");
        const result = await xaiChatResult({
          ...options,
          model,
          reasoningEffort: options.reasoningEffort ?? "high",
          responseFormat: "json_object",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
      case "gemini": {
        const { geminiChatResult } = await import("./gemini.server");
        const result = await geminiChatResult({
          ...options,
          model,
          thinkingLevel: options.reasoningEffort ?? "high",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
      case "openai": {
        const { openaiTextJson } = await import("./openai.server");
        const result = await openaiTextJson({
          ...options,
          model,
          reasoningEffort: options.reasoningEffort ?? "high",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
      case "anthropic": {
        const { claudeTextJson } = await import("./claude.server");
        const result = await claudeTextJson({ ...options, model });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
    }
  });
}

export async function runTextCommittee(
  options: CommitteeTextOptions,
): Promise<CommitteeCallResult<CommitteeTextValue>[]> {
  return Promise.all(PROVIDERS.map((provider) => runTextProvider(provider, options)));
}

export async function runTextCommitteeQuorum(
  options: CommitteeTextOptions,
  quorum: CommitteeQuorumOptions<CommitteeTextValue>,
): Promise<CommitteeCallResult<CommitteeTextValue>[]> {
  return runCommitteeQuorum(PROVIDERS, options.signal, quorum, (provider, signal) =>
    runTextProvider(provider, {
      ...options,
      reasoningEffort: options.reasoningEffort ?? "medium",
      signal,
    }),
  );
}

export async function runVisionProvider(
  provider: EnsembleProviderId,
  options: CommitteeVisionOptions,
): Promise<CommitteeCallResult<CommitteeTextValue>> {
  const model = providerModel(provider);
  return captureAttested(provider, model, options.signal, async () => {
    switch (provider) {
      case "xai": {
        const { xaiVisionJsonResult } = await import("./xai.server");
        const result = await xaiVisionJsonResult({
          ...options,
          model,
          reasoningEffort: options.reasoningEffort ?? "high",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
      case "gemini": {
        const { geminiVisionJsonResult } = await import("./gemini.server");
        const result = await geminiVisionJsonResult({
          ...options,
          model,
          thinkingLevel: options.reasoningEffort ?? "high",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
      case "openai": {
        const { openaiVisionJson } = await import("./openai.server");
        const result = await openaiVisionJson({
          ...options,
          model,
          reasoningEffort: options.reasoningEffort ?? "high",
          imageDetail: "high",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
      case "anthropic": {
        const { claudeVisionJson } = await import("./claude.server");
        const result = await claudeVisionJson({
          ...options,
          model,
          imageDetail: "high",
        });
        return {
          text: result.text,
          requestedModel: model,
          model: result.model,
          responseId: result.responseId,
        };
      }
    }
  });
}

export async function runVisionCommittee(
  options: CommitteeVisionOptions,
): Promise<CommitteeCallResult<CommitteeTextValue>[]> {
  return Promise.all(PROVIDERS.map((provider) => runVisionProvider(provider, options)));
}

export async function runVisionCommitteeQuorum(
  options: CommitteeVisionOptions,
  quorum: CommitteeQuorumOptions<CommitteeTextValue>,
): Promise<CommitteeCallResult<CommitteeTextValue>[]> {
  return runCommitteeQuorum(PROVIDERS, options.signal, quorum, (provider, signal) =>
    runVisionProvider(provider, {
      ...options,
      reasoningEffort: options.reasoningEffort ?? "medium",
      signal,
    }),
  );
}

export async function runImageProvider(
  provider: Exclude<EnsembleProviderId, "anthropic">,
  options: CommitteeImageOptions,
): Promise<CommitteeCallResult<CommitteeImageValue>> {
  const model = options.model?.trim() || imageModel(provider);
  if (provider === "gemini") {
    return captureAttestedImage(provider, model, options.signal, async () => {
      const { geminiImage } = await import("./gemini.server");
      return geminiImage({
        prompt: options.prompt,
        model,
        referenceImages: options.referenceImages,
        aspectRatio: options.aspectRatio,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        dispatch: options.dispatch,
      });
    });
  }
  return capture(provider, model, options.signal, async () => {
    switch (provider) {
      case "xai": {
        const { xaiImage } = await import("./xai.server");
        return xaiImage({
          prompt: options.prompt,
          model,
          quality: true,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          dispatch: options.dispatch,
        });
      }
      case "openai": {
        const { openaiImage } = await import("./openai.server");
        const result = await openaiImage({
          prompt: options.prompt,
          model,
          referenceImages: options.referenceImages as OpenAIImageInput[] | undefined,
          size: options.aspectRatio === "1:1" ? "1024x1024" : "1536x1024",
          quality: "high",
          outputFormat: "jpeg",
          outputCompression: 88,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          dispatch: options.dispatch,
        });
        return { b64: result.b64, mime: result.mime };
      }
    }
  });
}

export async function runImageCommittee(
  options: CommitteeImageOptions,
): Promise<CommitteeCallResult<CommitteeImageValue>[]> {
  return Promise.all(IMAGE_PROVIDERS.map((provider) => runImageProvider(provider, options)));
}

export async function runImageCommitteeQuorum(
  options: CommitteeImageOptions,
  quorum: CommitteeQuorumOptions<CommitteeImageValue>,
): Promise<CommitteeCallResult<CommitteeImageValue>[]> {
  return runCommitteeQuorum(IMAGE_PROVIDERS, options.signal, quorum, (provider, signal) =>
    runImageProvider(provider, { ...options, signal }),
  );
}

export function committeeStatuses(
  results: CommitteeCallResult<unknown>[],
): EnsembleProviderStatus[] {
  return PROVIDERS.map((provider) => {
    const calls = results.filter((result) => result.provider === provider);
    const latest = calls.at(-1);
    const anySuccess = calls.some((call) => call.ok);
    if (!latest) {
      return {
        provider,
        configured: false,
        authenticated: false,
        available: false,
        model: providerModel(provider),
        skipped: true,
      };
    }
    return {
      provider,
      configured: latest?.configured ?? false,
      authenticated: anySuccess || (latest?.authenticated ?? false),
      available: anySuccess || (latest?.available ?? false),
      model: latest?.model ?? providerModel(provider),
      skipped: false,
      error: anySuccess ? undefined : latest?.error,
    };
  });
}

export function mergeCommitteeStatuses(
  ...groups: EnsembleProviderStatus[][]
): EnsembleProviderStatus[] {
  return PROVIDERS.map((provider) => {
    const entries = groups.flat().filter((entry) => entry.provider === provider);
    const latest = entries.at(-1);
    const anySuccess = entries.some((entry) => entry.available);
    const skipped = entries.length > 0 && entries.every((entry) => entry.skipped === true);
    return {
      provider,
      configured: entries.some((entry) => entry.configured),
      authenticated: entries.some((entry) => entry.authenticated),
      available: anySuccess,
      model: latest?.model ?? providerModel(provider),
      skipped,
      error: anySuccess ? undefined : latest?.error,
    };
  });
}

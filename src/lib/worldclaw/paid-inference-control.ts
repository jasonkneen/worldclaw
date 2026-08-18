/**
 * Client-safe TanStack control surface for a server-owned paid inference run.
 *
 * The caller supplies the run id and bearer token only through the exported
 * paid-inference request headers. Validators deliberately strip unknown fields,
 * and every returned ledger is the secret-free public view from the server
 * module.
 */

import { createMiddleware, createServerFn } from "@tanstack/react-start";
import type {
  ExpectedRuntimeModelRoster,
  PaidInferenceAggregateStageCeiling,
  PaidInferenceLedgerSinkConfig,
  PaidInferenceRunLedger,
  PaidInferenceStageCeiling,
  PaidModality,
  PaidProvider,
} from "./paid-inference.server";

const PROVIDERS = new Set<PaidProvider>(["xai", "gemini", "openai", "anthropic"]);
const MODALITIES = new Set<PaidModality>(["text", "vision", "image"]);
const STAGES = new Set(["planning", "layout", "multiview", "critique", "final_judge"] as const);
const ATTESTATIONS = new Set(["provider-response", "request-only"] as const);
const FINISH_STATUSES = new Set(["completed", "failed", "cancelled"] as const);
const MAX_ROSTER_ENTRIES = 16;
const MAX_STAGE_CEILINGS = 20;
const MAX_AGGREGATE_STAGE_CEILINGS = 5;
const MAX_ALLOWED_DISPATCHES = 8;
const MAX_MODEL_CHARS = 128;
const MAX_SINK_URL_CHARS = 256;
const MAX_TOKEN_CHARS = 256;
const HARD_MAX_ATTEMPTS = 47;

export interface CreatePaidInferenceBenchmarkRunInput {
  expectedRoster: ExpectedRuntimeModelRoster;
  stageCeilings: PaidInferenceStageCeiling[];
  aggregateStageCeilings: PaidInferenceAggregateStageCeiling[];
  ledgerSink?: PaidInferenceLedgerSinkConfig;
  maxAttempts?: number;
}

export interface FinishPaidInferenceBenchmarkRunInput {
  status: "completed" | "failed" | "cancelled";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const text = value.trim();
  if (!text || text.length > maximum) {
    throw new Error(`${label} must contain from 1 to ${maximum} characters`);
  }
  return text;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function validateExpectedRoster(value: unknown): ExpectedRuntimeModelRoster {
  const input = record(value, "Expected runtime roster");
  if (
    !Array.isArray(input.entries) ||
    input.entries.length < 1 ||
    input.entries.length > MAX_ROSTER_ENTRIES
  ) {
    throw new Error(`Expected runtime roster must contain from 1 to ${MAX_ROSTER_ENTRIES} entries`);
  }
  return {
    entries: input.entries.map((rawEntry, index) => {
      const entry = record(rawEntry, `Expected runtime roster entry ${index}`);
      const normalized: ExpectedRuntimeModelRoster["entries"][number] = {
        provider: enumValue(entry.provider, PROVIDERS, `Roster provider ${index}`),
        modality: enumValue(entry.modality, MODALITIES, `Roster modality ${index}`),
        model: boundedString(entry.model, `Roster model ${index}`, MAX_MODEL_CHARS),
      };
      if (entry.configured !== undefined) {
        if (typeof entry.configured !== "boolean") {
          throw new Error(`Roster configured status ${index} must be boolean`);
        }
        normalized.configured = entry.configured;
      }
      if (entry.identityAttestation !== undefined) {
        normalized.identityAttestation = enumValue(
          entry.identityAttestation,
          ATTESTATIONS,
          `Roster identity attestation ${index}`,
        );
      }
      if (entry.timeoutMs !== undefined) {
        normalized.timeoutMs = boundedInteger(
          entry.timeoutMs,
          `Roster timeout ${index}`,
          1,
          240_000,
        );
      }
      return normalized;
    }),
  };
}

function validateStageCeilings(value: unknown): PaidInferenceStageCeiling[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STAGE_CEILINGS) {
    throw new Error(
      `Paid inference control must contain from 1 to ${MAX_STAGE_CEILINGS} stage ceilings`,
    );
  }
  return value.map((rawCeiling, ceilingIndex) => {
    const ceiling = record(rawCeiling, `Stage ceiling ${ceilingIndex}`);
    if (
      !Array.isArray(ceiling.allowedDispatches) ||
      ceiling.allowedDispatches.length < 1 ||
      ceiling.allowedDispatches.length > MAX_ALLOWED_DISPATCHES
    ) {
      throw new Error(
        `Stage ceiling ${ceilingIndex} must allow from 1 to ${MAX_ALLOWED_DISPATCHES} dispatches`,
      );
    }
    return {
      provider: enumValue(ceiling.provider, PROVIDERS, `Stage provider ${ceilingIndex}`),
      stage: enumValue(ceiling.stage, STAGES, `Stage ${ceilingIndex}`),
      maxAttempts: boundedInteger(
        ceiling.maxAttempts,
        `Stage max attempts ${ceilingIndex}`,
        1,
        HARD_MAX_ATTEMPTS,
      ),
      allowedDispatches: ceiling.allowedDispatches.map((rawDispatch, dispatchIndex) => {
        const dispatch = record(
          rawDispatch,
          `Stage ceiling ${ceilingIndex} dispatch ${dispatchIndex}`,
        );
        return {
          modality: enumValue(
            dispatch.modality,
            MODALITIES,
            `Dispatch modality ${ceilingIndex}:${dispatchIndex}`,
          ),
          model: boundedString(
            dispatch.model,
            `Dispatch model ${ceilingIndex}:${dispatchIndex}`,
            MAX_MODEL_CHARS,
          ),
          timeoutMs: boundedInteger(
            dispatch.timeoutMs,
            `Dispatch timeout ${ceilingIndex}:${dispatchIndex}`,
            1,
            240_000,
          ),
        };
      }),
    };
  });
}

function validateAggregateStageCeilings(value: unknown): PaidInferenceAggregateStageCeiling[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AGGREGATE_STAGE_CEILINGS) {
    throw new Error(
      `Paid inference control must contain from 1 to ${MAX_AGGREGATE_STAGE_CEILINGS} aggregate stage ceilings`,
    );
  }
  return value.map((rawCeiling, index) => {
    const ceiling = record(rawCeiling, `Aggregate stage ceiling ${index}`);
    return {
      stage: enumValue(ceiling.stage, STAGES, `Aggregate stage ${index}`),
      maxAttempts: boundedInteger(
        ceiling.maxAttempts,
        `Aggregate stage max attempts ${index}`,
        1,
        HARD_MAX_ATTEMPTS,
      ),
    };
  });
}

function validateLedgerSink(value: unknown): PaidInferenceLedgerSinkConfig | undefined {
  if (value === undefined) return undefined;
  const sink = record(value, "Paid inference ledger sink");
  const normalized: PaidInferenceLedgerSinkConfig = {
    url: boundedString(sink.url, "Paid inference ledger sink URL", MAX_SINK_URL_CHARS),
    token: boundedString(sink.token, "Paid inference ledger sink token", MAX_TOKEN_CHARS),
  };
  if (sink.timeoutMs !== undefined) {
    normalized.timeoutMs = boundedInteger(
      sink.timeoutMs,
      "Paid inference ledger sink timeout",
      1,
      2_000,
    );
  }
  return normalized;
}

function validateCreateInput(value: unknown): CreatePaidInferenceBenchmarkRunInput {
  const input = record(value, "Paid inference run input");
  return {
    expectedRoster: validateExpectedRoster(input.expectedRoster),
    stageCeilings: validateStageCeilings(input.stageCeilings),
    aggregateStageCeilings: validateAggregateStageCeilings(input.aggregateStageCeilings),
    ...(input.ledgerSink !== undefined ? { ledgerSink: validateLedgerSink(input.ledgerSink) } : {}),
    ...(input.maxAttempts !== undefined
      ? {
          maxAttempts: boundedInteger(
            input.maxAttempts,
            "Paid inference max attempts",
            1,
            HARD_MAX_ATTEMPTS,
          ),
        }
      : {}),
  };
}

function validateFinishInput(value: unknown): FinishPaidInferenceBenchmarkRunInput {
  const input = record(value, "Paid inference finish input");
  return {
    status: enumValue(input.status, FINISH_STATUSES, "Paid inference finish status"),
  };
}

/** Apply this middleware to every server function that may dispatch a paid call. */
export const paidInferenceRunMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const { withPaidInferenceRequest } = await import("./paid-inference.server");
    return withPaidInferenceRequest(() => next());
  },
);

export const createPaidInferenceBenchmarkRun = createServerFn({ method: "POST" })
  .validator(validateCreateInput)
  .handler(async ({ data }): Promise<PaidInferenceRunLedger> => {
    const { createPaidInferenceRun, requirePaidInferenceRequestIdentity } =
      await import("./paid-inference.server");
    const { runId, enforcementToken } = await requirePaidInferenceRequestIdentity();
    return createPaidInferenceRun({
      runId,
      enforcementToken,
      expectedRoster: data.expectedRoster,
      stageCeilings: data.stageCeilings,
      aggregateStageCeilings: data.aggregateStageCeilings,
      ...(data.ledgerSink ? { ledgerSink: data.ledgerSink } : {}),
      ...(data.maxAttempts !== undefined ? { maxAttempts: data.maxAttempts } : {}),
    });
  });

export const getPaidInferenceBenchmarkLedger = createServerFn({ method: "GET" }).handler(
  async (): Promise<PaidInferenceRunLedger> => {
    const { getPaidInferenceRunLedger, requirePaidInferenceRequestIdentity } =
      await import("./paid-inference.server");
    const { runId, enforcementToken } = await requirePaidInferenceRequestIdentity();
    return getPaidInferenceRunLedger(runId, enforcementToken);
  },
);

export const finishPaidInferenceBenchmarkRun = createServerFn({ method: "POST" })
  .validator(validateFinishInput)
  .handler(async ({ data }): Promise<PaidInferenceRunLedger> => {
    const { finishPaidInferenceRun, requirePaidInferenceRequestIdentity } =
      await import("./paid-inference.server");
    const { runId, enforcementToken } = await requirePaidInferenceRequestIdentity();
    return finishPaidInferenceRun(runId, enforcementToken, data.status);
  });

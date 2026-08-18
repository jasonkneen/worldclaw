/**
 * Server-only, in-memory safety boundary for paid WorldClaw provider calls.
 *
 * Normal interactive app calls remain compatible when benchmark enforcement is
 * absent. A benchmark caller sets WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN and
 * creates/attaches a run before any provider dispatch; provider adapters then
 * fail before fetch if that request-bound context is missing or mismatched.
 * Nothing in this module writes to the runtime filesystem.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { XAI_IMAGE_MODEL_DEFAULT, XAI_TEXT_MODEL_DEFAULT } from "./model-ids";

/** Request headers the benchmark server functions must reattach on every call. */
export const PAID_INFERENCE_RUN_ID_HEADER = "x-worldclaw-paid-run-id";
export const PAID_INFERENCE_RUN_TOKEN_HEADER = "x-worldclaw-paid-run-token";

export type PaidProvider = "xai" | "gemini" | "openai" | "anthropic";
export type PaidModality = "text" | "vision" | "image";
export type PaidInferenceStage = "planning" | "layout" | "multiview" | "critique" | "final_judge";
export type PaidAttemptOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface RuntimeModelRosterEntry {
  provider: PaidProvider;
  modality: PaidModality;
  model: string;
  configured: boolean;
  identityAttestation: "provider-response" | "request-only";
  defaultTimeoutMs: number;
  maximumTimeoutMs: number;
}

export interface RuntimeModelRosterSnapshot {
  version: 1;
  enforcementRequired: boolean;
  entries: RuntimeModelRosterEntry[];
}

export interface ExpectedRuntimeModelRoster {
  entries: Array<{
    provider: PaidProvider;
    modality: PaidModality;
    model: string;
    configured?: boolean;
    identityAttestation?: "provider-response" | "request-only";
    timeoutMs?: number;
  }>;
}

export interface PaidInferenceAttemptEvent {
  type: "attempt";
  sequence: number;
  at: string;
  attemptId: string;
  provider: PaidProvider;
  modality: PaidModality;
  model: string;
  timeoutMs: number;
  stage: PaidInferenceStage;
  iteration: number;
  role: string;
}

export interface PaidInferenceOutcomeEvent {
  type: "outcome";
  sequence: number;
  at: string;
  attemptId: string;
  outcome: PaidAttemptOutcome;
  responseId?: string;
  error?: string;
}

export interface PaidInferenceRunEvent {
  type: "run";
  sequence: number;
  at: string;
  status: "created" | "completed" | "failed" | "cancelled";
}

export type PaidInferenceLedgerEvent =
  PaidInferenceAttemptEvent | PaidInferenceOutcomeEvent | PaidInferenceRunEvent;

export interface PaidInferenceRunLedger {
  version: 1;
  runId: string;
  createdAt: string;
  maxAttempts: number;
  attemptCount: number;
  status: "open" | "completed" | "failed" | "cancelled";
  roster: RuntimeModelRosterSnapshot;
  stageCeilings: PaidInferenceStageCeiling[];
  aggregateStageCeilings: PaidInferenceAggregateStageCeiling[];
  events: PaidInferenceLedgerEvent[];
}

export interface PaidInferenceStageCeiling {
  provider: PaidProvider;
  stage: PaidInferenceStage;
  maxAttempts: number;
  allowedDispatches: PaidInferenceAllowedDispatch[];
}

export interface PaidInferenceAllowedDispatch {
  modality: PaidModality;
  model: string;
  timeoutMs: number;
}

export interface PaidInferenceAggregateStageCeiling {
  stage: PaidInferenceStage;
  maxAttempts: number;
}

export interface PaidInferenceLedgerSinkConfig {
  url: string;
  token: string;
  timeoutMs?: number;
}

export interface PaidInferenceRunConfig {
  runId: string;
  enforcementToken: string;
  expectedRoster: ExpectedRuntimeModelRoster;
  stageCeilings: PaidInferenceStageCeiling[];
  aggregateStageCeilings: PaidInferenceAggregateStageCeiling[];
  ledgerSink?: PaidInferenceLedgerSinkConfig;
  maxAttempts?: number;
}

export interface PaidDispatchContext {
  stage: PaidInferenceStage;
  iteration: number;
  role: string;
}

export interface PaidDispatchDescriptor extends PaidDispatchContext {
  provider: PaidProvider;
  modality: PaidModality;
  model: string;
  timeoutMs: number;
}

/**
 * Opaque identity for adapter-local health state shared by every attachment to
 * one paid run. It contains no run id, enforcement token, or public ledger
 * data and is intentionally useful only by object identity.
 */
export type PaidInferenceRunScope = Readonly<object>;

interface RunState extends PaidInferenceRunLedger {
  /** Private request-bound bearer value; never serialized by publicLedger. */
  enforcementToken: string;
  /** Private stable identity used by bounded, run-local provider circuits. */
  scope: PaidInferenceRunScope;
  ledgerSink?: Required<PaidInferenceLedgerSinkConfig>;
  attemptIds: Set<string>;
  stageAttemptCounts: Map<string, number>;
  aggregateStageAttemptCounts: Map<PaidInferenceStage, number>;
}

interface RunContext {
  runId: string;
  enforcementToken: string;
  scope: PaidInferenceRunScope;
}

export interface PaidInferenceRequestIdentity {
  request: Request;
  runId: string;
  enforcementToken: string;
}

const RUN_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{15,255}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const PROVIDER_RESPONSE_ID = /^[a-z0-9][a-z0-9._:/+=-]{0,255}$/i;
const ROLE = /^[a-z0-9][a-z0-9 ._:/-]{0,95}$/i;
const DEFAULT_MAX_ATTEMPTS = 47;
const HARD_MAX_ATTEMPTS = 47;
const MAX_RETAINED_RUNS = 32;
const MAX_EVENTS_PER_RUN = HARD_MAX_ATTEMPTS * 2 + 4;
const ERROR_MAX_CHARS = 320;
const MAX_ITERATION = 32;
const DEFAULT_SINK_TIMEOUT_MS = 1_000;
const MAX_SINK_TIMEOUT_MS = 2_000;
const MAX_SINK_PAYLOAD_BYTES = 8 * 1024;
const MIN_EPHEMERAL_PORT = 49_152;
const MAX_PORT = 65_535;
const MAX_ALLOWED_DISPATCHES_PER_STAGE = 8;
const runs = new Map<string, RunState>();
const runContext = new AsyncLocalStorage<RunContext>();

export type PaidInferenceLedgerSinkWriter = (
  sink: Readonly<Required<PaidInferenceLedgerSinkConfig>>,
  payload: Readonly<{ version: 1; runId: string; event: PaidInferenceLedgerEvent }>,
) => Promise<void>;

let testSinkWriter: PaidInferenceLedgerSinkWriter | undefined;

type PaidInferenceLedgerEventInput =
  | Omit<PaidInferenceAttemptEvent, "sequence" | "at">
  | Omit<PaidInferenceOutcomeEvent, "sequence" | "at">
  | Omit<PaidInferenceRunEvent, "sequence" | "at">;

function envModel(name: string, fallback: string): string {
  const model = process.env[name]?.trim() || fallback;
  if (!MODEL_ID.test(model)) throw new Error(`${name} contains an invalid model identifier`);
  return model;
}

function exactEnvModel(name: string, required: string): string {
  const model = envModel(name, required);
  if (model !== required) throw new Error(`${name} must be exactly ${required}`);
  return model;
}

function configured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function enforcementToken(): string | undefined {
  return process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN?.trim() || undefined;
}

export function benchmarkPaidInferenceEnforcementRequired(): boolean {
  return Boolean(enforcementToken()) || [...runs.values()].some((state) => state.status === "open");
}

export function runtimeModelRosterSnapshot(): RuntimeModelRosterSnapshot {
  const xaiConfigured = configured("XAI_API_KEY");
  const geminiDirectConfigured = configured("GEMINI_API_KEY");
  const geminiTextConfigured = geminiDirectConfigured || configured("AI_GATEWAY_API_KEY");
  const openaiConfigured = configured("OPENAI_API_KEY");
  const claudeConfigured = configured("AI_GATEWAY_API_KEY");
  const entries: RuntimeModelRosterEntry[] = [
    {
      provider: "xai",
      modality: "text",
      model: envModel("XAI_TEXT_MODEL", XAI_TEXT_MODEL_DEFAULT),
      configured: xaiConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 45_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "xai",
      modality: "vision",
      model: envModel("XAI_TEXT_MODEL", XAI_TEXT_MODEL_DEFAULT),
      configured: xaiConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 90_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "xai",
      modality: "image",
      model: XAI_IMAGE_MODEL_DEFAULT,
      configured: xaiConfigured,
      identityAttestation: "request-only",
      defaultTimeoutMs: 120_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "gemini",
      modality: "text",
      model: exactEnvModel("GEMINI_TEXT_MODEL", "gemini-3.6-flash"),
      configured: geminiTextConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 45_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "gemini",
      modality: "vision",
      model: exactEnvModel("GEMINI_TEXT_MODEL", "gemini-3.6-flash"),
      configured: geminiTextConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 90_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "gemini",
      modality: "image",
      model: exactEnvModel("GEMINI_IMAGE_MODEL", "gemini-3-pro-image"),
      configured: geminiDirectConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 120_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "openai",
      modality: "text",
      model: envModel("OPENAI_TEXT_MODEL", "gpt-5.6-sol"),
      configured: openaiConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 90_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "openai",
      modality: "vision",
      model: envModel("OPENAI_TEXT_MODEL", "gpt-5.6-sol"),
      configured: openaiConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 120_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "openai",
      modality: "image",
      model: envModel("OPENAI_IMAGE_MODEL", "gpt-image-2"),
      configured: openaiConfigured,
      identityAttestation: "request-only",
      defaultTimeoutMs: 150_000,
      maximumTimeoutMs: 240_000,
    },
    {
      provider: "anthropic",
      modality: "text",
      model: envModel("CLAUDE_MODEL", "anthropic/claude-opus-5"),
      configured: claudeConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 90_000,
      maximumTimeoutMs: 180_000,
    },
    {
      provider: "anthropic",
      modality: "vision",
      model: envModel("CLAUDE_MODEL", "anthropic/claude-opus-5"),
      configured: claudeConfigured,
      identityAttestation: "provider-response",
      defaultTimeoutMs: 120_000,
      maximumTimeoutMs: 180_000,
    },
  ];
  return {
    version: 1,
    enforcementRequired: benchmarkPaidInferenceEnforcementRequired(),
    entries: entries.map((entry) => ({ ...entry })),
  };
}

function rosterKey(entry: { provider: PaidProvider; modality: PaidModality; model: string }) {
  return `${entry.provider}:${entry.modality}:${entry.model}`;
}

export function assertRuntimeModelRoster(
  expected: ExpectedRuntimeModelRoster,
): RuntimeModelRosterSnapshot {
  if (!expected || !Array.isArray(expected.entries) || expected.entries.length === 0) {
    throw new Error("Expected runtime model roster must contain entries");
  }
  const snapshot = runtimeModelRosterSnapshot();
  const actual = new Map(snapshot.entries.map((entry) => [rosterKey(entry), entry]));
  const expectedKeys = new Set<string>();
  for (const entry of expected.entries) {
    if (!MODEL_ID.test(entry.model)) throw new Error("Expected roster contains an invalid model");
    const key = rosterKey(entry);
    if (expectedKeys.has(key)) throw new Error(`Expected roster duplicates ${key}`);
    expectedKeys.add(key);
    const found = actual.get(key);
    if (!found) throw new Error(`Runtime model roster omitted ${key}`);
    if (entry.configured !== undefined && found.configured !== entry.configured) {
      throw new Error(`${key} configured status drifted`);
    }
    if (
      entry.identityAttestation !== undefined &&
      found.identityAttestation !== entry.identityAttestation
    ) {
      throw new Error(`${key} identity attestation drifted`);
    }
    if (
      entry.timeoutMs !== undefined &&
      (!Number.isInteger(entry.timeoutMs) ||
        entry.timeoutMs < 1 ||
        entry.timeoutMs > found.maximumTimeoutMs)
    ) {
      throw new Error(
        `${key} timeout ${entry.timeoutMs}ms exceeds adapter maximum ${found.maximumTimeoutMs}ms`,
      );
    }
  }
  if (expectedKeys.size !== actual.size) {
    const unexpected = [...actual.keys()].filter((key) => !expectedKeys.has(key));
    throw new Error(`Runtime model roster has unexpected entries: ${unexpected.join(", ")}`);
  }
  return snapshot;
}

function now(): string {
  return new Date().toISOString();
}

function appendEvent(
  state: RunState,
  event: PaidInferenceLedgerEventInput,
): PaidInferenceLedgerEvent {
  if (state.events.length >= MAX_EVENTS_PER_RUN) {
    throw new Error(`Paid inference ledger ${state.runId} exceeded its event budget`);
  }
  const recorded = {
    ...event,
    sequence: state.events.length + 1,
    at: now(),
  } as PaidInferenceLedgerEvent;
  state.events.push(recorded);
  return recorded;
}

function stageCeilingKey(provider: PaidProvider, stage: PaidInferenceStage): string {
  return `${provider}:${stage}`;
}

function validateStageCeilings(
  input: PaidInferenceStageCeiling[],
  aggregateMaximum: number,
  roster: RuntimeModelRosterSnapshot,
): PaidInferenceStageCeiling[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Paid inference run requires per-provider stage ceilings");
  }
  const seen = new Set<string>();
  return input.map((entry) => {
    const key = stageCeilingKey(entry.provider, entry.stage);
    if (seen.has(key)) throw new Error(`Paid inference stage ceiling duplicates ${key}`);
    seen.add(key);
    if (
      !Number.isInteger(entry.maxAttempts) ||
      entry.maxAttempts < 1 ||
      entry.maxAttempts > aggregateMaximum
    ) {
      throw new Error(`Paid inference stage ceiling ${key} must be from 1 to ${aggregateMaximum}`);
    }
    if (
      !Array.isArray(entry.allowedDispatches) ||
      entry.allowedDispatches.length < 1 ||
      entry.allowedDispatches.length > MAX_ALLOWED_DISPATCHES_PER_STAGE
    ) {
      throw new Error(
        `Paid inference stage ceiling ${key} must allow from 1 to ${MAX_ALLOWED_DISPATCHES_PER_STAGE} exact dispatches`,
      );
    }
    const allowedKeys = new Set<string>();
    const allowedDispatches = entry.allowedDispatches.map((allowed) => {
      const allowedKey = `${allowed.modality}:${allowed.model}:${allowed.timeoutMs}`;
      if (allowedKeys.has(allowedKey)) {
        throw new Error(`Paid inference stage ceiling ${key} duplicates ${allowedKey}`);
      }
      allowedKeys.add(allowedKey);
      const rosterEntry = roster.entries.find(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.modality === allowed.modality &&
          candidate.model === allowed.model,
      );
      if (!rosterEntry) {
        throw new Error(
          `Paid inference stage ceiling ${key} allows a dispatch outside the runtime model roster`,
        );
      }
      if (!rosterEntry.configured) {
        throw new Error(`Paid inference stage ceiling ${key} requires a configured provider`);
      }
      if (
        !Number.isInteger(allowed.timeoutMs) ||
        allowed.timeoutMs < 1 ||
        allowed.timeoutMs > rosterEntry.maximumTimeoutMs
      ) {
        throw new Error(
          `Paid inference stage ceiling ${key} timeout ${allowed.timeoutMs}ms exceeds adapter maximum ${rosterEntry.maximumTimeoutMs}ms`,
        );
      }
      return { ...allowed };
    });
    return { ...entry, allowedDispatches };
  });
}

function validateAggregateStageCeilings(
  input: PaidInferenceAggregateStageCeiling[],
  aggregateMaximum: number,
  stageCeilings: PaidInferenceStageCeiling[],
): PaidInferenceAggregateStageCeiling[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5) {
    throw new Error("Paid inference run requires from 1 to 5 aggregate stage ceilings");
  }
  const providerStages = new Set(stageCeilings.map((entry) => entry.stage));
  const providerMaximums = new Map<PaidInferenceStage, number>();
  for (const entry of stageCeilings) {
    providerMaximums.set(entry.stage, (providerMaximums.get(entry.stage) ?? 0) + entry.maxAttempts);
  }
  const seen = new Set<PaidInferenceStage>();
  const normalized = input.map((entry) => {
    if (seen.has(entry.stage)) {
      throw new Error(`Paid inference aggregate stage ceiling duplicates ${entry.stage}`);
    }
    seen.add(entry.stage);
    if (!providerStages.has(entry.stage)) {
      throw new Error(
        `Paid inference aggregate stage ceiling ${entry.stage} has no provider-stage ceiling`,
      );
    }
    if (
      !Number.isInteger(entry.maxAttempts) ||
      entry.maxAttempts < 1 ||
      entry.maxAttempts > aggregateMaximum
    ) {
      throw new Error(
        `Paid inference aggregate stage ceiling ${entry.stage} must be from 1 to ${aggregateMaximum}`,
      );
    }
    const providerMaximum = providerMaximums.get(entry.stage) ?? 0;
    if (entry.maxAttempts > providerMaximum) {
      throw new Error(
        `Paid inference aggregate stage ceiling ${entry.stage} exceeds its provider-stage total ${providerMaximum}`,
      );
    }
    return { ...entry };
  });
  const missing = [...providerStages].filter((stage) => !seen.has(stage));
  if (missing.length > 0) {
    throw new Error(`Paid inference aggregate stage ceilings omitted ${missing.join(", ")}`);
  }
  return normalized;
}

function validateLedgerSink(
  input: PaidInferenceLedgerSinkConfig | undefined,
): Required<PaidInferenceLedgerSinkConfig> | undefined {
  if (!input) return undefined;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Paid inference ledger sink URL is invalid");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < MIN_EPHEMERAL_PORT ||
    port > MAX_PORT
  ) {
    throw new Error(
      `Paid inference ledger sink must be exactly http://127.0.0.1:<${MIN_EPHEMERAL_PORT}-${MAX_PORT}>/`,
    );
  }
  if (!TOKEN.test(input.token)) throw new Error("Paid inference ledger sink token is invalid");
  const timeoutMs = input.timeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SINK_TIMEOUT_MS) {
    throw new Error(
      `Paid inference ledger sink timeout must be from 1 to ${MAX_SINK_TIMEOUT_MS}ms`,
    );
  }
  return { url: url.toString(), token: input.token, timeoutMs };
}

const defaultSinkWriter: PaidInferenceLedgerSinkWriter = async (sink, payload) => {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_SINK_PAYLOAD_BYTES) {
    throw new Error("Paid inference ledger sink payload exceeds its byte budget");
  }
  const deadline = AbortSignal.timeout(sink.timeoutMs);
  let response: Response;
  try {
    response = await fetch(sink.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sink.token}`,
      },
      body,
      signal: deadline,
    });
  } catch (error) {
    if (deadline.aborted) {
      throw new Error(`Paid inference ledger sink timed out after ${sink.timeoutMs}ms`, {
        cause: error,
      });
    }
    throw new Error("Paid inference ledger sink request failed", { cause: error });
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Paid inference ledger sink failed with HTTP ${response.status}`);
  }
};

async function persistEvent(state: RunState, event: PaidInferenceLedgerEvent): Promise<void> {
  if (!state.ledgerSink) return;
  const payload = {
    version: 1,
    runId: state.runId,
    event: { ...event },
  } as const;
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SINK_PAYLOAD_BYTES) {
    throw new Error("Paid inference ledger sink payload exceeds its byte budget");
  }
  await (testSinkWriter ?? defaultSinkWriter)(state.ledgerSink, payload);
}

function evictFinishedRuns(): void {
  if (runs.size < MAX_RETAINED_RUNS) return;
  for (const [runId, state] of runs) {
    if (state.status !== "open") {
      runs.delete(runId);
      if (runs.size < MAX_RETAINED_RUNS) return;
    }
  }
  throw new Error(`Paid inference run registry reached its ${MAX_RETAINED_RUNS}-run budget`);
}

function validateRunIdentity(runId: string, token: string): void {
  if (!RUN_ID.test(runId)) throw new Error("Paid inference runId is invalid");
  if (!TOKEN.test(token)) throw new Error("Paid inference enforcement token is invalid");
  const required = enforcementToken();
  if (required && token !== required) throw new Error("Benchmark enforcement token mismatch");
}

export function createPaidInferenceRun(config: PaidInferenceRunConfig): PaidInferenceRunLedger {
  validateRunIdentity(config.runId, config.enforcementToken);
  if (runs.has(config.runId)) throw new Error(`Paid inference run ${config.runId} already exists`);
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > HARD_MAX_ATTEMPTS) {
    throw new Error(`Paid inference maxAttempts must be from 1 to ${HARD_MAX_ATTEMPTS}`);
  }
  const roster = assertRuntimeModelRoster(config.expectedRoster);
  const stageCeilings = validateStageCeilings(config.stageCeilings, maxAttempts, roster);
  const aggregateStageCeilings = validateAggregateStageCeilings(
    config.aggregateStageCeilings,
    maxAttempts,
    stageCeilings,
  );
  const ledgerSink = validateLedgerSink(config.ledgerSink);
  evictFinishedRuns();
  const state: RunState = {
    version: 1,
    runId: config.runId,
    enforcementToken: config.enforcementToken,
    scope: Object.freeze({}),
    createdAt: now(),
    maxAttempts,
    attemptCount: 0,
    status: "open",
    roster,
    stageCeilings,
    aggregateStageCeilings,
    events: [],
    ledgerSink,
    attemptIds: new Set(),
    stageAttemptCounts: new Map(),
    aggregateStageAttemptCounts: new Map(),
  };
  appendEvent(state, { type: "run", status: "created" });
  runs.set(config.runId, state);
  state.roster.enforcementRequired = benchmarkPaidInferenceEnforcementRequired();
  return getPaidInferenceRunLedger(config.runId, config.enforcementToken);
}

export function withPaidInferenceRun<T>(
  runId: string,
  enforcementTokenValue: string,
  operation: () => T,
): T {
  validateRunIdentity(runId, enforcementTokenValue);
  const state = runs.get(runId);
  if (!state || state.enforcementToken !== enforcementTokenValue) {
    throw new Error(`Paid inference run ${runId} is unavailable`);
  }
  if (state.status !== "open") throw new Error(`Paid inference run ${runId} is closed`);
  return runContext.run(
    { runId, enforcementToken: enforcementTokenValue, scope: state.scope },
    operation,
  );
}

/**
 * Return the current paid run's secret-free opaque scope, if attached.
 * Provider adapters may key WeakMap/WeakSet state with this object without
 * retaining run identifiers or extending state beyond the run registry.
 */
export function currentPaidInferenceRunScope(): PaidInferenceRunScope | undefined {
  return runContext.getStore()?.scope;
}

function paidInferenceRequestIdentity(request: Request): PaidInferenceRequestIdentity | undefined {
  const runId = request.headers.get(PAID_INFERENCE_RUN_ID_HEADER)?.trim() || undefined;
  const enforcementTokenValue =
    request.headers.get(PAID_INFERENCE_RUN_TOKEN_HEADER)?.trim() || undefined;
  if (Boolean(runId) !== Boolean(enforcementTokenValue)) {
    throw new Error("Paid inference request must provide both run id and token headers");
  }
  if (!runId || !enforcementTokenValue) return undefined;
  return { request, runId, enforcementToken: enforcementTokenValue };
}

async function currentPaidInferenceRequest(): Promise<Request> {
  const { getRequest } = await import("@tanstack/react-start/server");
  return getRequest();
}

/** Read and validate the request-bound benchmark bearer pair. */
export async function requirePaidInferenceRequestIdentity(): Promise<PaidInferenceRequestIdentity> {
  const request = await currentPaidInferenceRequest();
  const identity = paidInferenceRequestIdentity(request);
  if (!identity) throw new Error("Paid inference request identity is missing");
  return identity;
}

/**
 * Reattach a server-function request to its run-scoped dispatch context.
 * Requests without benchmark headers remain compatible only while enforcement
 * is disabled and no run is open in this server process.
 */
export async function withPaidInferenceRequest<T>(
  operation: (request: Request) => T,
): Promise<Awaited<T>> {
  const request = await currentPaidInferenceRequest();
  const identity = paidInferenceRequestIdentity(request);
  if (!identity) {
    if (benchmarkPaidInferenceEnforcementRequired()) {
      throw new Error("Benchmark paid inference request identity is missing");
    }
    return await operation(request);
  }
  return await withPaidInferenceRun(identity.runId, identity.enforcementToken, () =>
    operation(request),
  );
}

export async function runPaidInference<T>(
  config: PaidInferenceRunConfig,
  operation: () => Promise<T>,
): Promise<T> {
  createPaidInferenceRun(config);
  try {
    const value = await withPaidInferenceRun(config.runId, config.enforcementToken, operation);
    finishPaidInferenceRun(config.runId, config.enforcementToken, "completed");
    return value;
  } catch (error) {
    const state = runs.get(config.runId);
    if (state?.status === "open") {
      finishPaidInferenceRun(
        config.runId,
        config.enforcementToken,
        error instanceof Error && /cancel/i.test(error.message) ? "cancelled" : "failed",
      );
    }
    throw error;
  }
}

export function finishPaidInferenceRun(
  runId: string,
  enforcementTokenValue: string,
  status: "completed" | "failed" | "cancelled",
): PaidInferenceRunLedger {
  validateRunIdentity(runId, enforcementTokenValue);
  const state = runs.get(runId);
  if (!state || state.enforcementToken !== enforcementTokenValue) {
    throw new Error(`Paid inference run ${runId} is unavailable`);
  }
  if (state.status !== "open") throw new Error(`Paid inference run ${runId} is already closed`);
  const completedAttemptIds = new Set(
    state.events
      .filter((event): event is PaidInferenceOutcomeEvent => event.type === "outcome")
      .map((event) => event.attemptId),
  );
  const pendingAttempts = state.events.filter(
    (event): event is PaidInferenceAttemptEvent =>
      event.type === "attempt" && !completedAttemptIds.has(event.attemptId),
  );
  if (status === "completed" && pendingAttempts.length > 0) {
    throw new Error(
      `Paid inference run ${runId} cannot complete with ${pendingAttempts.length} pending attempt(s)`,
    );
  }
  for (const attempt of pendingAttempts) {
    appendEvent(state, {
      type: "outcome",
      attemptId: attempt.attemptId,
      outcome: status === "cancelled" ? "cancelled" : "failed",
      error: `Run ${status} before the provider outcome was retained`,
    });
  }
  state.status = status;
  appendEvent(state, { type: "run", status });
  return getPaidInferenceRunLedger(runId, enforcementTokenValue);
}

function publicLedger(state: RunState): PaidInferenceRunLedger {
  return {
    version: state.version,
    runId: state.runId,
    createdAt: state.createdAt,
    maxAttempts: state.maxAttempts,
    attemptCount: state.attemptCount,
    status: state.status,
    roster: {
      ...state.roster,
      entries: state.roster.entries.map((entry) => ({ ...entry })),
    },
    stageCeilings: state.stageCeilings.map((entry) => ({
      ...entry,
      allowedDispatches: entry.allowedDispatches.map((allowed) => ({ ...allowed })),
    })),
    aggregateStageCeilings: state.aggregateStageCeilings.map((entry) => ({ ...entry })),
    events: state.events.map((event) => ({ ...event })),
  };
}

export function getPaidInferenceRunLedger(
  runId: string,
  enforcementTokenValue: string,
): PaidInferenceRunLedger {
  validateRunIdentity(runId, enforcementTokenValue);
  const state = runs.get(runId);
  if (!state || state.enforcementToken !== enforcementTokenValue) {
    throw new Error(`Paid inference run ${runId} is unavailable`);
  }
  return publicLedger(state);
}

function activeRunForDispatch(): RunState | undefined {
  const requiredToken = enforcementToken();
  const enforcementRequired = benchmarkPaidInferenceEnforcementRequired();
  const context = runContext.getStore();
  if (!context) {
    if (enforcementRequired) {
      throw new Error("Benchmark paid inference dispatch has no active run context");
    }
    return undefined;
  }
  if (requiredToken && context.enforcementToken !== requiredToken) {
    throw new Error("Benchmark paid inference run token drifted");
  }
  const state = runs.get(context.runId);
  if (!state || state.enforcementToken !== context.enforcementToken) {
    throw new Error("Benchmark paid inference run is unavailable");
  }
  if (state.status !== "open") throw new Error(`Paid inference run ${state.runId} is closed`);
  return state;
}

function validateDispatchContext(descriptor: PaidDispatchDescriptor): void {
  if (!ROLE.test(descriptor.role)) throw new Error("Paid dispatch role is invalid");
  if (
    !Number.isInteger(descriptor.iteration) ||
    descriptor.iteration < 1 ||
    descriptor.iteration > MAX_ITERATION
  ) {
    throw new Error(`Paid dispatch iteration must be from 1 to ${MAX_ITERATION}`);
  }
}

export async function beginPaidProviderDispatch(
  descriptor: PaidDispatchDescriptor | undefined,
): Promise<string | undefined> {
  const state = activeRunForDispatch();
  if (!state) return undefined;
  if (!descriptor) {
    throw new Error("Benchmark paid inference dispatch metadata is missing");
  }
  validateDispatchContext(descriptor);
  if (!MODEL_ID.test(descriptor.model)) throw new Error("Paid dispatch model is invalid");
  const roster = state.roster.entries.find(
    (entry) =>
      entry.provider === descriptor.provider &&
      entry.modality === descriptor.modality &&
      entry.model === descriptor.model,
  );
  if (!roster) {
    throw new Error(`Paid dispatch is outside the preflighted roster: ${rosterKey(descriptor)}`);
  }
  if (!roster.configured) {
    throw new Error(`Paid dispatch provider is not configured: ${rosterKey(descriptor)}`);
  }
  if (
    !Number.isInteger(descriptor.timeoutMs) ||
    descriptor.timeoutMs < 1 ||
    descriptor.timeoutMs > roster.maximumTimeoutMs
  ) {
    throw new Error(
      `${rosterKey(descriptor)} timeout ${descriptor.timeoutMs}ms exceeds adapter maximum ${roster.maximumTimeoutMs}ms`,
    );
  }
  if (state.attemptCount >= state.maxAttempts) {
    throw new Error(
      `Paid inference run ${state.runId} exhausted its ${state.maxAttempts}-attempt cap`,
    );
  }
  const ceilingKey = stageCeilingKey(descriptor.provider, descriptor.stage);
  const ceiling = state.stageCeilings.find(
    (entry) => entry.provider === descriptor.provider && entry.stage === descriptor.stage,
  );
  if (!ceiling) {
    throw new Error(`Paid dispatch has no preflighted stage ceiling: ${ceilingKey}`);
  }
  const allowedDispatch = ceiling.allowedDispatches.find(
    (allowed) =>
      allowed.modality === descriptor.modality &&
      allowed.model === descriptor.model &&
      allowed.timeoutMs === descriptor.timeoutMs,
  );
  if (!allowedDispatch) {
    throw new Error(
      `Paid dispatch drifted from ${ceilingKey}'s preflighted modality, model, or timeout`,
    );
  }
  const stageAttempts = state.stageAttemptCounts.get(ceilingKey) ?? 0;
  if (stageAttempts >= ceiling.maxAttempts) {
    throw new Error(
      `Paid inference run ${state.runId} exhausted ${ceilingKey}'s ${ceiling.maxAttempts}-attempt cap`,
    );
  }
  const aggregateCeiling = state.aggregateStageCeilings.find(
    (entry) => entry.stage === descriptor.stage,
  );
  if (!aggregateCeiling) {
    throw new Error(
      `Paid dispatch has no preflighted aggregate stage ceiling: ${descriptor.stage}`,
    );
  }
  const aggregateStageAttempts = state.aggregateStageAttemptCounts.get(descriptor.stage) ?? 0;
  if (aggregateStageAttempts >= aggregateCeiling.maxAttempts) {
    throw new Error(
      `Paid inference run ${state.runId} exhausted ${descriptor.stage} aggregate ${aggregateCeiling.maxAttempts}-attempt cap`,
    );
  }
  let attemptId: string;
  do {
    attemptId = randomUUID();
  } while (state.attemptIds.has(attemptId));
  state.attemptIds.add(attemptId);
  state.attemptCount += 1;
  state.stageAttemptCounts.set(ceilingKey, stageAttempts + 1);
  state.aggregateStageAttemptCounts.set(descriptor.stage, aggregateStageAttempts + 1);
  const event = appendEvent(state, {
    type: "attempt",
    attemptId,
    provider: descriptor.provider,
    modality: descriptor.modality,
    model: descriptor.model,
    timeoutMs: descriptor.timeoutMs,
    stage: descriptor.stage,
    iteration: descriptor.iteration,
    role: descriptor.role,
  });
  try {
    await persistEvent(state, event);
  } catch (error) {
    appendEvent(state, {
      type: "outcome",
      attemptId,
      outcome: "failed",
      error: safeError(error),
    });
    throw error;
  }
  return attemptId;
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = new Set<string>();
  const requiredToken = enforcementToken();
  if (requiredToken) secrets.add(requiredToken);
  for (const state of runs.values()) {
    secrets.add(state.enforcementToken);
    if (state.ledgerSink) secrets.add(state.ledgerSink.token);
  }
  for (const secret of secrets) message = message.split(secret).join("[credential redacted]");
  return message
    .replace(/(?:sk|xai|AIza|Bearer)[-_a-z0-9]{12,}/gi, "[credential redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_MAX_CHARS);
}

export async function finishPaidProviderDispatch(
  attemptId: string | undefined,
  outcome: PaidAttemptOutcome,
  details: { responseId?: string; error?: unknown } = {},
): Promise<void> {
  if (!attemptId) return;
  if (details.responseId !== undefined && !PROVIDER_RESPONSE_ID.test(details.responseId)) {
    throw new Error("Paid dispatch response identifier is invalid");
  }
  const context = runContext.getStore();
  if (!context) throw new Error("Paid dispatch outcome has no active run context");
  const state = runs.get(context.runId);
  if (!state || !state.attemptIds.has(attemptId)) {
    throw new Error("Paid dispatch outcome references an unknown attempt");
  }
  if (state.events.some((event) => event.type === "outcome" && event.attemptId === attemptId)) {
    throw new Error(`Paid dispatch attempt ${attemptId} already has a terminal outcome`);
  }
  const event = appendEvent(state, {
    type: "outcome",
    attemptId,
    outcome,
    ...(details.responseId ? { responseId: details.responseId } : {}),
    ...(details.error !== undefined ? { error: safeError(details.error) } : {}),
  });
  await persistEvent(state, event);
}

export async function accountPaidProviderDispatch<T>(
  descriptor: PaidDispatchDescriptor | undefined,
  operation: () => Promise<T>,
  responseId?: (value: T) => string | undefined,
): Promise<T> {
  const attemptId = await beginPaidProviderDispatch(descriptor);
  let value: T;
  try {
    value = await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: PaidAttemptOutcome = /cancel/i.test(message)
      ? "cancelled"
      : /timed out|timeout/i.test(message)
        ? "timed_out"
        : "failed";
    try {
      await finishPaidProviderDispatch(attemptId, outcome, { error });
    } catch (sinkError) {
      throw new Error(`${safeError(error)}; ${safeError(sinkError)}`, {
        cause: new AggregateError([error, sinkError]),
      });
    }
    throw error;
  }
  const providerResponseId = responseId?.(value);
  if (providerResponseId !== undefined && !PROVIDER_RESPONSE_ID.test(providerResponseId)) {
    const error = new Error("Paid dispatch response identifier is invalid");
    await finishPaidProviderDispatch(attemptId, "failed", { error });
    throw error;
  }
  await finishPaidProviderDispatch(attemptId, "succeeded", {
    responseId: providerResponseId,
  });
  return value;
}

/** Test-only reset; intentionally not used by production callers. */
export function resetPaidInferenceLedgersForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Paid inference ledger reset is test-only");
  }
  runs.clear();
  testSinkWriter = undefined;
}

/** Injects a no-network ledger writer for focused tests only. */
export function setPaidInferenceLedgerSinkWriterForTests(
  writer: PaidInferenceLedgerSinkWriter | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Paid inference ledger sink writer override is test-only");
  }
  testSinkWriter = writer;
}

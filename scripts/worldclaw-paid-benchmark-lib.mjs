import assert from "node:assert/strict";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

const MIN_EPHEMERAL_PORT = 49_152;
const MAX_PORT_EXCLUSIVE = 65_536;
const MAX_BIND_ATTEMPTS = 64;
const MAX_SINK_PAYLOAD_BYTES = 8 * 1024;
const MAX_SINK_EVENTS = 46 * 2;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{15,255}$/i;
const RUN_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MODEL = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const ATTEMPT_ID = /^[a-f0-9-]{16,64}$/i;
const RESPONSE_ID = /^[a-z0-9][a-z0-9._:/+=-]{0,255}$/i;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PROVIDERS = new Set(["xai", "gemini", "openai", "anthropic"]);
const MODALITIES = new Set(["text", "vision", "image"]);
const STAGES = new Set(["planning", "layout", "multiview", "critique", "final_judge"]);
const OUTCOMES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const LEDGER_ORIGINS = new Set([
  "server-ledger",
  "server-ledger-with-parent-terminal-reconciliation",
  "server-ledger-recovered-by-parent",
  "parent-reconstructed-after-child-exit",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  assert.deepEqual(
    Object.keys(value).sort(),
    Object.keys(value)
      .filter((key) => allowed.has(key))
      .sort(),
    "Paid inference sink payload contains unknown fields",
  );
  for (const key of required) assert.ok(key in value, `Paid inference sink payload omitted ${key}`);
}

function validateSinkEvent(event) {
  assert.ok(event && typeof event === "object" && !Array.isArray(event), "Sink event is invalid");
  assert.ok(Number.isInteger(event.sequence) && event.sequence >= 1 && event.sequence <= 100);
  assert.match(event.at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(event.attemptId ?? "", ATTEMPT_ID);
  if (event.type === "attempt") {
    exactKeys(event, [
      "type",
      "sequence",
      "at",
      "attemptId",
      "provider",
      "modality",
      "model",
      "timeoutMs",
      "stage",
      "iteration",
      "role",
    ]);
    assert.ok(PROVIDERS.has(event.provider), "Sink attempt provider is invalid");
    assert.ok(MODALITIES.has(event.modality), "Sink attempt modality is invalid");
    assert.match(event.model ?? "", MODEL);
    assert.ok(
      Number.isInteger(event.timeoutMs) && event.timeoutMs >= 1 && event.timeoutMs <= 240_000,
      "Sink attempt timeout is invalid",
    );
    assert.ok(STAGES.has(event.stage), "Sink attempt stage is invalid");
    assert.ok(
      Number.isInteger(event.iteration) && event.iteration >= 1 && event.iteration <= 32,
      "Sink attempt iteration is invalid",
    );
    assert.ok(
      typeof event.role === "string" && event.role.length >= 1 && event.role.length <= 96,
      "Sink attempt role is invalid",
    );
  } else {
    assert.equal(event.type, "outcome", "Sink only accepts paid attempt/outcome events");
    exactKeys(event, ["type", "sequence", "at", "attemptId", "outcome"], ["responseId", "error"]);
    assert.ok(OUTCOMES.has(event.outcome), "Sink outcome is invalid");
    if (event.responseId !== undefined) assert.match(event.responseId, RESPONSE_ID);
    if (event.error !== undefined) {
      assert.ok(
        typeof event.error === "string" && event.error.length <= 320,
        "Sink outcome error is invalid",
      );
    }
  }
  return event;
}

function validateSinkPayload(value, expectedRunId) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Sink payload is invalid");
  exactKeys(value, ["version", "runId", "event"]);
  assert.equal(value.version, 1, "Sink payload version drifted");
  assert.equal(value.runId, expectedRunId, "Sink payload run id drifted");
  return { version: 1, runId: expectedRunId, event: validateSinkEvent(value.event) };
}

function constantTimeTokenEqual(received, expected) {
  if (typeof received !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBoundedRequest(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SINK_PAYLOAD_BYTES) {
    throw Object.assign(new Error("Paid inference sink payload is too large"), { statusCode: 413 });
  }
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_SINK_PAYLOAD_BYTES) {
      throw Object.assign(new Error("Paid inference sink payload is too large"), {
        statusCode: 413,
      });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

async function listenInEphemeralRange(requestListener) {
  const attemptedPorts = new Set();
  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt += 1) {
    let port;
    do {
      port = randomInt(MIN_EPHEMERAL_PORT, MAX_PORT_EXCLUSIVE);
    } while (attemptedPorts.has(port));
    attemptedPorts.add(port);
    const server = createServer(requestListener);
    const result = await new Promise((resolveResult, rejectResult) => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error?.code === "EADDRINUSE") resolveResult(false);
        else rejectResult(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveResult(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (result) return { server, port };
    server.close();
  }
  throw new Error(`Unable to bind a paid inference sink after ${MAX_BIND_ATTEMPTS} attempts`);
}

/**
 * Start a token-authenticated, fsyncing loopback collector for provider attempt
 * events. The server adapter posts before provider fetch and after termination.
 */
export async function startPaidInferenceJsonlCollector({ filePath, runId, token }) {
  assert.match(runId ?? "", RUN_ID, "Paid inference collector run id is invalid");
  assert.match(token ?? "", TOKEN, "Paid inference collector token is invalid");
  const handle = await open(filePath, "wx", 0o600);
  let closed = false;
  let acceptedEvents = 0;
  let nextSequence = 2; // sequence 1 is the in-memory-only run-created event
  const attemptIds = new Set();
  const completedIds = new Set();
  let appendQueue = Promise.resolve();
  const pendingBySequence = new Map();

  function scheduleFlush() {
    appendQueue = appendQueue
      .then(async () => {
        while (pendingBySequence.has(nextSequence)) {
          const pending = pendingBySequence.get(nextSequence);
          pendingBySequence.delete(nextSequence);
          const { payload, resolve: resolvePending } = pending;
          const event = payload.event;
          if (event.type === "attempt") {
            assert.ok(!attemptIds.has(event.attemptId), "Sink attempt id is duplicated");
            attemptIds.add(event.attemptId);
          } else {
            assert.ok(attemptIds.has(event.attemptId), "Sink outcome has no prior attempt");
            assert.ok(!completedIds.has(event.attemptId), "Sink outcome is duplicated");
            completedIds.add(event.attemptId);
          }
          await handle.appendFile(`${JSON.stringify(payload)}\n`, "utf8");
          await handle.sync();
          acceptedEvents += 1;
          nextSequence += 1;
          resolvePending();
        }
      })
      .catch((error) => {
        for (const pending of pendingBySequence.values()) pending.reject(error);
        pendingBySequence.clear();
        throw error;
      });
  }

  const requestListener = (request, response) => {
    void (async () => {
      try {
        if (request.method !== "POST" || request.url !== "/") {
          response.writeHead(404).end();
          return;
        }
        const authorization = request.headers.authorization;
        const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
        if (!constantTimeTokenEqual(bearer, token)) {
          response.writeHead(401).end();
          return;
        }
        if (acceptedEvents + pendingBySequence.size >= MAX_SINK_EVENTS) {
          response.writeHead(429).end();
          return;
        }
        const body = await readBoundedRequest(request);
        const payload = validateSinkPayload(JSON.parse(body), runId);
        const event = payload.event;
        assert.ok(
          event.sequence >= nextSequence && !pendingBySequence.has(event.sequence),
          "Sink event sequence is duplicated or stale",
        );
        const persisted = new Promise((resolvePersisted, rejectPersisted) => {
          pendingBySequence.set(event.sequence, {
            payload,
            resolve: resolvePersisted,
            reject: rejectPersisted,
          });
        });
        scheduleFlush();
        await persisted;
        response.writeHead(204).end();
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
        response.writeHead(status).end();
      }
    })();
  };

  let listener;
  try {
    listener = await listenInEphemeralRange(requestListener);
  } catch (error) {
    await handle.close();
    throw error;
  }
  listener.server.unref();
  return {
    url: `http://127.0.0.1:${listener.port}/`,
    token,
    filePath,
    async close() {
      if (closed) return;
      closed = true;
      if (pendingBySequence.size > 0) {
        const error = new Error("Paid inference sink closed with a sequence gap");
        for (const pending of pendingBySequence.values()) pending.reject(error);
        pendingBySequence.clear();
      }
      await new Promise((resolveClose, rejectClose) => {
        listener.server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      await appendQueue;
      await handle.sync();
      await handle.close();
    },
  };
}

function expectedRosterKey(entry) {
  return `${entry.provider}:${entry.modality}:${entry.model}`;
}

function assertNoSecrets(bytes, secrets) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret.length > 0) {
      assert.equal(text.includes(secret), false, "Paid inference evidence contains a secret");
    }
  }
}

function validatePaidInferenceLedger(ledger, expectedRunId, expectedConfig, expectedStatus) {
  assert.ok(ledger && typeof ledger === "object", "Paid inference ledger is missing");
  assert.equal(ledger.version, 1, "Paid inference ledger version drifted");
  assert.equal(ledger.runId, expectedRunId, "Paid inference ledger run id drifted");
  assert.equal(ledger.status, expectedStatus, "Paid inference ledger status drifted");
  assert.ok(TERMINAL_RUN_STATUSES.has(ledger.status), "Paid inference ledger remains open");
  assert.equal(ledger.maxAttempts, expectedConfig.maxAttempts, "Paid inference cap drifted");
  assert.ok(
    Number.isInteger(ledger.attemptCount) &&
      ledger.attemptCount >= 0 &&
      ledger.attemptCount <= expectedConfig.maxAttempts,
    "Paid inference attempt count is invalid",
  );
  assert.equal(ledger.roster?.version, 1, "Paid inference roster version drifted");
  assert.equal(
    ledger.roster?.enforcementRequired,
    true,
    "Paid inference roster was not enforcement-bound",
  );
  assert.ok(Array.isArray(ledger.roster?.entries), "Paid inference roster entries are missing");
  const actualRoster = new Map(
    ledger.roster.entries.map((entry) => [expectedRosterKey(entry), entry]),
  );
  assert.equal(
    actualRoster.size,
    expectedConfig.expectedRoster.entries.length,
    "Paid inference roster cardinality drifted",
  );
  for (const expected of expectedConfig.expectedRoster.entries) {
    const actual = actualRoster.get(expectedRosterKey(expected));
    assert.ok(actual, `Paid inference roster omitted ${expectedRosterKey(expected)}`);
    assert.equal(
      actual.configured,
      expected.configured,
      "Paid inference configured status drifted",
    );
    assert.equal(
      actual.identityAttestation,
      expected.identityAttestation,
      "Paid inference attestation contract drifted",
    );
    assert.ok(
      Number.isInteger(actual.maximumTimeoutMs) && expected.timeoutMs <= actual.maximumTimeoutMs,
      "Paid inference adapter deadline contract drifted",
    );
  }
  assert.deepEqual(
    ledger.stageCeilings,
    expectedConfig.stageCeilings,
    "Paid inference stage ceilings drifted",
  );
  assert.deepEqual(
    ledger.aggregateStageCeilings,
    expectedConfig.aggregateStageCeilings,
    "Paid inference aggregate stage ceilings drifted",
  );
  assert.ok(Array.isArray(ledger.events), "Paid inference events are missing");
  assert.ok(ledger.events.length >= 2, "Paid inference terminal run events are missing");
  ledger.events.forEach((event, index) => {
    assert.equal(event.sequence, index + 1, "Paid inference event sequence drifted");
  });
  assert.deepEqual(
    { type: ledger.events[0].type, status: ledger.events[0].status },
    { type: "run", status: "created" },
    "Paid inference creation event drifted",
  );
  const lastEvent = ledger.events.at(-1);
  assert.deepEqual(
    { type: lastEvent.type, status: lastEvent.status },
    { type: "run", status: expectedStatus },
    "Paid inference terminal event drifted",
  );

  const attempts = new Map();
  const outcomes = new Map();
  const stageCounts = new Map();
  const aggregateStageCounts = new Map();
  for (const event of ledger.events.slice(1, -1)) {
    if (event.type === "attempt") {
      validateSinkEvent(event);
      assert.ok(!attempts.has(event.attemptId), "Paid inference attempt id is duplicated");
      const ceiling = expectedConfig.stageCeilings.find(
        (candidate) => candidate.provider === event.provider && candidate.stage === event.stage,
      );
      assert.ok(ceiling, "Paid inference attempt has no expected stage ceiling");
      assert.ok(
        ceiling.allowedDispatches.some(
          (allowed) =>
            allowed.modality === event.modality &&
            allowed.model === event.model &&
            allowed.timeoutMs === event.timeoutMs,
        ),
        "Paid inference attempt drifted from its exact dispatch contract",
      );
      const key = `${event.provider}:${event.stage}`;
      const count = (stageCounts.get(key) ?? 0) + 1;
      assert.ok(count <= ceiling.maxAttempts, `${key} paid attempt ceiling was exceeded`);
      stageCounts.set(key, count);
      const aggregateCeiling = expectedConfig.aggregateStageCeilings.find(
        (candidate) => candidate.stage === event.stage,
      );
      assert.ok(aggregateCeiling, "Paid inference attempt has no aggregate stage ceiling");
      const aggregateCount = (aggregateStageCounts.get(event.stage) ?? 0) + 1;
      assert.ok(
        aggregateCount <= aggregateCeiling.maxAttempts,
        `${event.stage} aggregate paid attempt ceiling was exceeded`,
      );
      aggregateStageCounts.set(event.stage, aggregateCount);
      attempts.set(event.attemptId, event);
    } else if (event.type === "outcome") {
      validateSinkEvent(event);
      assert.ok(attempts.has(event.attemptId), "Paid inference outcome has no prior attempt");
      assert.ok(!outcomes.has(event.attemptId), "Paid inference outcome is duplicated");
      const attempt = attempts.get(event.attemptId);
      const roster = actualRoster.get(expectedRosterKey(attempt));
      if (event.outcome === "succeeded" && roster.identityAttestation === "provider-response") {
        assert.match(event.responseId ?? "", RESPONSE_ID, "Attested success omitted response id");
      }
      if (roster.identityAttestation === "request-only") {
        assert.equal(event.responseId, undefined, "Request-only dispatch invented a response id");
      }
      outcomes.set(event.attemptId, event);
    } else {
      assert.fail("Paid inference ledger contains an interior run event");
    }
  }
  assert.equal(attempts.size, ledger.attemptCount, "Paid inference attempt count drifted");
  assert.equal(outcomes.size, attempts.size, "Paid inference attempt lacks a terminal outcome");
  return ledger.events.filter((event) => event.type === "attempt" || event.type === "outcome");
}

function parseAttemptLog(bytes, expectedRunId) {
  if (bytes.length === 0) return [];
  const text = bytes.toString("utf8");
  assert.ok(text.endsWith("\n"), "Paid inference attempt log is not newline-terminated");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => validateSinkPayload(JSON.parse(line), expectedRunId));
}

function evidencePath(directory, fileName) {
  assert.match(fileName ?? "", FILE_NAME, "Paid inference evidence filename is invalid");
  assert.equal(basename(fileName), fileName, "Paid inference evidence filename escaped its root");
  const root = resolve(directory);
  const path = resolve(root, fileName);
  assert.ok(path.startsWith(`${root}${sep}`), "Paid inference evidence escaped its root");
  return path;
}

function validateAttemptLog(attemptLogBytes, expectedEvents, expectedRunId) {
  const payloads = parseAttemptLog(attemptLogBytes, expectedRunId);
  assert.deepEqual(
    payloads.map(({ event }) => event),
    expectedEvents,
    "Durable attempt log drifted from the public paid ledger",
  );
  return payloads.length;
}

function validatePartialAttemptLog(attemptLogBytes, expectedRunId, expectedConfig) {
  const payloads = parseAttemptLog(attemptLogBytes, expectedRunId);
  const attempts = new Map();
  const outcomes = new Set();
  const providerStageCounts = new Map();
  const aggregateStageCounts = new Map();
  let previousSequence = 1;
  for (const { event } of payloads) {
    assert.ok(
      event.sequence > previousSequence,
      "Partial paid attempt log sequence did not increase",
    );
    previousSequence = event.sequence;
    if (event.type === "attempt") {
      assert.ok(!attempts.has(event.attemptId), "Partial paid attempt id is duplicated");
      const ceiling = expectedConfig.stageCeilings.find(
        (candidate) => candidate.provider === event.provider && candidate.stage === event.stage,
      );
      assert.ok(ceiling, "Partial paid attempt has no preflighted provider-stage ceiling");
      assert.ok(
        ceiling.allowedDispatches.some(
          (allowed) =>
            allowed.modality === event.modality &&
            allowed.model === event.model &&
            allowed.timeoutMs === event.timeoutMs,
        ),
        "Partial paid attempt drifted from its dispatch contract",
      );
      const providerStageKey = `${event.provider}:${event.stage}`;
      const providerStageCount = (providerStageCounts.get(providerStageKey) ?? 0) + 1;
      assert.ok(providerStageCount <= ceiling.maxAttempts, "Partial provider-stage cap exceeded");
      providerStageCounts.set(providerStageKey, providerStageCount);
      const aggregateCeiling = expectedConfig.aggregateStageCeilings.find(
        (candidate) => candidate.stage === event.stage,
      );
      assert.ok(aggregateCeiling, "Partial paid attempt has no aggregate stage ceiling");
      const aggregateCount = (aggregateStageCounts.get(event.stage) ?? 0) + 1;
      assert.ok(
        aggregateCount <= aggregateCeiling.maxAttempts,
        "Partial aggregate stage cap exceeded",
      );
      aggregateStageCounts.set(event.stage, aggregateCount);
      attempts.set(event.attemptId, event);
    } else {
      assert.ok(attempts.has(event.attemptId), "Partial paid outcome has no attempt");
      assert.ok(!outcomes.has(event.attemptId), "Partial paid outcome is duplicated");
      outcomes.add(event.attemptId);
    }
  }
  assert.ok(attempts.size <= expectedConfig.maxAttempts, "Partial paid total cap exceeded");
  return { payloads, attemptCount: attempts.size, outcomeCount: outcomes.size };
}

export async function snapshotPartialPaidAttemptLog({
  directory,
  attemptLogPath,
  attemptLogFile,
  expectedRunId,
  expectedConfig,
  forbiddenSecrets = [],
  status = "aborted-before-ledger-retrieval",
}) {
  const canonicalAttemptPath = evidencePath(directory, attemptLogFile);
  assert.equal(resolve(attemptLogPath), canonicalAttemptPath, "Partial paid log path drifted");
  const bytes = await readFile(canonicalAttemptPath);
  assert.ok(bytes.length <= MAX_EVIDENCE_BYTES, "Partial paid attempt log is too large");
  assertNoSecrets(bytes, forbiddenSecrets);
  const summary = validatePartialAttemptLog(bytes, expectedRunId, expectedConfig);
  return {
    version: 1,
    runId: expectedRunId,
    status,
    maxAttempts: expectedConfig.maxAttempts,
    attemptCount: summary.attemptCount,
    outcomeCount: summary.outcomeCount,
    pendingAttemptCount: summary.attemptCount - summary.outcomeCount,
    attemptLogFile,
    attemptLogSha256: sha256(bytes),
    attemptLogBytes: bytes.length,
    attemptLogLines: summary.payloads.length,
  };
}

export async function reconstructTerminatedPaidInferenceLedger({
  attemptLogPath,
  expectedRunId,
  expectedConfig,
  status,
  createdAt,
}) {
  assert.ok(["failed", "cancelled"].includes(status), "Reconstructed ledger status is invalid");
  assert.match(createdAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const attemptLogBytes = await readFile(attemptLogPath);
  const { payloads, attemptCount } = validatePartialAttemptLog(
    attemptLogBytes,
    expectedRunId,
    expectedConfig,
  );
  const events = [
    { type: "run", sequence: 1, at: createdAt, status: "created" },
    ...payloads.map(({ event }) => structuredClone(event)),
  ];
  const completed = new Set(
    events.filter((event) => event.type === "outcome").map((event) => event.attemptId),
  );
  for (const attempt of events.filter((event) => event.type === "attempt")) {
    if (completed.has(attempt.attemptId)) continue;
    events.push({
      type: "outcome",
      sequence: events.length + 1,
      at: new Date().toISOString(),
      attemptId: attempt.attemptId,
      outcome: status === "cancelled" ? "cancelled" : "failed",
      error: `Reviewer process ${status} before its provider outcome was retained`,
    });
  }
  events.push({
    type: "run",
    sequence: events.length + 1,
    at: new Date().toISOString(),
    status,
  });
  return {
    version: 1,
    runId: expectedRunId,
    createdAt,
    maxAttempts: expectedConfig.maxAttempts,
    attemptCount,
    status,
    roster: {
      version: 1,
      enforcementRequired: true,
      entries: expectedConfig.expectedRoster.entries.map((entry) => ({
        provider: entry.provider,
        modality: entry.modality,
        model: entry.model,
        configured: entry.configured ?? true,
        identityAttestation: entry.identityAttestation,
        defaultTimeoutMs: entry.timeoutMs,
        maximumTimeoutMs: entry.timeoutMs,
      })),
    },
    stageCeilings: structuredClone(expectedConfig.stageCeilings),
    aggregateStageCeilings: structuredClone(expectedConfig.aggregateStageCeilings),
    events,
  };
}

export async function persistPaidInferenceEvidence({
  directory,
  ledger,
  attemptLogPath,
  ledgerFile,
  attemptLogFile,
  expectedConfig,
  expectedStatus,
  forbiddenSecrets = [],
  completeAttemptLog = false,
  ledgerOrigin = completeAttemptLog
    ? "server-ledger-with-parent-terminal-reconciliation"
    : "server-ledger",
}) {
  assert.ok(LEDGER_ORIGINS.has(ledgerOrigin), "Paid inference ledger origin is invalid");
  const expectedEvents = validatePaidInferenceLedger(
    ledger,
    ledger.runId,
    expectedConfig,
    expectedStatus,
  );
  const canonicalAttemptPath = evidencePath(directory, attemptLogFile);
  assert.equal(
    resolve(attemptLogPath),
    canonicalAttemptPath,
    "Paid inference attempt log path drifted",
  );
  let attemptLogBytes = await readFile(canonicalAttemptPath);
  assert.ok(
    attemptLogBytes.length <= MAX_EVIDENCE_BYTES,
    "Paid inference attempt log is too large",
  );
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  assert.ok(ledgerBytes.length <= MAX_EVIDENCE_BYTES, "Paid inference ledger is too large");
  assertNoSecrets(ledgerBytes, forbiddenSecrets);
  assertNoSecrets(attemptLogBytes, forbiddenSecrets);
  if (completeAttemptLog) {
    const loggedPayloads = parseAttemptLog(attemptLogBytes, ledger.runId);
    const loggedSequences = new Set(loggedPayloads.map(({ event }) => event.sequence));
    const missingEvents = expectedEvents.filter((event) => !loggedSequences.has(event.sequence));
    if (missingEvents.length > 0) {
      assert.notEqual(
        expectedStatus,
        "completed",
        "Completed paid inference evidence cannot require attempt-log reconciliation",
      );
      assert.ok(
        missingEvents.every((event) => event.type === "outcome"),
        "Durable attempt log omitted a pre-dispatch attempt event",
      );
      const reconciledLines = missingEvents
        .map((event) => JSON.stringify({ version: 1, runId: ledger.runId, event }))
        .join("\n");
      const handle = await open(canonicalAttemptPath, "a", 0o600);
      try {
        await handle.appendFile(`${reconciledLines}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      attemptLogBytes = await readFile(canonicalAttemptPath);
      assertNoSecrets(attemptLogBytes, forbiddenSecrets);
    }
  }
  const attemptLogLines = validateAttemptLog(attemptLogBytes, expectedEvents, ledger.runId);
  const ledgerPath = evidencePath(directory, ledgerFile);
  try {
    await writeFile(ledgerPath, ledgerBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    assert.deepEqual(
      await readFile(ledgerPath),
      ledgerBytes,
      "Existing paid inference ledger bytes drifted",
    );
  }
  return {
    version: 1,
    runId: ledger.runId,
    status: ledger.status,
    maxAttempts: ledger.maxAttempts,
    attemptCount: ledger.attemptCount,
    ledgerFile,
    ledgerSha256: sha256(ledgerBytes),
    ledgerBytes: ledgerBytes.length,
    attemptLogFile,
    attemptLogSha256: sha256(attemptLogBytes),
    attemptLogBytes: attemptLogBytes.length,
    attemptLogLines,
    ledgerOrigin,
  };
}

export async function validatePaidInferenceEvidence({
  directory,
  descriptor,
  expectedRunId,
  expectedConfig,
  expectedStatus,
}) {
  assert.ok(descriptor && typeof descriptor === "object", "Paid inference descriptor is missing");
  assert.equal(descriptor.version, 1, "Paid inference descriptor version drifted");
  assert.equal(descriptor.runId, expectedRunId, "Paid inference descriptor run id drifted");
  assert.equal(descriptor.status, expectedStatus, "Paid inference descriptor status drifted");
  assert.equal(descriptor.maxAttempts, expectedConfig.maxAttempts, "Paid inference cap drifted");
  assert.ok(
    LEDGER_ORIGINS.has(descriptor.ledgerOrigin),
    "Paid inference descriptor ledger origin is invalid",
  );
  const ledgerPath = evidencePath(directory, descriptor.ledgerFile);
  const attemptLogPath = evidencePath(directory, descriptor.attemptLogFile);
  const [ledgerBytes, attemptLogBytes, ledgerStats, attemptStats] = await Promise.all([
    readFile(ledgerPath),
    readFile(attemptLogPath),
    stat(ledgerPath),
    stat(attemptLogPath),
  ]);
  assert.equal(ledgerStats.size, descriptor.ledgerBytes, "Paid inference ledger size drifted");
  assert.equal(attemptStats.size, descriptor.attemptLogBytes, "Paid attempt log size drifted");
  assert.equal(sha256(ledgerBytes), descriptor.ledgerSha256, "Paid inference ledger hash drifted");
  assert.equal(
    sha256(attemptLogBytes),
    descriptor.attemptLogSha256,
    "Paid inference attempt log hash drifted",
  );
  const ledger = JSON.parse(ledgerBytes.toString("utf8"));
  const expectedEvents = validatePaidInferenceLedger(
    ledger,
    expectedRunId,
    expectedConfig,
    expectedStatus,
  );
  const attemptLogLines = validateAttemptLog(attemptLogBytes, expectedEvents, expectedRunId);
  assert.equal(
    attemptLogLines,
    descriptor.attemptLogLines,
    "Paid inference attempt-log line count drifted",
  );
  assert.equal(
    ledger.attemptCount,
    descriptor.attemptCount,
    "Paid inference attempt count drifted",
  );
  return { ledger, descriptor };
}

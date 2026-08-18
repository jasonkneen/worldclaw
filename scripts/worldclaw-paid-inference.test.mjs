import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestHandler } from "@tanstack/react-start/server";
import {
  createPaidInferenceBenchmarkRun,
  finishPaidInferenceBenchmarkRun,
  getPaidInferenceBenchmarkLedger,
  paidInferenceRunMiddleware,
} from "../src/lib/worldclaw/paid-inference-control.ts";
import {
  accountPaidProviderDispatch,
  benchmarkPaidInferenceEnforcementRequired,
  beginPaidProviderDispatch,
  createPaidInferenceRun as createPaidInferenceRunRaw,
  finishPaidInferenceRun,
  getPaidInferenceRunLedger,
  resetPaidInferenceLedgersForTests,
  runtimeModelRosterSnapshot,
  requirePaidInferenceRequestIdentity,
  setPaidInferenceLedgerSinkWriterForTests,
  withPaidInferenceRequest,
  withPaidInferenceRun,
} from "../src/lib/worldclaw/paid-inference.server.ts";
import { xaiChatResult } from "../src/lib/worldclaw/xai.server.ts";
import {
  geminiChatResult,
  geminiImage,
  geminiVisionJsonResult,
} from "../src/lib/worldclaw/gemini.server.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const ENV_NAMES = [
  "NODE_ENV",
  "WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "XAI_TEXT_MODEL",
  "GEMINI_TEXT_MODEL",
  "GEMINI_IMAGE_MODEL",
  "OPENAI_TEXT_MODEL",
  "OPENAI_IMAGE_MODEL",
  "CLAUDE_MODEL",
];
const originalEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;

function insideTanStackRequest(headers, operation) {
  const handler = requestHandler(async () => {
    try {
      const value = await operation();
      return new Response(JSON.stringify(value ?? null), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), {
        status: 400,
      });
    }
  });
  return handler(new Request("http://worldclaw.test/__server", { headers }), {});
}

function restoreEnvironment() {
  for (const name of ENV_NAMES) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function configureBenchmark() {
  process.env.NODE_ENV = "test";
  process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN = "worldclaw-benchmark-unit-token";
  process.env.XAI_API_KEY = "xai-unit-key";
  process.env.GEMINI_API_KEY = "gemini-unit-key";
  process.env.OPENAI_API_KEY = "openai-unit-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
}

function expectedRoster() {
  return {
    entries: runtimeModelRosterSnapshot().entries.map((entry) => ({
      provider: entry.provider,
      modality: entry.modality,
      model: entry.model,
      configured: entry.configured,
      identityAttestation: entry.identityAttestation,
      timeoutMs: entry.defaultTimeoutMs,
    })),
  };
}

function xaiTextCeiling(stage, maxAttempts = 1) {
  return {
    provider: "xai",
    stage,
    maxAttempts,
    allowedDispatches: [
      {
        modality: "text",
        model: "grok-4.6",
        timeoutMs: 45_000,
      },
    ],
  };
}

function inferredAggregateStageCeilings(stageCeilings) {
  const totals = new Map();
  for (const ceiling of stageCeilings) {
    totals.set(ceiling.stage, (totals.get(ceiling.stage) ?? 0) + ceiling.maxAttempts);
  }
  return [...totals].map(([stage, maxAttempts]) => ({ stage, maxAttempts }));
}

function createPaidInferenceRun(config) {
  return createPaidInferenceRunRaw({
    ...config,
    aggregateStageCeilings:
      config.aggregateStageCeilings ?? inferredAggregateStageCeilings(config.stageCeilings),
  });
}

afterEach(() => {
  process.env.NODE_ENV = "test";
  resetPaidInferenceLedgersForTests();
  restoreEnvironment();
  globalThis.fetch = originalFetch;
});

test("benchmark enforcement rejects a provider dispatch without a run before fetch", async () => {
  configureBenchmark();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };

  await assert.rejects(
    xaiChatResult({ system: "Return JSON.", user: "Plan." }),
    /no active run context/,
  );
  assert.equal(fetchCalls, 0);
});

test("request attachment rejects either half of the paid run header pair", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const missingToken = await insideTanStackRequest(
    { "x-worldclaw-paid-run-id": "partial-header-run" },
    requirePaidInferenceRequestIdentity,
  );
  assert.equal(missingToken.status, 400);
  assert.match(await missingToken.text(), /both run id and token headers/);
  const missingRunId = await insideTanStackRequest({ "x-worldclaw-paid-run-token": token }, () =>
    withPaidInferenceRequest(async () => "must not run"),
  );
  assert.equal(missingRunId.status, 400);
  assert.match(await missingRunId.text(), /both run id and token headers/);
});

test("request attachment activates the paid run across asynchronous dispatch work", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "request-attached-run";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [xaiTextCeiling("planning")],
  });

  const response = await insideTanStackRequest(
    {
      "x-worldclaw-paid-run-id": runId,
      "x-worldclaw-paid-run-token": token,
    },
    () =>
      withPaidInferenceRequest(async (request) => {
        assert.equal(request.signal.aborted, false);
        await accountPaidProviderDispatch(
          {
            provider: "xai",
            modality: "text",
            model: "grok-4.6",
            timeoutMs: 45_000,
            stage: "planning",
            iteration: 1,
            role: "Independent scene-plan candidate",
          },
          async () => undefined,
        );
        return "attached";
      }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.json(), "attached");
  assert.equal(getPaidInferenceRunLedger(runId, token).attemptCount, 1);
});

test("paid control exports bounded server-function methods and attachment middleware", () => {
  assert.equal(createPaidInferenceBenchmarkRun.method, "POST");
  assert.equal(getPaidInferenceBenchmarkLedger.method, "GET");
  assert.equal(finishPaidInferenceBenchmarkRun.method, "POST");
  assert.equal(typeof paidInferenceRunMiddleware.options.server, "function");
});

test("an attested dispatch is durably attempted before fetch and terminal afterward", async () => {
  configureBenchmark();
  const sinkEvents = [];
  setPaidInferenceLedgerSinkWriterForTests(async (sink, payload) => {
    assert.equal(sink.url, "http://127.0.0.1:55000/");
    assert.equal(sink.token, "worldclaw-ledger-sink-token");
    sinkEvents.push(structuredClone(payload));
  });
  const observedOrder = [];
  globalThis.fetch = async (_url, init) => {
    observedOrder.push("provider-fetch");
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "chatcmpl_paid_run_1",
        model: body.model,
        choices: [{ message: { content: "{}" } }],
      }),
      { status: 200 },
    );
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "paid-run-attested";
  const created = createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [xaiTextCeiling("planning")],
    ledgerSink: {
      url: "http://127.0.0.1:55000/",
      token: "worldclaw-ledger-sink-token",
    },
  });
  assert.equal("enforcementToken" in created, false);
  const serializedCreated = JSON.stringify(created);
  assert.equal(serializedCreated.includes(token), false);
  assert.equal(serializedCreated.includes("ledger-sink-token"), false);

  const result = await withPaidInferenceRun(runId, token, () =>
    xaiChatResult({
      system: "Return JSON.",
      user: "Plan.",
      dispatch: { stage: "planning", iteration: 1, role: "world planner" },
    }),
  );
  observedOrder.unshift(sinkEvents[0].event.type);
  observedOrder.push(sinkEvents[1].event.type);
  assert.deepEqual(observedOrder, ["attempt", "provider-fetch", "outcome"]);
  assert.equal(result.responseId, "chatcmpl_paid_run_1");
  assert.equal(sinkEvents[0].event.stage, "planning");
  assert.equal(sinkEvents[0].event.iteration, 1);
  assert.equal(sinkEvents[0].event.role, "world planner");
  assert.equal(sinkEvents[1].event.responseId, "chatcmpl_paid_run_1");

  await assert.rejects(
    withPaidInferenceRun(runId, token, () =>
      xaiChatResult({
        system: "Return JSON.",
        user: "Retry.",
        dispatch: { stage: "planning", iteration: 1, role: "world planner" },
      }),
    ),
    /exhausted its 1-attempt cap/,
  );
  const ledger = finishPaidInferenceRun(runId, token, "completed");
  assert.equal(ledger.attemptCount, 1);
  assert.deepEqual(
    ledger.events.map((event) => event.type),
    ["run", "attempt", "outcome", "run"],
  );
  assert.equal(getPaidInferenceRunLedger(runId, token).status, "completed");
});

test("direct Gemini billing denial and Gateway fallback are two separately accounted dispatches", async () => {
  configureBenchmark();
  let fetchCalls = 0;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Quota unavailable until billing is enabled for this paid plan.",
          },
        }),
        { status: 429 },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_gateway_paid_fallback",
        model: "google/gemini-3.6-flash",
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }),
      { status: 200 },
    );
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "gemini-paid-fallback";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 2,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "planning",
        maxAttempts: 2,
        allowedDispatches: [{ modality: "text", model: "gemini-3.6-flash", timeoutMs: 45_000 }],
      },
    ],
  });

  const result = await withPaidInferenceRun(runId, token, () =>
    geminiChatResult({
      system: "Return JSON.",
      user: "Plan.",
      dispatch: { stage: "planning", iteration: 1, role: "world planner" },
    }),
  );
  assert.equal(result.responseId, "chatcmpl_gateway_paid_fallback");
  assert.equal(fetchCalls, 2);
  const ledger = getPaidInferenceRunLedger(runId, token);
  assert.equal(ledger.attemptCount, 2);
  assert.deepEqual(
    ledger.events
      .filter((event) => event.type === "outcome")
      .map((event) => ({ outcome: event.outcome, responseId: event.responseId })),
    [
      { outcome: "failed", responseId: undefined },
      { outcome: "succeeded", responseId: "chatcmpl_gateway_paid_fallback" },
    ],
  );
});

test("Gemini billing circuit bypasses direct Google for later text and vision work in one paid run", async () => {
  configureBenchmark();
  let directCalls = 0;
  let gatewayCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      directCalls += 1;
      if (directCalls > 1) {
        return new Response(
          JSON.stringify({
            modelVersion: "models/gemini-3.6-flash",
            responseId: "gemini_independent_run",
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Lightning dunning decision is deny for project: projects/123456789",
          },
        }),
        { status: 403 },
      );
    }
    gatewayCalls += 1;
    return new Response(
      JSON.stringify({
        id: `chatcmpl_gateway_circuit_${gatewayCalls}`,
        model: "google/gemini-3.6-flash",
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }),
      { status: 200 },
    );
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "gemini-paid-billing-circuit";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 3,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "planning",
        maxAttempts: 2,
        allowedDispatches: [{ modality: "text", model: "gemini-3.6-flash", timeoutMs: 45_000 }],
      },
      {
        provider: "gemini",
        stage: "critique",
        maxAttempts: 1,
        allowedDispatches: [{ modality: "vision", model: "gemini-3.6-flash", timeoutMs: 90_000 }],
      },
    ],
  });

  await withPaidInferenceRun(runId, token, () =>
    geminiChatResult({
      system: "Return JSON.",
      user: "Plan.",
      dispatch: { stage: "planning", iteration: 1, role: "world planner" },
    }),
  );
  const vision = await withPaidInferenceRun(runId, token, () =>
    geminiVisionJsonResult({
      system: "Return JSON.",
      user: "Critique.",
      images: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
      dispatch: { stage: "critique", iteration: 1, role: "visual critic" },
    }),
  );
  await assert.rejects(
    withPaidInferenceRun(runId, token, () =>
      geminiImage({
        prompt: "Generate the final registered map.",
        dispatch: { stage: "layout", iteration: 1, role: "image producer" },
      }),
    ),
    /direct Google billing circuit is open.*no certifiable image Gateway transport/,
  );
  const cancelledImage = new AbortController();
  cancelledImage.abort();
  await assert.rejects(
    withPaidInferenceRun(runId, token, () =>
      geminiImage({
        prompt: "Generate the cancelled registered map.",
        signal: cancelledImage.signal,
        dispatch: { stage: "layout", iteration: 1, role: "image producer" },
      }),
    ),
    /Gemini image cancelled/,
  );

  assert.equal(vision.responseId, "chatcmpl_gateway_circuit_2");
  assert.equal(directCalls, 1);
  assert.equal(gatewayCalls, 2);
  const ledger = getPaidInferenceRunLedger(runId, token);
  assert.equal(ledger.attemptCount, 3);
  assert.deepEqual(
    ledger.events
      .filter((event) => event.type === "outcome")
      .map((event) => ({ outcome: event.outcome, responseId: event.responseId })),
    [
      { outcome: "failed", responseId: undefined },
      { outcome: "succeeded", responseId: "chatcmpl_gateway_circuit_1" },
      { outcome: "succeeded", responseId: "chatcmpl_gateway_circuit_2" },
    ],
  );

  const independentRunId = "gemini-paid-independent-run";
  createPaidInferenceRun({
    runId: independentRunId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "planning",
        maxAttempts: 1,
        allowedDispatches: [{ modality: "text", model: "gemini-3.6-flash", timeoutMs: 45_000 }],
      },
    ],
  });
  const independent = await withPaidInferenceRun(independentRunId, token, () =>
    geminiChatResult({
      system: "Return JSON.",
      user: "Plan independently.",
      dispatch: { stage: "planning", iteration: 1, role: "world planner" },
    }),
  );
  assert.equal(independent.responseId, "gemini_independent_run");
  assert.equal(directCalls, 2);
  assert.equal(gatewayCalls, 2);
});

test("Gemini fallback timeout is one shared operation budget and terminal ledger outcome", async () => {
  configureBenchmark();
  let fetchCalls = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1;
    if (String(url).includes("generativelanguage.googleapis.com")) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Lightning dunning decision is deny for project: projects/123456789",
          },
        }),
        { status: 403 },
      );
    }
    const signal = init?.signal;
    return new Promise((_, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "gemini-paid-fallback-timeout";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 2,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "planning",
        maxAttempts: 2,
        allowedDispatches: [{ modality: "text", model: "gemini-3.6-flash", timeoutMs: 80 }],
      },
    ],
  });

  await assert.rejects(
    withPaidInferenceRun(runId, token, () =>
      geminiChatResult({
        system: "Return JSON.",
        user: "Plan.",
        timeoutMs: 80,
        dispatch: { stage: "planning", iteration: 1, role: "world planner" },
      }),
    ),
    /Gateway timed out after 80ms/,
  );
  assert.equal(fetchCalls, 2);
  assert.deepEqual(
    getPaidInferenceRunLedger(runId, token)
      .events.filter((event) => event.type === "outcome")
      .map((event) => event.outcome),
    ["failed", "timed_out"],
  );
});

test("Gemini cancellation while reading response body is recorded as cancelled", async () => {
  configureBenchmark();
  delete process.env.AI_GATEWAY_API_KEY;
  let bodyStartedResolve;
  const bodyStarted = new Promise((resolve) => {
    bodyStartedResolve = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          const abort = () =>
            controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          bodyStartedResolve();
        },
      }),
      { status: 200 },
    );
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "gemini-paid-body-cancel";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "planning",
        maxAttempts: 1,
        allowedDispatches: [{ modality: "text", model: "gemini-3.6-flash", timeoutMs: 5_000 }],
      },
    ],
  });
  const controller = new AbortController();
  const pending = withPaidInferenceRun(runId, token, () =>
    geminiChatResult({
      system: "Return JSON.",
      user: "Plan.",
      timeoutMs: 5_000,
      signal: controller.signal,
      dispatch: { stage: "planning", iteration: 1, role: "world planner" },
    }),
  );
  await bodyStarted;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(
    getPaidInferenceRunLedger(runId, token)
      .events.filter((event) => event.type === "outcome")
      .map((event) => event.outcome),
    ["cancelled"],
  );
});

test("runtime preflight is secret-free, exact, and enforces adapter deadlines", () => {
  configureBenchmark();
  const snapshot = runtimeModelRosterSnapshot();
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /unit-key|unit-token/);
  assert.equal(
    snapshot.entries.some((entry) => entry.model === "gemini-3.1-flash-image"),
    false,
  );
  assert.equal(
    snapshot.entries.some(
      (entry) =>
        entry.provider === "gemini" &&
        entry.modality === "image" &&
        entry.model === "gemini-3.6-flash",
    ),
    false,
  );
  delete process.env.GEMINI_API_KEY;
  const gatewayOnlyGemini = runtimeModelRosterSnapshot().entries.filter(
    (entry) => entry.provider === "gemini",
  );
  assert.ok(
    gatewayOnlyGemini
      .filter((entry) => entry.modality !== "image")
      .every((entry) => entry.configured),
    "AI_GATEWAY_API_KEY alone must configure Gemini text and vision",
  );
  assert.equal(
    gatewayOnlyGemini.find((entry) => entry.modality === "image")?.configured,
    false,
    "certified Gemini image output remains direct-key only",
  );
  process.env.GEMINI_TEXT_MODEL = "gemini-3.1-flash";
  assert.throws(() => runtimeModelRosterSnapshot(), /must be exactly gemini-3\.6-flash/);
  delete process.env.GEMINI_TEXT_MODEL;
  const invalid = expectedRoster();
  const geminiImage = invalid.entries.find(
    (entry) =>
      entry.provider === "gemini" &&
      entry.modality === "image" &&
      entry.model === "gemini-3-pro-image",
  );
  geminiImage.timeoutMs = 180_001;
  assert.throws(
    () =>
      createPaidInferenceRun({
        runId: "bad-deadline",
        enforcementToken: process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN,
        expectedRoster: invalid,
        stageCeilings: [
          {
            provider: "gemini",
            stage: "layout",
            maxAttempts: 1,
            allowedDispatches: [
              {
                modality: "image",
                model: "gemini-3-pro-image",
                timeoutMs: 180_000,
              },
            ],
          },
        ],
      }),
    /exceeds adapter maximum 180000ms/,
  );
});

test("a loopback sink failure blocks the provider fetch and leaves a terminal mirror", async () => {
  configureBenchmark();
  setPaidInferenceLedgerSinkWriterForTests(async () => {
    throw new Error("collector unavailable");
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("provider fetch must not run");
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "sink-failure";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    stageCeilings: [xaiTextCeiling("planning")],
    ledgerSink: {
      url: "http://127.0.0.1:55001/",
      token: "worldclaw-ledger-sink-token",
    },
  });
  await assert.rejects(
    withPaidInferenceRun(runId, token, () =>
      xaiChatResult({
        system: "Return JSON.",
        user: "Plan.",
        dispatch: { stage: "planning", iteration: 1, role: "world planner" },
      }),
    ),
    /collector unavailable/,
  );
  assert.equal(fetchCalls, 0);
  const ledger = getPaidInferenceRunLedger(runId, token);
  assert.equal(ledger.attemptCount, 1);
  assert.deepEqual(
    ledger.events
      .slice(1)
      .map((event) => (event.type === "outcome" ? `${event.type}:${event.outcome}` : event.type)),
    ["attempt", "outcome:failed"],
  );
});

test("per-provider stage ceilings stop retries even below the aggregate run cap", async () => {
  configureBenchmark();
  let fetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: `chatcmpl_stage_${fetchCalls}`,
        model: body.model,
        choices: [{ message: { content: "{}" } }],
      }),
      { status: 200 },
    );
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "stage-cap";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 3,
    stageCeilings: [xaiTextCeiling("planning")],
  });
  const call = () =>
    withPaidInferenceRun(runId, token, () =>
      xaiChatResult({
        system: "Return JSON.",
        user: "Plan.",
        dispatch: { stage: "planning", iteration: 1, role: "world planner" },
      }),
    );
  await call();
  await assert.rejects(call(), /xai:planning's 1-attempt cap/);
  assert.equal(fetchCalls, 1);
});

test("aggregate stage ceilings stop cross-provider overrun before a paid dispatch", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "aggregate-stage-cap";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 4,
    stageCeilings: [
      xaiTextCeiling("planning", 2),
      {
        provider: "gemini",
        stage: "planning",
        maxAttempts: 2,
        allowedDispatches: [{ modality: "text", model: "gemini-3.6-flash", timeoutMs: 45_000 }],
      },
    ],
    aggregateStageCeilings: [{ stage: "planning", maxAttempts: 1 }],
  });
  const dispatch = (provider, model) =>
    withPaidInferenceRun(runId, token, () =>
      accountPaidProviderDispatch(
        {
          provider,
          modality: "text",
          model,
          timeoutMs: 45_000,
          stage: "planning",
          iteration: 1,
          role: "Independent scene-plan candidate",
        },
        async () => undefined,
      ),
    );

  await dispatch("xai", "grok-4.6");
  await assert.rejects(dispatch("gemini", "gemini-3.6-flash"), /planning aggregate 1-attempt cap/);
  const ledger = getPaidInferenceRunLedger(runId, token);
  assert.equal(ledger.attemptCount, 1);
  assert.deepEqual(ledger.aggregateStageCeilings, [{ stage: "planning", maxAttempts: 1 }]);
});

test("aggregate stage ceiling preflight is required, unique, and covers every provider stage", () => {
  configureBenchmark();
  const base = {
    enforcementToken: process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN,
    expectedRoster: expectedRoster(),
    maxAttempts: 2,
    stageCeilings: [xaiTextCeiling("planning"), xaiTextCeiling("critique")],
  };
  assert.throws(
    () => createPaidInferenceRunRaw({ ...base, runId: "aggregate-missing-array" }),
    /requires from 1 to 5 aggregate stage ceilings/,
  );
  assert.throws(
    () =>
      createPaidInferenceRunRaw({
        ...base,
        runId: "aggregate-duplicate",
        aggregateStageCeilings: [
          { stage: "planning", maxAttempts: 1 },
          { stage: "planning", maxAttempts: 1 },
        ],
      }),
    /duplicates planning/,
  );
  assert.throws(
    () =>
      createPaidInferenceRunRaw({
        ...base,
        runId: "aggregate-incomplete",
        aggregateStageCeilings: [{ stage: "planning", maxAttempts: 1 }],
      }),
    /omitted critique/,
  );
});

test("one provider-stage ceiling permits bounded retries of the exact Gemini Pro Image dispatch", async () => {
  configureBenchmark();
  globalThis.fetch = async () => {
    throw new Error("provider fetch must not run");
  };
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "gemini-layout-variants";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 3,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "layout",
        maxAttempts: 2,
        allowedDispatches: [{ modality: "image", model: "gemini-3-pro-image", timeoutMs: 120_000 }],
      },
    ],
  });

  const dispatch = (model, responseId) =>
    withPaidInferenceRun(runId, token, () =>
      accountPaidProviderDispatch(
        {
          provider: "gemini",
          modality: "image",
          model,
          timeoutMs: 120_000,
          stage: "layout",
          iteration: 1,
          role: "Canonical top-down semantic-map candidate",
        },
        async () => ({ responseId }),
        (value) => value.responseId,
      ),
    );

  await dispatch("gemini-3-pro-image", "interaction_quality_1");
  await dispatch("gemini-3-pro-image", "interaction_quality_2");
  await assert.rejects(
    dispatch("gemini-3-pro-image", "interaction_quality_3"),
    /gemini:layout's 2-attempt cap/,
  );
  assert.equal(getPaidInferenceRunLedger(runId, token).attemptCount, 2);
});

test("a dispatch outside a stage's exact allowed variants fails before accounting", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "exact-dispatch-contract";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [
      {
        provider: "gemini",
        stage: "layout",
        maxAttempts: 1,
        allowedDispatches: [{ modality: "image", model: "gemini-3-pro-image", timeoutMs: 120_000 }],
      },
    ],
  });

  await assert.rejects(
    withPaidInferenceRun(runId, token, () =>
      accountPaidProviderDispatch(
        {
          provider: "gemini",
          modality: "image",
          model: "gemini-3.6-flash",
          timeoutMs: 120_000,
          stage: "layout",
          iteration: 1,
          role: "Canonical top-down semantic-map candidate",
        },
        async () => undefined,
      ),
    ),
    /outside the preflighted roster/,
  );
  assert.equal(getPaidInferenceRunLedger(runId, token).attemptCount, 0);
});

test("one critique ceiling permits exact text and vision dispatches under one cap", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "xai-critique-modalities";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 2,
    stageCeilings: [
      {
        provider: "xai",
        stage: "critique",
        maxAttempts: 2,
        allowedDispatches: [
          { modality: "text", model: "grok-4.6", timeoutMs: 45_000 },
          { modality: "vision", model: "grok-4.6", timeoutMs: 90_000 },
        ],
      },
    ],
  });

  for (const [modality, timeoutMs] of [
    ["text", 45_000],
    ["vision", 90_000],
  ]) {
    await withPaidInferenceRun(runId, token, () =>
      accountPaidProviderDispatch(
        {
          provider: "xai",
          modality,
          model: "grok-4.6",
          timeoutMs,
          stage: "critique",
          iteration: 1,
          role: "Cross-model scene-plan judge",
        },
        async () => undefined,
      ),
    );
  }

  assert.equal(getPaidInferenceRunLedger(runId, token).attemptCount, 2);
});

test("an open run enforces context even when the preview started without an env token", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  delete process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "runtime-enforced-open-run";
  const created = createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [xaiTextCeiling("planning")],
  });
  assert.equal(benchmarkPaidInferenceEnforcementRequired(), true);
  assert.equal(created.roster.enforcementRequired, true);

  let fetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "chatcmpl_after_finish",
        model: body.model,
        choices: [{ message: { content: "{}" } }],
      }),
      { status: 200 },
    );
  };
  await assert.rejects(
    xaiChatResult({ system: "Return JSON.", user: "Unbound." }),
    /no active run context/,
  );
  assert.equal(fetchCalls, 0);

  finishPaidInferenceRun(runId, token, "completed");
  assert.equal(benchmarkPaidInferenceEnforcementRequired(), false);
  await xaiChatResult({ system: "Return JSON.", user: "Ordinary UI." });
  assert.equal(fetchCalls, 1);
});

test("decode failures and cancellation both receive terminal paid-attempt outcomes", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "terminal-outcomes";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 2,
    stageCeilings: [xaiTextCeiling("critique", 2)],
  });
  let request = 0;
  globalThis.fetch = async (_url, init) => {
    request += 1;
    if (request === 1) return new Response("{malformed", { status: 200 });
    const signal = init?.signal;
    return new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const invoke = (signal) =>
    withPaidInferenceRun(runId, token, () =>
      xaiChatResult({
        system: "Return JSON.",
        user: "Critique.",
        signal,
        dispatch: { stage: "critique", iteration: 1, role: "visual critic" },
      }),
    );
  await assert.rejects(invoke(undefined), /returned malformed JSON/);
  const controller = new AbortController();
  const cancelled = invoke(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);

  const outcomes = getPaidInferenceRunLedger(runId, token).events.filter(
    (event) => event.type === "outcome",
  );
  assert.deepEqual(
    outcomes.map((event) => event.outcome),
    ["failed", "cancelled"],
  );
});

test("parent cleanup cannot complete pending work and terminalizes orphan attempts", async () => {
  configureBenchmark();
  const token = process.env.WORLDCLAW_BENCHMARK_ENFORCEMENT_TOKEN;
  const runId = "orphan-cleanup";
  createPaidInferenceRun({
    runId,
    enforcementToken: token,
    expectedRoster: expectedRoster(),
    maxAttempts: 1,
    stageCeilings: [xaiTextCeiling("planning")],
  });
  await withPaidInferenceRun(runId, token, () =>
    beginPaidProviderDispatch({
      provider: "xai",
      modality: "text",
      model: "grok-4.6",
      timeoutMs: 45_000,
      stage: "planning",
      iteration: 1,
      role: "Independent scene-plan candidate",
    }),
  );
  assert.throws(
    () => finishPaidInferenceRun(runId, token, "completed"),
    /cannot complete with 1 pending attempt/,
  );
  const closed = finishPaidInferenceRun(runId, token, "cancelled");
  assert.equal(closed.status, "cancelled");
  assert.deepEqual(
    closed.events.map((event) =>
      event.type === "outcome" ? `${event.type}:${event.outcome}` : event.type,
    ),
    ["run", "attempt", "outcome:cancelled", "run"],
  );
});

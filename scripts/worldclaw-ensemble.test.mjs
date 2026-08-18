import assert from "node:assert/strict";
import { test } from "node:test";
import {
  committeeStatuses,
  runImageProvider,
  runTextCommittee,
  runTextCommitteeQuorum,
} from "../src/lib/worldclaw/ensemble.server.ts";
import { mergeEnsembleEvidence } from "../src/lib/worldclaw/inference.ts";

const KEY_NAMES = ["XAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"];
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("committee exposes all exact default models and fails closed without credentials", async () => {
  const previous = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]));
  const previousTextModel = process.env.XAI_TEXT_MODEL;
  try {
    for (const name of KEY_NAMES) delete process.env[name];
    delete process.env.XAI_TEXT_MODEL;
    const calls = await runTextCommittee({ system: "Return JSON.", user: "Test." });
    assert.deepEqual(
      calls.map((call) => [call.provider, call.model, call.configured, call.ok]),
      [
        ["xai", "grok-4.6", false, false],
        ["gemini", "gemini-3.6-flash", false, false],
        ["openai", "gpt-5.6-sol", false, false],
        ["anthropic", "anthropic/claude-opus-5", false, false],
      ],
    );
    assert.equal(committeeStatuses(calls).length, 4);
  } finally {
    for (const name of KEY_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    if (previousTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
    else process.env.XAI_TEXT_MODEL = previousTextModel;
  }
});

test("committee values retain provider-reported model and response identity", async () => {
  const previous = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]));
  const previousTextModel = process.env.XAI_TEXT_MODEL;
  const originalFetch = globalThis.fetch;
  for (const name of KEY_NAMES) process.env[name] = `${name.toLowerCase()}-unit-test`;
  delete process.env.XAI_TEXT_MODEL;
  try {
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      const body = JSON.parse(String(init?.body));
      if (href.includes("api.x.ai")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl_xai_committee",
            model: body.model,
            choices: [{ message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      }
      if (href.includes("generativelanguage.googleapis.com")) {
        const model = href.match(/models\/([^:]+):/)?.[1];
        return new Response(
          JSON.stringify({
            modelVersion: `models/${model}`,
            responseId: "gemini_committee",
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
          }),
          { status: 200 },
        );
      }
      if (href.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            id: "resp_openai_committee",
            model: body.model,
            status: "completed",
            output_text: "{}",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_claude_committee",
          model: body.model,
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
        }),
        { status: 200 },
      );
    };
    const calls = await runTextCommittee({ system: "Return JSON.", user: "Test." });
    assert.ok(calls.every((call) => call.ok));
    assert.deepEqual(
      calls.map((call) => ({
        provider: call.provider,
        requestedModel: call.requestedModel,
        model: call.model,
        responseId: call.responseId,
        identityAttestation: call.identityAttestation,
        valueModel: call.value?.model,
        valueResponseId: call.value?.responseId,
      })),
      [
        {
          provider: "xai",
          requestedModel: "grok-4.6",
          model: "grok-4.6",
          responseId: "chatcmpl_xai_committee",
          identityAttestation: "provider-response",
          valueModel: "grok-4.6",
          valueResponseId: "chatcmpl_xai_committee",
        },
        {
          provider: "gemini",
          requestedModel: "gemini-3.6-flash",
          model: "gemini-3.6-flash",
          responseId: "gemini_committee",
          identityAttestation: "provider-response",
          valueModel: "gemini-3.6-flash",
          valueResponseId: "gemini_committee",
        },
        {
          provider: "openai",
          requestedModel: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          responseId: "resp_openai_committee",
          identityAttestation: "provider-response",
          valueModel: "gpt-5.6-sol",
          valueResponseId: "resp_openai_committee",
        },
        {
          provider: "anthropic",
          requestedModel: "anthropic/claude-opus-5",
          model: "anthropic/claude-opus-5",
          responseId: "chatcmpl_claude_committee",
          identityAttestation: "provider-response",
          valueModel: "anthropic/claude-opus-5",
          valueResponseId: "chatcmpl_claude_committee",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of KEY_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    if (previousTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
    else process.env.XAI_TEXT_MODEL = previousTextModel;
  }
});

test("interactive committee quorum cancels slow stragglers after two usable results", async () => {
  const previous = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  for (const name of KEY_NAMES) process.env[name] = `${name.toLowerCase()}-quorum-test`;
  const aborted = [];
  try {
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      const body = JSON.parse(String(init?.body));
      if (href.includes("api.x.ai")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl_xai_quorum",
            model: body.model,
            choices: [{ message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      }
      if (href.includes("generativelanguage.googleapis.com")) {
        const model = href.match(/models\/([^:]+):/)?.[1];
        await new Promise((resolve) => setTimeout(resolve, 12));
        return new Response(
          JSON.stringify({
            modelVersion: `models/${model}`,
            responseId: "gemini_quorum",
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
          }),
          { status: 200 },
        );
      }
      return new Promise((resolve, reject) => {
        void resolve;
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            aborted.push(href);
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    };

    const calls = await runTextCommitteeQuorum(
      { system: "Return JSON.", user: "Test." },
      { minimumUsable: 2, isUsable: (call) => call.ok },
    );
    assert.deepEqual(
      calls.map((call) => call.provider),
      ["xai", "gemini"],
    );
    assert.equal(aborted.length, 2);
    assert.ok(aborted.some((href) => href.includes("api.openai.com")));
    assert.ok(aborted.some((href) => href.includes("ai-gateway.vercel.sh")));
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of KEY_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("image committee distinguishes provider-response from request-only identity", async () => {
  const previous = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  process.env.XAI_API_KEY = "xai-unit-test";
  process.env.GEMINI_API_KEY = "gemini-unit-test";
  process.env.OPENAI_API_KEY = "openai-unit-test";
  try {
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("api.x.ai")) {
        assert.equal(JSON.parse(String(init?.body)).model, "grok-imagine-image-quality");
        return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
          status: 200,
        });
      }
      if (href.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({
            modelVersion: "models/gemini-3-pro-image",
            responseId: "gemini_image_committee",
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [{ inlineData: { mimeType: "image/png", data: ONE_PIXEL_PNG } }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      assert.ok(init?.body instanceof FormData || typeof init?.body === "string");
      return new Response(JSON.stringify({ data: [{ b64_json: "dGVzdA==" }] }), {
        status: 200,
      });
    };
    const calls = await Promise.all([
      runImageProvider("xai", { prompt: "map" }),
      runImageProvider("gemini", { prompt: "map" }),
      runImageProvider("openai", { prompt: "map" }),
    ]);
    assert.deepEqual(
      calls.map(({ provider, requestedModel, model, responseId, identityAttestation }) => ({
        provider,
        requestedModel,
        model,
        responseId,
        identityAttestation,
      })),
      [
        {
          provider: "xai",
          requestedModel: "grok-imagine-image-quality",
          model: "grok-imagine-image-quality",
          responseId: undefined,
          identityAttestation: "request-only",
        },
        {
          provider: "gemini",
          requestedModel: "gemini-3-pro-image",
          model: "gemini-3-pro-image",
          responseId: "gemini_image_committee",
          identityAttestation: "provider-response",
        },
        {
          provider: "openai",
          requestedModel: "gpt-image-2",
          model: "gpt-image-2",
          responseId: undefined,
          identityAttestation: "request-only",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of KEY_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("Gateway-only Gemini configuration does not advertise a certifiable image transport", async () => {
  const previous = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  delete process.env.GEMINI_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-test";
  let fetchCalls = 0;
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    };
    const result = await runImageProvider("gemini", { prompt: "map" });
    assert.deepEqual(
      {
        requestedModel: result.requestedModel,
        configured: result.configured,
        available: result.available,
        ok: result.ok,
        identityAttestation: result.identityAttestation,
      },
      {
        requestedModel: "gemini-3-pro-image",
        configured: false,
        available: false,
        ok: false,
        identityAttestation: "unattested",
      },
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of KEY_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("ensemble merge preserves stage selections and bounds retained image variants", () => {
  const providers = [
    {
      provider: "xai",
      configured: true,
      authenticated: true,
      available: true,
      model: "grok-4.5",
    },
  ];
  const artifact = (index, stage) => ({
    id: `${stage}-${index}`,
    iteration: 1,
    stage,
    provider: "xai",
    model: stage === "layout" ? "grok-imagine-image-quality" : "grok-4.5",
    requestedModel: stage === "layout" ? "grok-imagine-image-quality" : "grok-4.5",
    responseId: stage === "layout" ? undefined : `xai_${stage}_${index}`,
    identityAttestation: stage === "layout" ? "request-only" : "provider-response",
    role: `${stage} output`,
    status: index === 0 ? "selected" : "candidate",
    imageDataUrl: `data:image/jpeg;base64,${"a".repeat(32)}`,
    parentArtifactIds: [],
    metrics: {},
    observations: [],
    conflicts: [],
  });
  const layout = {
    providers,
    artifacts: Array.from({ length: 8 }, (_, index) => artifact(index, "layout")),
    selection: {
      chosenLayoutArtifactId: "layout-0",
      consensusScore: 0.91,
      rationale: ["layout selected"],
    },
    completedIterations: 1,
    maxIterations: 2,
  };
  const multiview = {
    providers,
    artifacts: Array.from({ length: 8 }, (_, index) => artifact(index, "multiview")),
    selection: {
      chosenMultiviewArtifactId: "multiview-0",
      consensusScore: 0.84,
      rationale: ["multiview selected"],
    },
    completedIterations: 2,
    maxIterations: 2,
  };
  const merged = mergeEnsembleEvidence(layout, multiview);
  assert.ok(merged);
  assert.equal(merged.selection.chosenLayoutArtifactId, "layout-0");
  assert.equal(merged.selection.chosenMultiviewArtifactId, "multiview-0");
  assert.equal(merged.selection.consensusScore, 0.84);
  assert.equal(merged.completedIterations, 2);
  assert.equal(merged.artifacts.filter((entry) => entry.imageDataUrl).length, 12);
  assert.equal(
    merged.artifacts.filter((entry) =>
      entry.observations.some((note) => note.includes("evidence budget")),
    ).length,
    4,
  );
});

test("ensemble merge preserves bounded inspectable structured outputs without inline images", () => {
  const artifact = (index) => ({
    id: `planning-${index}`,
    iteration: 1,
    stage: "planning",
    provider: "xai",
    model: "grok-4.5",
    requestedModel: "grok-4.5",
    responseId: `xai_planning_${index}`,
    identityAttestation: "provider-response",
    role: "planning output",
    status: index === 0 ? "selected" : "candidate",
    structuredOutput: JSON.stringify({ index, plan: { sceneType: "test" } }),
    parentArtifactIds: [],
    metrics: {},
    observations: [],
    conflicts: [],
  });
  const evidence = {
    providers: [],
    artifacts: Array.from({ length: 70 }, (_, index) => artifact(index)),
    completedIterations: 1,
    maxIterations: 2,
  };
  const merged = mergeEnsembleEvidence(evidence);
  assert.ok(merged);
  assert.equal(merged.artifacts.filter((entry) => entry.structuredOutput).length, 64);
  assert.deepEqual(JSON.parse(merged.artifacts[0].structuredOutput), {
    index: 0,
    plan: { sceneType: "test" },
  });
  assert.equal(
    merged.artifacts.filter((entry) =>
      entry.observations.some((note) => note.includes("Structured output omitted")),
    ).length,
    6,
  );
});

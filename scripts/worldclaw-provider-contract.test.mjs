import assert from "node:assert/strict";
import { test } from "node:test";
import jpeg from "jpeg-js";
import {
  GEMINI_ORDINARY_BILLING_COOLDOWN_MS,
  geminiChat,
  geminiChatResult,
  geminiImage,
  geminiVisionJson,
  geminiVisionJsonResult,
} from "../src/lib/worldclaw/gemini.server.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { xaiChat, xaiImage, xaiChatResult } from "../src/lib/worldclaw/xai.server.ts";
import { runtimeModelRosterSnapshot } from "../src/lib/worldclaw/paid-inference.server.ts";
import { XAI_TEXT_MODEL_DEFAULT } from "../src/lib/worldclaw/model-ids.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_JPEG = Buffer.from(
  jpeg.encode({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }, 90).data,
).toString("base64");

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("xAI defaults use the current reasoning and Imagine quality models", async () => {
  const previousKey = process.env.XAI_API_KEY;
  const previousTextModel = process.env.XAI_TEXT_MODEL;
  process.env.XAI_API_KEY = "unit-test-key";
  delete process.env.XAI_TEXT_MODEL;
  const requests = [];
  try {
    await withMockFetch(
      async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        if (String(url).includes("/chat/completions")) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl_xai_default",
              model: "grok-4.6",
              choices: [{ message: { content: "{}" } }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        await xaiChat({
          system: "Return JSON",
          user: "Plan a world",
          responseFormat: "json_object",
        });
        await xaiImage({ prompt: "Top-down terrain", quality: true });
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
    if (previousTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
    else process.env.XAI_TEXT_MODEL = previousTextModel;
  }

  assert.equal(requests[0].body.model, "grok-4.6");
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(requests[1].body.model, "grok-imagine-image-quality");
});

test("startup.sh default XAI_TEXT_MODEL matches the shipped xAI text identity", () => {
  const startup = readFileSync(fileURLToPath(new URL("../startup.sh", import.meta.url)), "utf8");
  const match = startup.match(/export XAI_TEXT_MODEL="\$\{XAI_TEXT_MODEL:-([^}]+)\}"/);
  assert.ok(match, "startup.sh must export XAI_TEXT_MODEL with a default");
  assert.equal(match[1], XAI_TEXT_MODEL_DEFAULT);
  assert.doesNotMatch(startup, /XAI_TEXT_MODEL:-grok-4\.5/);
});

test("xAI text and vision honor XAI_TEXT_MODEL while image stays on Imagine quality", async () => {
  const previousKey = process.env.XAI_API_KEY;
  const previousTextModel = process.env.XAI_TEXT_MODEL;
  process.env.XAI_API_KEY = "unit-test-key";
  const requests = [];
  try {
    delete process.env.XAI_TEXT_MODEL;
    const defaultRoster = runtimeModelRosterSnapshot();
    assert.equal(
      defaultRoster.entries.find((entry) => entry.provider === "xai" && entry.modality === "text")
        ?.model,
      "grok-4.6",
    );
    assert.equal(
      defaultRoster.entries.find((entry) => entry.provider === "xai" && entry.modality === "vision")
        ?.model,
      "grok-4.6",
    );
    assert.equal(
      defaultRoster.entries.find((entry) => entry.provider === "xai" && entry.modality === "image")
        ?.model,
      "grok-imagine-image-quality",
    );

    process.env.XAI_TEXT_MODEL = "grok-4.6-probe";
    const envRoster = runtimeModelRosterSnapshot();
    assert.equal(
      envRoster.entries.find((entry) => entry.provider === "xai" && entry.modality === "text")
        ?.model,
      "grok-4.6-probe",
    );
    assert.equal(
      envRoster.entries.find((entry) => entry.provider === "xai" && entry.modality === "vision")
        ?.model,
      "grok-4.6-probe",
    );
    assert.equal(
      envRoster.entries.find((entry) => entry.provider === "xai" && entry.modality === "image")
        ?.model,
      "grok-imagine-image-quality",
    );

    await withMockFetch(
      async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            id: "chatcmpl_xai_env",
            model: "grok-4.6-probe",
            choices: [{ message: { content: "{}" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      async () => {
        await xaiChat({
          system: "Return JSON",
          user: "Plan a world",
          responseFormat: "json_object",
        });
      },
    );
    assert.equal(requests[0].body.model, "grok-4.6-probe");
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
    if (previousTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
    else process.env.XAI_TEXT_MODEL = previousTextModel;
  }
});

test("xAI bounds streamed JSON and validates generated image bytes and dimensions", async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "unit-test-key";
  const oversizedDimensions = Buffer.from(ONE_PIXEL_PNG, "base64");
  oversizedDimensions.writeUInt32BE(4_097, 16);
  const responses = [
    new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    }),
    new Response(JSON.stringify({ data: [{ b64_json: "not-base64!" }] }), {
      status: 200,
    }),
    new Response(JSON.stringify({ data: [{ b64_json: oversizedDimensions.toString("base64") }] }), {
      status: 200,
    }),
  ];
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls += 1;
        return responses.shift();
      },
      async () => {
        await assert.rejects(
          xaiChatResult({ system: "Return JSON.", user: "Plan." }),
          /response exceeds the output budget/,
        );
        await assert.rejects(xaiImage({ prompt: "Map", quality: true }), /malformed base64 data/);
        await assert.rejects(xaiImage({ prompt: "Map", quality: true }), /image dimension budget/);
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
  assert.equal(fetchCalls, 3);
});

test("Gemini defaults use 3.6 Flash and the current GA image model", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousTextModel = process.env.GEMINI_TEXT_MODEL;
  const previousImageModel = process.env.GEMINI_IMAGE_MODEL;
  process.env.GEMINI_API_KEY = "unit-test-key";
  delete process.env.GEMINI_TEXT_MODEL;
  delete process.env.GEMINI_IMAGE_MODEL;
  const requests = [];
  try {
    await withMockFetch(
      async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        const parts = String(url).includes("gemini-3-pro-image")
          ? [{ inlineData: { mimeType: "image/png", data: ONE_PIXEL_PNG } }]
          : [{ text: "{}" }];
        const model = String(url).match(/models\/([^:]+):/)?.[1];
        return new Response(
          JSON.stringify({
            modelVersion: `models/${model}`,
            responseId: `gemini_${requests.length}`,
            candidates: [{ finishReason: "STOP", content: { parts } }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
      async () => {
        await geminiChat({ system: "Return JSON", user: "Plan a world" });
        const image = await geminiImage({
          prompt: "Registered oblique reference",
          aspectRatio: "16:9",
          referenceImages: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
        });
        assert.equal(image.model, "gemini-3-pro-image");
        assert.equal(image.responseId, "gemini_2");
        await geminiVisionJson({
          system: "Return JSON",
          user: "Compare registered views",
          images: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
        });
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousTextModel === undefined) delete process.env.GEMINI_TEXT_MODEL;
    else process.env.GEMINI_TEXT_MODEL = previousTextModel;
    if (previousImageModel === undefined) delete process.env.GEMINI_IMAGE_MODEL;
    else process.env.GEMINI_IMAGE_MODEL = previousImageModel;
  }

  assert.match(requests[0].url, /models\/gemini-3\.6-flash:generateContent/);
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal("temperature" in requests[0].body.generationConfig, false);
  assert.match(requests[1].url, /models\/gemini-3-pro-image:generateContent/);
  assert.equal(requests[1].body.generationConfig.imageConfig.aspectRatio, "16:9");
  assert.deepEqual(requests[1].body.contents[0].parts[1], {
    inlineData: { mimeType: "image/png", data: ONE_PIXEL_PNG },
  });
  assert.match(requests[2].url, /models\/gemini-3\.6-flash:generateContent/);
  assert.deepEqual(requests[2].body.contents[0].parts[1], {
    inlineData: { mimeType: "image/png", data: ONE_PIXEL_PNG },
  });
});

test("Gemini text falls back to an exactly attested Gateway dispatch only for direct billing denial", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  process.env.GEMINI_API_KEY = "direct-unit-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  const requests = [];
  try {
    await withMockFetch(
      async (url, init) => {
        requests.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: JSON.parse(String(init?.body)),
        });
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                status: "PERMISSION_DENIED",
                message: "Lightning dunning decision is deny for project: projects/123456789",
              },
            }),
            { status: 403 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl_gateway_gemini_36",
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        assert.deepEqual(await geminiChatResult({ system: "Return JSON", user: "Plan a world" }), {
          text: '{"ok":true}',
          provider: "gemini",
          model: "gemini-3.6-flash",
          responseId: "chatcmpl_gateway_gemini_36",
        });
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(requests[0].headers["x-goog-api-key"], "direct-unit-key");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].url, "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(requests[1].headers.authorization, "Bearer gateway-unit-key");
  assert.equal(requests[1].headers["x-goog-api-key"], undefined);
  assert.equal(requests[1].body.model, "google/gemini-3.6-flash");
  assert.equal(requests[1].body.reasoning_effort, "high");
});

test("Gemini ordinary billing cooldown sends later text and vision calls straight to Gateway", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  process.env.GEMINI_API_KEY = "ordinary-cooldown-direct-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let directCalls = 0;
  let gatewayCalls = 0;
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com")) {
          directCalls += 1;
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
            id: `chatcmpl_gateway_ordinary_${gatewayCalls}`,
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        await geminiChatResult({ system: "Return JSON", user: "First ordinary call" });
        await geminiVisionJsonResult({
          system: "Return JSON",
          user: "Second ordinary vision call",
          images: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
        });
        await assert.rejects(
          geminiImage({ prompt: "Blocked direct-only image during the ordinary cooldown" }),
          /direct Google billing cooldown is active.*no certifiable image Gateway transport/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(directCalls, 1);
  assert.equal(gatewayCalls, 2);
});

test("Gemini ordinary billing cooldown expires and retries corrected direct billing", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  const originalDateNow = Date.now;
  process.env.GEMINI_API_KEY = "ordinary-expiry-direct-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let nowMs = 1_800_000_000_000;
  let directCalls = 0;
  let gatewayCalls = 0;
  Date.now = () => nowMs;
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com")) {
          directCalls += 1;
          if (directCalls === 1) {
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
          return new Response(
            JSON.stringify({
              modelVersion: "models/gemini-3.6-flash",
              responseId: "gemini_billing_recovered",
              candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
            }),
            { status: 200 },
          );
        }
        gatewayCalls += 1;
        return new Response(
          JSON.stringify({
            id: `chatcmpl_gateway_expiry_${gatewayCalls}`,
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        await geminiChatResult({ system: "Return JSON", user: "Open cooldown" });
        await geminiChatResult({ system: "Return JSON", user: "Use cooldown" });
        nowMs += GEMINI_ORDINARY_BILLING_COOLDOWN_MS + 1;
        const recovered = await geminiChatResult({
          system: "Return JSON",
          user: "Retry direct after cooldown",
        });
        assert.equal(recovered.responseId, "gemini_billing_recovered");
      },
    );
  } finally {
    Date.now = originalDateNow;
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(directCalls, 2);
  assert.equal(gatewayCalls, 2);
});

test("Gemini ordinary billing cooldown resets immediately when the direct credential rotates", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  process.env.GEMINI_API_KEY = "ordinary-rotation-denied-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let directCalls = 0;
  let gatewayCalls = 0;
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com")) {
          directCalls += 1;
          if (directCalls === 1) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  status: "PERMISSION_DENIED",
                  message: "Billing is disabled for this paid plan.",
                },
              }),
              { status: 403 },
            );
          }
          return new Response(
            JSON.stringify({
              modelVersion: "gemini-3.6-flash",
              responseId: "gemini_rotated_credential",
              candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
            }),
            { status: 200 },
          );
        }
        gatewayCalls += 1;
        return new Response(
          JSON.stringify({
            id: "chatcmpl_gateway_before_rotation",
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        await geminiChatResult({ system: "Return JSON", user: "Open credential cooldown" });
        process.env.GEMINI_API_KEY = "ordinary-rotation-corrected-key";
        const recovered = await geminiChatResult({
          system: "Return JSON",
          user: "Retry with rotated credential",
        });
        assert.equal(recovered.responseId, "gemini_rotated_credential");
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(directCalls, 2);
  assert.equal(gatewayCalls, 1);
});

test("Gemini ordinary billing cooldown fails open to direct retry after a mid-window clock rollback", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  const originalDateNow = Date.now;
  process.env.GEMINI_API_KEY = "ordinary-rollback-direct-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let nowMs = 1_800_000_000_000;
  let directCalls = 0;
  let gatewayCalls = 0;
  Date.now = () => nowMs;
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com")) {
          directCalls += 1;
          if (directCalls === 1) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  status: "PERMISSION_DENIED",
                  message: "Billing is disabled for this paid plan.",
                },
              }),
              { status: 403 },
            );
          }
          return new Response(
            JSON.stringify({
              modelVersion: "gemini-3.6-flash",
              responseId: "gemini_after_clock_rollback",
              candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
            }),
            { status: 200 },
          );
        }
        gatewayCalls += 1;
        return new Response(
          JSON.stringify({
            id: `chatcmpl_gateway_rollback_${gatewayCalls}`,
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        await geminiChatResult({ system: "Return JSON", user: "Open rollback cooldown" });
        nowMs += 120_000;
        await geminiChatResult({ system: "Return JSON", user: "Observe cooldown at two minutes" });
        nowMs -= 60_000;
        const recovered = await geminiChatResult({
          system: "Return JSON",
          user: "Retry direct after clock rollback",
        });
        assert.equal(recovered.responseId, "gemini_after_clock_rollback");
      },
    );
  } finally {
    Date.now = originalDateNow;
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(directCalls, 2);
  assert.equal(gatewayCalls, 2);
});

test("Gemini direct and Gateway attempts share one end-to-end deadline", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  process.env.GEMINI_API_KEY = "direct-unit-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  const starts = [];
  const signals = [];
  try {
    await withMockFetch(
      async (url, init) => {
        starts.push(Date.now());
        signals.push(init?.signal);
        if (String(url).includes("generativelanguage.googleapis.com")) {
          await new Promise((resolve) => setTimeout(resolve, 35));
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
      },
      async () => {
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan", timeoutMs: 70 }),
          /Gateway timed out after 70ms/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(starts.length, 2);
  assert.strictEqual(signals[0], signals[1], "both transports must reuse one deadline signal");
});

test("Gemini Gateway vision uses bounded inline inputs and exact response identity", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let request;
  try {
    await withMockFetch(
      async (url, init) => {
        request = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(
          JSON.stringify({
            id: "chatcmpl_gateway_vision_36",
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        assert.deepEqual(
          await geminiVisionJsonResult({
            system: "Return JSON",
            user: "Judge the registered view",
            images: [
              { mime: "image/png", b64: ONE_PIXEL_PNG },
              { mime: "image/jpeg", b64: ONE_PIXEL_JPEG },
            ],
          }),
          {
            text: "{}",
            provider: "gemini",
            model: "gemini-3.6-flash",
            responseId: "chatcmpl_gateway_vision_36",
          },
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(request.url, "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(request.body.model, "google/gemini-3.6-flash");
  assert.deepEqual(request.body.messages[1].content, [
    { type: "text", text: "Judge the registered view" },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG}`, detail: "high" },
    },
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${ONE_PIXEL_JPEG}`, detail: "high" },
    },
  ]);
});

test("Gemini Gateway text fails closed on missing or drifted response attestation", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  const payloads = [
    {
      id: "chatcmpl_gateway_wrong_model",
      model: "google/gemini-3.5-flash",
      choices: [{ message: { content: "{}" } }],
    },
    {
      model: "google/gemini-3.6-flash",
      choices: [{ message: { content: "{}" } }],
    },
  ];
  try {
    await withMockFetch(
      async () => new Response(JSON.stringify(payloads.shift()), { status: 200 }),
      async () => {
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan" }),
          /provider model mismatch: requested google\/gemini-3\.6-flash, received google\/gemini-3\.5-flash/,
        );
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan" }),
          /no valid response identifier/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
});

test("Gemini Gateway refuses non-terminal completion reasons", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  try {
    await withMockFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_gateway_filtered",
            model: "google/gemini-3.6-flash",
            choices: [{ finish_reason: "content_filter", message: { content: "{}" } }],
          }),
          { status: 200 },
        ),
      async () => {
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan" }),
          /did not return a complete answer/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
});

test("Gemini text and image model policy rejects drift before paid fetch", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "direct-unit-key";
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
      async () => {
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan", model: "gemini-3.1-flash" }),
          /requires gemini-3\.6-flash/,
        );
        await assert.rejects(
          geminiImage({ prompt: "Map", model: "gemini-3.1-pro-image" }),
          /requires gemini-3-pro-image/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
  }
  assert.equal(fetchCalls, 0);
});

test("Gemini does not route authentication or generic provider failures through paid Gateway fallback", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  process.env.GEMINI_API_KEY = "invalid-direct-unit-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "API key is not authorized for this project.",
            },
          }),
          { status: 403 },
        );
      },
      async () => {
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan" }),
          /failed with HTTP 403/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(fetchCalls, 1);
});

test("Gemini 3 Pro Image does not use Gateway when raw Google identity is unavailable", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
      async () => {
        await assert.rejects(
          geminiImage({ prompt: "Registered oblique harbor reference" }),
          /requires direct GEMINI_API_KEY access/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(fetchCalls, 0);
});

test("Gemini image rejects direct billing denial and unsupported fast model without Gateway spend", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  process.env.GEMINI_API_KEY = "direct-unit-key";
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Billing account is disabled for this API key.",
            },
          }),
          { status: 403 },
        );
      },
      async () => {
        await assert.rejects(
          geminiImage({ prompt: "Map", model: "gemini-3-pro-image" }),
          /direct billing is unavailable/,
        );
        await assert.rejects(
          geminiImage({ prompt: "Map", model: "gemini-3.6-flash" }),
          /is not an image-output model/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
  assert.equal(fetchCalls, 1);
});

test("Gemini Gateway bounds text responses", async () => {
  const previousDirectKey = process.env.GEMINI_API_KEY;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gateway-unit-key";
  const response = new Response("{}", {
    status: 200,
    headers: { "content-length": String(2 * 1024 * 1024 + 1) },
  });
  try {
    await withMockFetch(
      async () => response,
      async () => {
        await assert.rejects(
          geminiChatResult({ system: "Return JSON", user: "Plan" }),
          /response exceeds the output budget/,
        );
      },
    );
  } finally {
    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  }
});

test("Gemini vision rejects invalid count, MIME, and combined bytes before fetch", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key";
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls++;
        throw new Error("fetch must not run");
      },
      async () => {
        const image = { mime: "image/png", b64: "dGVzdA==" };
        await assert.rejects(
          geminiVisionJson({
            system: "Return JSON",
            user: "Review",
            images: Array(5).fill(image),
          }),
          /at most 4/,
        );
        await assert.rejects(
          geminiVisionJson({
            system: "Return JSON",
            user: "Review",
            images: [{ mime: "image/svg+xml", b64: "dGVzdA==" }],
          }),
          /unsupported MIME/,
        );
        const eightMiB = Buffer.alloc(8 * 1024 * 1024).toString("base64");
        await assert.rejects(
          geminiVisionJson({
            system: "Return JSON",
            user: "Review",
            images: [
              { mime: "image/png", b64: eightMiB },
              { mime: "image/png", b64: eightMiB },
            ],
          }),
          /combined inline byte budget/,
        );
        await assert.rejects(
          geminiVisionJson({
            system: "Return JSON",
            user: "Review",
            images: [image],
          }),
          /not a supported PNG or JPEG image/,
        );
        const corruptPng = Buffer.from(ONE_PIXEL_PNG, "base64");
        corruptPng[45] ^= 1;
        await assert.rejects(
          geminiVisionJson({
            system: "Return JSON",
            user: "Review",
            images: [{ mime: "image/png", b64: corruptPng.toString("base64") }],
          }),
          /invalid or corrupt image data/,
        );
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
  assert.equal(fetchCalls, 0);
});

test("Gemini direct image output rejects corrupt and MIME-mismatched bytes", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key";
  const corruptPng = Buffer.from(ONE_PIXEL_PNG, "base64");
  corruptPng[45] ^= 1;
  const outputs = [
    { mimeType: "image/png", data: corruptPng.toString("base64") },
    { mimeType: "image/jpeg", data: ONE_PIXEL_PNG },
  ];
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            modelVersion: "models/gemini-3-pro-image",
            responseId: `gemini_bad_image_${fetchCalls}`,
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ inlineData: outputs.shift() }] },
              },
            ],
          }),
          { status: 200 },
        );
      },
      async () => {
        await assert.rejects(geminiImage({ prompt: "Map" }), /invalid or corrupt image data/);
        await assert.rejects(geminiImage({ prompt: "Map" }), /MIME type does not match/);
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
  assert.equal(fetchCalls, 2);
});

test("xAI and Gemini expose provider-attested model and response identity", async () => {
  const previousXaiKey = process.env.XAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  const previousTextModel = process.env.XAI_TEXT_MODEL;
  process.env.XAI_API_KEY = "unit-test-key";
  process.env.GEMINI_API_KEY = "unit-test-key";
  delete process.env.XAI_TEXT_MODEL;
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("api.x.ai")) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl_xai_attested",
              model: "grok-4.6",
              choices: [{ message: { content: "{}" } }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            modelVersion: "models/gemini-3.6-flash",
            responseId: "gemini_attested_1",
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
          }),
          { status: 200 },
        );
      },
      async () => {
        assert.deepEqual(await xaiChatResult({ system: "Return JSON", user: "Plan" }), {
          text: "{}",
          provider: "xai",
          model: "grok-4.6",
          responseId: "chatcmpl_xai_attested",
        });
        assert.deepEqual(
          await geminiVisionJsonResult({
            system: "Return JSON",
            user: "Review",
            images: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
          }),
          {
            text: "{}",
            provider: "gemini",
            model: "gemini-3.6-flash",
            responseId: "gemini_attested_1",
          },
        );
      },
    );
  } finally {
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousXaiKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
    if (previousTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
    else process.env.XAI_TEXT_MODEL = previousTextModel;
  }
});

test("xAI and Gemini fail closed on missing or mismatched provider attestation", async () => {
  const previousXaiKey = process.env.XAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  const previousTextModel = process.env.XAI_TEXT_MODEL;
  process.env.XAI_API_KEY = "unit-test-key";
  process.env.GEMINI_API_KEY = "unit-test-key";
  delete process.env.XAI_TEXT_MODEL;
  const xaiPayloads = [
    {
      id: "chatcmpl_xai_wrong",
      model: "grok-4.4",
      choices: [{ message: { content: "{}" } }],
    },
    {
      model: "grok-4.6",
      choices: [{ message: { content: "{}" } }],
    },
  ];
  const geminiPayloads = [
    {
      modelVersion: "models/gemini-3.5-flash",
      responseId: "gemini_wrong_model",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
    },
    {
      modelVersion: "models/gemini-3.6-flash",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
    },
  ];
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("api.x.ai")) {
          return new Response(JSON.stringify(xaiPayloads.shift()), { status: 200 });
        }
        return new Response(JSON.stringify(geminiPayloads.shift()), { status: 200 });
      },
      async () => {
        await assert.rejects(
          xaiChatResult({ system: "Return JSON", user: "Plan" }),
          /provider model mismatch: requested grok-4\.6, received grok-4\.4/,
        );
        await assert.rejects(
          xaiChatResult({ system: "Return JSON", user: "Plan" }),
          /no valid response identifier/,
        );
        await assert.rejects(
          geminiVisionJsonResult({
            system: "Return JSON",
            user: "Review",
            images: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
          }),
          /provider model mismatch: requested gemini-3\.6-flash, received gemini-3\.5-flash/,
        );
        await assert.rejects(
          geminiVisionJsonResult({
            system: "Return JSON",
            user: "Review",
            images: [{ mime: "image/png", b64: ONE_PIXEL_PNG }],
          }),
          /no valid response identifier/,
        );
      },
    );
  } finally {
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousXaiKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
    if (previousTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
    else process.env.XAI_TEXT_MODEL = previousTextModel;
  }
});

test("Gemini image applies the same strict prompt and reference-image bounds before fetch", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key";
  let fetchCalls = 0;
  try {
    await withMockFetch(
      async () => {
        fetchCalls++;
        throw new Error("fetch must not run");
      },
      async () => {
        const image = { mime: "image/png", b64: "dGVzdA==" };
        await assert.rejects(geminiImage({ prompt: "x".repeat(20_001) }), /character budget/);
        await assert.rejects(
          geminiImage({ prompt: "edit", referenceImages: Array(5).fill(image) }),
          /at most 4/,
        );
        await assert.rejects(
          geminiImage({
            prompt: "edit",
            referenceImages: [{ mime: "image/gif", b64: "dGVzdA==" }],
          }),
          /unsupported MIME/,
        );
        await assert.rejects(
          geminiImage({ prompt: "edit", referenceImages: [image] }),
          /not a supported PNG or JPEG image/,
        );
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
  assert.equal(fetchCalls, 0);
});

test("provider requests propagate caller cancellation to fetch", async () => {
  const previousXaiKey = process.env.XAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  process.env.XAI_API_KEY = "unit-test-key";
  process.env.GEMINI_API_KEY = "unit-test-key";
  const observedSignals = [];

  const heldFetch = async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal, "provider fetch had no AbortSignal");
    observedSignals.push(signal);
    return new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };

  try {
    await withMockFetch(heldFetch, async () => {
      const xaiController = new AbortController();
      const xaiRequest = xaiChat({
        system: "test",
        user: "test",
        signal: xaiController.signal,
        timeoutMs: 5_000,
      });
      xaiController.abort();
      await assert.rejects(xaiRequest, /xAI chat cancelled/);

      const geminiController = new AbortController();
      const geminiRequest = geminiChat({
        system: "test",
        user: "test",
        signal: geminiController.signal,
        timeoutMs: 5_000,
      });
      while (observedSignals.length < 2) await new Promise((resolve) => setImmediate(resolve));
      geminiController.abort();
      await assert.rejects(geminiRequest, /Gemini chat cancelled/);
    });
  } finally {
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousXaiKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }

  assert.equal(observedSignals.length, 2);
  assert.ok(observedSignals.every((signal) => signal.aborted));
});

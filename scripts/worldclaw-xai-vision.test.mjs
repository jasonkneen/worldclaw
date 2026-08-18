import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { xaiVisionJson, xaiVisionJsonResult } from "../src/lib/worldclaw/xai.server.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.XAI_API_KEY;
const originalTextModel = process.env.XAI_TEXT_MODEL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = originalKey;
  if (originalTextModel === undefined) delete process.env.XAI_TEXT_MODEL;
  else process.env.XAI_TEXT_MODEL = originalTextModel;
});

test("Grok 4.6 vision sends bounded inline images and requires JSON", async () => {
  process.env.XAI_API_KEY = "test-secret-that-must-not-leak";
  delete process.env.XAI_TEXT_MODEL;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(
      JSON.stringify({
        id: "chatcmpl_xai_vision_1",
        model: "grok-4.6",
        choices: [{ message: { content: '{"passed":true}' } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await xaiVisionJson({
    system: "Judge the image.",
    user: "Return JSON.",
    images: [{ mime: "image/png", b64: "aGVsbG8=" }],
  });
  assert.equal(result, '{"passed":true}');
  assert.equal(request.url, "https://api.x.ai/v1/chat/completions");
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "grok-4.6");
  assert.equal(body.response_format.type, "json_object");
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(request.init.headers.Authorization, "Bearer test-secret-that-must-not-leak");
  assert.doesNotMatch(JSON.stringify(body), /test-secret-that-must-not-leak/);

  const attested = await xaiVisionJsonResult({
    system: "Judge the image.",
    user: "Return JSON.",
    images: [{ mime: "image/png", b64: "aGVsbG8=" }],
  });
  assert.equal(attested.model, "grok-4.6");
  assert.equal(attested.responseId, "chatcmpl_xai_vision_1");
});

test("Grok vision rejects missing, unsupported, and oversized image inputs before fetch", async () => {
  process.env.XAI_API_KEY = "test-secret";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected fetch");
  };
  await assert.rejects(
    xaiVisionJson({ system: "s", user: "u", images: [] }),
    /requires 1-8 images/,
  );
  await assert.rejects(
    xaiVisionJson({
      system: "s",
      user: "u",
      images: [{ mime: "image/webp", b64: "aGVsbG8=" }],
    }),
    /must be PNG or JPEG/,
  );
  await assert.rejects(
    xaiVisionJson({
      system: "s",
      user: "u",
      images: [{ mime: "image/png", b64: "a".repeat(8_000_001) }],
    }),
    /exceeds the inline image budget/,
  );
  assert.equal(calls, 0);
});

test("Grok vision rejects malformed model output", async () => {
  process.env.XAI_API_KEY = "test-secret";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_xai_vision_bad_json",
        model: "grok-4.6",
        choices: [{ message: { content: "not-json" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  await assert.rejects(
    xaiVisionJson({
      system: "s",
      user: "u",
      images: [{ mime: "image/jpeg", b64: "aGVsbG8=" }],
    }),
    /valid JSON/,
  );
});

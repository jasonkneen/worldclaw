import assert from "node:assert/strict";
import { claudeTextJson } from "../src/lib/worldclaw/claude.server.ts";
import { geminiChat } from "../src/lib/worldclaw/gemini.server.ts";
import { openaiTextJson } from "../src/lib/worldclaw/openai.server.ts";
import { xaiChat } from "../src/lib/worldclaw/xai.server.ts";

import {
  XAI_IMAGE_MODEL_DEFAULT,
  XAI_TEXT_MODEL_DEFAULT,
} from "../src/lib/worldclaw/model-ids.ts";

const XAI_TEXT_MODEL = XAI_TEXT_MODEL_DEFAULT;
const XAI_IMAGE_MODEL = XAI_IMAGE_MODEL_DEFAULT;
const GEMINI_TEXT_MODEL = "gemini-3.6-flash";
const GEMINI_IMAGE_MODEL = "gemini-3-pro-image";
const OPENAI_TEXT_MODEL = "gpt-5.6-sol";
const OPENAI_IMAGE_MODEL = "gpt-image-2";
const CLAUDE_MODEL = "anthropic/claude-opus-5";

function requiredKey(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is missing`);
  return value;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`);
  return response.json();
}

const xaiKey = requiredKey("XAI_API_KEY");
const geminiKey = requiredKey("GEMINI_API_KEY");
const openaiKey = requiredKey("OPENAI_API_KEY");
requiredKey("AI_GATEWAY_API_KEY");

const [xaiModelsResponse, geminiText, geminiImage, openaiModelsResponse] = await Promise.all([
  fetchJson("https://api.x.ai/v1/models", {
    Authorization: `Bearer ${xaiKey}`,
  }),
  fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}`, {
    "x-goog-api-key": geminiKey,
  }),
  fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}`, {
    "x-goog-api-key": geminiKey,
  }),
  fetchJson("https://api.openai.com/v1/models", {
    Authorization: `Bearer ${openaiKey}`,
  }),
]);

const xaiModelIds = new Set(
  (xaiModelsResponse.data ?? xaiModelsResponse.models ?? []).map((model) => model.id ?? model.name),
);
assert.ok(xaiModelIds.has(XAI_TEXT_MODEL), `${XAI_TEXT_MODEL} is not available`);
assert.ok(xaiModelIds.has(XAI_IMAGE_MODEL), `${XAI_IMAGE_MODEL} is not available`);
assert.ok(
  String(geminiText.name ?? "").endsWith(GEMINI_TEXT_MODEL),
  `${GEMINI_TEXT_MODEL} metadata did not match`,
);
assert.ok(
  String(geminiImage.name ?? "").endsWith(GEMINI_IMAGE_MODEL),
  `${GEMINI_IMAGE_MODEL} metadata did not match`,
);
const openaiModelIds = new Set((openaiModelsResponse.data ?? []).map((model) => model.id));
assert.ok(openaiModelIds.has(OPENAI_TEXT_MODEL), `${OPENAI_TEXT_MODEL} is not available`);
assert.ok(openaiModelIds.has(OPENAI_IMAGE_MODEL), `${OPENAI_IMAGE_MODEL} is not available`);

const probeLabels = ["xAI", "Gemini", "OpenAI", "Claude"];
const probeResults = await Promise.allSettled([
  xaiChat({
    system: "Return exactly OK and nothing else.",
    user: "Credential check.",
    model: XAI_TEXT_MODEL,
    maxTokens: 64,
    reasoningEffort: "low",
    timeoutMs: 60_000,
  }),
  geminiChat({
    system: "Return exactly OK and nothing else.",
    user: "Credential check.",
    model: GEMINI_TEXT_MODEL,
    maxTokens: 64,
    thinkingLevel: "minimal",
    timeoutMs: 60_000,
  }),
  openaiTextJson({
    system: 'Return only the JSON object {"ok":true}.',
    user: "Credential check.",
    model: OPENAI_TEXT_MODEL,
    maxTokens: 256,
    reasoningEffort: "low",
    timeoutMs: 60_000,
  }),
  claudeTextJson({
    system: 'Return only the JSON object {"ok":true}.',
    user: "Credential check.",
    model: CLAUDE_MODEL,
    maxTokens: 256,
    timeoutMs: 90_000,
  }),
]);
for (const [index, result] of probeResults.entries()) {
  assert.equal(
    result.status,
    "fulfilled",
    `${probeLabels[index]} live probe failed: ${result.status === "rejected" ? (result.reason?.message ?? String(result.reason)) : "unknown error"}`,
  );
}
const [xaiProbe, geminiProbe, openaiProbe, claudeProbe] = probeResults.map(
  (result) => result.value,
);

assert.ok(xaiProbe.length > 0, "xAI inference returned no answer");
assert.ok(geminiProbe.length > 0, "Gemini inference returned no answer");
assert.equal(JSON.parse(openaiProbe.text).ok, true, "OpenAI inference returned invalid JSON");
assert.equal(JSON.parse(claudeProbe.text).ok, true, "Claude inference returned invalid JSON");

console.log(
  JSON.stringify(
    {
      ok: true,
      xai: {
        authenticated: true,
        textModel: XAI_TEXT_MODEL,
        imageModel: XAI_IMAGE_MODEL,
        liveInference: true,
      },
      gemini: {
        authenticated: true,
        textModel: GEMINI_TEXT_MODEL,
        imageModel: GEMINI_IMAGE_MODEL,
        liveInference: true,
      },
      openai: {
        authenticated: true,
        textModel: OPENAI_TEXT_MODEL,
        imageModel: OPENAI_IMAGE_MODEL,
        liveInference: true,
      },
      anthropic: {
        authenticatedVia: "Vercel AI Gateway",
        model: CLAUDE_MODEL,
        liveInference: true,
      },
    },
    null,
    2,
  ),
);

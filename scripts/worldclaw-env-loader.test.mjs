import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyWorldclawEnvValues,
  parseWorldclawEnvFile,
} from "./load-worldclaw-env.mjs";
import { readWorldclawPlanningAvailability } from "../src/lib/worldclaw/inference.ts";

test("planning availability is template when no provider keys are present", async () => {
  const names = ["XAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const status = await readWorldclawPlanningAvailability();
    assert.equal(status.mode, "template");
    assert.equal(
      status.providers.every((provider) => provider.configured === false),
      true,
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("planning availability is committee when an xAI key is present", async () => {
  const names = ["XAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.XAI_API_KEY = "unit-test-key";
    const status = await readWorldclawPlanningAvailability();
    assert.equal(status.mode, "committee");
    assert.equal(status.providers.find((provider) => provider.provider === "xai")?.configured, true);
    assert.equal(
      status.providers.find((provider) => provider.provider === "gemini")?.configured,
      false,
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("parses quoted WorldClaw keys and ignores unrelated secrets", () => {
  const parsed = parseWorldclawEnvFile(`
# comment
XAI_API_KEY="xai-live-key"
GEMINI_API_KEY=gemini-live
GROQ_API_KEY=must-not-load
XAI_TEXT_MODEL='grok-4.6'
EMPTY_VALUE=
NOT_A_KEY
`);
  assert.deepEqual(parsed, {
    XAI_API_KEY: "xai-live-key",
    GEMINI_API_KEY: "gemini-live",
    XAI_TEXT_MODEL: "grok-4.6",
  });
});

test("does not overwrite env values already present in the process", () => {
  const env = { XAI_API_KEY: "already-set", GEMINI_API_KEY: "" };
  const applied = applyWorldclawEnvValues(
    { XAI_API_KEY: "from-file", GEMINI_API_KEY: "gemini-from-file" },
    env,
  );
  assert.deepEqual(applied, ["GEMINI_API_KEY"]);
  assert.equal(env.XAI_API_KEY, "already-set");
  assert.equal(env.GEMINI_API_KEY, "gemini-from-file");
});

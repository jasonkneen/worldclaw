import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerRendererReadiness,
  waitForRendererReadiness,
  WORLDCLAW_RENDERER_READY_TIMEOUT_MS,
} from "../src/components/worldclaw/renderer-readiness.ts";

test("renderer readiness uses the bounded 90-second QA window", () => {
  assert.equal(WORLDCLAW_RENDERER_READY_TIMEOUT_MS, 90_000);
});

test("renderer readiness accepts a slow compiled batch within the bounded window", async () => {
  const target = {};
  const controller = new AbortController();
  let resolveCompiled;
  const compiled = new Promise((resolve) => {
    resolveCompiled = resolve;
  });

  const waiting = waitForRendererReadiness(target, "world-slow", controller.signal, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  registerRendererReadiness(target, { worldId: "world-slow", ready: compiled });
  await new Promise((resolve) => setTimeout(resolve, 20));
  resolveCompiled();

  await waiting;
});

test("renderer readiness fails closed after its deadline", async () => {
  const target = {};
  registerRendererReadiness(target, {
    worldId: "world-never-ready",
    ready: new Promise(() => undefined),
  });
  await assert.rejects(
    waitForRendererReadiness(target, "world-never-ready", new AbortController().signal, 25),
    /timed out before compiled GLB batches were ready/i,
  );
});

test("renderer readiness cleanup cannot delete a replacement world signal", () => {
  const target = {};
  const cleanupOld = registerRendererReadiness(target, {
    worldId: "world-old",
    ready: Promise.resolve(),
  });
  const replacement = { worldId: "world-new", ready: Promise.resolve() };
  registerRendererReadiness(target, replacement);

  cleanupOld();

  assert.strictEqual(target.__WORLDCLAW_RENDERER_READINESS__, replacement);
});

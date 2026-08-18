import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  PAPER_CHILD_PROCESS_TIMEOUT_MAX_MS,
  createBoundedChildOrchestrator,
} from "./worldclaw-paper-process.mjs";

function mockedChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  return child;
}

test("bounded child orchestration returns exits and cleans watchdogs on child errors", async () => {
  const success = mockedChild();
  const failed = mockedChild(1235);
  const children = [success, failed];
  const cancelled = [];
  const terminated = [];
  const orchestrator = createBoundedChildOrchestrator({
    spawnChild: () => children.shift(),
    terminateChild: (child) => terminated.push(child.pid),
    scheduleTimeout: () => ({ timer: true }),
    cancelTimeout: (timer) => cancelled.push(timer),
  });

  const successRun = orchestrator.run({ label: "success", command: "node", timeoutMs: 1_000 });
  success.exitCode = 0;
  success.emit("exit", 0, null);
  assert.equal(await successRun, 0);

  const failedRun = orchestrator.run({ label: "failure", command: "node", timeoutMs: 1_000 });
  failed.emit("error", new Error("mocked spawn error"));
  await assert.rejects(failedRun, /mocked spawn error/);
  assert.deepEqual(terminated, [1235]);
  assert.equal(cancelled.length, 2);
  assert.equal(orchestrator.activeChild, null);
});

test("bounded child orchestration terminates and reports watchdog expiry", async () => {
  const child = mockedChild();
  let watchdog;
  let cancelled = false;
  const orchestrator = createBoundedChildOrchestrator({
    spawnChild: () => child,
    terminateChild: (target) => {
      target.exitCode = null;
      target.emit("exit", null, "SIGTERM");
    },
    scheduleTimeout: (callback) => {
      watchdog = callback;
      return "watchdog";
    },
    cancelTimeout: (timer) => {
      assert.equal(timer, "watchdog");
      cancelled = true;
    },
  });
  const run = orchestrator.run({ label: "slow child", command: "node", timeoutMs: 1_000 });
  watchdog();
  await assert.rejects(run, /slow child exceeded 1000ms/);
  assert.equal(cancelled, true);
  assert.equal(orchestrator.activeChild, null);
});

test("bounded child orchestration accepts the derived case path but rejects unbounded deadlines", async () => {
  assert.equal(PAPER_CHILD_PROCESS_TIMEOUT_MAX_MS, 3_000_000);
  const child = mockedChild();
  const orchestrator = createBoundedChildOrchestrator({
    spawnChild: () => child,
    terminateChild: () => {},
    scheduleTimeout: (_callback, timeoutMs) => {
      assert.equal(timeoutMs, 2_700_000);
      return "watchdog";
    },
    cancelTimeout: () => {},
  });
  const bounded = orchestrator.run({
    label: "derived generation case",
    command: "node",
    timeoutMs: 2_700_000,
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.equal(await bounded, 0);
  await assert.rejects(
    orchestrator.run({
      label: "unbounded generation case",
      command: "node",
      timeoutMs: PAPER_CHILD_PROCESS_TIMEOUT_MAX_MS + 1,
    }),
    /timeout is out of bounds/,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} terminates the active child and permanently prevents later spawns`, async () => {
    const child = mockedChild();
    let spawnCount = 0;
    const orchestrator = createBoundedChildOrchestrator({
      spawnChild: () => {
        spawnCount++;
        return child;
      },
      terminateChild: (target) => {
        target.emit("exit", null, "SIGTERM");
      },
      scheduleTimeout: () => "watchdog",
      cancelTimeout: () => {},
    });
    const activeRun = orchestrator.run({
      label: "paid generation",
      command: "node",
      timeoutMs: 1_000,
    });
    orchestrator.interrupt(signal);
    await assert.rejects(activeRun, new RegExp(`paid generation interrupted by ${signal}`));
    await assert.rejects(
      orchestrator.run({ label: "next paid case", command: "node", timeoutMs: 1_000 }),
      new RegExp(`refusing to spawn next paid case after ${signal}`),
    );
    assert.equal(spawnCount, 1);
    assert.equal(orchestrator.interruptedSignal, signal);
  });
}

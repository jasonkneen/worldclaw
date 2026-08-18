import assert from "node:assert/strict";

export const PAPER_CHILD_PROCESS_TIMEOUT_MAX_MS = 3_000_000;

export function createBoundedChildOrchestrator({
  spawnChild,
  terminateChild,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
}) {
  assert.equal(typeof spawnChild, "function", "Child orchestrator requires a spawn adapter");
  assert.equal(
    typeof terminateChild,
    "function",
    "Child orchestrator requires a termination adapter",
  );
  let activeChild = null;
  let interruptedSignal = null;

  function interrupt(signal) {
    assert.ok(["SIGINT", "SIGTERM"].includes(signal), `Unsupported interrupt signal ${signal}`);
    interruptedSignal ??= signal;
    if (activeChild) terminateChild(activeChild);
  }

  async function run({ label, command, args = [], options = {}, timeoutMs }) {
    assert.ok(
      Number.isInteger(timeoutMs) &&
        timeoutMs >= 1_000 &&
        timeoutMs <= PAPER_CHILD_PROCESS_TIMEOUT_MAX_MS,
      `${label} timeout is out of bounds`,
    );
    assert.equal(typeof command, "string", `${label} command must be text`);
    assert.ok(command.length > 0, `${label} command must not be empty`);
    if (interruptedSignal) {
      throw new Error(`refusing to spawn ${label} after ${interruptedSignal}`);
    }

    const child = spawnChild(command, args, options);
    assert.ok(child && typeof child.once === "function", `${label} spawn returned no child`);
    activeChild = child;
    let timedOut = false;
    const watchdog = scheduleTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);
    let outcome;
    try {
      outcome = await new Promise((resolveExit, reject) => {
        const onError = (error) => {
          child.off?.("exit", onExit);
          reject(error);
        };
        const onExit = (code, signal) => {
          child.off?.("error", onError);
          resolveExit({ code: code ?? (signal ? 128 : 1), signal });
        };
        child.once("error", onError);
        child.once("exit", onExit);
      });
    } catch (error) {
      if (!timedOut && !interruptedSignal && child.exitCode === null) terminateChild(child);
      if (interruptedSignal) {
        throw new Error(`${label} interrupted by ${interruptedSignal}`, { cause: error });
      }
      if (timedOut) throw new Error(`${label} exceeded ${timeoutMs}ms and was terminated`);
      throw error;
    } finally {
      cancelTimeout(watchdog);
      if (activeChild === child) activeChild = null;
    }
    if (timedOut) throw new Error(`${label} exceeded ${timeoutMs}ms and was terminated`);
    if (interruptedSignal) throw new Error(`${label} interrupted by ${interruptedSignal}`);
    return outcome.code;
  }

  return {
    run,
    interrupt,
    get activeChild() {
      return activeChild;
    },
    get interruptedSignal() {
      return interruptedSignal;
    },
  };
}

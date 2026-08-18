import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const errors = [];
let page;

try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // Hold the first TanStack server-function fetch until its AbortSignal fires.
  // Later calls use the real network so this also verifies that retry recovers.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__WORLDCLAW_CANCEL_QA__ = {
      intercepted: 0,
      aborted: false,
      abortLatencyMs: null,
      abortAt: null,
      cancelClickAt: null,
      uiIdleAt: null,
      hasSignal: false,
      release: null,
    };
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      const signal = init?.signal ??
        (input instanceof Request ? input.signal : undefined);
      const probe = window.__WORLDCLAW_CANCEL_QA__;
      if (
        probe.intercepted === 0 &&
        request.method === "POST" &&
        request.url.includes("/_serverFn/")
      ) {
        probe.intercepted = 1;
        probe.hasSignal = Boolean(signal);
        const startedAt = performance.now();
        return new Promise((_, reject) => {
          let settled = false;
          const fail = (message) => {
            if (settled) return;
            settled = true;
            reject(new DOMException(message, "AbortError"));
          };
          const abort = () => {
            probe.aborted = true;
            probe.abortAt = performance.now();
            probe.abortLatencyMs = performance.now() - startedAt;
            fail("World generation cancelled");
          };
          probe.release = () => fail("Cancellation QA cleanup");
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return nativeFetch(input, init);
    };
  });

  const response = await page.goto("http://127.0.0.1:8080/", {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  assert.ok(response?.ok(), `Initial navigation failed: ${response?.status()}`);

  const generate = page.getByRole("button", { name: /Generate world/i });
  await generate.click();
  await page.waitForFunction(
    () => window.__WORLDCLAW_CANCEL_QA__?.intercepted === 1,
    undefined,
    { timeout: 5_000 },
  );

  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await cancel.waitFor({ state: "visible", timeout: 5_000 });
  await page.evaluate(() => {
    const probe = window.__WORLDCLAW_CANCEL_QA__;
    const cancelButton = document.querySelector('button[aria-label="Cancel"]');
    if (!(cancelButton instanceof HTMLButtonElement)) {
      throw new Error("Cancel button is unavailable");
    }
    const markIdle = () => {
      const generateButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Generate world"),
      );
      if (
        !document.querySelector('button[aria-label="Cancel"]') &&
        generateButton instanceof HTMLButtonElement &&
        !generateButton.disabled
      ) {
        probe.uiIdleAt ??= performance.now();
        return true;
      }
      return false;
    };
    const observer = new MutationObserver(() => {
      if (markIdle()) observer.disconnect();
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    probe.cancelClickAt = performance.now();
    cancelButton.click();
    markIdle();
  });
  await page
    .waitForFunction(
      () => window.__WORLDCLAW_CANCEL_QA__?.aborted === true,
      undefined,
      { timeout: 500 },
    )
    .catch(() => {});
  const cancelledProbe = await page.evaluate(
    () => window.__WORLDCLAW_CANCEL_QA__,
  );
  assert.equal(
    cancelledProbe.hasSignal,
    true,
    "Server-function fetch had no AbortSignal",
  );
  assert.equal(
    cancelledProbe.aborted,
    true,
    `Server-function request did not abort: ${JSON.stringify(cancelledProbe)}`,
  );
  await generate.waitFor({ state: "visible", timeout: 500 });
  assert.equal(await generate.isEnabled(), true, "Generate did not return to idle");
  await page.waitForFunction(
    () => window.__WORLDCLAW_CANCEL_QA__?.uiIdleAt !== null,
    undefined,
    { timeout: 2_000 },
  );
  const settledProbe = await page.evaluate(() => window.__WORLDCLAW_CANCEL_QA__);
  const requestCancelLatencyMs =
    settledProbe.abortAt - settledProbe.cancelClickAt;
  const uiCancelLatencyMs = settledProbe.uiIdleAt - settledProbe.cancelClickAt;
  assert.ok(
    requestCancelLatencyMs >= 0 && requestCancelLatencyMs < 500,
    `Request abort took ${requestCancelLatencyMs}ms after the Cancel event`,
  );
  assert.ok(
    uiCancelLatencyMs >= 0 && uiCancelLatencyMs < 500,
    `UI idle took ${uiCancelLatencyMs}ms after the Cancel event`,
  );

  await page.waitForTimeout(600);
  assert.equal(
    (await page.locator("body").innerText()).includes("World ready"),
    false,
    "A cancelled request committed a late world",
  );

  await generate.click();
  await page.waitForFunction(
    () => document.body.innerText.includes("World ready"),
    undefined,
    { timeout: 420_000 },
  );
  const retryBody = await page.locator("body").innerText();
  assert.match(
    retryBody,
    /(grok-4\.5|gemini-3\.6-flash) plan/,
    "Retry did not disclose a real current planning model",
  );
  assert.match(
    retryBody,
    /(grok-imagine-image-quality|gemini-3\.1-flash-image) terrain/,
    "Retry did not disclose a real current image model",
  );
  const probe = await page.evaluate(() => window.__WORLDCLAW_CANCEL_QA__);
  assert.equal(probe.intercepted, 1);
  assert.equal(probe.hasSignal, true, "Server-function fetch had no AbortSignal");
  assert.equal(probe.aborted, true);
  assert.deepEqual(errors, [], `Browser errors:\n${errors.join("\n")}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        uiCancelLatencyMs,
        requestCancelLatencyMs,
        requestAbortObserved: probe.aborted,
        retryReady: true,
      },
      null,
      2,
    ),
  );
} finally {
  await page
    ?.evaluate(() => window.__WORLDCLAW_CANCEL_QA__?.release?.())
    .catch(() => {});
  await browser.close();
}

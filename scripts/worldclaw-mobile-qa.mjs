import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotsDir = join(workspaceRoot, "screenshots");
await mkdir(screenshotsDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const response = await page.goto("http://127.0.0.1:8080/", {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  assert.ok(response?.ok(), `Initial navigation failed: ${response?.status()}`);
  await page.screenshot({ path: join(screenshotsDir, "worldclaw-mobile-start.png") });

  const launcher = page.getByRole("button", { name: /WorldClaw/i }).first();
  assert.equal(await launcher.count(), 1, "Missing collapsed mobile launcher");
  await launcher.click();

  const generate = page.getByRole("button", { name: /Generate world/i });
  assert.equal(await generate.count(), 1, "Missing mobile Generate world control");
  await generate.click();
  const generationDeadline = Date.now() + 600_000;
  while (Date.now() < generationDeadline) {
    const alert = page.getByRole("alert");
    if ((await alert.count()) > 0 && (await alert.first().isVisible())) {
      throw new Error(`Mobile generation failed: ${await alert.first().innerText()}`);
    }
    if ((await page.locator("body").innerText()).includes("World ready")) break;
    await page.waitForTimeout(500);
  }
  assert.match(await page.locator("body").innerText(), /World ready/);

  const finalValidation = page.getByTestId("final-render-validation");
  await finalValidation.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const status = document
        .querySelector('[data-testid="final-render-validation"]')
        ?.getAttribute("data-status");
      return status && !["pending", "running"].includes(status);
    },
    undefined,
    { timeout: 180_000 },
  );
  assert.equal(
    await finalValidation.getAttribute("data-status"),
    "passed",
    `Mobile final renderer gate failed: ${await finalValidation.innerText()}`,
  );

  for (const mode of ["Instance", "Depth", "Normal", "Lit", "Walk"]) {
    const button = page.getByRole("button", { name: mode, exact: true });
    assert.equal(await button.count(), 1, `Missing mobile ${mode} control`);
    await button.click();
  }

  const collapse = page.getByRole("button", { name: /Collapse panel/i });
  assert.equal(await collapse.count(), 1, "Missing Collapse panel control");
  await collapse.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screenshotsDir, "worldclaw-mobile-world.png") });

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    canvas: document.querySelector("canvas")?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(dimensions.scroll, dimensions.viewport, "Mobile layout overflows horizontally");
  assert.ok(dimensions.canvas?.width >= 390 && dimensions.canvas?.height >= 700);
  assert.deepEqual(errors, [], `Mobile browser errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify({ ok: true, dimensions }, null, 2));
} finally {
  await browser.close();
}

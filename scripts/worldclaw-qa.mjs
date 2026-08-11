import { chromium } from "playwright";
import { mkdir } from "fs/promises";

await mkdir("/workspace/screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(1500);

const gen = page.getByRole("button", { name: /Generate world/i });
await gen.click();
console.log("clicked generate");

// Wait for pipeline completion
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500);
  const t = await page.locator("body").innerText();
  if (t.includes("World ready") || t.includes("seed 0x")) {
    console.log("done at", i * 500, "ms");
    break;
  }
}

const body = await page.locator("body").innerText();
console.log("has World ready:", body.includes("World ready"));
console.log("has seed:", /seed 0x/.test(body));
console.log("snippet:", body.slice(0, 800));

await page.screenshot({ path: "/workspace/screenshots/worldclaw-generated.png" });

for (const mode of ["Instance", "Depth", "Normal", "Lit"]) {
  const btn = page.getByRole("button", { name: mode, exact: true });
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/workspace/screenshots/worldclaw-${mode.toLowerCase()}.png` });
  }
}

const walk = page.getByRole("button", { name: "Walk", exact: true });
if (await walk.count()) {
  await walk.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/workspace/screenshots/worldclaw-walk.png" });
}

// Generate desert scene
const desert = page.getByRole("button", { name: "Desert battlefield", exact: true });
if (await desert.count()) {
  await desert.click();
  await page.waitForTimeout(200);
  await gen.click();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const t = await page.locator("body").innerText();
    if (t.includes("World ready") && t.includes("desert")) break;
  }
  await page.screenshot({ path: "/workspace/screenshots/worldclaw-desert.png" });
}

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: "/workspace/screenshots/worldclaw-mobile.png" });

console.log("errors:", JSON.stringify(errors, null, 2));
await browser.close();

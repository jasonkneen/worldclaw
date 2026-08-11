import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: "/workspace/screenshots/worldclaw-mobile-start.png" });
// open panel, generate
await page.getByRole("button", { name: /WorldClaw/i }).first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /Generate world/i }).click();
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(400);
  const t = await page.locator("body").innerText();
  if (t.includes("World ready")) break;
}
// collapse to see world
await page.getByRole("button", { name: /Collapse panel/i }).click().catch(()=>{});
await page.waitForTimeout(500);
await page.screenshot({ path: "/workspace/screenshots/worldclaw-mobile-world.png" });
console.log("errors", errors);
await browser.close();

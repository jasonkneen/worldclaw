import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_CARD_BYTES, computeBrandWarnings } from "./brand-check.mjs";

const PLACEHOLDER_ROOT = `
const ogImage = host
  ? \`https://og.grok.me/v1/card.png?host=\${encodeURIComponent(host)}\`
  : undefined;
`;

const CUSTOM_ROOT = "const ogImage = host ? `https://${host}/og.jpg` : undefined;";

function makeWorkspace({ rootTsx, cardFile, cardBytes = 200 * 1024 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brand-check-"));
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(join(root, "src/routes"), { recursive: true });
  if (rootTsx !== undefined) {
    writeFileSync(join(root, "src/routes/__root.tsx"), rootTsx);
  }
  if (cardFile !== undefined) {
    writeFileSync(join(root, "public", cardFile), Buffer.alloc(cardBytes, 7));
  }
  return root;
}

test("non-canvas app with placeholder gets a soft BRAND NOTE (utility exception)", () => {
  const root = makeWorkspace({ rootTsx: PLACEHOLDER_ROOT });
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^BRAND NOTE:/);
  assert.match(warnings[0], /plain utilit/);
  assert.doesNotMatch(warnings[0], /^BRAND WARNING:/);
});

test("non-canvas app with a compliant card is silent", () => {
  const root = makeWorkspace({ rootTsx: CUSTOM_ROOT, cardFile: "og.jpg" });
  assert.deepEqual(computeBrandWarnings({ hasCanvas: false, workspaceRoot: root }), []);
});

test("non-canvas app with no og:image at all is silent", () => {
  // No head og wiring (e.g. mid-scaffold): nothing to judge yet.
  const root = makeWorkspace({ rootTsx: "export const Route = createRootRoute({});" });
  assert.deepEqual(computeBrandWarnings({ hasCanvas: false, workspaceRoot: root }), []);
});

test("oversized card warns for non-canvas apps too", () => {
  const root = makeWorkspace({
    rootTsx: CUSTOM_ROOT,
    cardFile: "og.jpg",
    cardBytes: MAX_CARD_BYTES + 1,
  });
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /over 600 KB/);
});

test("canvas app with no card warns 'missing'", () => {
  const root = makeWorkspace({ rootTsx: PLACEHOLDER_ROOT });
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /og\.jpg.*is missing/s);
  assert.match(warnings[0], /not done/);
});

test("card present but placeholder still wired warns 'wire og:image'", () => {
  const root = makeWorkspace({ rootTsx: PLACEHOLDER_ROOT, cardFile: "og.jpg" });
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /still points og:image/);
});

test("oversized card warns on the scraper budget (jpg and legacy png)", () => {
  for (const cardFile of ["og.jpg", "og.png"]) {
    const root = makeWorkspace({
      rootTsx: CUSTOM_ROOT,
      cardFile,
      cardBytes: MAX_CARD_BYTES + 1,
    });
    const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
    assert.equal(warnings.length, 1, cardFile);
    assert.match(warnings[0], /over 600 KB/);
  }
});

test("compliant jpg card under budget is silent", () => {
  const root = makeWorkspace({ rootTsx: CUSTOM_ROOT, cardFile: "og.jpg" });
  assert.deepEqual(computeBrandWarnings({ hasCanvas: true, workspaceRoot: root }), []);
});

test("legacy png under budget with custom wiring is accepted", () => {
  const root = makeWorkspace({
    rootTsx: "const ogImage = host ? `https://${host}/og.png` : undefined;",
    cardFile: "og.png",
  });
  assert.deepEqual(computeBrandWarnings({ hasCanvas: true, workspaceRoot: root }), []);
});

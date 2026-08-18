import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  discoverPrototypes,
  parseCatalogue,
  repoRoot,
} from "./lib.mjs";
import {
  mergeVibeAssetLibrary,
  parseVibeAssetLibrary,
  parseWorldClawAssetManifest,
  resolveBrowserAsset,
} from "../../src/lib/worldclaw/assets.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

test("catalogue parser accepts a kebab-case WorldClaw prototype", () => {
  const catalogue = parseCatalogue(
    JSON.parse(readFileSync(join(fixtureRoot, "unit-box/catalogue.json"), "utf8")),
  );
  assert.equal(catalogue.id, "unit-box");
  assert.equal(catalogue.prototype, "crate");
  assert.equal(catalogue.node, "ASSET_crate");
  assert.equal(catalogue.status, "accepted");
});

test("discoverPrototypes finds the unit-box fixture", () => {
  const entries = discoverPrototypes(fixtureRoot);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.catalogue.id, "unit-box");
});

test("empty vibe compile still writes a sidecar library", () => {
  const root = mkdtempSync(join(tmpdir(), "worldclaw-vibe-src-"));
  const outDir = mkdtempSync(join(tmpdir(), "worldclaw-vibe-empty-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/register-ts-extension-loader.mjs",
        "scripts/vibe-model/compile.mjs",
        "--root",
        root,
        "--out",
        outDir,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const library = JSON.parse(readFileSync(join(outDir, "library.json"), "utf8"));
    assert.equal(library.source, "vibe_model");
    assert.deepEqual(library.prototypes, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("vibe compile exports an accepted fixture GLB overlay", () => {
  const outDir = mkdtempSync(join(tmpdir(), "worldclaw-vibe-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/register-ts-extension-loader.mjs",
        "scripts/vibe-model/compile.mjs",
        "--root",
        fixtureRoot,
        "--out",
        outDir,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /WORLDCLAW_VIBE_COMPILE_OK/);
    const library = JSON.parse(readFileSync(join(outDir, "library.json"), "utf8"));
    assert.equal(library.prototypes.crate.source, "vibe_model");
    assert.equal(library.prototypes.crate.libraryUri, "/worldclaw/assets/vibe/unit-box.glb");
    const glb = readFileSync(join(outDir, "unit-box.glb"));
    assert.ok(glb.byteLength > 100);
    assert.equal(glb.subarray(0, 4).toString(), "glTF");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("vibe preview captures a PNG of the unit-box fixture", { timeout: 60_000 }, () => {
  const outDir = mkdtempSync(join(tmpdir(), "worldclaw-vibe-preview-"));
  try {
    const output = join(outDir, "unit-box.png");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/vibe-model/preview.mjs",
        "--module",
        "scripts/vibe-model/fixtures/unit-box/model.ts",
        "--asset",
        "unit-box",
        "--output",
        output,
        "--width",
        "256",
        "--height",
        "256",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const png = readFileSync(output);
    assert.ok(png.byteLength > 100);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("committed vibe sidecar is a valid empty overlay", () => {
  const library = parseVibeAssetLibrary(
    JSON.parse(readFileSync(new URL("../../public/worldclaw/assets/vibe/library.json", import.meta.url), "utf8")),
  );
  assert.deepEqual(library, {});
});

test("runtime overlay replaces a blender prototype URI with the vibe GLB", () => {
  const blender = parseWorldClawAssetManifest(
    JSON.parse(
      readFileSync(new URL("../../assets/worldclaw/asset-library.json", import.meta.url), "utf8"),
    ),
  );
  const vibe = parseVibeAssetLibrary({
    version: 1,
    prototypes: {
      crate: {
        node: "ASSET_crate",
        generator: "crate",
        targetHeightMeters: 0.7,
        source: "vibe_model",
        libraryUri: "/worldclaw/assets/vibe/unit-box.glb",
        collider: {
          type: "box",
          centerMeters: [0, 0.35, 0],
          sizeMeters: [0.7, 0.7, 0.7],
        },
        defaultVariant: "unit-box",
        variants: [
          {
            id: "unit-box",
            node: "ASSET_crate",
            status: "authored",
            appearanceTerms: ["crate"],
            materialIds: ["timber_warm"],
          },
        ],
      },
    },
  });
  const merged = mergeVibeAssetLibrary(blender, vibe);
  assert.equal(merged.prototypes.crate?.source, "vibe_model");
  const asset = resolveBrowserAsset("crate", merged, "supply crate");
  assert.equal(asset?.uri, "/worldclaw/assets/vibe/unit-box.glb");
  assert.equal(asset?.source, "vibe_model");
  assert.equal(merged.prototypes.palm?.source, "blender_procedural");
});

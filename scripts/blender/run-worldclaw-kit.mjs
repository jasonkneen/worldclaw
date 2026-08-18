#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const builder = join(repoRoot, "scripts/blender/build-worldclaw-kit.py");
const renderer = join(repoRoot, "scripts/blender/render-worldclaw-dossiers.py");
const validator = join(repoRoot, "scripts/blender/validate-worldclaw-kit.mjs");
const dossierComparator = join(repoRoot, "scripts/blender/compare-worldclaw-dossiers.mjs");
const publishSeamValidator = join(repoRoot, "scripts/blender/validate-worldclaw-publish-seam.mjs");
const sourceManifest = join(repoRoot, "assets/worldclaw/asset-library.json");
const publicDir = join(repoRoot, "public/worldclaw/assets");
const defaultOutput = join(publicDir, "worldclaw-kit.glb");
const defaultReport = join(publicDir, "worldclaw-kit.report.json");
const defaultPublicManifest = join(publicDir, "asset-library.json");

function isStagedArtifactPath(value) {
  return isAbsolute(value) && [resolve(tmpdir()), "/tmp"].some((root) => value.startsWith(root + "/"));
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a path`);
  return resolve(value);
}

function locateBlender() {
  const candidates = [
    process.env.BLENDER_BIN,
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/opt/homebrew/bin/blender",
    "/usr/local/bin/blender",
    "/usr/bin/blender",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const probe = spawnSync("blender", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "blender";
  throw new Error(
    "Blender was not found. Set BLENDER_BIN to a Blender 5.x executable.",
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PYTHONHASHSEED: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function build(blender, output, report, publicManifest, detailedOutput = null) {
  run(blender, [
    "--background",
    "--factory-startup",
    "--disable-autoexec",
    "--python",
    builder,
    "--",
    "--manifest",
    sourceManifest,
    "--output",
    output,
    "--report",
    report,
    "--public-manifest",
    publicManifest,
    ...(detailedOutput ? ["--detailed-output", detailedOutput] : []),
  ]);
}

function renderEvidence(blender, glb, report) {
  run(blender, [
    "--background",
    "--factory-startup",
    "--disable-autoexec",
    "--python",
    renderer,
    "--",
    "--glb",
    glb,
    "--manifest",
    sourceManifest,
    "--output-dir",
    join(publicDir, "dossiers"),
    "--report",
    report,
  ]);
}

function validate(glb, report, publicManifest, writeReport = false, skipEvidence = false) {
  run(process.execPath, [
    validator,
    "--manifest",
    sourceManifest,
    "--public-manifest",
    publicManifest,
    "--glb",
    glb,
    "--report",
    report,
    ...(writeReport ? ["--write-report"] : []),
    ...(skipEvidence ? ["--skip-evidence"] : []),
  ]);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const blender = locateBlender();
const stageDir = optionValue("--stage-dir");
if (stageDir) {
  if (!isStagedArtifactPath(stageDir)) {
    throw new Error(`--stage-dir must be outside the workspace under ${resolve(tmpdir())} or /tmp; got ${stageDir}`);
  }
  mkdirSync(stageDir, { recursive: true });
  const output = join(stageDir, "worldclaw-kit.glb");
  const report = join(stageDir, "worldclaw-kit.report.json");
  const publicManifest = join(stageDir, "asset-library.json");
  const evidenceDir = join(stageDir, "dossiers");
  const detailedOutput = process.argv.includes("--retain-detailed")
    ? join(stageDir, "worldclaw-kit.detailed.glb")
    : null;
  build(blender, output, report, publicManifest, detailedOutput);
  run(blender, [
    "--background", "--factory-startup", "--disable-autoexec", "--python", renderer, "--",
    "--glb", output, "--manifest", sourceManifest, "--output-dir", evidenceDir, "--report", report,
  ]);
  run(process.execPath, [
    validator, "--manifest", sourceManifest, "--public-manifest", publicManifest,
    "--glb", output, "--report", report, "--evidence-dir", evidenceDir, "--write-report",
  ]);
  console.log(`WORLDCLAW_ASSET_STAGE_OK dir=${stageDir} sha256=${sha256(output)}`);
  process.exit(0);
}
if (process.argv.includes("--publish-from")) {
  const source = optionValue("--publish-from");
  if (!source) throw new Error("--publish-from requires a staged directory");
  if (!isStagedArtifactPath(source)) {
    throw new Error(`--publish-from must read a staged directory under ${resolve(tmpdir())} or /tmp; got ${source}`);
  }
  const stagedDossiers = join(source, "dossiers");
  if (!existsSync(stagedDossiers)) throw new Error(`Staged dossiers are missing: ${stagedDossiers}`);
  for (const name of ["worldclaw-kit.glb", "worldclaw-kit.report.json", "asset-library.json"]) {
    if (!existsSync(join(source, name))) throw new Error(`Staged publish input is missing: ${join(source, name)}`);
  }

  // Fail before touching public if the staged contract, GLB, evidence, or
  // baseline visual equivalence is stale. The swap below is rename-only.
  run(process.execPath, [
    validator, "--manifest", sourceManifest, "--public-manifest", join(source, "asset-library.json"),
    "--glb", join(source, "worldclaw-kit.glb"), "--report", join(source, "worldclaw-kit.report.json"),
    "--evidence-dir", stagedDossiers,
  ]);
  run(process.execPath, [
    dossierComparator, "--baseline-dir", join(publicDir, "dossiers"),
    "--candidate-dir", stagedDossiers,
  ]);
  run(process.execPath, [
    publishSeamValidator, "--source-manifest", sourceManifest,
    "--staged-manifest", join(source, "asset-library.json"),
    "--old-glb", defaultOutput, "--new-glb", join(source, "worldclaw-kit.glb"),
  ]);

  const transactionDir = mkdtempSync(join(publicDir, ".worldclaw-publish-"));
  const nextDir = join(transactionDir, "next");
  const previousDir = join(transactionDir, "previous");
  mkdirSync(nextDir);
  mkdirSync(previousDir);
  const artifactNames = ["worldclaw-kit.glb", "worldclaw-kit.report.json", "asset-library.json"];
  for (const name of artifactNames) cpSync(join(source, name), join(nextDir, name));
  cpSync(stagedDossiers, join(nextDir, "dossiers"), { recursive: true });

  const swapped = [];
  try {
    // The manifest is unchanged byte-for-byte and both old/new GLBs expose the
    // same 34 ASSET roots. Rename the GLB first, then its report/evidence; the
    // browser contract therefore remains compatible throughout the short swap.
    for (const name of ["worldclaw-kit.glb", "worldclaw-kit.report.json", "dossiers", "asset-library.json"]) {
      const live = join(publicDir, name);
      if (existsSync(live)) renameSync(live, join(previousDir, name));
      renameSync(join(nextDir, name), live);
      swapped.push(name);
    }
    validate(defaultOutput, defaultReport, defaultPublicManifest, false);
  } catch (error) {
    for (const name of [...swapped].reverse()) {
      const live = join(publicDir, name);
      if (existsSync(live)) renameSync(live, join(nextDir, name));
      const previous = join(previousDir, name);
      if (existsSync(previous)) renameSync(previous, live);
    }
    throw error;
  } finally {
    rmSync(transactionDir, { recursive: true, force: true });
  }
  console.log(`WORLDCLAW_ASSET_PUBLISH_OK sha256=${sha256(defaultOutput)}`);
  process.exit(0);
}
if (!process.argv.includes("--repro")) {
  build(blender, defaultOutput, defaultReport, defaultPublicManifest);
  renderEvidence(blender, defaultOutput, defaultReport);
  validate(defaultOutput, defaultReport, defaultPublicManifest, true);
  console.log(`WORLDCLAW_ASSET_BUILD_OK sha256=${sha256(defaultOutput)}`);
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "worldclaw-blender-repro-"));
try {
  const outputs = ["first", "second"].map((name) => ({
    glb: join(tempRoot, `${name}.glb`),
    report: join(tempRoot, `${name}.report.json`),
    manifest: join(tempRoot, `${name}.manifest.json`),
  }));
  for (const output of outputs) {
    build(blender, output.glb, output.report, output.manifest);
    validate(output.glb, output.report, output.manifest, false, true);
  }
  const hashes = outputs.map((output) => sha256(output.glb));
  if (hashes[0] !== hashes[1]) {
    throw new Error(`Blender reproducibility mismatch: ${hashes.join(" != ")}`);
  }
  console.log(`WORLDCLAW_ASSET_REPRO_OK sha256=${hashes[0]}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

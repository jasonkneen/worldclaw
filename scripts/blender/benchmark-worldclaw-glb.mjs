#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);

if (!globalThis.ProgressEvent) globalThis.ProgressEvent = class ProgressEvent {};

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function projectPath(value) {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function geometryMergeSignature(geometry) {
  const attributes = Object.entries(geometry.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, attribute]) => {
      const gpuType = "gpuType" in attribute ? attribute.gpuType : "float";
      return `${name}:${attribute.itemSize}:${attribute.normalized}:${gpuType}`;
    })
    .join("|");
  return [
    geometry.index ? "indexed" : "plain",
    geometry.morphTargetsRelative ? "relative" : "absolute",
    Object.keys(geometry.morphAttributes).sort().join(","),
    attributes,
  ].join(";");
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

async function parseGltf(path) {
  const bytes = readFileSync(path);
  return await new Promise((resolveLoad, rejectLoad) => {
    new GLTFLoader().parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
      resolveLoad,
      rejectLoad,
    );
  });
}

function compileRuntimeBatches(gltf) {
  const roots = [];
  gltf.scene.traverse((object) => {
    if (object.name.startsWith("ASSET_")) roots.push(object);
  });
  roots.sort((left, right) => left.name.localeCompare(right.name));
  const missingRoots = [];
  const definitions = [];
  let sourceMeshes = 0;
  let fallbackGeometries = 0;
  let mergedSourceGeometries = 0;
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    const rootInverse = root.matrixWorld.clone().invert();
    const candidates = new Map();
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      sourceMeshes += 1;
      child.updateWorldMatrix(true, false);
      if (Array.isArray(child.material)) {
        definitions.push({ geometry: child.geometry, owned: false });
        return;
      }
      const geometry = child.geometry.clone();
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInverse, child.matrixWorld));
      const key = `${child.material.uuid}:${geometryMergeSignature(geometry)}`;
      const candidate = candidates.get(key) ?? { material: child.material, geometries: [] };
      candidate.geometries.push(geometry);
      candidates.set(key, candidate);
    });
    if (candidates.size === 0) missingRoots.push(root.name);
    for (const candidate of candidates.values()) {
      const merged = candidate.geometries.length === 1
        ? candidate.geometries[0]
        : mergeGeometries(candidate.geometries, false);
      if (merged) {
        if (candidate.geometries.length > 1) {
          mergedSourceGeometries += candidate.geometries.length;
          for (const geometry of candidate.geometries) geometry.dispose();
        }
        definitions.push({ geometry: merged, owned: true });
        continue;
      }
      fallbackGeometries += candidate.geometries.length;
      for (const geometry of candidate.geometries) definitions.push({ geometry, owned: true });
    }
  }
  for (const definition of definitions) if (definition.owned) definition.geometry.dispose();
  return {
    assetRoots: roots.length,
    sourceMeshes,
    batchDefinitions: definitions.length,
    mergedSourceGeometries,
    fallbackGeometries,
    missingRoots,
  };
}

async function worker() {
  const path = projectPath(option("--worker"));
  const start = performance.now();
  const gltf = await parseGltf(path);
  const parsed = performance.now();
  const runtime = compileRuntimeBatches(gltf);
  const batched = performance.now();
  process.stdout.write(JSON.stringify({
    path,
    parseMs: parsed - start,
    batchMs: batched - parsed,
    totalMs: batched - start,
    ...runtime,
  }));
}

function isolatedRun(path) {
  const result = spawnSync(process.execPath, [scriptPath, "--worker", path], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Benchmark worker failed for ${path}:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function summarize(path, runs) {
  const fixed = runs[0];
  for (const run of runs.slice(1)) {
    for (const key of ["assetRoots", "sourceMeshes", "batchDefinitions", "mergedSourceGeometries", "fallbackGeometries"]) {
      if (run[key] !== fixed[key]) throw new Error(`${path}: nondeterministic ${key} benchmark result`);
    }
    if (JSON.stringify(run.missingRoots) !== JSON.stringify(fixed.missingRoots)) {
      throw new Error(`${path}: nondeterministic missingRoots benchmark result`);
    }
  }
  return {
    path,
    iterations: runs.length,
    assetRoots: fixed.assetRoots,
    sourceMeshes: fixed.sourceMeshes,
    batchDefinitions: fixed.batchDefinitions,
    mergedSourceGeometries: fixed.mergedSourceGeometries,
    fallbackGeometries: fixed.fallbackGeometries,
    missingRoots: fixed.missingRoots,
    coldProcessMs: {
      parseP50: percentile(runs.map((run) => run.parseMs), 0.5),
      parseP90: percentile(runs.map((run) => run.parseMs), 0.9),
      batchP50: percentile(runs.map((run) => run.batchMs), 0.5),
      batchP90: percentile(runs.map((run) => run.batchMs), 0.9),
      totalP50: percentile(runs.map((run) => run.totalMs), 0.5),
      totalP90: percentile(runs.map((run) => run.totalMs), 0.9),
    },
    samples: runs.map(({ parseMs, batchMs, totalMs }) => ({ parseMs, batchMs, totalMs })),
  };
}

function controller() {
  const baseline = projectPath(option("--baseline", "public/worldclaw/assets/worldclaw-kit.glb"));
  const candidate = projectPath(option("--candidate", "/tmp/worldclaw-compact-stage/worldclaw-kit.glb"));
  const iterations = Number(option("--iterations", "7"));
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 25) {
    throw new Error("--iterations must be an integer from 3 through 25");
  }
  // Alternate independent Node processes to avoid favoring one artifact with
  // filesystem/cache ordering. Each worker parses and compiles exactly once.
  const baselineRuns = [];
  const candidateRuns = [];
  for (let index = 0; index < iterations; index += 1) {
    const order = index % 2 === 0
      ? [[baseline, baselineRuns], [candidate, candidateRuns]]
      : [[candidate, candidateRuns], [baseline, baselineRuns]];
    for (const [path, target] of order) target.push(isolatedRun(path));
  }
  const baselineSummary = summarize(baseline, baselineRuns);
  const candidateSummary = summarize(candidate, candidateRuns);
  const reduction = {
    sourceMeshes: 1 - candidateSummary.sourceMeshes / baselineSummary.sourceMeshes,
    batchMergeInputs: 1 - candidateSummary.mergedSourceGeometries / baselineSummary.mergedSourceGeometries,
    parseP50: 1 - candidateSummary.coldProcessMs.parseP50 / baselineSummary.coldProcessMs.parseP50,
    batchP50: 1 - candidateSummary.coldProcessMs.batchP50 / baselineSummary.coldProcessMs.batchP50,
    totalP50: 1 - candidateSummary.coldProcessMs.totalP50 / baselineSummary.coldProcessMs.totalP50,
  };
  const failures = [];
  if (candidateSummary.assetRoots !== 34) failures.push(`candidate has ${candidateSummary.assetRoots} roots; expected 34`);
  if (candidateSummary.missingRoots.length) failures.push(`candidate missing mesh roots: ${candidateSummary.missingRoots.join(", ")}`);
  if (candidateSummary.fallbackGeometries !== 0) failures.push(`candidate needed ${candidateSummary.fallbackGeometries} runtime merge fallbacks`);
  if (candidateSummary.sourceMeshes > 220) failures.push(`candidate has ${candidateSummary.sourceMeshes} runtime source meshes; expected <=220`);
  if (candidateSummary.batchDefinitions !== baselineSummary.batchDefinitions) {
    failures.push(`candidate exposes ${candidateSummary.batchDefinitions} batches; baseline exposes ${baselineSummary.batchDefinitions}`);
  }
  if (reduction.totalP50 < 0.25) failures.push(`candidate p50 parse+batch reduction is only ${(reduction.totalP50 * 100).toFixed(1)}%; expected >=25%`);
  const report = {
    version: 1,
    policy: "isolated_node_process_gltfloader_runtime_batch_compile_v1",
    methodology: {
      iterations,
      processIsolation: "fresh Node process per artifact sample",
      order: "alternating baseline and candidate",
      parse: "Three.js GLTFLoader.parse over an in-memory GLB buffer",
      batch: "CompiledAssetBatches-equivalent root-local clone/applyMatrix4/material+signature merge",
      scope: "cold CPU parse and batch preparation; excludes network transfer, WebGL upload, and shader compilation",
    },
    baseline: baselineSummary,
    candidate: candidateSummary,
    reduction,
    failures,
  };
  const reportPath = option("--report");
  if (reportPath) {
    const output = projectPath(reportPath);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failures.length) throw new Error(`WorldClaw cold benchmark failed:\n- ${failures.join("\n- ")}`);
  console.log(
    `WORLDCLAW_COLD_BENCHMARK_OK iterations=${iterations} ` +
    `meshes=${baselineSummary.sourceMeshes}->${candidateSummary.sourceMeshes} ` +
    `batchInputs=${baselineSummary.mergedSourceGeometries}->${candidateSummary.mergedSourceGeometries} ` +
    `parseP50=${baselineSummary.coldProcessMs.parseP50.toFixed(2)}ms->${candidateSummary.coldProcessMs.parseP50.toFixed(2)}ms ` +
    `batchP50=${baselineSummary.coldProcessMs.batchP50.toFixed(2)}ms->${candidateSummary.coldProcessMs.batchP50.toFixed(2)}ms ` +
    `totalReduction=${(reduction.totalP50 * 100).toFixed(1)}%`,
  );
}

if (process.argv.includes("--worker")) {
  await worker();
} else {
  await controller();
}

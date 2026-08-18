#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_CHUNK = 0x4e4f534a;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a path`);
  return value;
}

function projectPath(value) {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseGlb(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") throw new Error(`${path}: bad GLB magic or truncated header`);
  if (bytes.readUInt32LE(4) !== 2) throw new Error(`${path}: only GLB version 2 is supported`);
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error(`${path}: declared GLB length is stale`);
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || 20 + jsonLength > bytes.length) throw new Error(`${path}: missing or truncated JSON chunk`);
  return { bytes, json: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim()) };
}

function rootContract(gltf, manifest, label) {
  const names = new Map();
  for (const [index, node] of (gltf.nodes ?? []).entries()) {
    if (!node.name) continue;
    if (names.has(node.name)) throw new Error(`${label}: duplicate node name ${node.name}`);
    names.set(node.name, { index, node });
  }
  const expected = new Map();
  for (const [prototype, spec] of Object.entries(manifest.prototypes ?? {})) {
    expected.set(spec.node, prototype);
    for (const variant of spec.variants ?? []) expected.set(variant.node, prototype);
  }
  const roots = {};
  for (const [nodeName, prototype] of [...expected].sort(([left], [right]) => left.localeCompare(right))) {
    const entry = names.get(nodeName);
    if (!entry) throw new Error(`${label}: manifest node ${nodeName} is missing`);
    if (entry.node.mesh !== undefined) throw new Error(`${label}: ${nodeName} must remain a root, not a mesh node`);
    if (entry.node.extras?.assetKey !== prototype) throw new Error(`${label}: ${nodeName} extras.assetKey must remain ${prototype}`);
    if (entry.node.extras?.source !== "blender_procedural") throw new Error(`${label}: ${nodeName} source contract is missing`);
    let descendantMeshes = 0;
    const seen = new Set();
    function visit(index) {
      if (seen.has(index)) throw new Error(`${label}: cycle or shared node below ${nodeName}`);
      seen.add(index);
      const node = gltf.nodes?.[index];
      if (!node) throw new Error(`${label}: ${nodeName} references missing child ${index}`);
      if (node.mesh !== undefined) descendantMeshes += 1;
      for (const child of node.children ?? []) visit(child);
    }
    visit(entry.index);
    if (descendantMeshes === 0) throw new Error(`${label}: ${nodeName} has no renderable descendant mesh`);
    roots[nodeName] = { prototype, descendantMeshes };
  }
  const exportedAssetRoots = (gltf.nodes ?? []).filter((node) => node.name?.startsWith("ASSET_")).map((node) => node.name).sort();
  if (JSON.stringify(exportedAssetRoots) !== JSON.stringify(Object.keys(roots).sort())) {
    throw new Error(`${label}: exported ASSET roots differ from the manifest node union`);
  }
  return roots;
}

function main() {
  const sourceManifestPath = projectPath(option("--source-manifest", "assets/worldclaw/asset-library.json"));
  const stagedManifestPath = projectPath(option("--staged-manifest", "/tmp/worldclaw-compact-stage-final/asset-library.json"));
  const oldGlbPath = projectPath(option("--old-glb", "public/worldclaw/assets/worldclaw-kit.glb"));
  const newGlbPath = projectPath(option("--new-glb", "/tmp/worldclaw-compact-stage-final/worldclaw-kit.glb"));
  const sourceManifestBytes = readFileSync(sourceManifestPath);
  const stagedManifestBytes = readFileSync(stagedManifestPath);
  if (!sourceManifestBytes.equals(stagedManifestBytes)) {
    throw new Error("Staged manifest is not byte-identical to the source manifest; atomic GLB-first publication is unsafe");
  }
  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (manifest.library?.uri !== "/worldclaw/assets/worldclaw-kit.glb") throw new Error("Manifest runtime GLB URI is stale");
  for (const [alias, prototype] of Object.entries(manifest.aliases ?? {})) {
    if (!manifest.prototypes?.[prototype]) throw new Error(`Alias ${alias} targets missing prototype ${prototype}`);
  }
  const oldGlb = parseGlb(oldGlbPath);
  const newGlb = parseGlb(newGlbPath);
  const oldRoots = rootContract(oldGlb.json, manifest, "old GLB");
  const newRoots = rootContract(newGlb.json, manifest, "new GLB");
  if (JSON.stringify(Object.keys(oldRoots)) !== JSON.stringify(Object.keys(newRoots))) {
    throw new Error("Old and new GLBs expose different runtime root node sets");
  }
  console.log(
    `WORLDCLAW_PUBLISH_SEAM_OK manifestBytes=${sourceManifestBytes.length} ` +
    `roots=${Object.keys(newRoots).length} aliases=${Object.keys(manifest.aliases).length} ` +
    `oldSha256=${sha256(oldGlb.bytes)} newSha256=${sha256(newGlb.bytes)}`,
  );
}

main();

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const defaultPrototypeRoot = join(repoRoot, "assets/worldclaw/prototypes");
export const defaultVibePublicDir = join(repoRoot, "public/worldclaw/assets/vibe");
export const VIBE_LIBRARY_URI = "/worldclaw/assets/vibe/library.json";

const STATUSES = new Set(["draft", "accepted"]);

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCatalogue(raw, label = "catalogue.json") {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  const id = stringField(raw.id, `${label}.id`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`${label}.id must be a kebab-case slug`);
  }
  const prototype = stringField(raw.prototype, `${label}.prototype`);
  const node = stringField(raw.node, `${label}.node`);
  if (node !== `ASSET_${prototype}`) {
    throw new Error(`${label}.node must be ASSET_${prototype}`);
  }
  const status = stringField(raw.status, `${label}.status`);
  if (!STATUSES.has(status)) {
    throw new Error(`${label}.status must be draft or accepted`);
  }
  const targetHeightMeters = finitePositive(
    raw.targetHeightMeters,
    `${label}.targetHeightMeters`,
  );
  return {
    id,
    prototype,
    node,
    status,
    targetHeightMeters,
    collider: raw.collider ?? null,
    reference: optionalString(raw.reference),
    yaw: optionalNumber(raw.yaw, 0.7),
    pitch: optionalNumber(raw.pitch, 0.35),
    appearanceTerms: Array.isArray(raw.appearanceTerms)
      ? raw.appearanceTerms.filter((value) => typeof value === "string")
      : [],
    materialIds: Array.isArray(raw.materialIds)
      ? raw.materialIds.filter((value) => typeof value === "string")
      : [],
  };
}

export function discoverPrototypes(root = defaultPrototypeRoot) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const directory = join(root, name.name);
    const cataloguePath = join(directory, "catalogue.json");
    const modulePath = join(directory, "model.ts");
    if (!existsSync(cataloguePath) || !existsSync(modulePath)) continue;
    const catalogue = parseCatalogue(
      JSON.parse(readFileSync(cataloguePath, "utf8")),
      `${name.name}/catalogue.json`,
    );
    if (catalogue.id !== name.name) {
      throw new Error(`${name.name}/catalogue.json id must match the directory name`);
    }
    entries.push({
      directory,
      cataloguePath,
      modulePath,
      catalogue,
    });
  }
  return entries.sort((left, right) => left.catalogue.id.localeCompare(right.catalogue.id));
}

export function resolveCreateModel(exported) {
  if (exported && typeof exported.createModel === "function") return exported.createModel;
  if (typeof exported === "function") return exported;
  throw new Error("module must export createModel");
}

export function unwrapModel(created) {
  if (!created) throw new Error("createModel returned nothing");
  if (created.isObject3D) return { root: created, dispose: created.dispose };
  if (created.root?.isObject3D) return created;
  throw new Error("createModel must return a Three.js Object3D or { root }");
}

function stringField(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

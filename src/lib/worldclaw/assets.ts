import type {
  BrowserAssetCollider,
  BrowserAssetMetadata,
  BrowserAssetPrototype,
  ObjectKind,
  PlacedObject,
} from "./types";

export const WORLDCLAW_ASSET_MANIFEST_URI = "/worldclaw/assets/asset-library.json";
const WORLDCLAW_ASSET_MANIFEST_TIMEOUT_MS = 10_000;
const WORLDCLAW_ASSET_MANIFEST_MAX_BYTES = 1_000_000;

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    throw new Error(`Asset manifest exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("Asset manifest byte ceiling exceeded");
        throw new Error(`Asset manifest exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const REQUIRED_PROTOTYPES = [
  "palm",
  "tree",
  "pine",
  "rock",
  "cactus",
  "hut",
  "building",
  "watchtower",
  "ship",
  "tank",
] as const satisfies readonly BrowserAssetPrototype[];

const SUPPORTED_PROTOTYPES = [
  ...REQUIRED_PROTOTYPES,
  "pagoda",
  "torii",
  "bridge",
  "dragon",
  "windmill",
  "mine",
  "crystal",
  "antenna",
  "satellite",
  "dock",
  "tent",
  "well",
  "statue",
  "fence",
  "campfire",
  "crate",
  "market",
] as const satisfies readonly BrowserAssetPrototype[];

/**
 * Placement records currently include each primitive kind's nominal scale.
 * Blender prototypes are already authored in meters, so their runtime scale
 * keeps only the per-instance variation around that legacy nominal value.
 */
const LEGACY_KIND_BASE_SCALE: Partial<Record<ObjectKind, number>> = {
  palm: 1.6,
  tree: 1.4,
  pine: 1.8,
  rock: 0.8,
  boulder: 1.3,
  cactus: 1,
  hut: 1.2,
  house: 1.6,
  building: 2.4,
  bunker: 2,
  barn: 2.2,
  tower: 2.2,
  watchtower: 2.5,
  ship: 3.2,
  boat: 1.4,
  vehicle: 1.4,
  tank: 1.8,
  pagoda: 2.8,
  torii: 2.2,
  bridge: 3.5,
  dragon: 4,
  windmill: 3.5,
  mine: 2,
  crystal: 0.9,
  antenna: 2.8,
  satellite: 1.6,
  dock: 2.5,
  tent: 1.1,
  well: 1,
  statue: 1.5,
  fence: 1,
  campfire: 0.7,
  crate: 0.55,
  market: 1.8,
};

export interface AssetLibraryManifest {
  uri: string;
  format: "glb";
  sourceUpAxis: "Z";
  runtimeUpAxis: "Y";
  metersPerUnit: 1;
  fileBudgetBytes: number;
  maxTriangles: number;
}

export interface AssetPrototypeManifest {
  node: string;
  generator: string;
  targetHeightMeters: number;
  collider: BrowserAssetCollider;
  source: "blender_procedural";
  defaultVariant?: string;
  variants?: AssetVariantManifest[];
  evidence?: {
    turnaroundUri: string;
    contactSheetUri: string;
  };
}

export interface AssetVariantManifest {
  id: string;
  node: string;
  status: string;
  appearanceTerms: string[];
  materialIds: string[];
  targetHeightMeters?: number;
  collider?: BrowserAssetCollider;
  constructionRecipe?: {
    wallAssembly?: string;
    openingAssemblies?: string[];
    doorAssembly?: string;
    roofAssembly?: string;
    gateAssembly?: string;
    botanicalAssembly?: string;
    bridgeAssembly?: string;
    creatureAssembly?: string;
    industrialAssembly?: string;
    communicationsAssembly?: string;
    earthworkAssembly?: string;
    propAssembly?: string;
    weatheringProfile?: string;
    systems?: string[];
    authoredDimensions?: Record<string, number | number[]>;
    geometryGuarantees?: string[];
  };
  evidence?: {
    turnaroundUri?: string;
  };
  provenance?: {
    paperPages?: number[];
    researchReferenceIds?: string[];
    note?: string;
  };
}

export interface WorldClawAssetManifest {
  version: 1;
  library: AssetLibraryManifest;
  prototypes: Partial<Record<BrowserAssetPrototype, AssetPrototypeManifest>>;
  aliases: Partial<Record<ObjectKind, BrowserAssetPrototype>>;
  evidence?: {
    baseUri: string;
    contactSheetUri: string;
    turnaroundViews: string[];
    renderSource: string;
    projection: string;
  };
}

export type AssetManifestLoadStatus = "loaded" | "unavailable" | "invalid";

export interface AssetManifestLoadResult {
  status: AssetManifestLoadStatus;
  manifestUri: string;
  manifest?: WorldClawAssetManifest;
  error?: string;
}

export interface BrowserAssetResolution extends AssetManifestLoadResult {
  objects: PlacedObject[];
  blenderPrototypeInstances: number;
  primitiveFallbackInstances: number;
  prototypes: BrowserAssetPrototype[];
}

export interface BrowserAssetObjectBatch {
  key: string;
  prototype: BrowserAssetPrototype;
  uri: string;
  node: string;
  objects: PlacedObject[];
}

const manifestCache = new Map<string, Promise<AssetManifestLoadResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function optionalStringArray(value: unknown, maxItems = 64): string[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, maxItems)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 160));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : undefined;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function vec3(value: unknown, label: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new Error(`${label} must contain three finite numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function parseCollider(value: unknown, label: string): BrowserAssetCollider {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const centerMeters = vec3(value.centerMeters, `${label}.centerMeters`);

  if (value.type === "box") {
    const sizeMeters = vec3(value.sizeMeters, `${label}.sizeMeters`);
    if (sizeMeters.some((component) => component <= 0)) {
      throw new Error(`${label}.sizeMeters must be positive`);
    }
    return { type: "box", centerMeters, sizeMeters };
  }

  if (value.type === "capsule") {
    return {
      type: "capsule",
      centerMeters,
      radiusMeters: finitePositive(value.radiusMeters, `${label}.radiusMeters`),
      heightMeters: finitePositive(value.heightMeters, `${label}.heightMeters`),
    };
  }

  if (value.type === "sphere") {
    return {
      type: "sphere",
      centerMeters,
      radiusMeters: finitePositive(value.radiusMeters, `${label}.radiusMeters`),
    };
  }

  throw new Error(`${label}.type must be box, capsule, or sphere`);
}

function isBrowserAssetPrototype(value: string): value is BrowserAssetPrototype {
  return (SUPPORTED_PROTOTYPES as readonly string[]).includes(value);
}

function optionalAuthoredDimensions(value: unknown): Record<string, number | number[]> | undefined {
  if (!isRecord(value)) return undefined;
  const dimensions: Record<string, number | number[]> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      dimensions[key] = raw;
      continue;
    }
    if (
      Array.isArray(raw) &&
      raw.length <= 8 &&
      raw.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      dimensions[key] = raw as number[];
    }
  }
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

function optionalNumberArray(value: unknown, maxItems = 16): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value
    .slice(0, maxItems)
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return numbers.length > 0 ? numbers : undefined;
}

/**
 * Validate the Blender compiler's small browser contract at the network seam.
 * Extra manifest fields are intentionally tolerated so future LOD/export
 * metadata can be added without changing this vertical slice.
 */
export function parseWorldClawAssetManifest(value: unknown): WorldClawAssetManifest {
  if (!isRecord(value)) throw new Error("asset manifest must be an object");
  if (value.version !== 1) throw new Error("asset manifest version must be 1");
  if (!isRecord(value.library)) throw new Error("library must be an object");
  if (!isRecord(value.prototypes)) {
    throw new Error("prototypes must be an object");
  }
  if (!isRecord(value.aliases)) throw new Error("aliases must be an object");

  const uri = stringField(value.library.uri, "library.uri");
  if (!uri.startsWith("/") || !uri.toLowerCase().endsWith(".glb")) {
    throw new Error("library.uri must be a root-relative GLB path");
  }
  if (value.library.format !== "glb") {
    throw new Error("library.format must be glb");
  }
  if (value.library.sourceUpAxis !== "Z") {
    throw new Error("library.sourceUpAxis must be Z");
  }
  if (value.library.runtimeUpAxis !== "Y") {
    throw new Error("library.runtimeUpAxis must be Y");
  }
  if (value.library.metersPerUnit !== 1) {
    throw new Error("library.metersPerUnit must be 1");
  }

  const prototypes: Partial<Record<BrowserAssetPrototype, AssetPrototypeManifest>> = {};
  for (const key of SUPPORTED_PROTOTYPES) {
    const raw = value.prototypes[key];
    if (!isRecord(raw) && !(REQUIRED_PROTOTYPES as readonly string[]).includes(key)) {
      continue;
    }
    if (!isRecord(raw)) {
      throw new Error(`prototypes.${key} must be an object`);
    }
    const node = stringField(raw.node, `prototypes.${key}.node`);
    if (node !== `ASSET_${key}`) {
      throw new Error(`prototypes.${key}.node must be ASSET_${key}`);
    }
    if (raw.source !== "blender_procedural") {
      throw new Error(`prototypes.${key}.source must be blender_procedural`);
    }
    const variants = (Array.isArray(raw.variants) ? raw.variants : [])
      .slice(0, 32)
      .filter(isRecord)
      .map((variant, index): AssetVariantManifest => {
        const recipe = isRecord(variant.constructionRecipe)
          ? variant.constructionRecipe
          : undefined;
        return {
          id: stringField(variant.id, `prototypes.${key}.variants.${index}.id`),
          node: stringField(variant.node, `prototypes.${key}.variants.${index}.node`),
          status: optionalString(variant.status) ?? "unknown",
          appearanceTerms: optionalStringArray(variant.appearanceTerms),
          materialIds: optionalStringArray(variant.materialIds),
          targetHeightMeters:
            variant.targetHeightMeters === undefined
              ? undefined
              : finitePositive(
                  variant.targetHeightMeters,
                  `prototypes.${key}.variants.${index}.targetHeightMeters`,
                ),
          collider: isRecord(variant.collider)
            ? parseCollider(variant.collider, `prototypes.${key}.variants.${index}.collider`)
            : undefined,
          constructionRecipe: recipe
            ? {
                wallAssembly: optionalString(recipe.wallAssembly),
                openingAssemblies: optionalStringArray(recipe.openingAssemblies),
                doorAssembly: optionalString(recipe.doorAssembly),
                roofAssembly: optionalString(recipe.roofAssembly),
                gateAssembly: optionalString(recipe.gateAssembly),
                botanicalAssembly: optionalString(recipe.botanicalAssembly),
                bridgeAssembly: optionalString(recipe.bridgeAssembly),
                creatureAssembly: optionalString(recipe.creatureAssembly),
                industrialAssembly: optionalString(recipe.industrialAssembly),
                communicationsAssembly: optionalString(recipe.communicationsAssembly),
                earthworkAssembly: optionalString(recipe.earthworkAssembly),
                propAssembly: optionalString(recipe.propAssembly),
                weatheringProfile: optionalString(recipe.weatheringProfile),
                systems: optionalStringArray(recipe.systems),
                authoredDimensions: optionalAuthoredDimensions(recipe.authoredDimensions),
                geometryGuarantees: optionalStringArray(recipe.geometryGuarantees),
              }
            : undefined,
          evidence: isRecord(variant.evidence)
            ? {
                turnaroundUri: optionalString(variant.evidence.turnaroundUri),
              }
            : undefined,
          provenance: isRecord(variant.provenance)
            ? {
                paperPages: optionalNumberArray(variant.provenance.paperPages),
                researchReferenceIds: optionalStringArray(
                  variant.provenance.researchReferenceIds,
                  32,
                ),
                note: optionalString(variant.provenance.note),
              }
            : undefined,
        };
      });
    const prototypeEvidence = isRecord(raw.evidence)
      ? {
          turnaroundUri: stringField(
            raw.evidence.turnaroundUri,
            `prototypes.${key}.evidence.turnaroundUri`,
          ),
          contactSheetUri: stringField(
            raw.evidence.contactSheetUri,
            `prototypes.${key}.evidence.contactSheetUri`,
          ),
        }
      : undefined;
    prototypes[key] = {
      node,
      generator: stringField(raw.generator, `prototypes.${key}.generator`),
      targetHeightMeters: finitePositive(
        raw.targetHeightMeters,
        `prototypes.${key}.targetHeightMeters`,
      ),
      collider: parseCollider(raw.collider, `prototypes.${key}.collider`),
      source: "blender_procedural",
      defaultVariant: optionalString(raw.defaultVariant),
      variants,
      evidence: prototypeEvidence,
    };
  }

  const aliases: Partial<Record<ObjectKind, BrowserAssetPrototype>> = {};
  for (const [kind, rawPrototype] of Object.entries(value.aliases)) {
    if (typeof rawPrototype !== "string" || !isBrowserAssetPrototype(rawPrototype)) {
      throw new Error(`aliases.${kind} references an unknown prototype`);
    }
    aliases[kind as ObjectKind] = rawPrototype;
  }

  const evidence = isRecord(value.evidence)
    ? {
        baseUri: stringField(value.evidence.baseUri, "evidence.baseUri"),
        contactSheetUri: stringField(value.evidence.contactSheetUri, "evidence.contactSheetUri"),
        turnaroundViews: optionalStringArray(value.evidence.turnaroundViews, 16),
        renderSource: stringField(value.evidence.renderSource, "evidence.renderSource"),
        projection: stringField(value.evidence.projection, "evidence.projection"),
      }
    : undefined;

  return {
    version: 1,
    library: {
      uri,
      format: "glb",
      sourceUpAxis: "Z",
      runtimeUpAxis: "Y",
      metersPerUnit: 1,
      fileBudgetBytes: finitePositive(value.library.fileBudgetBytes, "library.fileBudgetBytes"),
      maxTriangles: finitePositive(value.library.maxTriangles, "library.maxTriangles"),
    },
    prototypes,
    aliases,
    evidence,
  };
}

export async function loadWorldClawAssetManifest(
  manifestUri = WORLDCLAW_ASSET_MANIFEST_URI,
  signal?: AbortSignal,
): Promise<AssetManifestLoadResult> {
  const load = async (): Promise<AssetManifestLoadResult> => {
    try {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(WORLDCLAW_ASSET_MANIFEST_TIMEOUT_MS);
      const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(manifestUri, {
        headers: { accept: "application/json" },
        signal: fetchSignal,
      });
      if (!response.ok) {
        return { status: "unavailable", manifestUri, error: `HTTP ${response.status}` };
      }
      const text = await readBoundedResponseText(response, WORLDCLAW_ASSET_MANIFEST_MAX_BYTES);
      return {
        status: "loaded",
        manifestUri,
        manifest: parseWorldClawAssetManifest(JSON.parse(text)),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        status:
          error instanceof SyntaxError ||
          (error instanceof Error && /manifest|utf-8|bytes/i.test(error.message))
            ? "invalid"
            : "unavailable",
        manifestUri,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // A caller-owned cancellation signal must never abort another caller's
  // shared cached request. Bound benchmark generation therefore uses an
  // isolated, abortable manifest read; ordinary UI consumers retain the cache.
  if (signal) return load();
  const existing = manifestCache.get(manifestUri);
  if (existing) return existing;

  const pending = load();

  manifestCache.set(manifestUri, pending);
  void pending.then((result) => {
    // A preview can briefly race the offline asset build; retry a missing or
    // half-written manifest instead of pinning fallback forever.
    if (result.status !== "loaded" && manifestCache.get(manifestUri) === pending) {
      manifestCache.delete(manifestUri);
    }
  });
  return pending;
}

function normalizeAppearance(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_APPEARANCE_TOKENS = new Set([
  "asset",
  "building",
  "house",
  "object",
  "structure",
  "styled",
  "stylized",
]);

function appearanceTokens(value: string): string[] {
  return normalizeAppearance(value)
    .split(" ")
    .filter(Boolean)
    .map((token) =>
      token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token,
    );
}

export function selectAssetVariant(
  definition: AssetPrototypeManifest,
  appearance: string,
): AssetVariantManifest | undefined {
  const variants = definition.variants ?? [];
  if (variants.length === 0) return undefined;
  const normalized = normalizeAppearance(appearance);
  const requestedTokens = new Set(appearanceTokens(appearance));
  const exact = variants.find((variant) => normalizeAppearance(variant.id) === normalized);
  if (exact) return exact;

  const declaredDefault =
    variants.find((variant) => variant.id === definition.defaultVariant) ?? variants[0];
  let best = declaredDefault;
  let bestScore = 0;
  for (const variant of variants) {
    const vocabulary = [...variant.appearanceTerms, ...variant.materialIds]
      .map((term) => ({ normalized: normalizeAppearance(term), tokens: appearanceTokens(term) }))
      .filter(Boolean);
    const score = vocabulary.reduce((total, term) => {
      const distinctiveTokens = term.tokens.filter(
        (token) => !GENERIC_APPEARANCE_TOKENS.has(token),
      );
      if (distinctiveTokens.length === 0) return total;
      if (normalized.includes(term.normalized)) {
        return total + 2 + distinctiveTokens.length;
      }
      const overlap = distinctiveTokens.filter((token) => requestedTokens.has(token)).length;
      const ratio = overlap / distinctiveTokens.length;
      return ratio >= 0.5 ? total + overlap * ratio : total;
    }, 0);
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }
  return best;
}

export function resolveBrowserAsset(
  kind: ObjectKind,
  manifest: WorldClawAssetManifest,
  appearance = "",
): BrowserAssetMetadata | undefined {
  const prototype = manifest.aliases[kind];
  if (!prototype) return undefined;
  const definition = manifest.prototypes[prototype];
  if (!definition) return undefined;
  const variant = selectAssetVariant(definition, appearance);
  return {
    prototype,
    uri: manifest.library.uri,
    node: variant?.node ?? definition.node,
    source: definition.source,
    targetHeightMeters: variant?.targetHeightMeters ?? definition.targetHeightMeters,
    collider: variant?.collider ?? definition.collider,
    variantId: variant?.id ?? definition.defaultVariant,
    appearanceTerms: variant?.appearanceTerms,
    materialIds: variant?.materialIds,
    constructionRecipe: variant?.constructionRecipe,
    provenance: variant?.provenance,
    evidence: variant?.evidence,
  };
}

export function browserAssetInstanceScale(object: PlacedObject): number {
  return object.scale / (LEGACY_KIND_BASE_SCALE[object.kind] ?? 1);
}

/**
 * A prototype may publish multiple authored GLB roots. Batch by the resolved
 * root, not only the semantic prototype, or construction variants collapse to
 * whichever node happens to be encountered first.
 */
export function groupBrowserAssetObjects(
  objects: readonly PlacedObject[],
): BrowserAssetObjectBatch[] {
  const groups = new Map<string, BrowserAssetObjectBatch>();
  for (const object of objects) {
    const asset = object.browserAsset;
    if (!asset) continue;
    const key = `${asset.uri}\u0000${asset.node}`;
    const group = groups.get(key) ?? {
      key,
      prototype: asset.prototype,
      uri: asset.uri,
      node: asset.node,
      objects: [],
    };
    group.objects.push(object);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Attach immutable browser asset references while preserving semantic kinds. */
export async function attachBrowserAssets(
  objects: PlacedObject[],
  manifestUri = WORLDCLAW_ASSET_MANIFEST_URI,
  signal?: AbortSignal,
): Promise<BrowserAssetResolution> {
  const load = await loadWorldClawAssetManifest(manifestUri, signal);
  if (!load.manifest) {
    return {
      ...load,
      objects,
      blenderPrototypeInstances: 0,
      primitiveFallbackInstances: objects.length,
      prototypes: [],
    };
  }

  const prototypeSet = new Set<BrowserAssetPrototype>();
  let blenderPrototypeInstances = 0;
  const resolved = objects.map((object) => {
    const browserAsset = resolveBrowserAsset(object.kind, load.manifest!, object.label);
    if (!browserAsset) return object;
    blenderPrototypeInstances++;
    prototypeSet.add(browserAsset.prototype);
    return { ...object, browserAsset };
  });

  return {
    ...load,
    objects: resolved,
    blenderPrototypeInstances,
    primitiveFallbackInstances: objects.length - blenderPrototypeInstances,
    prototypes: [...prototypeSet].sort(),
  };
}

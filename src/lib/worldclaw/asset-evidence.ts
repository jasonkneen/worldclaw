import type { BrowserAssetResolution } from "./assets";
import type {
  EnsembleArtifact,
  EnsembleEvidence,
  EnsembleProviderId,
  ObjectKind,
  PlacedObject,
} from "./types";

const MAX_ASSET_CONFLICTS = 12;
const MAX_ASSET_OBSERVATIONS = 12;

export type AssetResolutionEvidenceStatus = "compiled" | "fallback" | "missing";

export interface AssetResolutionEvidence {
  readonly status: AssetResolutionEvidenceStatus;
  readonly manifestStatus: BrowserAssetResolution["status"];
  readonly totalInstances: number;
  readonly compiledInstances: number;
  readonly fallbackInstances: number;
  readonly missingInstances: number;
}

export interface AssetResolutionPolicy {
  /** Explicitly enabled by a bound benchmark/request contract; never inferred from prompt text. */
  readonly strictAssetResolution?: boolean;
}

export function summarizeAssetResolution(
  resolution: BrowserAssetResolution,
): AssetResolutionEvidence {
  const compiledInstances = resolution.objects.reduce(
    (count, object) => count + (object.browserAsset ? 1 : 0),
    0,
  );
  const unresolvedInstances = resolution.objects.length - compiledInstances;
  const manifestMissing = resolution.status !== "loaded" || !resolution.manifest;
  return {
    status: manifestMissing ? "missing" : unresolvedInstances > 0 ? "fallback" : "compiled",
    manifestStatus: resolution.status,
    totalInstances: resolution.objects.length,
    compiledInstances,
    fallbackInstances: manifestMissing ? 0 : unresolvedInstances,
    missingInstances: manifestMissing ? unresolvedInstances : 0,
  };
}

/**
 * Fail closed for explicitly strict runs before a world can reach renderer
 * capture or final review. Ordinary app runs receive the same evidence but
 * retain their honest primitive rendering fallback.
 */
export function assertAssetResolutionPolicy(
  resolution: BrowserAssetResolution,
  policy: AssetResolutionPolicy = {},
): AssetResolutionEvidence {
  const evidence = summarizeAssetResolution(resolution);
  if (policy.strictAssetResolution && evidence.status !== "compiled") {
    throw new Error(
      `Strict asset resolution failed before final review: status=${evidence.status}; ` +
        `compiled=${evidence.compiledInstances}; fallback=${evidence.fallbackInstances}; ` +
        `missing=${evidence.missingInstances}; total=${evidence.totalInstances}` +
        (resolution.error ? `; manifest=${resolution.error.slice(0, 240)}` : ""),
    );
  }
  return evidence;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function selectedPlanningProducer(evidence: EnsembleEvidence | undefined): {
  provider: EnsembleProviderId;
  model: string;
  artifactId: string;
} | null {
  if (!evidence) return null;
  const selected = [...evidence.artifacts]
    .reverse()
    .find((artifact) => artifact.stage === "planning" && artifact.status === "selected");
  return selected
    ? {
        provider: selected.provider,
        model: selected.model,
        artifactId: selected.id,
      }
    : null;
}

function fallbackCounts(objects: readonly PlacedObject[]): [ObjectKind, number][] {
  const counts = new Map<ObjectKind, number>();
  for (const object of objects) {
    if (object.browserAsset) continue;
    counts.set(object.kind, (counts.get(object.kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Connect the selected model-authored plan to the deterministic offline Blender
 * compiler without claiming that Blender ran inside the provider request.
 * Local/template runs have no truthful model producer, so they deliberately do
 * not emit an ensemble artifact.
 */
export function buildAssetVariantEvidence(
  current: EnsembleEvidence | undefined,
  resolution: BrowserAssetResolution,
): EnsembleEvidence | undefined {
  const producer = selectedPlanningProducer(current);
  if (!current || !producer) return current;

  const compiledObjects = resolution.objects.filter((object) => object.browserAsset);
  const nodes = uniqueSorted(
    compiledObjects.flatMap((object) => (object.browserAsset ? [object.browserAsset.node] : [])),
  );
  const variantIds = uniqueSorted(
    compiledObjects.flatMap((object) =>
      object.browserAsset?.variantId ? [object.browserAsset.variantId] : [],
    ),
  );
  const evidenceUris = uniqueSorted(
    compiledObjects.flatMap((object) =>
      object.browserAsset?.evidence?.turnaroundUri
        ? [object.browserAsset.evidence.turnaroundUri]
        : [],
    ),
  );
  const fallback = fallbackCounts(resolution.objects);
  const resolutionEvidence = summarizeAssetResolution(resolution);
  const manifestLoaded =
    resolutionEvidence.manifestStatus === "loaded" && Boolean(resolution.manifest);
  const passed = resolutionEvidence.status === "compiled";
  const conflicts = fallback
    .map(
      ([kind, count]) =>
        `${kind}: ${count} placed instance${count === 1 ? " lacks" : "s lack"} an authored GLB prototype or matching variant`,
    )
    .slice(0, MAX_ASSET_CONFLICTS);
  if (!manifestLoaded) {
    conflicts.unshift(
      `Blender asset manifest ${resolution.status}${resolution.error ? `: ${resolution.error}` : ""}`,
    );
  }

  const observations = [
    `Resolved ${resolutionEvidence.compiledInstances}/${resolutionEvidence.totalInstances} placed objects through the frozen offline Blender manifest; fallback=${resolutionEvidence.fallbackInstances}; missing=${resolutionEvidence.missingInstances}; Blender did not run in the browser request`,
    `Selected ${nodes.length} independent GLB node${nodes.length === 1 ? "" : "s"}: ${nodes.join(", ") || "none"}`,
    `Authored variant ids: ${variantIds.join(", ") || "none"}`,
    `Published per-variant turnaround evidence: ${evidenceUris.length} unique dossier${evidenceUris.length === 1 ? "" : "s"}`,
    resolution.manifest
      ? `Browser asset contract: ${resolution.manifest.library.uri} · glTF/GLB · Z-up source → Y-up runtime · meters per unit ${resolution.manifest.library.metersPerUnit}`
      : "Browser asset contract was unavailable",
  ].slice(0, MAX_ASSET_OBSERVATIONS);

  const parentArtifactIds = uniqueSorted(
    [
      producer.artifactId,
      current.selection?.chosenLayoutArtifactId,
      current.selection?.chosenMultiviewArtifactId,
    ].filter((value): value is string => Boolean(value)),
  ).slice(0, 12);
  const artifact: EnsembleArtifact = {
    id: `asset-variant-i1-${producer.provider}-blender-manifest`.slice(0, 120),
    iteration: Math.max(1, Math.min(8, current.completedIterations || 1)),
    stage: "asset_variant",
    provider: producer.provider,
    model: producer.model.slice(0, 160),
    role: "Selected model plan and appearance brief resolved against the frozen offline Blender/GLB manifest",
    status: "selected",
    structuredOutput: JSON.stringify({
      resolution: resolutionEvidence,
      manifest: resolution.manifest
        ? {
            uri: resolution.manifest.library.uri,
            format: resolution.manifest.library.format,
            sourceUpAxis: resolution.manifest.library.sourceUpAxis,
            runtimeUpAxis: resolution.manifest.library.runtimeUpAxis,
            metersPerUnit: resolution.manifest.library.metersPerUnit,
          }
        : null,
      selectedNodes: nodes,
      selectedVariantIds: variantIds,
      turnaroundEvidenceUris: evidenceUris,
      primitiveFallbacks: fallback.map(([kind, count]) => ({ kind, count })),
    }),
    parentArtifactIds,
    score: resolution.objects.length
      ? resolutionEvidence.compiledInstances / resolution.objects.length
      : 1,
    passed,
    metrics: {
      placedObjects: resolution.objects.length,
      compiledInstances: resolutionEvidence.compiledInstances,
      fallbackInstances: resolutionEvidence.fallbackInstances,
      missingInstances: resolutionEvidence.missingInstances,
      primitiveFallbackInstances:
        resolutionEvidence.fallbackInstances + resolutionEvidence.missingInstances,
      selectedPrototypes: resolution.prototypes.length,
      selectedNodes: nodes.length,
      selectedVariants: variantIds.length,
      turnaroundDossiers: evidenceUris.length,
    },
    observations,
    conflicts: conflicts.slice(0, MAX_ASSET_CONFLICTS),
    error: manifestLoaded ? undefined : conflicts[0]?.slice(0, 600),
  };

  return {
    ...current,
    artifacts: [...current.artifacts.filter((entry) => entry.id !== artifact.id), artifact].slice(
      -128,
    ),
  };
}

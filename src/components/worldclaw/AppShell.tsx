import { useEffect } from "react";
import { evaluateFinalWorldRender } from "~/lib/worldclaw/inference";
import { constructionAudit } from "~/lib/worldclaw/construction-audit";
import {
  objectCoverageCertificationFailures,
  sceneReferenceSummary,
  shouldRunFinalModelReview,
  visualReferenceCertificationFailures,
} from "~/lib/worldclaw/pipeline";
import { listPresets } from "~/lib/worldclaw/planning";
import {
  boundaryF1WithinTolerance,
  compareMaskTransforms,
  countConnectedComponents,
  measureBidirectionalBoundaryDistance,
  measureMaskOverlap,
  measureReferenceInteriorLeakage,
} from "~/lib/worldclaw/reference-metrics";
import { useWorldClaw } from "~/lib/worldclaw/store";
import type { WorldScene } from "~/lib/worldclaw/types";
import { ControlPanel } from "./ControlPanel";
import { waitForRendererReadiness } from "./renderer-readiness";
import { WorldViewport } from "./WorldScene";

async function waitForRegisteredCapture(signal: AbortSignal, expectedWorldId: string) {
  const deadline = performance.now() + 20_000;
  let lastTransientError: Error | null = null;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    if (window.__WORLDCLAW_CAPTURE_REGISTERED__) {
      try {
        const capture = await window.__WORLDCLAW_CAPTURE_REGISTERED__();
        if (capture.worldId === expectedWorldId) return capture;
        lastTransientError = new Error(
          `Registered capture belongs to ${capture.worldId}, waiting for ${expectedWorldId}`,
        );
      } catch (error) {
        const resolved = error instanceof Error ? error : new Error(String(error));
        if (!/completed world|active world changed|superseded world/i.test(resolved.message)) {
          throw resolved;
        }
        lastTransientError = resolved;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw lastTransientError ?? new Error("Registered renderer capture did not become available");
}

type RegisteredCapture = Awaited<ReturnType<typeof waitForRegisteredCapture>>;

const LAND_WATER_IOU_FLOOR = 0.95;
const SHORELINE_BOUNDARY_F1_FLOOR = 0.95;
const FALSE_WATER_ON_LAND_CEILING = 0.005;
const MISSING_CANONICAL_WATER_CEILING = 0.01;
const MINIMUM_HERO_PROXY_PIXELS = 64;
const MATERIAL_FAMILY_MACRO_F1_FLOOR = 0.9;

function decodeTerrainMask(capture: RegisteredCapture): Uint8Array {
  const source = capture.analysis.terrainWaterMask;
  const encoded = source.rawMask;
  if (!encoded) {
    throw new Error(
      source.rawMaskOmittedReason ?? "Rendered land/water mask has no deterministic raw payload",
    );
  }
  const binary = window.atob(encoded.dataBase64);
  if (binary.length % 3 !== 0) {
    throw new Error("Rendered land/water mask RLE is malformed");
  }
  const output = new Uint8Array(encoded.decodedPixelCount);
  let writeOffset = 0;
  for (let offset = 0; offset < binary.length; offset += 3) {
    const category = binary.charCodeAt(offset);
    const runLength = binary.charCodeAt(offset + 1) | (binary.charCodeAt(offset + 2) << 8);
    if (category > 2 || runLength < 1 || writeOffset + runLength > output.length) {
      throw new Error("Rendered land/water mask RLE contains an invalid run");
    }
    output.fill(category, writeOffset, writeOffset + runLength);
    writeOffset += runLength;
  }
  if (writeOffset !== output.length) {
    throw new Error("Rendered land/water mask RLE decoded to the wrong size");
  }
  return output;
}

function canonicalTerrainMask(world: WorldScene, capture: RegisteredCapture): Uint8Array {
  const { width, height } = capture.analysis.terrainWaterMask;
  const bounds = capture.images.map.camera.orthographicBounds;
  if (!bounds) throw new Error("Registered map camera has no orthographic bounds");
  const output = new Uint8Array(width * height);
  const halfWorld = world.heightField.worldSize * 0.5;
  const resolution = world.heightField.resolution;
  for (let pixelY = 0; pixelY < height; pixelY++) {
    const cameraY = bounds.top + (bounds.bottom - bounds.top) * ((pixelY + 0.5) / height);
    const worldZ = -cameraY;
    for (let pixelX = 0; pixelX < width; pixelX++) {
      const worldX = bounds.left + (bounds.right - bounds.left) * ((pixelX + 0.5) / width);
      const offset = pixelY * width + pixelX;
      if (Math.abs(worldX) > halfWorld || Math.abs(worldZ) > halfWorld) {
        output[offset] = 0;
        continue;
      }
      const gridX = Math.min(
        resolution - 1,
        Math.max(0, Math.round((worldX / world.heightField.worldSize + 0.5) * (resolution - 1))),
      );
      const gridY = Math.min(
        resolution - 1,
        Math.max(0, Math.round((worldZ / world.heightField.worldSize + 0.5) * (resolution - 1))),
      );
      const regionIndex = world.heightField.regionId[gridY * resolution + gridX] ?? 0;
      const category = world.plan.regions[regionIndex]?.category;
      output[offset] = category === "ocean" || category === "river" ? 1 : 2;
    }
  }
  return output;
}

function binaryCategoryMask(categories: Uint8Array, category: 1 | 2): Uint8Array {
  const output = new Uint8Array(categories.length);
  for (let index = 0; index < categories.length; index++) {
    output[index] = categories[index] === category ? 1 : 0;
  }
  return output;
}

function maskArtifactDataUrl(
  width: number,
  height: number,
  colorAt: (index: number) => readonly [number, number, number, number],
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Reference comparison could not create an artifact canvas");
  const image = context.createImageData(width, height);
  for (let index = 0; index < width * height; index++) {
    image.data.set(colorAt(index), index * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function compareTerrainReference(world: WorldScene, capture: RegisteredCapture) {
  const width = capture.analysis.terrainWaterMask.width;
  const height = capture.analysis.terrainWaterMask.height;
  if (width !== height) throw new Error("Deterministic terrain comparison requires a square map");
  const referenceCategories = canonicalTerrainMask(world, capture);
  const renderedCategories = decodeTerrainMask(capture);
  const referenceLand = binaryCategoryMask(referenceCategories, 2);
  const renderedLand = binaryCategoryMask(renderedCategories, 2);
  const referenceWater = binaryCategoryMask(referenceCategories, 1);
  const renderedWater = binaryCategoryMask(renderedCategories, 1);
  const renderedNonWater = new Uint8Array(renderedCategories.length);
  for (let index = 0; index < renderedCategories.length; index++) {
    renderedNonWater[index] = renderedCategories[index] === 1 ? 0 : 1;
  }
  const land = measureMaskOverlap(
    { width, height, data: referenceLand },
    { width, height, data: renderedLand },
  );
  const water = measureMaskOverlap(
    { width, height, data: referenceWater },
    { width, height, data: renderedWater },
  );
  const boundaryTolerance = 4 * (width / 1024);
  const shoreline = boundaryF1WithinTolerance(
    { width, height, data: referenceLand },
    { width, height, data: renderedLand },
    boundaryTolerance,
  );
  const shorelineDistance = measureBidirectionalBoundaryDistance(
    { width, height, data: referenceLand },
    { width, height, data: renderedLand },
  );
  const orientation = compareMaskTransforms(
    { width, height, data: referenceLand },
    { width, height, data: renderedLand },
    0.02,
  );
  // Shoreline registration is already judged by F1 and P95. Measure water
  // leakage only beyond that accepted raster boundary so a one-pixel alias is
  // not counted twice as inland flooding.
  const falseWater = measureReferenceInteriorLeakage(
    { width, height, data: referenceLand },
    { width, height, data: renderedWater },
    boundaryTolerance,
  );
  const missingWater = measureReferenceInteriorLeakage(
    { width, height, data: referenceWater },
    { width, height, data: renderedNonWater },
    boundaryTolerance,
  );
  const falseWaterOnLandRatio = falseWater.interiorLeakageRatio ?? 1;
  const missingCanonicalWaterRatio = missingWater.interiorLeakageRatio ?? 1;
  const referenceWaterComponents = countConnectedComponents(
    { width, height, data: referenceWater },
    { minAreaRatio: 0.001, connectivity: 4 },
  );
  const renderedWaterComponents = countConnectedComponents(
    { width, height, data: renderedWater },
    { minAreaRatio: 0.001, connectivity: 4 },
  );
  const landWaterIoU = (land.iou + water.iou) * 0.5;
  const artifacts = {
    canonicalLandWaterMask: maskArtifactDataUrl(width, height, (index) =>
      referenceCategories[index] === 1
        ? [22, 103, 170, 255]
        : referenceCategories[index] === 2
          ? [102, 166, 74, 255]
          : [8, 12, 17, 255],
    ),
    renderedLandWaterMask: capture.analysis.terrainWaterMask.pngDataUrl,
    shorelineOverlay: maskArtifactDataUrl(width, height, (index) => {
      const inReference = referenceLand[index] === 1;
      const inRender = renderedLand[index] === 1;
      if (inReference && inRender) return [36, 190, 94, 255];
      if (inReference) return [229, 65, 188, 255];
      if (inRender) return [250, 204, 21, 255];
      return [8, 12, 17, 255];
    }),
    landWaterDifference: maskArtifactDataUrl(width, height, (index) => {
      const expected = referenceCategories[index];
      const actual = renderedCategories[index];
      if (expected === actual) {
        return expected === 1
          ? [22, 103, 170, 255]
          : expected === 2
            ? [56, 142, 60, 255]
            : [8, 12, 17, 255];
      }
      if (expected === 2 && actual === 1) return [225, 48, 48, 255];
      if (expected === 1 && actual !== 1) return [245, 158, 11, 255];
      return [214, 67, 191, 255];
    }),
  };
  return {
    metrics: {
      landWaterIoU,
      landIoU: land.iou,
      waterIoU: water.iou,
      shorelineBoundaryF1: shoreline.f1,
      shorelineP95DistancePixels: shorelineDistance.bidirectionalP95,
      maskSize: width,
      orientationSuspicious: orientation.suspicious,
      bestAlternateOrientation: orientation.bestAlternateTransform,
      alternateOrientationImprovement: orientation.alternateImprovement,
      leakageBoundaryTolerancePixels: boundaryTolerance,
      rawFalseWaterOnLandRatio: falseWater.rawLeakageRatio ?? 1,
      falseWaterOnLandRatio,
      rawMissingCanonicalWaterRatio: missingWater.rawLeakageRatio ?? 1,
      missingCanonicalWaterRatio,
      referenceWaterComponents,
      renderedWaterComponents,
    },
    artifacts,
  };
}

async function compressCapture(dataUrl: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("A registered renderer capture could not be decoded"));
    element.src = dataUrl;
  });
  signal.throwIfAborted();
  const scale = Math.min(1, 720 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Browser image compression is unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function heroVisibilityAudit(world: WorldScene, capture: RegisteredCapture) {
  const required = world.inferenceMeta?.objectCoverage?.heroRequiredByKind ?? {};
  const failures: string[] = [];
  const mappings = capture.analysis.objectProxyVisibility.mapping;
  const views = Object.values(capture.analysis.objectProxyVisibility.views);
  for (const [kind, expectedCount] of Object.entries(required)) {
    const instances = mappings.filter((mapping) => mapping.objectKind === kind);
    if (instances.length !== expectedCount) {
      failures.push(
        `${kind}: expected ${expectedCount} hero instances, captured ${instances.length}`,
      );
    }
    for (const instance of instances) {
      const maximumVisiblePixels = Math.max(
        ...views.map((view) => view.visiblePixelsByObjectId[instance.objectId] ?? 0),
      );
      if (maximumVisiblePixels < MINIMUM_HERO_PROXY_PIXELS) {
        failures.push(
          `${kind} ${instance.objectId}: only ${maximumVisiblePixels} proxy pixels in its best registered view`,
        );
      }
    }
  }
  return { required, failures };
}

function deterministicFinalEvidence(world: WorldScene, capture: RegisteredCapture) {
  let waterMax = Number.NEGATIVE_INFINITY;
  let landMin = Number.POSITIVE_INFINITY;
  for (let index = 0; index < world.heightField.data.length; index++) {
    const category = world.plan.regions[world.heightField.regionId[index] ?? 0]?.category;
    const height = world.heightField.data[index];
    if (height === undefined || !Number.isFinite(height)) continue;
    if (category === "ocean" || category === "river") waterMax = Math.max(waterMax, height);
    else landMin = Math.min(landMin, height);
  }
  const coverage = world.inferenceMeta?.objectCoverage;
  const heroRequiredByKind = coverage?.heroRequiredByKind ?? {};
  const heroCountFailures = Object.entries(heroRequiredByKind)
    .filter(([kind, expected]) => (coverage?.placedByKind[kind] ?? 0) !== expected)
    .map(
      ([kind, expected]) =>
        `${kind}: expected exactly ${expected}, placed ${coverage?.placedByKind[kind] ?? 0}`,
    );
  const heroVisibility = heroVisibilityAudit(world, capture);
  const construction = constructionAudit(world);
  const terrainComparison = compareTerrainReference(world, capture);
  const mapCamera = capture.images.map.camera;
  const mapNorthUp =
    capture.images.map.width === capture.images.map.height &&
    mapCamera.projection === "orthographic" &&
    Math.abs(mapCamera.elevationDegrees - 90) < 0.001 &&
    Math.abs(mapCamera.up[0]) < 0.001 &&
    Math.abs(mapCamera.up[1]) < 0.001 &&
    Math.abs(mapCamera.up[2] + 1) < 0.001;
  const cameraMatricesPassed = Object.values(capture.images).every(
    (image) => image.camera.matrixSanity.passed,
  );
  const depthPassesFinite = Object.values(capture.analysis.normalizedDepth).every(
    (depth) =>
      depth.finiteNormalized && depth.nonFinitePixels === 0 && depth.outOfRangePixels === 0,
  );
  const waterLevelMeters = world.plan.visualContract?.waterLevelMeters ?? -0.35;
  const checks = {
    objectSatisfactionRatio: coverage?.satisfactionRatio ?? 0,
    heroRequiredByKind,
    missingHeroKinds: coverage?.missingHeroKinds ?? [],
    heroCountFailures,
    heroVisibilityFailures: heroVisibility.failures,
    constructionConflicts: construction.conflicts,
    materialFamilyMacroF1: construction.materialFamilyMacroF1,
    waterMaxMeters: Number.isFinite(waterMax) ? waterMax : null,
    landMinMeters: Number.isFinite(landMin) ? landMin : null,
    waterLevelMeters,
    mapNorthUp,
    cameraMatricesPassed,
    compiledSlotsMatched: capture.analysis.compiledSlots.matched,
    depthPassesFinite,
    ...terrainComparison.metrics,
    failures: [] as string[],
  };
  checks.failures.push(...visualReferenceCertificationFailures(world.plan));
  checks.failures.push(
    ...objectCoverageCertificationFailures({
      satisfactionRatio: checks.objectSatisfactionRatio,
      missingKinds: coverage?.missingKinds ?? [],
      missingHeroKinds: coverage?.missingHeroKinds ?? [],
    }),
  );
  checks.failures.push(...heroCountFailures, ...heroVisibility.failures, ...construction.conflicts);
  if (construction.materialFamilyMacroF1 < MATERIAL_FAMILY_MACRO_F1_FLOOR) {
    checks.failures.push(
      `Material-family contract F1 ${construction.materialFamilyMacroF1.toFixed(3)} is below ${MATERIAL_FAMILY_MACRO_F1_FLOOR}`,
    );
  }
  if (checks.waterMaxMeters !== null && checks.waterMaxMeters > waterLevelMeters - 0.2) {
    checks.failures.push("Water terrain rises too close to or above the visible water plane");
  }
  if (checks.landMinMeters !== null && checks.landMinMeters < waterLevelMeters) {
    checks.failures.push("Land terrain penetrates below the visible water plane");
  }
  if (!mapNorthUp) checks.failures.push("Registered map camera is not square north-up");
  if (!cameraMatricesPassed)
    checks.failures.push("A registered camera matrix failed sanity checks");
  if (!checks.compiledSlotsMatched)
    checks.failures.push("Compiled GLB object slots are incomplete");
  if (!depthPassesFinite) checks.failures.push("A registered depth pass is empty or non-finite");
  if (checks.landWaterIoU < LAND_WATER_IOU_FLOOR) {
    checks.failures.push(
      `Land/water macro IoU ${checks.landWaterIoU.toFixed(3)} is below ${LAND_WATER_IOU_FLOOR}`,
    );
  }
  if (checks.shorelineBoundaryF1 < SHORELINE_BOUNDARY_F1_FLOOR) {
    checks.failures.push(
      `Shoreline boundary F1 ${checks.shorelineBoundaryF1.toFixed(3)} is below ${SHORELINE_BOUNDARY_F1_FLOOR}`,
    );
  }
  const shorelineP95Limit = 6 * (checks.maskSize / 1024);
  if (checks.shorelineP95DistancePixels > shorelineP95Limit) {
    checks.failures.push(
      `Shoreline P95 ${checks.shorelineP95DistancePixels.toFixed(2)}px exceeds ${shorelineP95Limit.toFixed(2)}px`,
    );
  }
  if (checks.orientationSuspicious) {
    checks.failures.push(
      `${checks.bestAlternateOrientation} improves map IoU by ${checks.alternateOrientationImprovement.toFixed(3)}; possible mirror/rotation`,
    );
  }
  if (checks.falseWaterOnLandRatio > FALSE_WATER_ON_LAND_CEILING) {
    checks.failures.push(
      `False water covers ${(checks.falseWaterOnLandRatio * 100).toFixed(2)}% of canonical land`,
    );
  }
  if (checks.missingCanonicalWaterRatio > MISSING_CANONICAL_WATER_CEILING) {
    checks.failures.push(
      `Rendered terrain misses ${(checks.missingCanonicalWaterRatio * 100).toFixed(2)}% of canonical water`,
    );
  }
  if (checks.referenceWaterComponents !== checks.renderedWaterComponents) {
    checks.failures.push(
      `Water components differ: reference ${checks.referenceWaterComponents}, render ${checks.renderedWaterComponents}`,
    );
  }
  checks.failures = [...new Set(checks.failures)].sort();
  return { checks, artifacts: terrainComparison.artifacts };
}

export function AppShell() {
  const setPrompt = useWorldClaw((s) => s.setPrompt);
  const prompt = useWorldClaw((s) => s.prompt);
  const world = useWorldClaw((s) => s.world);
  const running = useWorldClaw((s) => s.running);
  const stage = useWorldClaw((s) => s.stage);
  const renderValidation = useWorldClaw((s) => s.renderValidation);
  const setRenderValidation = useWorldClaw((s) => s.setRenderValidation);
  const mergeWorldEnsemble = useWorldClaw((s) => s.mergeWorldEnsemble);

  useEffect(() => {
    if (!prompt) {
      const presets = listPresets();
      setPrompt(presets[0]?.prompt ?? "");
    }
  }, [prompt, setPrompt]);

  useEffect(() => {
    if (!world) return;
    if (
      world.inferenceMeta?.ensemble?.artifacts.some((artifact) => artifact.stage === "final_judge")
    ) {
      return;
    }
    const layoutImageDataUrl = world.plan.layoutImageDataUrl;
    const perspectiveImageDataUrl = world.plan.perspectiveImageDataUrl;
    if (!layoutImageDataUrl || !perspectiveImageDataUrl || !world.plan.visualContract) {
      setRenderValidation({
        status: "unavailable",
        error: "This run has no canonical map and approved multi-angle reference to compare",
      });
      return;
    }

    const controller = new AbortController();
    setRenderValidation({ status: "running" });
    void (async () => {
      try {
        await waitForRendererReadiness(window, world.id, controller.signal);
        const capture = await waitForRegisteredCapture(controller.signal, world.id);
        const deterministic = deterministicFinalEvidence(world, capture);
        const [map, isometric, oblique, walk] = await Promise.all([
          compressCapture(capture.images.map.dataUrl, controller.signal),
          compressCapture(capture.images.isometric.dataUrl, controller.signal),
          compressCapture(capture.images.oblique.dataUrl, controller.signal),
          compressCapture(capture.images.walk.dataUrl, controller.signal),
        ]);
        if (!shouldRunFinalModelReview(deterministic.checks.failures)) {
          controller.signal.throwIfAborted();
          if (useWorldClaw.getState().world?.id !== world.id) return;
          setRenderValidation({
            status: "failed",
            error: `Built world and final captures retained; deterministic certification stopped model review: ${deterministic.checks.failures.join("; ")}`,
            captures: { map, isometric, oblique, walk },
            comparisonArtifacts: deterministic.artifacts,
          });
          return;
        }
        const captureMetadata = JSON.stringify({
          views: Object.fromEntries(
            Object.entries(capture.images).map(([view, image]) => [
              view,
              {
                width: image.width,
                height: image.height,
                camera: {
                  view: image.camera.view,
                  source: image.camera.source,
                  projection: image.camera.projection,
                  position: image.camera.position,
                  targetWorld: image.camera.targetWorld,
                  targetNormalized: image.camera.targetNormalized,
                  up: image.camera.up,
                  azimuthDegrees: image.camera.azimuthDegrees,
                  elevationDegrees: image.camera.elevationDegrees,
                  distanceScale: image.camera.distanceScale,
                  near: image.camera.near,
                  far: image.camera.far,
                  fovDegrees: image.camera.fovDegrees,
                  orthographicBounds: image.camera.orthographicBounds,
                  matrixSanity: image.camera.matrixSanity,
                  placementSafety: image.camera.placementSafety,
                  description: image.camera.description,
                },
                pixelValidation: image.validation,
              },
            ]),
          ),
          analysis: {
            terrainWaterMask: {
              pass: capture.analysis.terrainWaterMask.pass,
              width: capture.analysis.terrainWaterMask.width,
              height: capture.analysis.terrainWaterMask.height,
              orientation: capture.analysis.terrainWaterMask.orientation,
              pixelCounts: capture.analysis.terrainWaterMask.pixelCounts,
            },
            objectProxyPass: {
              pass: capture.analysis.objectProxyVisibility.pass,
              literalObjectMeshes: capture.analysis.objectProxyVisibility.literalObjectMeshes,
              visibleObjectCounts: Object.fromEntries(
                Object.entries(capture.analysis.objectProxyVisibility.views).map(
                  ([view, value]) => [view, value.visibleObjectCount],
                ),
              ),
            },
            compiledSlots: {
              expectedCompiledObjectCount:
                capture.analysis.compiledSlots.expectedCompiledObjectCount,
              loadedUniqueObjectSlotCount:
                capture.analysis.compiledSlots.loadedUniqueObjectSlotCount,
              loadedSubmeshInstanceSlotCount:
                capture.analysis.compiledSlots.loadedSubmeshInstanceSlotCount,
              loadedBatchCount: capture.analysis.compiledSlots.loadedBatchCount,
              matched: capture.analysis.compiledSlots.matched,
              missingCount: capture.analysis.compiledSlots.missingObjectIds.length,
              unexpectedCount: capture.analysis.compiledSlots.unexpectedObjectIds.length,
            },
            depth: capture.analysis.normalizedDepth,
          },
        });
        const judgement = await evaluateFinalWorldRender({
          data: {
            prompt: world.plan.prompt,
            sceneSummary: sceneReferenceSummary(world.plan),
            layoutImageDataUrl,
            perspectiveImageDataUrl,
            captures: { map, isometric, oblique, walk },
            captureMetadata,
            deterministicChecks: deterministic.checks,
            parentArtifactIds: [
              world.inferenceMeta?.ensemble?.selection?.chosenLayoutArtifactId,
              world.inferenceMeta?.ensemble?.selection?.chosenMultiviewArtifactId,
            ].filter((value): value is string => Boolean(value)),
          },
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (useWorldClaw.getState().world?.id !== world.id) return;
        setRenderValidation({
          status: judgement.passed ? "passed" : "failed",
          judgement,
          captures: { map, isometric, oblique, walk },
          comparisonArtifacts: deterministic.artifacts,
        });
        mergeWorldEnsemble(world.id, judgement.ensemble);
      } catch (error) {
        if (controller.signal.aborted) return;
        setRenderValidation({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => controller.abort();
  }, [mergeWorldEnsemble, setRenderValidation, world]);

  const planSrc = world?.inferenceMeta?.planSource;
  const terrSrc = world?.inferenceMeta?.terrainSource;
  const planProvider = world?.inferenceMeta?.planProvider;
  const terrainProvider = world?.inferenceMeta?.terrainProvider;
  const hasReferenceWarnings = world?.plan.visualContract?.judgement?.passed === false;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-bg">
      <WorldViewport />
      <ControlPanel />

      <div className="pointer-events-none absolute top-16 right-3 z-10 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2 sm:top-3">
        <div className="max-w-full rounded-lg border border-border bg-surface/90 px-3 py-2 text-right backdrop-blur-sm">
          <p className="text-[10px] tracking-wide text-fg-subtle uppercase">
            WorldClaw · Agentic Open-World
          </p>
          <p className="text-xs text-fg-muted">
            {world
              ? `${planSrc === "llm" ? `${planProvider ?? "LLM"} plan` : "template plan"} · ${terrSrc === "image_guided" ? `${terrainProvider ?? "image model"} terrain` : "procedural terrain"} · ${renderValidation?.status === "passed" ? "reference-certified" : renderValidation?.status === "running" ? "final review running" : renderValidation?.status === "failed" ? "built with review warnings" : hasReferenceWarnings ? "reference warnings retained" : "render-ready"}`
              : running
                ? `Stage: ${stage.replace(/_/g, " ")}`
                : "Enter a prompt — model-guided or local generation"}
          </p>
        </div>
      </div>

      {!world && !running && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center px-6 sm:pl-[380px]">
          <div className="max-w-sm text-center">
            <h2 className="text-lg font-semibold tracking-tight text-fg">Open-world generation</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              Model-guided planning → semantic layout I_layout → image-guided height field →
              regional objects → contact refinement. Pick a paper example or write your own prompt.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

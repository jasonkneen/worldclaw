import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  OrbitControls,
  OrthographicCamera,
  PerformanceMonitor,
  PerspectiveCamera,
  Sky,
  Stars,
} from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import {
  colliderSupportPointsXZ,
  resolveCircleMovementXZ,
  worldColliderForObject,
  type WorldColliderProxy,
} from "~/lib/worldclaw/collision";
import { useWorldClaw } from "~/lib/worldclaw/store";
import { sampleHeight } from "~/lib/worldclaw/terrain";
import { ObjectMesh } from "./ObjectMesh";
import { CompiledAssetBatches } from "./CompiledAssetBatches";
import {
  fitLiveMapFraming,
  isLiveWalkSpawnSafe,
  LIVE_COMPILED_INSTANCE_MATERIAL_VERTEX_COLORS,
  LIVE_DEPTH_LUMINANCE_RANGE,
  LIVE_DEPTH_MINIMUM_LUMINANCE,
  registerRendererReadiness,
  selectLiveWalkHeading,
  stableLiveInstanceColor,
  WORLDCLAW_RENDERER_READY_TIMEOUT_MS,
  type LiveWalkHeadingObstacle,
  type WorldClawRendererReadiness,
} from "./renderer-readiness";
import { TerrainMesh, WaterPlane } from "./TerrainMesh";
import type {
  ObjectKind,
  TerrainCategory,
  VisualCameraReference,
  WorldScene as WorldSceneType,
} from "~/lib/worldclaw/types";

const WALK_COLLIDER_RADIUS = 0.45;
const WALK_FORWARD = new THREE.Vector3();
const WALK_RIGHT = new THREE.Vector3();
const WALK_LOOK = new THREE.Vector3();
const WALK_POSITION = new THREE.Vector3(0, 4, 18);
const LIVE_WALK_MINIMUM_SPAWN_CLEARANCE_METERS = 2.25;
const LIVE_WALK_MINIMUM_FORWARD_SIGHTLINE_METERS = 7;
const LIVE_WALK_MINIMUM_DRY_NEIGHBORHOOD_METERS = 1.5;
const REGISTERED_MAP_CAPTURE_SIZE = 960;
const REGISTERED_PERSPECTIVE_CAPTURE_WIDTH = 960;
const REGISTERED_PERSPECTIVE_CAPTURE_HEIGHT = 540;
// The deadline covers four beauty PNG encodes plus mask, RGB24 proxy and depth
// passes. A fully populated 150+ object GLB scene can exceed 12 seconds on the
// headless software renderer even though the same capture takes ~5 seconds on
// a GPU. Keep it bounded without rejecting a valid high-resolution dossier.
const REGISTERED_CAPTURE_TIMEOUT_MS = 45_000;
const REGISTERED_WALK_EYE_HEIGHT_METERS = 1.65;
const REGISTERED_WALK_CLEARANCE_RADIUS_METERS = 1.2;
const REGISTERED_WALK_LAND_MARGIN_METERS = 0.05;
const REGISTERED_WALK_SEARCH_RADIUS_METERS = 24;
const REGISTERED_WALK_SEARCH_RING_STEP_METERS = 1;
const REGISTERED_WALK_SEARCH_DIRECTIONS = 16;
const REGISTERED_VIEW_TARGET_MAJOR_FILL = 0.9;
const REGISTERED_VIEW_MINIMUM_VALIDATED_MAJOR_FILL = 0.88;
const REGISTERED_VIEW_FRAMING_PADDING_RATIO = 1 / REGISTERED_VIEW_TARGET_MAJOR_FILL;
const REGISTERED_VIEW_MINIMUM_CONTENT_SPAN_RATIO = 0.16;
const REGISTERED_WALK_NEAR_VEGETATION_RATIO = 0.075;
const REGISTERED_WALK_CONSTRUCTION_RANGE_RATIO = 0.45;
const REGISTERED_WALK_MIN_CONSTRUCTION_CLEARANCE_METERS = 3.2;
const REGISTERED_WALK_MIN_FORWARD_SIGHTLINE_METERS = 7;
const REGISTERED_WALK_PREFERRED_MAX_ADJUSTMENT_METERS = 12;
const REGISTERED_WALK_MIN_VEGETATION_CLEARANCE_METERS = 4.5;
const REGISTERED_WALK_MIN_DRY_NEIGHBORHOOD_RADIUS_METERS = 3.5;
const REGISTERED_WALK_MIN_ARCHITECTURE_SUBJECTS = 2;
const REGISTERED_WALK_MIN_HERO_OR_HARBOR_SUBJECTS = 1;
const REGISTERED_ANALYSIS_MASK_SIZE = 512;
const REGISTERED_RAW_MASK_MAX_BASE64_CHARS = 512_000;

/**
 * The paper matrix is intentionally smaller than the registered validation
 * dossier. A complete request still contains 9 views x 4 PNG passes, so a
 * fixed 640x360 target keeps the worst-case full-request readback below 56 MiB
 * even with float32 depth, while targets are reused sequentially. Callers can
 * request any subset of the nine views when they do not need the complete
 * matrix.
 */
const PAPER_CAPTURE_WIDTH = 640;
const PAPER_CAPTURE_HEIGHT = 360;
const PAPER_CAPTURE_TIMEOUT_MS = 90_000;
const PAPER_CAPTURE_TERRAIN_ID = "surface:terrain";
const PAPER_CAPTURE_WATER_ID = "surface:water";
const PAPER_CAPTURE_VIEW_NAMES = [
  "global",
  "region-1",
  "region-2",
  "region-3",
  "region-4",
  "walk-1",
  "walk-2",
  "walk-3",
  "walk-4",
] as const;

type RegisteredCaptureName = "map" | "isometric" | "oblique" | "walk";
type CaptureVector2 = readonly [number, number];
type CaptureVector3 = readonly [number, number, number];
type PaperCaptureViewName = (typeof PAPER_CAPTURE_VIEW_NAMES)[number];
type PaperCaptureViewRole = "global" | "regional" | "walk";
type PaperCapturePassName = "beauty" | "instance" | "depth" | "normal";

interface PaperCaptureRequest {
  /** Omit to capture all nine views. Duplicates are removed in canonical order. */
  readonly views?: readonly PaperCaptureViewName[];
  /** Present for benchmark captures; copied into the result only after prompt verification. */
  readonly binding?: PaperCaptureBinding | null;
  /** Ordered, preregistered roles for region-1 through region-4. */
  readonly regionalRoles?: readonly string[];
}

interface PaperCaptureBinding {
  readonly suiteId: string;
  readonly caseId: string;
  readonly caseToken: string;
  readonly promptSha256: string;
  readonly regionalReadability: readonly string[];
}

interface PaperCaptureLogicalIdMapping {
  readonly logicalId: string;
  readonly logicalType: "terrain" | "water" | "object";
  readonly objectKind?: string;
  readonly encodedId24: number;
  readonly rgb: readonly [number, number, number];
  readonly colorHex: string;
}

interface PaperCaptureCameraMetadata {
  readonly view: PaperCaptureViewName;
  readonly role: PaperCaptureViewRole;
  readonly ordinal: number;
  readonly projection: "orthographic" | "perspective";
  readonly position: CaptureVector3;
  readonly targetWorld: CaptureVector3;
  readonly targetNormalized: CaptureVector2;
  readonly up: CaptureVector3;
  readonly near: number;
  readonly far: number;
  readonly fovDegrees?: number;
  readonly eyeHeightMeters?: number;
  readonly region?: Readonly<{
    id: string;
    name: string;
    category: TerrainCategory | "fallback";
    radiusNormalized: number;
    selectionSource:
      | "spatially-diverse-plan-region"
      | "highest-terrain-fallback"
      | "preregistered-semantic-role-match";
    requestedSemanticRole?: string;
    semanticMatch?: Readonly<{
      method: "plan-region-semantic-token-and-category-match";
      score: number;
      matchedTerms: readonly string[];
      sourceText: string;
      distinctRegion: true;
    }>;
  }>;
  readonly placementSafety?: Readonly<{
    method: "deterministic-nearby-collider-proxy-search";
    candidateIndex: number;
    candidatesTested: number;
    adjusted: boolean;
    adjustmentDistanceMeters: number;
    terrainHeightMeters: number;
    collidedObjectIds: readonly string[];
    unresolvedObjectIds: readonly string[];
    boundsClamped: boolean;
  }>;
  readonly matrixWorld: readonly number[];
  readonly viewMatrix: readonly number[];
  readonly projectionMatrix: readonly number[];
  readonly matrixSanity: RegisteredCaptureCameraMetadata["matrixSanity"];
  readonly orthographicBounds?: Readonly<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>;
}

interface PaperCaptureImagePass {
  readonly pass: PaperCapturePassName;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

interface PaperCaptureView {
  readonly role: PaperCaptureViewRole;
  readonly ordinal: number;
  readonly width: number;
  readonly height: number;
  readonly camera: PaperCaptureCameraMetadata;
  readonly beauty: PaperCaptureImagePass & {
    readonly postprocessingBypassed: true;
    readonly renderPipeline: "direct-lit-structural-beauty";
    readonly purpose: "camera-matched-structural-comparison";
    readonly visiblePostprocessingEquivalent: false;
    readonly omittedVisibleEffects: readonly ["N8AO", "Bloom", "Vignette"];
    readonly validation: PixelValidation;
  };
  readonly instance: PaperCaptureImagePass & {
    readonly postprocessingBypassed: true;
    readonly geometry: "literal-rendered-terrain-water-and-object-meshes";
    readonly idEncoding: "stable-sorted-logical-id-rgb24";
    readonly backgroundEncodedId24: 0;
    readonly visibility: Readonly<{
      stableAcrossViewsAndSubmeshes: true;
      visiblePixelsByLogicalId: Readonly<Record<string, number>>;
      visibleLogicalIds: readonly string[];
      visibleObjectIds: readonly string[];
      visibleLogicalObjectCount: number;
      visibleObjectCount: number;
      backgroundPixelCount: number;
      invalidIdPixelCount: number;
    }>;
  };
  readonly depth: PaperCaptureImagePass & {
    readonly postprocessingBypassed: true;
    readonly geometry: "literal-rendered-terrain-water-and-object-meshes";
    readonly measurementEncoding: "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel";
    readonly previewEncoding: "linear-near-far-grayscale-u8-alpha-coverage";
    readonly finiteValidation: "geometry-preflight-plus-shader-sentinel-plus-float32-readback";
    readonly runtimeAttestation: "float32-finiteness-and-range-validated-before-lossy-png-preview";
    readonly units: "meters";
    readonly nearMeters: number;
    readonly farMeters: number;
    readonly finiteDepthPixelCount: number;
    readonly nonFiniteDepthPixelCount: number;
    readonly outOfRangeDepthPixelCount: number;
    readonly backgroundPixelCount: number;
    readonly minimumMeters: number | null;
    readonly maximumMeters: number | null;
    readonly meanMeters: number | null;
  };
  readonly normal: PaperCaptureImagePass & {
    readonly postprocessingBypassed: true;
    readonly geometry: "literal-rendered-terrain-water-and-object-meshes";
    readonly encoding: "view-space-geometry-normal-rgb8-alpha-coverage";
    readonly normalMapApplied: false;
    readonly coveredPixelCount: number;
    readonly backgroundPixelCount: number;
  };
}

interface WorldClawPaperCaptureMatrix {
  readonly version: 1;
  readonly worldId: string;
  readonly seed: number;
  readonly binding?: PaperCaptureBinding | null;
  readonly worldPromptSha256?: string;
  readonly worldFingerprint?: string;
  readonly worldFingerprintAlgorithm?: "fnv1a-dual32-canonical-world";
  readonly capturedAt?: string;
  readonly regionalReadability?: readonly string[];
  readonly mimeType: "image/png";
  readonly capturePolicy: Readonly<{
    availableViews: typeof PAPER_CAPTURE_VIEW_NAMES;
    capturedViews: readonly PaperCaptureViewName[];
    defaultRequest: "all-nine-views";
    fixedResolution: Readonly<{ width: number; height: number }>;
    sequential: true;
    maximumViewsPerRequest: 9;
    passesPerView: readonly ["beauty", "instance", "depth", "normal"];
    maximumRawReadbackBytes: number;
    maximumSimultaneousRawReadbackBytes: number;
    rawPixelsRetained: false;
    beautyPipeline: "direct-lit-structural-beauty-not-visible-postprocessed-ui";
    diagnosticPipeline: "literal-geometry-direct-render-postprocessing-bypassed";
  }>;
  readonly logicalIds: Readonly<{
    stableAcrossViewsAndCompiledSubmeshes: true;
    source: "world-object-id-and-rendered-surface-id";
    mapping: readonly PaperCaptureLogicalIdMapping[];
  }>;
  readonly geometryInventory: PaperLiteralGeometryInventory;
  readonly materialAudit: Readonly<{
    verification: "live-mesh-uuid-material-reference-and-property-fingerprint";
    originalMaterialEntryCount: number;
    litMaterialEntryCount: number;
    liveMaterialReferencesUnchangedDuringDiagnostics: true;
    liveMaterialPropertiesUnchangedDuringDiagnostics: true;
    originalMaterialPropertiesRestored: true;
  }>;
  readonly views: Readonly<Partial<Record<PaperCaptureViewName, PaperCaptureView>>>;
  readonly performance: Readonly<{
    totalDurationMs: number;
    encodedPayloadCharacters: number;
    viewDurationMs: Readonly<Partial<Record<PaperCaptureViewName, number>>>;
  }>;
  readonly stateAudit: Readonly<{
    directLitBeautyReportedAsVisiblePostprocessingEquivalent: false;
    liveMaterialStateVerified: true;
    liveCameraStateVerified: true;
    worldFingerprintVerified: true;
  }>;
  readonly isolation: Readonly<{
    worldDataMutated: false;
    liveCameraMutated: false;
    liveMaterialsUsedForDiagnostics: false;
    diagnosticPostprocessingBypassed: true;
    rendererStateRestored: true;
    uiViewModeRestored: true;
    uiSelectionRestored: true;
  }>;
}

interface RegisteredCaptureCameraMetadata {
  readonly view: RegisteredCaptureName;
  readonly source: "registered-map" | "visual-contract";
  readonly projection: "orthographic" | "perspective";
  readonly position: CaptureVector3;
  readonly targetWorld: CaptureVector3;
  readonly targetNormalized: CaptureVector2;
  readonly up: CaptureVector3;
  readonly azimuthDegrees: number;
  readonly elevationDegrees: number;
  readonly distanceScale: number;
  readonly near: number;
  readonly far: number;
  readonly description: string;
  readonly viewMatrix: readonly number[];
  readonly projectionMatrix: readonly number[];
  readonly matrixSanity: Readonly<{
    finite: boolean;
    viewDeterminant: number;
    projectionDeterminant: number;
    worldBasisDeterminant: number;
    reflectionDetected: boolean;
    passed: boolean;
  }>;
  readonly fovDegrees?: number;
  readonly eyeHeightMeters?: number;
  readonly framing?: RegisteredViewFramingMetadata;
  readonly placementSafety?: Readonly<{
    method: "deterministic-nearby-collider-proxy-search";
    adjusted: boolean;
    bearingPreserved: true;
    clearanceRadiusMeters: number;
    gameplayRadiusMeters: number;
    worldHalfExtentMeters: number;
    maximumSearchRadiusMeters: number;
    candidateIndex: number;
    candidatesTested: number;
    originalPosition: CaptureVector3;
    originalTargetWorld: CaptureVector3;
    resolvedPosition: CaptureVector3;
    resolvedTargetWorld: CaptureVector3;
    adjustmentDistanceMeters: number;
    terrainHeightMeters: number;
    waterLevelMeters: number;
    aboveWaterLevelMeters: number;
    minimumLandMarginMeters: number;
    collidedObjectIds: readonly string[];
    unresolvedObjectIds: readonly string[];
    boundsClamped: boolean;
    viewSelection: Readonly<{
      method: "settlement-harbor-collider-proxy-score";
      acceptedCandidateCount: number;
      compositionCandidateCount: number;
      nearbyCompositionCandidateCount: number;
      rejectedNearOccluderCandidateCount: number;
      rejectedVegetationCandidateCount: number;
      rejectedShorelineCandidateCount: number;
      rejectedSubjectCandidateCount: number;
      compositionFallbackUsed: boolean;
      regionCategory: TerrainCategory | "unknown";
      visibleConstructionObjectIds: readonly string[];
      nearVegetationObjectIds: readonly string[];
      vegetationOccluderObjectIds: readonly string[];
      nearConstructionOccluderObjectIds: readonly string[];
      forwardOccluderObjectIds: readonly string[];
      visibleHeroObjectIds: readonly string[];
      visibleHarborObjectIds: readonly string[];
      constructionScore: number;
      vegetationPenalty: number;
      nearConstructionPenalty: number;
      corridorScore: number;
      harborSightlineScore: number;
      forwardClearanceMeters: number;
      minimumConstructionClearanceMeters: number;
      requiredConstructionClearanceMeters: number;
      requiredForwardSightlineMeters: number;
      preferredMaximumAdjustmentMeters: number;
      minimumVegetationClearanceMeters: number;
      requiredVegetationClearanceMeters: number;
      dryNeighborhoodRadiusMeters: number;
      requiredDryNeighborhoodRadiusMeters: number;
      shorelineSafe: boolean;
      vegetationSafe: boolean;
      subjectSafe: boolean;
      inspectionSafe: boolean;
      totalScore: number;
    }>;
  }>;
  readonly orthographicBounds?: Readonly<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>;
}

interface RegisteredWorldBoundsMetadata {
  readonly minimum: CaptureVector3;
  readonly maximum: CaptureVector3;
  readonly center: CaptureVector3;
  readonly size: CaptureVector3;
}

interface RegisteredViewFramingMetadata {
  readonly method: "non-water-terrain-and-collider-proxy-bounds";
  readonly sampleBasis: "literal-terrain-vertices-and-collider-proxy-surfaces";
  readonly paddingRatio: number;
  readonly framingPointCount: number;
  readonly landSampleCount: number;
  readonly objectColliderCount: number;
  readonly targetMajorFill: number;
  readonly minimumValidatedMajorFill: number;
  readonly contentBoundsWorld: RegisteredWorldBoundsMetadata;
  readonly contractTargetWorld: CaptureVector3;
  readonly contractTargetNormalized: CaptureVector2;
  readonly resolvedTargetNormalized: CaptureVector2;
  readonly contractDistanceMeters: number;
  readonly resolvedDistanceMeters: number;
  readonly projectedFill: Readonly<{
    horizontal: number;
    vertical: number;
    major: number;
    minor: number;
    minimumNdc: CaptureVector2;
    maximumNdc: CaptureVector2;
    centerNdc: CaptureVector2;
    finite: boolean;
    withinViewport: boolean;
    centered: boolean;
    tightFramingPassed: boolean;
  }>;
}

interface RegisteredCaptureImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly camera: RegisteredCaptureCameraMetadata;
  readonly validation: Readonly<{
    opaqueCoverage: number;
    luminanceStandardDeviation: number;
    luminanceRange: number;
  }>;
}

interface WorldClawRegisteredCapture {
  readonly version: 1;
  readonly worldId: string;
  readonly seed: number;
  readonly mimeType: "image/png";
  /** Offscreen WebGL render of the lit scene; post-process overlays are omitted. */
  readonly renderPipeline: "direct-lit-validation";
  readonly visualContractSource: string;
  readonly viewports: Readonly<{
    map: Readonly<{ width: number; height: number }>;
    multiAngle: Readonly<{ width: number; height: number }>;
  }>;
  readonly images: Readonly<Record<RegisteredCaptureName, RegisteredCaptureImage>>;
  readonly analysis: RegisteredCaptureAnalysis;
}

interface RegisteredTerrainWaterMask {
  readonly pass: "literal-terrain-geometry-height-threshold";
  readonly width: number;
  readonly height: number;
  readonly orientation: "north-up";
  readonly waterLevelMeters: number;
  readonly objectsExcluded: true;
  readonly categories: Readonly<{
    background: 0;
    water: 1;
    land: 2;
  }>;
  readonly pixelCounts: Readonly<{
    background: number;
    water: number;
    land: number;
  }>;
  readonly pngDataUrl: string;
  readonly rawMask?: Readonly<{
    encoding: "rle-category-u8-count-u16le-base64";
    dataBase64: string;
    runCount: number;
    decodedPixelCount: number;
  }>;
  readonly rawMaskOmittedReason?: string;
}

interface RegisteredObjectProxyMapping {
  readonly objectId: string;
  readonly objectKind: string;
  readonly encodedId24: number;
  readonly rgb: readonly [number, number, number];
  readonly colorHex: string;
  readonly colliderSource: "browser-asset" | "primitive-fallback";
  readonly proxyShape: "vertical-circle-prism" | "vertical-obb-prism";
}

interface RegisteredObjectProxyView {
  readonly width: number;
  readonly height: number;
  readonly pngDataUrl: string;
  readonly visiblePixelsByObjectId: Readonly<Record<string, number>>;
  readonly visibleObjectCount: number;
  readonly backgroundPixels: number;
  readonly invalidColorPixels: number;
}

interface RegisteredHeroReadabilityEvidence {
  readonly method: "stable-rgb24-collider-proxy-pixel-coverage";
  readonly structuralOverview: boolean;
  readonly instances: readonly Readonly<{
    objectId: string;
    objectKind: string;
    visiblePixels: number;
    viewportRatio: number;
  }>[];
  readonly maximumHeroPixels: number;
  readonly maximumHeroViewportRatio: number;
}

interface RegisteredDepthSummary {
  readonly pass: "literal-terrain-plus-collider-proxy-depth";
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly coveredPixels: number;
  readonly backgroundPixels: number;
  readonly coverage: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
  readonly nonFinitePixels: number;
  readonly outOfRangePixels: number;
  readonly finiteNormalized: boolean;
}

interface RegisteredCompiledSlotEvidence {
  readonly expectedCompiledObjectCount: number;
  readonly loadedUniqueObjectSlotCount: number;
  readonly loadedSubmeshInstanceSlotCount: number;
  readonly loadedBatchCount: number;
  readonly matched: boolean;
  readonly missingObjectIds: readonly string[];
  readonly unexpectedObjectIds: readonly string[];
  readonly accounting: "unique-object-ids-across-submesh-batches";
}

interface RegisteredCaptureAnalysis {
  readonly terrainWaterMask: RegisteredTerrainWaterMask;
  readonly objectProxyVisibility: Readonly<{
    pass: "stable-rgb24-collider-proxy-visibility";
    geometry: "vertical-prisms-from-worldColliderForObject";
    occlusion: "literal-terrain-depth-plus-proxy-depth";
    literalObjectMeshes: false;
    idEncoding: "sorted-object-id-sequential-rgb24";
    mapping: readonly RegisteredObjectProxyMapping[];
    views: Readonly<Record<RegisteredCaptureName, RegisteredObjectProxyView>>;
    heroReadabilityByView: Readonly<
      Record<RegisteredCaptureName, RegisteredHeroReadabilityEvidence>
    >;
  }>;
  readonly normalizedDepth: Readonly<Record<RegisteredCaptureName, RegisteredDepthSummary>>;
  readonly compiledSlots: RegisteredCompiledSlotEvidence;
}

interface CaptureViewDefinition {
  readonly name: RegisteredCaptureName;
  readonly width: number;
  readonly height: number;
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly metadata: RegisteredCaptureCameraMetadata;
}

interface PaperCaptureViewDefinition {
  readonly name: PaperCaptureViewName;
  readonly role: PaperCaptureViewRole;
  readonly ordinal: number;
  readonly width: number;
  readonly height: number;
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly metadata: PaperCaptureCameraMetadata;
}

interface PaperRegionAnchor {
  readonly id: string;
  readonly name: string;
  readonly category: TerrainCategory | "fallback";
  readonly targetNormalized: CaptureVector2;
  readonly radiusNormalized: number;
  readonly selectionSource:
    | "spatially-diverse-plan-region"
    | "highest-terrain-fallback"
    | "preregistered-semantic-role-match";
  readonly requestedSemanticRole?: string;
  readonly semanticMatch?: NonNullable<
    NonNullable<PaperCaptureCameraMetadata["region"]>["semanticMatch"]
  >;
}

interface PaperLiteralGeometryInventory {
  readonly terrainMeshCount: number;
  readonly waterMeshCount: number;
  readonly primitiveOrUnbatchedObjectMeshCount: number;
  readonly compiledBatchCount: number;
  readonly compiledSubmeshInstanceSlotCount: number;
  readonly renderedLogicalObjectCount: number;
  readonly expectedLogicalObjectCount: number;
  readonly missingLogicalObjectIds: readonly string[];
  readonly unexpectedLogicalObjectIds: readonly string[];
  readonly compiledLogicalIdAssignmentsStable: boolean;
  readonly geometryAttributeValueCount: number;
  readonly meshWorldMatrixValueCount: number;
  readonly instanceMatrixValueCount: number;
  readonly nonFiniteGeometryValueCount: 0;
  readonly missingNormalAttributeMeshCount: 0;
  readonly geometryFinitePreflightPassed: true;
  readonly diagnosticsUseColliderProxies: false;
}

interface PixelValidation {
  readonly opaqueCoverage: number;
  readonly luminanceStandardDeviation: number;
  readonly luminanceRange: number;
}

interface PaperCameraStateSnapshot {
  readonly uuid: string;
  readonly matrix: readonly number[];
  readonly matrixWorld: readonly number[];
  readonly matrixWorldInverse: readonly number[];
  readonly projectionMatrix: readonly number[];
  readonly projectionMatrixInverse: readonly number[];
}

interface PaperLiveMaterialEntry {
  readonly meshUuid: string;
  readonly references: readonly THREE.Material[];
  readonly propertyFingerprint: string;
}

interface PaperLiveMaterialSnapshot {
  readonly entries: ReadonlyMap<string, PaperLiveMaterialEntry>;
}

function worldTargetFromReference(
  world: WorldSceneType,
  reference: VisualCameraReference,
): THREE.Vector3 {
  const worldSize = world.heightField.worldSize;
  const x = (reference.target[0] - 0.5) * worldSize;
  const z = (reference.target[1] - 0.5) * worldSize;
  return new THREE.Vector3(x, sampleHeight(world.heightField, x, z), z);
}

function positionRegisteredCamera(
  camera: THREE.Camera,
  target: THREE.Vector3,
  reference: VisualCameraReference,
  worldSize: number,
  distanceMeters = worldSize * reference.distanceScale,
): void {
  const azimuth = THREE.MathUtils.degToRad(reference.azimuthDegrees);
  const elevation = THREE.MathUtils.degToRad(reference.elevationDegrees);
  const distance = distanceMeters;
  const horizontalDistance = Math.cos(elevation) * distance;
  camera.position.set(
    target.x + Math.sin(azimuth) * horizontalDistance,
    target.y + Math.sin(elevation) * distance,
    target.z - Math.cos(azimuth) * horizontalDistance,
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

function captureVector3(vector: THREE.Vector3): CaptureVector3 {
  return [vector.x, vector.y, vector.z];
}

function captureCameraMatrices(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
): Pick<RegisteredCaptureCameraMetadata, "viewMatrix" | "projectionMatrix" | "matrixSanity"> {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewMatrix = [...camera.matrixWorldInverse.elements];
  const projectionMatrix = [...camera.projectionMatrix.elements];
  const viewDeterminant = camera.matrixWorldInverse.determinant();
  const projectionDeterminant = camera.projectionMatrix.determinant();
  const worldBasisDeterminant = new THREE.Matrix3()
    .setFromMatrix4(camera.matrixWorld)
    .determinant();
  const finite = [...viewMatrix, ...projectionMatrix].every(Number.isFinite);
  const reflectionDetected = worldBasisDeterminant < 0;
  const passed =
    finite &&
    Math.abs(viewDeterminant - 1) < 1e-5 &&
    Math.abs(projectionDeterminant) > 1e-12 &&
    Math.abs(worldBasisDeterminant - 1) < 1e-5 &&
    !reflectionDetected;
  return {
    viewMatrix,
    projectionMatrix,
    matrixSanity: {
      finite,
      viewDeterminant,
      projectionDeterminant,
      worldBasisDeterminant,
      reflectionDetected,
      passed,
    },
  };
}

interface RegisteredContentBounds {
  readonly box: THREE.Box3;
  readonly framingPoints: readonly THREE.Vector3[];
  readonly center: THREE.Vector3;
  readonly metadata: RegisteredWorldBoundsMetadata;
  readonly landSampleCount: number;
  readonly objectColliderCount: number;
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function ensureMinimumBoxSpan(box: THREE.Box3, worldSize: number): void {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const minimumHorizontalSpan = worldSize * REGISTERED_VIEW_MINIMUM_CONTENT_SPAN_RATIO;
  const halfX = Math.max(size.x, minimumHorizontalSpan) * 0.5;
  const halfZ = Math.max(size.z, minimumHorizontalSpan) * 0.5;
  const halfY = Math.max(size.y, 1) * 0.5;
  box.min.set(center.x - halfX, center.y - halfY, center.z - halfZ);
  box.max.set(center.x + halfX, center.y + halfY, center.z + halfZ);
}

/**
 * Bounds the finite world content rather than the infinite water plane or the
 * full square ocean-floor mesh. Non-water terrain samples establish the land
 * envelope; collider proxies extend it to include boats and authored objects.
 */
function registeredContentBounds(world: WorldSceneType): RegisteredContentBounds {
  const { resolution, worldSize, data } = world.heightField;
  const waterLevelMeters = world.plan.visualContract?.waterLevelMeters ?? 0;
  const hasOceanPlane = world.plan.regions.some((region) => region.category === "ocean");
  const box = new THREE.Box3();
  const framingPoints: THREE.Vector3[] = [];
  const addFramingPoint = (x: number, y: number, z: number) => {
    const point = new THREE.Vector3(x, y, z);
    framingPoints.push(point);
    box.expandByPoint(point);
  };
  let landSampleCount = 0;
  let finiteHeightMinimum = Number.POSITIVE_INFINITY;
  let finiteHeightMaximum = Number.NEGATIVE_INFINITY;

  for (let iy = 0; iy < resolution; iy++) {
    const z = (iy / Math.max(1, resolution - 1) - 0.5) * worldSize;
    for (let ix = 0; ix < resolution; ix++) {
      const index = iy * resolution + ix;
      const height = data[index];
      if (!Number.isFinite(height)) continue;
      finiteHeightMinimum = Math.min(finiteHeightMinimum, height!);
      finiteHeightMaximum = Math.max(finiteHeightMaximum, height!);
      const isLand =
        !hasOceanPlane || height! >= waterLevelMeters + REGISTERED_WALK_LAND_MARGIN_METERS;
      if (!isLand) continue;
      const x = (ix / Math.max(1, resolution - 1) - 0.5) * worldSize;
      addFramingPoint(x, height!, z);
      landSampleCount++;
    }
  }

  if (landSampleCount === 0) {
    const minimumY = Number.isFinite(finiteHeightMinimum) ? finiteHeightMinimum : 0;
    const maximumY = Number.isFinite(finiteHeightMaximum) ? finiteHeightMaximum : minimumY + 1;
    box.set(
      new THREE.Vector3(-worldSize * 0.5, minimumY, -worldSize * 0.5),
      new THREE.Vector3(worldSize * 0.5, maximumY, worldSize * 0.5),
    );
    framingPoints.push(...boxCorners(box));
  }

  const colliders = world.objects.map(worldColliderForObject);
  for (const collider of colliders) {
    for (const [x, z] of colliderSupportPointsXZ(collider)) {
      addFramingPoint(x, collider.bottomY, z);
      addFramingPoint(x, collider.topY, z);
    }
  }

  const boundsBeforeMinimumSpan = box.clone();
  ensureMinimumBoxSpan(box, worldSize);
  const center = box.getCenter(new THREE.Vector3());
  if (
    !box.min.equals(boundsBeforeMinimumSpan.min) ||
    !box.max.equals(boundsBeforeMinimumSpan.max)
  ) {
    framingPoints.push(
      new THREE.Vector3(box.min.x, center.y, center.z),
      new THREE.Vector3(box.max.x, center.y, center.z),
      new THREE.Vector3(center.x, box.min.y, center.z),
      new THREE.Vector3(center.x, box.max.y, center.z),
      new THREE.Vector3(center.x, center.y, box.min.z),
      new THREE.Vector3(center.x, center.y, box.max.z),
    );
  }
  const size = box.getSize(new THREE.Vector3());
  return {
    box,
    framingPoints,
    center,
    metadata: {
      minimum: captureVector3(box.min),
      maximum: captureVector3(box.max),
      center: captureVector3(center),
      size: captureVector3(size),
    },
    landSampleCount,
    objectColliderCount: colliders.length,
  };
}

function centerTargetInCameraPlane(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  target: THREE.Vector3,
  framingPoints: readonly THREE.Vector3[],
): void {
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const relative = new THREE.Vector3();
  let minimumRight = Number.POSITIVE_INFINITY;
  let maximumRight = Number.NEGATIVE_INFINITY;
  let minimumUp = Number.POSITIVE_INFINITY;
  let maximumUp = Number.NEGATIVE_INFINITY;
  for (const point of framingPoints) {
    relative.copy(point).sub(target);
    const rightCoordinate = relative.dot(right);
    const upCoordinate = relative.dot(up);
    minimumRight = Math.min(minimumRight, rightCoordinate);
    maximumRight = Math.max(maximumRight, rightCoordinate);
    minimumUp = Math.min(minimumUp, upCoordinate);
    maximumUp = Math.max(maximumUp, upCoordinate);
  }
  target
    .addScaledVector(right, (minimumRight + maximumRight) * 0.5)
    .addScaledVector(up, (minimumUp + maximumUp) * 0.5);
}

function fitOrthographicCameraToContent(
  camera: THREE.OrthographicCamera,
  framingPoints: readonly THREE.Vector3[],
  aspect: number,
  paddingRatio: number,
): void {
  camera.updateMatrixWorld(true);
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const local = new THREE.Vector3();
  for (const point of framingPoints) {
    local.copy(point).applyMatrix4(camera.matrixWorldInverse);
    minimumX = Math.min(minimumX, local.x);
    maximumX = Math.max(maximumX, local.x);
    minimumY = Math.min(minimumY, local.y);
    maximumY = Math.max(maximumY, local.y);
  }
  const centerX = (minimumX + maximumX) * 0.5;
  const centerY = (minimumY + maximumY) * 0.5;
  const contentWidth = Math.max(0.1, maximumX - minimumX);
  const contentHeight = Math.max(0.1, maximumY - minimumY);
  const halfVertical = Math.max(contentHeight * 0.5, (contentWidth * 0.5) / aspect) * paddingRatio;
  const halfHorizontal = halfVertical * aspect;
  camera.left = centerX - halfHorizontal;
  camera.right = centerX + halfHorizontal;
  camera.top = centerY + halfVertical;
  camera.bottom = centerY - halfVertical;
  camera.updateProjectionMatrix();
}

function fittedPerspectiveDistance(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  framingPoints: readonly THREE.Vector3[],
  paddingRatio: number,
  worldSize: number,
): number {
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const backward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).normalize();
  const tangentVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
  const tangentHorizontal = tangentVertical * camera.aspect;
  let requiredDistance = 0;
  let maximumTowardCamera = Number.NEGATIVE_INFINITY;
  const relative = new THREE.Vector3();
  for (const point of framingPoints) {
    relative.copy(point).sub(target);
    const horizontal = Math.abs(relative.dot(right));
    const vertical = Math.abs(relative.dot(up));
    const towardCamera = relative.dot(backward);
    maximumTowardCamera = Math.max(maximumTowardCamera, towardCamera);
    requiredDistance = Math.max(
      requiredDistance,
      towardCamera + (horizontal * paddingRatio) / Math.max(1e-6, tangentHorizontal),
      towardCamera + (vertical * paddingRatio) / Math.max(1e-6, tangentVertical),
    );
  }
  requiredDistance = Math.max(
    requiredDistance,
    maximumTowardCamera + camera.near * 4,
    worldSize * REGISTERED_VIEW_MINIMUM_CONTENT_SPAN_RATIO,
  );
  return Math.min(worldSize * 8, requiredDistance);
}

function projectedContentFill(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  framingPoints: readonly THREE.Vector3[],
): RegisteredViewFramingMetadata["projectedFill"] {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const projected = new THREE.Vector3();
  for (const point of framingPoints) {
    projected.copy(point).project(camera);
    minimumX = Math.min(minimumX, projected.x);
    minimumY = Math.min(minimumY, projected.y);
    maximumX = Math.max(maximumX, projected.x);
    maximumY = Math.max(maximumY, projected.y);
  }
  const finite = [minimumX, minimumY, maximumX, maximumY].every(Number.isFinite);
  const horizontal = finite ? Math.max(0, (maximumX - minimumX) * 0.5) : 0;
  const vertical = finite ? Math.max(0, (maximumY - minimumY) * 0.5) : 0;
  const major = Math.max(horizontal, vertical);
  const minor = Math.min(horizontal, vertical);
  const centerX = finite ? (minimumX + maximumX) * 0.5 : 0;
  const centerY = finite ? (minimumY + maximumY) * 0.5 : 0;
  const withinViewport =
    finite &&
    minimumX >= -1.0001 &&
    minimumY >= -1.0001 &&
    maximumX <= 1.0001 &&
    maximumY <= 1.0001;
  return {
    horizontal,
    vertical,
    major,
    minor,
    minimumNdc: [minimumX, minimumY],
    maximumNdc: [maximumX, maximumY],
    centerNdc: [centerX, centerY],
    finite,
    withinViewport,
    centered: Math.abs(centerX) <= 0.02 && Math.abs(centerY) <= 0.02,
    tightFramingPassed:
      withinViewport &&
      Math.abs(centerX) <= 0.02 &&
      Math.abs(centerY) <= 0.02 &&
      major >= REGISTERED_VIEW_MINIMUM_VALIDATED_MAJOR_FILL &&
      major <= REGISTERED_VIEW_TARGET_MAJOR_FILL + 0.002,
  };
}

function solvePerspectiveRegisteredFraming(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  reference: VisualCameraReference,
  worldSize: number,
  framingPoints: readonly THREE.Vector3[],
): number {
  let distance = fittedPerspectiveDistance(
    camera,
    target,
    framingPoints,
    REGISTERED_VIEW_FRAMING_PADDING_RATIO,
    worldSize,
  );
  const tangentVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
  const tangentHorizontal = tangentVertical * camera.aspect;
  const maximumShift = worldSize * 0.1;

  for (let iteration = 0; iteration < 4; iteration++) {
    positionRegisteredCamera(camera, target, reference, worldSize, distance);
    const fill = projectedContentFill(camera, framingPoints);
    if (Math.abs(fill.centerNdc[0]) <= 0.002 && Math.abs(fill.centerNdc[1]) <= 0.002) {
      return distance;
    }
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const rightShift = THREE.MathUtils.clamp(
      fill.centerNdc[0] * distance * tangentHorizontal,
      -maximumShift,
      maximumShift,
    );
    const upShift = THREE.MathUtils.clamp(
      fill.centerNdc[1] * distance * tangentVertical,
      -maximumShift,
      maximumShift,
    );
    target.addScaledVector(right, rightShift).addScaledVector(up, upShift);
    positionRegisteredCamera(camera, target, reference, worldSize, distance);
    distance = fittedPerspectiveDistance(
      camera,
      target,
      framingPoints,
      REGISTERED_VIEW_FRAMING_PADDING_RATIO,
      worldSize,
    );
  }

  positionRegisteredCamera(camera, target, reference, worldSize, distance);
  return distance;
}

function assertTightRegisteredFraming(
  view: "isometric" | "oblique",
  fill: RegisteredViewFramingMetadata["projectedFill"],
): void {
  if (fill.tightFramingPassed) return;
  throw new Error(
    `Registered ${view} framing failed projected-content validation: major=${fill.major.toFixed(3)}, ` +
      `target=${REGISTERED_VIEW_TARGET_MAJOR_FILL.toFixed(3)}, ` +
      `center=[${fill.centerNdc.map((value) => value.toFixed(3)).join(",")}], ` +
      `withinViewport=${String(fill.withinViewport)}.`,
  );
}

function normalizedWorldTarget(worldSize: number, target: THREE.Vector3): CaptureVector2 {
  return [target.x / worldSize + 0.5, target.z / worldSize + 0.5];
}

const REGISTERED_WALK_CONSTRUCTION_WEIGHTS: Partial<Record<ObjectKind, number>> = {
  hut: 2,
  house: 2.4,
  tower: 2.4,
  dock: 3,
  ship: 1.8,
  boat: 1.6,
  building: 2.6,
  watchtower: 2.4,
  bunker: 1.8,
  barn: 2,
  market: 2.4,
  pagoda: 3.2,
  torii: 3.2,
  bridge: 3,
  windmill: 2.2,
  well: 1.4,
};

const REGISTERED_WALK_VEGETATION_KINDS = new Set<ObjectKind>(["tree", "palm", "pine"]);
const REGISTERED_WALK_SOLID_CONSTRUCTION_KINDS = new Set<ObjectKind>([
  "hut",
  "house",
  "tower",
  "building",
  "watchtower",
  "bunker",
  "barn",
  "market",
  "pagoda",
  "windmill",
]);
const REGISTERED_WALK_HARBOR_KINDS = new Set<ObjectKind>(["dock", "bridge", "ship", "boat"]);
const REGISTERED_HERO_KINDS = new Set<ObjectKind>(["torii", "pagoda"]);

interface RegisteredWalkViewSelection {
  readonly method: "settlement-harbor-collider-proxy-score";
  readonly acceptedCandidateCount: number;
  readonly compositionCandidateCount: number;
  readonly nearbyCompositionCandidateCount: number;
  readonly rejectedNearOccluderCandidateCount: number;
  readonly rejectedVegetationCandidateCount: number;
  readonly rejectedShorelineCandidateCount: number;
  readonly rejectedSubjectCandidateCount: number;
  readonly compositionFallbackUsed: boolean;
  readonly regionCategory: TerrainCategory | "unknown";
  readonly visibleConstructionObjectIds: readonly string[];
  readonly nearVegetationObjectIds: readonly string[];
  readonly vegetationOccluderObjectIds: readonly string[];
  readonly nearConstructionOccluderObjectIds: readonly string[];
  readonly forwardOccluderObjectIds: readonly string[];
  readonly visibleHeroObjectIds: readonly string[];
  readonly visibleHarborObjectIds: readonly string[];
  readonly constructionScore: number;
  readonly vegetationPenalty: number;
  readonly nearConstructionPenalty: number;
  readonly corridorScore: number;
  readonly harborSightlineScore: number;
  readonly forwardClearanceMeters: number;
  readonly minimumConstructionClearanceMeters: number;
  readonly requiredConstructionClearanceMeters: number;
  readonly requiredForwardSightlineMeters: number;
  readonly preferredMaximumAdjustmentMeters: number;
  readonly minimumVegetationClearanceMeters: number;
  readonly requiredVegetationClearanceMeters: number;
  readonly dryNeighborhoodRadiusMeters: number;
  readonly requiredDryNeighborhoodRadiusMeters: number;
  readonly shorelineSafe: boolean;
  readonly vegetationSafe: boolean;
  readonly subjectSafe: boolean;
  readonly inspectionSafe: boolean;
  readonly totalScore: number;
}

function terrainCategoryAtXZ(
  world: WorldSceneType,
  x: number,
  z: number,
): TerrainCategory | "unknown" {
  const { resolution, worldSize, regionId } = world.heightField;
  const u = x / worldSize + 0.5;
  const v = z / worldSize + 0.5;
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) {
    return "unknown";
  }
  const ix = Math.max(0, Math.min(resolution - 1, Math.round(u * (resolution - 1))));
  const iy = Math.max(0, Math.min(resolution - 1, Math.round(v * (resolution - 1))));
  return world.plan.regions[regionId[iy * resolution + ix] ?? 0]?.category ?? "unknown";
}

function dryNeighborhoodRadiusMeters(
  world: WorldSceneType,
  position: readonly [number, number],
): number {
  const waterLevelMeters = world.plan.visualContract?.waterLevelMeters ?? 0;
  const maximumRadius = Math.max(
    REGISTERED_WALK_MIN_DRY_NEIGHBORHOOD_RADIUS_METERS,
    world.heightField.worldSize * 0.08,
  );
  const step = Math.max(
    0.5,
    world.heightField.worldSize / Math.max(1, world.heightField.resolution),
  );
  const directionCount = 16;
  for (let radius = step; radius <= maximumRadius + 1e-6; radius += step) {
    for (let direction = 0; direction < directionCount; direction++) {
      const angle = (direction * Math.PI * 2) / directionCount;
      const x = position[0] + Math.cos(angle) * radius;
      const z = position[1] + Math.sin(angle) * radius;
      const category = terrainCategoryAtXZ(world, x, z);
      const height = sampleHeight(world.heightField, x, z);
      if (
        category === "ocean" ||
        category === "river" ||
        !Number.isFinite(height) ||
        height < waterLevelMeters + REGISTERED_WALK_LAND_MARGIN_METERS
      ) {
        return Math.max(0, radius - step);
      }
    }
  }
  return maximumRadius;
}

function distanceToColliderXZ(
  position: readonly [number, number],
  collider: WorldColliderProxy,
): number {
  const dx = position[0] - collider.centerX;
  const dz = position[1] - collider.centerZ;
  if (collider.shape === "circle") return Math.max(0, Math.hypot(dx, dz) - collider.radius);
  const cosine = Math.cos(collider.yaw);
  const sine = Math.sin(collider.yaw);
  const localX = cosine * dx - sine * dz;
  const localZ = sine * dx + cosine * dz;
  const outsideX = Math.max(0, Math.abs(localX) - collider.halfWidth);
  const outsideZ = Math.max(0, Math.abs(localZ) - collider.halfDepth);
  return Math.hypot(outsideX, outsideZ);
}

function colliderIntersectsViewCone(
  centerDistance: number,
  facing: number,
  collider: WorldColliderProxy,
  halfAngleRadians: number,
): boolean {
  const radius =
    collider.shape === "circle"
      ? collider.radius
      : Math.hypot(collider.halfWidth, collider.halfDepth);
  if (centerDistance <= radius + 1e-6) return true;
  const centerAngle = Math.acos(THREE.MathUtils.clamp(facing, -1, 1));
  const angularRadius = Math.asin(THREE.MathUtils.clamp(radius / centerDistance, 0, 1));
  return centerAngle - angularRadius <= halfAngleRadians;
}

function scoreRegisteredWalkView(
  world: WorldSceneType,
  position: readonly [number, number],
  outwardBearing: readonly [number, number],
  colliders: readonly WorldColliderProxy[],
  adjustmentDistance: number,
  walkFovDegrees: number,
): Omit<
  RegisteredWalkViewSelection,
  | "method"
  | "acceptedCandidateCount"
  | "compositionCandidateCount"
  | "nearbyCompositionCandidateCount"
  | "rejectedNearOccluderCandidateCount"
  | "rejectedVegetationCandidateCount"
  | "rejectedShorelineCandidateCount"
  | "rejectedSubjectCandidateCount"
  | "compositionFallbackUsed"
> & {
  readonly viewworthy: boolean;
  readonly compositionSafe: boolean;
  readonly nearOccluderSafe: boolean;
} {
  const forwardLength = Math.hypot(outwardBearing[0], outwardBearing[1]) || 1;
  const forwardX = -outwardBearing[0] / forwardLength;
  const forwardZ = -outwardBearing[1] / forwardLength;
  const constructionRange = Math.max(
    18,
    world.heightField.worldSize * REGISTERED_WALK_CONSTRUCTION_RANGE_RATIO,
  );
  const nearVegetationRange = Math.max(
    6,
    world.heightField.worldSize * REGISTERED_WALK_NEAR_VEGETATION_RATIO,
  );
  const walkEyeY =
    sampleHeight(world.heightField, position[0], position[1]) + REGISTERED_WALK_EYE_HEIGHT_METERS;
  const viewConeHalfAngle = THREE.MathUtils.degToRad(walkFovDegrees * 0.5 + 5);
  const visibleConstructionObjectIds: string[] = [];
  const nearVegetationObjectIds: string[] = [];
  const vegetationOccluderObjectIds: string[] = [];
  const nearConstructionOccluderObjectIds: string[] = [];
  const forwardOccluderObjectIds: string[] = [];
  const visibleHeroObjectIds: string[] = [];
  const visibleHarborObjectIds: string[] = [];
  let constructionScore = 0;
  let vegetationPenalty = 0;
  let nearConstructionPenalty = 0;
  let forwardClearanceMeters = constructionRange;
  let minimumConstructionClearanceMeters = constructionRange;
  let minimumVegetationClearanceMeters = constructionRange;
  let leftCorridorScore = 0;
  let rightCorridorScore = 0;
  let harborSightlineScore = 0;

  for (let index = 0; index < world.objects.length; index++) {
    const object = world.objects[index]!;
    const collider = colliders[index]!;
    const dx = collider.centerX - position[0];
    const dz = collider.centerZ - position[1];
    const centerDistance = Math.hypot(dx, dz);
    const distance = distanceToColliderXZ(position, collider);
    const facing = centerDistance > 1e-6 ? (dx * forwardX + dz * forwardZ) / centerDistance : 1;
    const constructionWeight = REGISTERED_WALK_CONSTRUCTION_WEIGHTS[object.kind];
    const isSolidConstruction = REGISTERED_WALK_SOLID_CONSTRUCTION_KINDS.has(object.kind);
    const intersectsViewCone = colliderIntersectsViewCone(
      centerDistance,
      facing,
      collider,
      viewConeHalfAngle,
    );

    if (constructionWeight && facing > 0.05 && distance <= constructionRange) {
      const preferredDistance = Math.max(10, world.heightField.worldSize * 0.12);
      const distanceFactor = Math.max(
        0.2,
        1 - Math.abs(distance - preferredDistance) / Math.max(preferredDistance * 2, 1),
      );
      const facingFactor = 0.35 + Math.max(0, facing) * 0.65;
      constructionScore += constructionWeight * distanceFactor * facingFactor;
      if (intersectsViewCone) {
        visibleConstructionObjectIds.push(object.id);
        if (REGISTERED_HERO_KINDS.has(object.kind)) {
          visibleHeroObjectIds.push(object.id);
        }
      }
    }

    if (
      REGISTERED_WALK_HARBOR_KINDS.has(object.kind) &&
      facing > 0.05 &&
      distance <= constructionRange
    ) {
      const rangeFactor = Math.max(0.15, 1 - distance / constructionRange);
      harborSightlineScore += (constructionWeight ?? 1) * rangeFactor * (0.5 + facing * 0.5);
      if (intersectsViewCone) visibleHarborObjectIds.push(object.id);
    }

    if (isSolidConstruction && facing > -0.35) {
      minimumConstructionClearanceMeters = Math.min(minimumConstructionClearanceMeters, distance);
      if (distance < REGISTERED_WALK_MIN_CONSTRUCTION_CLEARANCE_METERS) {
        const proximity =
          1 - distance / Math.max(REGISTERED_WALK_MIN_CONSTRUCTION_CLEARANCE_METERS, 1e-6);
        nearConstructionPenalty += proximity * (1.5 + Math.max(0, facing) * 2.5);
        nearConstructionOccluderObjectIds.push(object.id);
      }
    }

    if (
      isSolidConstruction &&
      intersectsViewCone &&
      collider.topY >= walkEyeY - 0.45 &&
      distance <= constructionRange
    ) {
      forwardClearanceMeters = Math.min(forwardClearanceMeters, distance);
      forwardOccluderObjectIds.push(object.id);
    }

    if (
      isSolidConstruction &&
      distance >= REGISTERED_WALK_MIN_CONSTRUCTION_CLEARANCE_METERS &&
      distance <= constructionRange * 0.55 &&
      facing > -0.3
    ) {
      const lateral = -forwardZ * dx + forwardX * dz;
      const sideFactor = 1 - Math.min(1, Math.abs(facing));
      const rangeFactor = Math.max(0.15, 1 - distance / (constructionRange * 0.55));
      const contribution = (constructionWeight ?? 1) * (0.4 + sideFactor * 0.6) * rangeFactor;
      if (lateral < 0) leftCorridorScore += contribution;
      else rightCorridorScore += contribution;
    }

    if (
      REGISTERED_WALK_VEGETATION_KINDS.has(object.kind) &&
      facing > -0.2 &&
      distance < nearVegetationRange
    ) {
      const proximity = 1 - distance / nearVegetationRange;
      const forwardWeight = facing > 0.25 ? 2 : 0.8;
      vegetationPenalty += proximity * forwardWeight;
      nearVegetationObjectIds.push(object.id);
      minimumVegetationClearanceMeters = Math.min(minimumVegetationClearanceMeters, distance);
      if (
        intersectsViewCone &&
        collider.topY >= walkEyeY - 0.45 &&
        distance < REGISTERED_WALK_MIN_VEGETATION_CLEARANCE_METERS
      ) {
        vegetationOccluderObjectIds.push(object.id);
      }
    }
  }

  const regionCategory = terrainCategoryAtXZ(world, position[0], position[1]);
  const dryNeighborhoodMeters = dryNeighborhoodRadiusMeters(world, position);
  const regionPreference: Partial<Record<TerrainCategory, number>> = {
    settlement: 3,
    road: 2.5,
    beach: 2,
    sand: 1.5,
    grass: 1,
    hill: 0.25,
    forest: -2.5,
  };
  const openSightlineScore = THREE.MathUtils.clamp(
    (forwardClearanceMeters - REGISTERED_WALK_MIN_FORWARD_SIGHTLINE_METERS) /
      Math.max(1, constructionRange * 0.35),
    0,
    1,
  );
  const corridorScore = Math.min(leftCorridorScore, rightCorridorScore) + openSightlineScore * 2;
  const forwardOcclusionPenalty = Math.max(
    0,
    REGISTERED_WALK_MIN_FORWARD_SIGHTLINE_METERS - forwardClearanceMeters,
  );
  const totalScore =
    constructionScore * 2.5 +
    corridorScore * 6 +
    harborSightlineScore * 7 +
    (regionCategory === "unknown" ? 0 : (regionPreference[regionCategory] ?? 0)) * 2 -
    vegetationPenalty * 10 -
    nearConstructionPenalty * 18 -
    forwardOcclusionPenalty * 5 -
    adjustmentDistance * 0.12;
  const nearOccluderSafe =
    nearConstructionOccluderObjectIds.length === 0 &&
    forwardClearanceMeters >= REGISTERED_WALK_MIN_FORWARD_SIGHTLINE_METERS;
  const vegetationSafe = vegetationOccluderObjectIds.length === 0;
  const shorelineSafe = dryNeighborhoodMeters >= REGISTERED_WALK_MIN_DRY_NEIGHBORHOOD_RADIUS_METERS;
  const subjectSafe =
    visibleConstructionObjectIds.length >= REGISTERED_WALK_MIN_ARCHITECTURE_SUBJECTS &&
    visibleHeroObjectIds.length + visibleHarborObjectIds.length >=
      REGISTERED_WALK_MIN_HERO_OR_HARBOR_SUBJECTS;
  const inspectionSafe = nearOccluderSafe && vegetationSafe && shorelineSafe && subjectSafe;
  return {
    regionCategory,
    visibleConstructionObjectIds,
    nearVegetationObjectIds,
    vegetationOccluderObjectIds,
    nearConstructionOccluderObjectIds,
    forwardOccluderObjectIds,
    visibleHeroObjectIds,
    visibleHarborObjectIds,
    constructionScore,
    vegetationPenalty,
    nearConstructionPenalty,
    corridorScore,
    harborSightlineScore,
    forwardClearanceMeters,
    minimumConstructionClearanceMeters,
    requiredConstructionClearanceMeters: REGISTERED_WALK_MIN_CONSTRUCTION_CLEARANCE_METERS,
    requiredForwardSightlineMeters: REGISTERED_WALK_MIN_FORWARD_SIGHTLINE_METERS,
    preferredMaximumAdjustmentMeters: REGISTERED_WALK_PREFERRED_MAX_ADJUSTMENT_METERS,
    minimumVegetationClearanceMeters,
    requiredVegetationClearanceMeters: REGISTERED_WALK_MIN_VEGETATION_CLEARANCE_METERS,
    dryNeighborhoodRadiusMeters: dryNeighborhoodMeters,
    requiredDryNeighborhoodRadiusMeters: REGISTERED_WALK_MIN_DRY_NEIGHBORHOOD_RADIUS_METERS,
    shorelineSafe,
    vegetationSafe,
    subjectSafe,
    inspectionSafe,
    totalScore,
    compositionSafe: inspectionSafe,
    nearOccluderSafe,
    viewworthy:
      inspectionSafe &&
      nearVegetationObjectIds.length === 0 &&
      (corridorScore >= 1 || harborSightlineScore >= 0.75),
  };
}

interface SafeRegisteredWalkPosition {
  readonly position: readonly [number, number];
  readonly terrainHeightMeters: number;
  readonly candidateIndex: number;
  readonly candidatesTested: number;
  readonly collidedObjectIds: readonly string[];
  readonly unresolvedObjectIds: readonly string[];
  readonly boundsClamped: boolean;
  readonly maximumSearchRadiusMeters: number;
  readonly worldHalfExtentMeters: number;
  readonly viewSelection: RegisteredWalkViewSelection;
}

/**
 * Resolve the authored walk-camera X/Z intent to nearby dry ground. Candidate
 * zero is the exact contract position. Every bounded safe candidate is scored
 * against construction and vegetation collider proxies while preserving the
 * authored bearing. Near-wall candidates leave the preferred pool, and a
 * viewworthy candidate within the intent radius wins before a farther one.
 */
function findSafeRegisteredWalkPosition(
  world: WorldSceneType,
  intendedPosition: readonly [number, number],
  outwardBearing: readonly [number, number],
  walkFovDegrees: number,
): SafeRegisteredWalkPosition {
  const clearanceRadius = REGISTERED_WALK_CLEARANCE_RADIUS_METERS;
  const worldHalfExtent = Math.max(clearanceRadius + 0.1, world.heightField.worldSize * 0.48);
  const maximumSearchRadius = Math.min(
    REGISTERED_WALK_SEARCH_RADIUS_METERS,
    Math.max(0, worldHalfExtent - clearanceRadius - 0.1),
  );
  const ringCount = Math.max(
    0,
    Math.ceil(maximumSearchRadius / REGISTERED_WALK_SEARCH_RING_STEP_METERS),
  );
  const directionOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8];
  const baseAngle = Math.atan2(outwardBearing[1], outwardBearing[0]);
  const colliders = world.objects.map(worldColliderForObject);
  const waterLevelMeters = world.plan.visualContract!.waterLevelMeters;
  let candidateIndex = 0;
  type AcceptedCandidate = SafeRegisteredWalkPosition & {
    readonly viewworthy: boolean;
    readonly compositionSafe: boolean;
    readonly nearOccluderSafe: boolean;
    readonly adjustmentDistanceMeters: number;
  };
  const acceptedCandidates: AcceptedCandidate[] = [];

  const tryCandidate = (candidate: readonly [number, number]) => {
    const currentCandidateIndex = candidateIndex++;
    const resolution = resolveCircleMovementXZ({
      start: [candidate[0], candidate[1]],
      delta: [0, 0],
      radius: clearanceRadius,
      colliders,
      worldHalfExtent,
      maxPushIterations: 16,
    });
    const adjustmentDistance = Math.hypot(
      resolution.position[0] - intendedPosition[0],
      resolution.position[1] - intendedPosition[1],
    );
    const terrainHeightMeters = sampleHeight(
      world.heightField,
      resolution.position[0],
      resolution.position[1],
    );
    const onLand =
      Number.isFinite(terrainHeightMeters) &&
      terrainHeightMeters >= waterLevelMeters + REGISTERED_WALK_LAND_MARGIN_METERS;
    const withinNearbySearch = adjustmentDistance <= maximumSearchRadius + 1e-6;
    const accepted = resolution.unresolvedIds.length === 0 && onLand && withinNearbySearch;
    if (!accepted) return;
    const score = scoreRegisteredWalkView(
      world,
      resolution.position,
      outwardBearing,
      colliders,
      adjustmentDistance,
      walkFovDegrees,
    );
    acceptedCandidates.push({
      position: resolution.position,
      terrainHeightMeters,
      candidateIndex: currentCandidateIndex,
      candidatesTested: 0,
      collidedObjectIds: resolution.collidedIds,
      unresolvedObjectIds: resolution.unresolvedIds,
      boundsClamped: resolution.boundsClamped,
      maximumSearchRadiusMeters: maximumSearchRadius,
      worldHalfExtentMeters: worldHalfExtent,
      viewworthy: score.viewworthy,
      compositionSafe: score.compositionSafe,
      nearOccluderSafe: score.nearOccluderSafe,
      adjustmentDistanceMeters: adjustmentDistance,
      viewSelection: {
        method: "settlement-harbor-collider-proxy-score",
        acceptedCandidateCount: 0,
        compositionCandidateCount: 0,
        nearbyCompositionCandidateCount: 0,
        rejectedNearOccluderCandidateCount: 0,
        rejectedVegetationCandidateCount: 0,
        rejectedShorelineCandidateCount: 0,
        rejectedSubjectCandidateCount: 0,
        compositionFallbackUsed: false,
        regionCategory: score.regionCategory,
        visibleConstructionObjectIds: score.visibleConstructionObjectIds,
        nearVegetationObjectIds: score.nearVegetationObjectIds,
        vegetationOccluderObjectIds: score.vegetationOccluderObjectIds,
        nearConstructionOccluderObjectIds: score.nearConstructionOccluderObjectIds,
        forwardOccluderObjectIds: score.forwardOccluderObjectIds,
        visibleHeroObjectIds: score.visibleHeroObjectIds,
        visibleHarborObjectIds: score.visibleHarborObjectIds,
        constructionScore: score.constructionScore,
        vegetationPenalty: score.vegetationPenalty,
        nearConstructionPenalty: score.nearConstructionPenalty,
        corridorScore: score.corridorScore,
        harborSightlineScore: score.harborSightlineScore,
        forwardClearanceMeters: score.forwardClearanceMeters,
        minimumConstructionClearanceMeters: score.minimumConstructionClearanceMeters,
        requiredConstructionClearanceMeters: score.requiredConstructionClearanceMeters,
        requiredForwardSightlineMeters: score.requiredForwardSightlineMeters,
        preferredMaximumAdjustmentMeters: score.preferredMaximumAdjustmentMeters,
        minimumVegetationClearanceMeters: score.minimumVegetationClearanceMeters,
        requiredVegetationClearanceMeters: score.requiredVegetationClearanceMeters,
        dryNeighborhoodRadiusMeters: score.dryNeighborhoodRadiusMeters,
        requiredDryNeighborhoodRadiusMeters: score.requiredDryNeighborhoodRadiusMeters,
        shorelineSafe: score.shorelineSafe,
        vegetationSafe: score.vegetationSafe,
        subjectSafe: score.subjectSafe,
        inspectionSafe: score.inspectionSafe,
        totalScore: score.totalScore,
      },
    });
  };

  tryCandidate(intendedPosition);

  for (let ring = 1; ring <= ringCount; ring++) {
    const radius = Math.min(maximumSearchRadius, ring * REGISTERED_WALK_SEARCH_RING_STEP_METERS);
    for (const directionOffset of directionOffsets) {
      const angle = baseAngle + (directionOffset * Math.PI * 2) / REGISTERED_WALK_SEARCH_DIRECTIONS;
      tryCandidate([
        intendedPosition[0] + Math.cos(angle) * radius,
        intendedPosition[1] + Math.sin(angle) * radius,
      ]);
    }
  }

  const compositionCandidates = acceptedCandidates.filter((candidate) => candidate.compositionSafe);
  const nearbyCompositionCandidates = compositionCandidates.filter(
    (candidate) =>
      candidate.adjustmentDistanceMeters <= REGISTERED_WALK_PREFERRED_MAX_ADJUSTMENT_METERS,
  );
  const nearbyViewworthyCandidates = nearbyCompositionCandidates.filter(
    (candidate) => candidate.viewworthy,
  );
  const viewworthyCandidates = compositionCandidates.filter((candidate) => candidate.viewworthy);
  const selectionPool =
    nearbyViewworthyCandidates.length > 0
      ? nearbyViewworthyCandidates
      : viewworthyCandidates.length > 0
        ? viewworthyCandidates
        : nearbyCompositionCandidates.length > 0
          ? nearbyCompositionCandidates
          : compositionCandidates.length > 0
            ? compositionCandidates
            : acceptedCandidates;
  selectionPool.sort((a, b) => {
    if (a.viewworthy !== b.viewworthy) return a.viewworthy ? -1 : 1;
    const scoreDifference = b.viewSelection.totalScore - a.viewSelection.totalScore;
    if (Math.abs(scoreDifference) > 1e-9) return scoreDifference;
    const blockerDifference =
      a.viewSelection.nearVegetationObjectIds.length -
      b.viewSelection.nearVegetationObjectIds.length;
    if (blockerDifference !== 0) return blockerDifference;
    return a.candidateIndex - b.candidateIndex;
  });
  const selected = selectionPool[0];
  if (selected) {
    const {
      viewworthy: _viewworthy,
      compositionSafe: _compositionSafe,
      nearOccluderSafe: _nearOccluderSafe,
      adjustmentDistanceMeters: _adjustmentDistanceMeters,
      ...safePosition
    } = selected;
    return {
      ...safePosition,
      candidatesTested: candidateIndex,
      viewSelection: {
        ...selected.viewSelection,
        acceptedCandidateCount: acceptedCandidates.length,
        compositionCandidateCount: compositionCandidates.length,
        nearbyCompositionCandidateCount: nearbyCompositionCandidates.length,
        rejectedNearOccluderCandidateCount: acceptedCandidates.filter(
          (candidate) => !candidate.nearOccluderSafe,
        ).length,
        rejectedVegetationCandidateCount: acceptedCandidates.filter(
          (candidate) => !candidate.viewSelection.vegetationSafe,
        ).length,
        rejectedShorelineCandidateCount: acceptedCandidates.filter(
          (candidate) => !candidate.viewSelection.shorelineSafe,
        ).length,
        rejectedSubjectCandidateCount: acceptedCandidates.filter(
          (candidate) => !candidate.viewSelection.subjectSafe,
        ).length,
        compositionFallbackUsed: compositionCandidates.length === 0,
      },
    };
  }

  throw new Error(
    `Registered walk capture could not find collider-clear dry ground within ${maximumSearchRadius.toFixed(1)}m of its VisualContract position.`,
  );
}

function createRegisteredCaptureViews(world: WorldSceneType): CaptureViewDefinition[] {
  const contract = world.plan.visualContract;
  const isometric = contract?.cameras.find((camera) => camera.view === "isometric");
  const oblique = contract?.cameras.find((camera) => camera.view === "oblique");
  const walk = contract?.cameras.find((camera) => camera.view === "walk");
  if (!contract || !isometric || !oblique || !walk) {
    throw new Error(
      "Registered capture requires isometric, oblique, and walk VisualContract cameras.",
    );
  }

  const worldSize = world.heightField.worldSize;
  const multiAngleAspect =
    REGISTERED_PERSPECTIVE_CAPTURE_WIDTH / REGISTERED_PERSPECTIVE_CAPTURE_HEIGHT;
  const contentBounds = registeredContentBounds(world);
  const mapHalfVertical = worldSize * 0.57;
  const mapHalfHorizontal = mapHalfVertical;
  const mapTarget = new THREE.Vector3(0, 0, 0);
  const mapCamera = new THREE.OrthographicCamera(
    -mapHalfHorizontal,
    mapHalfHorizontal,
    mapHalfVertical,
    -mapHalfVertical,
    0.1,
    worldSize * 3,
  );
  mapCamera.position.set(0, worldSize * 1.25, 0);
  // Matches RegisteredMapCamera's rotation: image-up is world north (-Z).
  mapCamera.up.set(0, 0, -1);
  mapCamera.lookAt(mapTarget);
  mapCamera.updateProjectionMatrix();
  mapCamera.updateMatrixWorld(true);

  const isometricContractTarget = worldTargetFromReference(world, isometric);
  const isometricTarget = contentBounds.center.clone();
  const isometricContractDistance = worldSize * isometric.distanceScale;
  const isometricDistance = Math.max(
    isometricContractDistance,
    contentBounds.box.getSize(new THREE.Vector3()).length() * 1.2,
  );
  const isometricCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    Math.max(0.1, worldSize * 0.002),
    Math.max(900, isometricDistance + worldSize * 6),
  );
  positionRegisteredCamera(
    isometricCamera,
    isometricTarget,
    isometric,
    worldSize,
    isometricDistance,
  );
  centerTargetInCameraPlane(isometricCamera, isometricTarget, contentBounds.framingPoints);
  positionRegisteredCamera(
    isometricCamera,
    isometricTarget,
    isometric,
    worldSize,
    isometricDistance,
  );
  fitOrthographicCameraToContent(
    isometricCamera,
    contentBounds.framingPoints,
    multiAngleAspect,
    REGISTERED_VIEW_FRAMING_PADDING_RATIO,
  );
  const isometricProjectedFill = projectedContentFill(isometricCamera, contentBounds.framingPoints);
  assertTightRegisteredFraming("isometric", isometricProjectedFill);

  const obliqueContractTarget = worldTargetFromReference(world, oblique);
  const obliqueTarget = contentBounds.center.clone();
  const obliqueContractDistance = worldSize * oblique.distanceScale;
  const obliqueCamera = new THREE.PerspectiveCamera(
    oblique.fovDegrees ?? 50,
    multiAngleAspect,
    Math.max(0.1, worldSize * 0.002),
    Math.max(900, obliqueContractDistance + worldSize * 6),
  );
  positionRegisteredCamera(
    obliqueCamera,
    obliqueTarget,
    oblique,
    worldSize,
    obliqueContractDistance,
  );
  centerTargetInCameraPlane(obliqueCamera, obliqueTarget, contentBounds.framingPoints);
  const obliqueDistance = solvePerspectiveRegisteredFraming(
    obliqueCamera,
    obliqueTarget,
    oblique,
    worldSize,
    contentBounds.framingPoints,
  );
  obliqueCamera.far = Math.max(900, obliqueDistance + worldSize * 6);
  positionRegisteredCamera(obliqueCamera, obliqueTarget, oblique, worldSize, obliqueDistance);
  obliqueCamera.updateProjectionMatrix();
  const obliqueProjectedFill = projectedContentFill(obliqueCamera, contentBounds.framingPoints);
  assertTightRegisteredFraming("oblique", obliqueProjectedFill);

  // Walk uses the contract's X/Z registration and bearing, but its Y is
  // grounded at a real human eye height instead of orbiting around the target.
  const walkContractTarget = worldTargetFromReference(world, walk);
  const walkAzimuth = THREE.MathUtils.degToRad(walk.azimuthDegrees);
  const walkElevation = THREE.MathUtils.degToRad(walk.elevationDegrees);
  const walkFovDegrees = walk.fovDegrees ?? 58;
  const walkDistance = worldSize * walk.distanceScale;
  const intendedWalkX = walkContractTarget.x + Math.sin(walkAzimuth) * walkDistance;
  const intendedWalkZ = walkContractTarget.z - Math.cos(walkAzimuth) * walkDistance;
  const intendedWalkGroundY = sampleHeight(world.heightField, intendedWalkX, intendedWalkZ);
  const intendedWalkEyeY = intendedWalkGroundY + REGISTERED_WALK_EYE_HEIGHT_METERS;
  const intendedWalkPosition = new THREE.Vector3(intendedWalkX, intendedWalkEyeY, intendedWalkZ);
  const intendedWalkTarget = new THREE.Vector3(
    walkContractTarget.x,
    intendedWalkEyeY - Math.tan(walkElevation) * walkDistance,
    walkContractTarget.z,
  );
  const safeWalkPosition = findSafeRegisteredWalkPosition(
    world,
    [intendedWalkX, intendedWalkZ],
    [Math.sin(walkAzimuth), -Math.cos(walkAzimuth)],
    walkFovDegrees,
  );
  const walkEyeY = safeWalkPosition.terrainHeightMeters + REGISTERED_WALK_EYE_HEIGHT_METERS;
  const walkPosition = new THREE.Vector3(
    safeWalkPosition.position[0],
    walkEyeY,
    safeWalkPosition.position[1],
  );
  // Translate the target with the resolved camera so azimuth/elevation remain
  // exactly the authored contract bearing instead of silently re-aiming it.
  const walkAdjustment = walkPosition.clone().sub(intendedWalkPosition);
  const walkTarget = intendedWalkTarget.clone().add(walkAdjustment);
  const walkCamera = new THREE.PerspectiveCamera(
    walkFovDegrees,
    multiAngleAspect,
    0.1,
    Math.max(900, walkDistance + worldSize * 6),
  );
  walkCamera.position.copy(walkPosition);
  walkCamera.up.set(0, 1, 0);
  walkCamera.lookAt(walkTarget);
  walkCamera.updateProjectionMatrix();
  walkCamera.updateMatrixWorld(true);

  return [
    {
      name: "map",
      width: REGISTERED_MAP_CAPTURE_SIZE,
      height: REGISTERED_MAP_CAPTURE_SIZE,
      camera: mapCamera,
      metadata: {
        view: "map",
        source: "registered-map",
        projection: "orthographic",
        position: captureVector3(mapCamera.position),
        targetWorld: captureVector3(mapTarget),
        targetNormalized: [0.5, 0.5],
        up: captureVector3(mapCamera.up),
        azimuthDegrees: 0,
        elevationDegrees: 90,
        distanceScale: 1.25,
        near: mapCamera.near,
        far: mapCamera.far,
        description: "North-up square registered map overview",
        ...captureCameraMatrices(mapCamera),
        orthographicBounds: {
          left: mapCamera.left,
          right: mapCamera.right,
          top: mapCamera.top,
          bottom: mapCamera.bottom,
        },
      },
    },
    {
      name: "isometric",
      width: REGISTERED_PERSPECTIVE_CAPTURE_WIDTH,
      height: REGISTERED_PERSPECTIVE_CAPTURE_HEIGHT,
      camera: isometricCamera,
      metadata: {
        view: "isometric",
        source: "visual-contract",
        projection: "orthographic",
        position: captureVector3(isometricCamera.position),
        targetWorld: captureVector3(isometricTarget),
        targetNormalized: normalizedWorldTarget(worldSize, isometricTarget),
        up: captureVector3(isometricCamera.up),
        azimuthDegrees: isometric.azimuthDegrees,
        elevationDegrees: isometric.elevationDegrees,
        distanceScale: isometricDistance / worldSize,
        near: isometricCamera.near,
        far: isometricCamera.far,
        description: isometric.description,
        framing: {
          method: "non-water-terrain-and-collider-proxy-bounds",
          sampleBasis: "literal-terrain-vertices-and-collider-proxy-surfaces",
          paddingRatio: REGISTERED_VIEW_FRAMING_PADDING_RATIO,
          framingPointCount: contentBounds.framingPoints.length,
          landSampleCount: contentBounds.landSampleCount,
          objectColliderCount: contentBounds.objectColliderCount,
          targetMajorFill: REGISTERED_VIEW_TARGET_MAJOR_FILL,
          minimumValidatedMajorFill: REGISTERED_VIEW_MINIMUM_VALIDATED_MAJOR_FILL,
          contentBoundsWorld: contentBounds.metadata,
          contractTargetWorld: captureVector3(isometricContractTarget),
          contractTargetNormalized: [...isometric.target],
          resolvedTargetNormalized: normalizedWorldTarget(worldSize, isometricTarget),
          contractDistanceMeters: isometricContractDistance,
          resolvedDistanceMeters: isometricDistance,
          projectedFill: isometricProjectedFill,
        },
        ...captureCameraMatrices(isometricCamera),
        orthographicBounds: {
          left: isometricCamera.left,
          right: isometricCamera.right,
          top: isometricCamera.top,
          bottom: isometricCamera.bottom,
        },
      },
    },
    {
      name: "oblique",
      width: REGISTERED_PERSPECTIVE_CAPTURE_WIDTH,
      height: REGISTERED_PERSPECTIVE_CAPTURE_HEIGHT,
      camera: obliqueCamera,
      metadata: {
        view: "oblique",
        source: "visual-contract",
        projection: "perspective",
        position: captureVector3(obliqueCamera.position),
        targetWorld: captureVector3(obliqueTarget),
        targetNormalized: normalizedWorldTarget(worldSize, obliqueTarget),
        up: captureVector3(obliqueCamera.up),
        azimuthDegrees: oblique.azimuthDegrees,
        elevationDegrees: oblique.elevationDegrees,
        distanceScale: obliqueDistance / worldSize,
        near: obliqueCamera.near,
        far: obliqueCamera.far,
        description: oblique.description,
        fovDegrees: obliqueCamera.fov,
        framing: {
          method: "non-water-terrain-and-collider-proxy-bounds",
          sampleBasis: "literal-terrain-vertices-and-collider-proxy-surfaces",
          paddingRatio: REGISTERED_VIEW_FRAMING_PADDING_RATIO,
          framingPointCount: contentBounds.framingPoints.length,
          landSampleCount: contentBounds.landSampleCount,
          objectColliderCount: contentBounds.objectColliderCount,
          targetMajorFill: REGISTERED_VIEW_TARGET_MAJOR_FILL,
          minimumValidatedMajorFill: REGISTERED_VIEW_MINIMUM_VALIDATED_MAJOR_FILL,
          contentBoundsWorld: contentBounds.metadata,
          contractTargetWorld: captureVector3(obliqueContractTarget),
          contractTargetNormalized: [...oblique.target],
          resolvedTargetNormalized: normalizedWorldTarget(worldSize, obliqueTarget),
          contractDistanceMeters: obliqueContractDistance,
          resolvedDistanceMeters: obliqueDistance,
          projectedFill: obliqueProjectedFill,
        },
        ...captureCameraMatrices(obliqueCamera),
      },
    },
    {
      name: "walk",
      width: REGISTERED_PERSPECTIVE_CAPTURE_WIDTH,
      height: REGISTERED_PERSPECTIVE_CAPTURE_HEIGHT,
      camera: walkCamera,
      metadata: {
        view: "walk",
        source: "visual-contract",
        projection: "perspective",
        position: captureVector3(walkCamera.position),
        targetWorld: captureVector3(walkTarget),
        targetNormalized: [...walk.target],
        up: captureVector3(walkCamera.up),
        azimuthDegrees: walk.azimuthDegrees,
        elevationDegrees: walk.elevationDegrees,
        distanceScale: walk.distanceScale,
        near: walkCamera.near,
        far: walkCamera.far,
        description: walk.description,
        fovDegrees: walkCamera.fov,
        eyeHeightMeters: REGISTERED_WALK_EYE_HEIGHT_METERS,
        placementSafety: {
          method: "deterministic-nearby-collider-proxy-search",
          adjusted: walkAdjustment.lengthSq() > 1e-12,
          bearingPreserved: true,
          clearanceRadiusMeters: REGISTERED_WALK_CLEARANCE_RADIUS_METERS,
          gameplayRadiusMeters: WALK_COLLIDER_RADIUS,
          worldHalfExtentMeters: safeWalkPosition.worldHalfExtentMeters,
          maximumSearchRadiusMeters: safeWalkPosition.maximumSearchRadiusMeters,
          candidateIndex: safeWalkPosition.candidateIndex,
          candidatesTested: safeWalkPosition.candidatesTested,
          originalPosition: captureVector3(intendedWalkPosition),
          originalTargetWorld: captureVector3(intendedWalkTarget),
          resolvedPosition: captureVector3(walkPosition),
          resolvedTargetWorld: captureVector3(walkTarget),
          adjustmentDistanceMeters: Math.hypot(
            walkPosition.x - intendedWalkPosition.x,
            walkPosition.z - intendedWalkPosition.z,
          ),
          terrainHeightMeters: safeWalkPosition.terrainHeightMeters,
          waterLevelMeters: contract.waterLevelMeters,
          aboveWaterLevelMeters: safeWalkPosition.terrainHeightMeters - contract.waterLevelMeters,
          minimumLandMarginMeters: REGISTERED_WALK_LAND_MARGIN_METERS,
          collidedObjectIds: safeWalkPosition.collidedObjectIds,
          unresolvedObjectIds: safeWalkPosition.unresolvedObjectIds,
          boundsClamped: safeWalkPosition.boundsClamped,
          viewSelection: safeWalkPosition.viewSelection,
        },
        ...captureCameraMatrices(walkCamera),
      },
    },
  ];
}

export function resolvePaperCaptureViewNames(
  request: PaperCaptureRequest | undefined,
): PaperCaptureViewName[] {
  if (request?.views === undefined) return [...PAPER_CAPTURE_VIEW_NAMES];
  if (!Array.isArray(request.views) || request.views.length === 0) {
    throw new Error("Paper capture requires at least one view when views is provided.");
  }
  const requested = new Set<string>();
  for (const view of request.views) {
    if (!(PAPER_CAPTURE_VIEW_NAMES as readonly string[]).includes(view)) {
      throw new Error(`Unknown paper capture view: ${String(view)}.`);
    }
    requested.add(view);
  }
  return PAPER_CAPTURE_VIEW_NAMES.filter((view) => requested.has(view));
}

function resolvePaperCaptureBinding(
  binding: PaperCaptureRequest["binding"],
): PaperCaptureBinding | null {
  if (binding === undefined || binding === null) return null;
  if (typeof binding !== "object") {
    throw new Error("Paper capture binding must be an object.");
  }
  const regionalReadability = resolvePaperRegionalRoles(binding.regionalReadability);
  if (!regionalReadability) {
    throw new Error("Paper capture binding omitted regional readability roles.");
  }
  const normalized: PaperCaptureBinding = {
    suiteId: binding.suiteId,
    caseId: binding.caseId,
    caseToken: binding.caseToken,
    promptSha256: binding.promptSha256,
    regionalReadability,
  };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(normalized.suiteId)) {
    throw new Error("Paper capture suite binding is invalid.");
  }
  if (!/^figure-\d{2}-[a-z0-9-]{1,100}$/.test(normalized.caseId)) {
    throw new Error("Paper capture case binding is invalid.");
  }
  if (!/^[a-f0-9]{32,64}$/.test(normalized.caseToken)) {
    throw new Error("Paper capture case token is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(normalized.promptSha256)) {
    throw new Error("Paper capture prompt hash is invalid.");
  }
  return Object.freeze(normalized);
}

function resolvePaperRegionalRoles(value: PaperCaptureRequest["regionalRoles"]): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("Bound paper capture requires exactly four ordered regional roles.");
  }
  return value.map((role, index) => {
    if (typeof role !== "string") {
      throw new Error(`Paper regional role ${index + 1} must be text.`);
    }
    const normalized = role.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 120) {
      throw new Error(`Paper regional role ${index + 1} is empty or exceeds 120 characters.`);
    }
    return normalized;
  });
}

async function paperPromptSha256(prompt: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Paper capture requires browser SHA-256 support.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function highestTerrainPaperAnchor(world: WorldSceneType): PaperRegionAnchor {
  const { data, resolution } = world.heightField;
  let bestIndex = 0;
  let bestHeight = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < data.length; index++) {
    const height = data[index];
    if (height !== undefined && Number.isFinite(height) && height > bestHeight) {
      bestHeight = height;
      bestIndex = index;
    }
  }
  const ix = bestIndex % Math.max(1, resolution);
  const iy = Math.floor(bestIndex / Math.max(1, resolution));
  return {
    id: "terrain-high-point",
    name: "Highest finite terrain",
    category: "fallback",
    targetNormalized: [
      resolution <= 1 ? 0.5 : ix / (resolution - 1),
      resolution <= 1 ? 0.5 : iy / (resolution - 1),
    ],
    radiusNormalized: 0.16,
    selectionSource: "highest-terrain-fallback",
  };
}

const PAPER_ROLE_STOP_WORDS = new Set(["a", "an", "and", "of", "the"]);
const PAPER_ROLE_SYNONYM_GROUPS = [
  ["town", "village", "settlement", "district", "community"],
  ["coastal", "coast", "waterside", "waterfront", "riverbank", "bank", "harbor", "anchorage"],
  ["hill", "hillside", "mountain", "ridge", "cliff", "rim", "perch"],
  ["facility", "compound", "base", "outpost", "camp", "lair"],
  ["vehicle", "tank", "staging"],
  ["communications", "antenna", "satellite", "radio"],
  ["shrine", "pagoda", "torii", "ritual"],
  ["mine", "pit", "gemstone", "crystal", "seam", "processing", "level", "exposed"],
  ["crossing", "bridge", "ford"],
  ["battlefield", "battle", "fortified", "fortress", "watchtower"],
  ["open", "plain", "pastoral", "corridor", "route", "yard"],
  ["industrial", "processing", "equipment"],
  ["vegetated", "vegetation", "forest", "jungle", "bamboo", "grass"],
  ["interior", "inland"],
  ["frozen", "ice", "snow"],
  ["adventure", "camp", "tent", "campfire"],
];

function paperRoleTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !PAPER_ROLE_STOP_WORDS.has(token));
}

function expandedPaperRoleTokens(values: readonly string[]): Set<string> {
  const expanded = new Set(values);
  for (const token of values) {
    for (const group of PAPER_ROLE_SYNONYM_GROUPS) {
      if (group.includes(token)) for (const synonym of group) expanded.add(synonym);
    }
  }
  return expanded;
}

function paperRegionSemanticSource(
  world: WorldSceneType,
  region: WorldSceneType["plan"]["regions"][number],
) {
  const nearbyWater = world.plan.regions.some(
    (candidate) =>
      ["ocean", "river", "beach", "ice"].includes(candidate.category) &&
      Math.hypot(candidate.center[0] - region.center[0], candidate.center[1] - region.center[1]) <=
        candidate.radius + region.radius + 0.12,
  );
  const regionObjects = world.objects.filter((object) => object.regionId === region.id);
  const derived = [
    region.center[0] < 0.42 ? "left bank" : region.center[0] > 0.58 ? "right bank" : "central",
    nearbyWater ? "coastal waterside waterfront riverbank harbor anchorage" : "inland",
    region.baseElevation >= 2 ? "hill hillside mountain ridge cliff perch" : "valley plain",
    regionObjects.length <= 2 ? "open corridor route yard area" : "active developed",
  ];
  const sourceText = [
    region.name,
    region.role,
    region.category,
    ...derived,
    ...regionObjects.flatMap((object) => [object.kind, object.label]),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  return { sourceText, expandedTokens: expandedPaperRoleTokens(paperRoleTokens(sourceText)) };
}

function selectSemanticPaperRegionAnchors(
  world: WorldSceneType,
  regionalRoles: readonly string[],
): PaperRegionAnchor[] {
  const candidates = world.plan.regions.filter(
    (region) => region.category !== "ocean" && region.category !== "river",
  );
  if (candidates.length < 4) {
    throw new Error(
      `Bound paper capture needs four distinct planned land regions; found ${candidates.length}.`,
    );
  }
  const evidence = candidates.map((region) => {
    const semantic = paperRegionSemanticSource(world, region);
    return { region, ...semantic };
  });
  const matches = regionalRoles.map((role) => {
    const roleTokens = paperRoleTokens(role);
    if (roleTokens.length === 0)
      throw new Error(`Paper regional role "${role}" has no semantic tokens.`);
    const requiredMatchedTermCount = Math.max(1, Math.ceil(roleTokens.length / 2));
    return evidence.map((candidate) => {
      const matchedTerms = roleTokens.filter((token) => candidate.expandedTokens.has(token));
      const score = matchedTerms.length / roleTokens.length;
      return { candidate, score, matchedTerms, requiredMatchedTermCount };
    });
  });

  let best: { score: number; selections: Array<(typeof matches)[number][number]> } | undefined;
  const search = (
    roleIndex: number,
    used: Set<string>,
    score: number,
    selections: Array<(typeof matches)[number][number]>,
  ) => {
    if (roleIndex === regionalRoles.length) {
      const tieKey = selections.map((selection) => selection.candidate.region.id).join("\0");
      const bestTieKey = best?.selections
        .map((selection) => selection.candidate.region.id)
        .join("\0");
      if (
        !best ||
        score > best.score + 1e-12 ||
        (Math.abs(score - best.score) <= 1e-12 && tieKey < bestTieKey!)
      ) {
        best = { score, selections: [...selections] };
      }
      return;
    }
    for (const selection of matches[roleIndex]!) {
      const id = selection.candidate.region.id;
      if (used.has(id) || selection.matchedTerms.length < selection.requiredMatchedTermCount) {
        continue;
      }
      used.add(id);
      selections.push(selection);
      search(roleIndex + 1, used, score + selection.score, selections);
      selections.pop();
      used.delete(id);
    }
  };
  search(0, new Set(), 0, []);
  if (!best || best.selections.length !== 4) {
    throw new Error(
      "Bound paper capture could not evidence four distinct semantic region-role matches.",
    );
  }
  return best.selections.map((selection, index) => {
    const { region, sourceText } = selection.candidate;
    return {
      id: region.id,
      name: region.name,
      category: region.category,
      targetNormalized: [region.center[0], region.center[1]],
      radiusNormalized: THREE.MathUtils.clamp(region.radius, 0.04, 0.5),
      selectionSource: "preregistered-semantic-role-match",
      requestedSemanticRole: regionalRoles[index],
      semanticMatch: {
        method: "plan-region-semantic-token-and-category-match",
        score: selection.score,
        matchedTerms: selection.matchedTerms,
        sourceText,
        distinctRegion: true,
      },
    };
  });
}

/**
 * Select broad, spatially distinct land roles rather than trusting provider
 * array order. Ties are resolved by stable region id and any shortfall is
 * filled by revisiting the selected anchors from a different camera azimuth.
 */
function selectPaperRegionAnchors(
  world: WorldSceneType,
  regionalRoles: readonly string[] | null = null,
): PaperRegionAnchor[] {
  if (regionalRoles) return selectSemanticPaperRegionAnchors(world, regionalRoles);
  const candidates: PaperRegionAnchor[] = world.plan.regions
    .filter((region) => region.category !== "ocean" && region.category !== "river")
    .map((region) => ({
      id: region.id,
      name: region.name,
      category: region.category,
      targetNormalized: [region.center[0], region.center[1]],
      radiusNormalized: THREE.MathUtils.clamp(region.radius, 0.04, 0.5),
      selectionSource: "spatially-diverse-plan-region" as const,
    }));

  if (candidates.length === 0) candidates.push(highestTerrainPaperAnchor(world));
  const remaining = [...candidates];
  const selected: PaperRegionAnchor[] = [];
  while (remaining.length > 0 && selected.length < 4) {
    remaining.sort((left, right) => {
      if (selected.length === 0) {
        const radiusDifference = right.radiusNormalized - left.radiusNormalized;
        if (Math.abs(radiusDifference) > 1e-12) return radiusDifference;
      } else {
        const minimumDistanceSquared = (candidate: PaperRegionAnchor) =>
          Math.min(
            ...selected.map((anchor) => {
              const dx = candidate.targetNormalized[0] - anchor.targetNormalized[0];
              const dz = candidate.targetNormalized[1] - anchor.targetNormalized[1];
              return dx * dx + dz * dz;
            }),
          );
        const distanceDifference = minimumDistanceSquared(right) - minimumDistanceSquared(left);
        if (Math.abs(distanceDifference) > 1e-12) return distanceDifference;
      }
      return left.id.localeCompare(right.id);
    });
    selected.push(remaining.shift()!);
  }
  const distinctCount = selected.length;
  while (selected.length < 4) selected.push(selected[selected.length % distinctCount]!);
  return selected;
}

function paperCameraMatrixMetadata(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
): Pick<
  PaperCaptureCameraMetadata,
  "matrixWorld" | "viewMatrix" | "projectionMatrix" | "matrixSanity"
> {
  const registered = captureCameraMatrices(camera);
  return {
    matrixWorld: [...camera.matrixWorld.elements],
    ...registered,
  };
}

function paperRegionMetadata(
  anchor: PaperRegionAnchor,
): NonNullable<PaperCaptureCameraMetadata["region"]> {
  return {
    id: anchor.id,
    name: anchor.name,
    category: anchor.category,
    radiusNormalized: anchor.radiusNormalized,
    selectionSource: anchor.selectionSource,
    requestedSemanticRole: anchor.requestedSemanticRole,
    semanticMatch: anchor.semanticMatch,
  };
}

function createPaperCaptureViews(
  world: WorldSceneType,
  regionalRoles: readonly string[] | null = null,
): PaperCaptureViewDefinition[] {
  if (!world.plan.visualContract) {
    throw new Error("Paper capture requires a completed VisualContract.");
  }
  const width = PAPER_CAPTURE_WIDTH;
  const height = PAPER_CAPTURE_HEIGHT;
  const aspect = width / height;
  const worldSize = world.heightField.worldSize;
  const contentBounds = registeredContentBounds(world);
  const views: PaperCaptureViewDefinition[] = [];

  const globalTarget = contentBounds.center.clone();
  const globalReference: VisualCameraReference = {
    view: "isometric",
    azimuthDegrees: 45,
    elevationDegrees: 48,
    target: normalizedWorldTarget(worldSize, globalTarget) as [number, number],
    distanceScale: 2,
    projection: "orthographic",
    orthographicScale: 1,
    panelCropNormalized: [0, 0, 1, 1],
    description: "Global structural overview",
  };
  const globalCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    Math.max(0.1, worldSize * 0.002),
    Math.max(900, worldSize * 8),
  );
  positionRegisteredCamera(globalCamera, globalTarget, globalReference, worldSize, worldSize * 2);
  centerTargetInCameraPlane(globalCamera, globalTarget, contentBounds.framingPoints);
  positionRegisteredCamera(globalCamera, globalTarget, globalReference, worldSize, worldSize * 2);
  fitOrthographicCameraToContent(
    globalCamera,
    contentBounds.framingPoints,
    aspect,
    REGISTERED_VIEW_FRAMING_PADDING_RATIO,
  );
  views.push({
    name: "global",
    role: "global",
    ordinal: 1,
    width,
    height,
    camera: globalCamera,
    metadata: {
      view: "global",
      role: "global",
      ordinal: 1,
      projection: "orthographic",
      position: captureVector3(globalCamera.position),
      targetWorld: captureVector3(globalTarget),
      targetNormalized: normalizedWorldTarget(worldSize, globalTarget),
      up: captureVector3(globalCamera.up),
      near: globalCamera.near,
      far: globalCamera.far,
      ...paperCameraMatrixMetadata(globalCamera),
      orthographicBounds: {
        left: globalCamera.left,
        right: globalCamera.right,
        top: globalCamera.top,
        bottom: globalCamera.bottom,
      },
    },
  });

  const anchors = selectPaperRegionAnchors(world, regionalRoles);
  const azimuths = [45, 135, 225, 315] as const;
  for (let index = 0; index < 4; index++) {
    const anchor = anchors[index]!;
    const target = new THREE.Vector3(
      (anchor.targetNormalized[0] - 0.5) * worldSize,
      0,
      (anchor.targetNormalized[1] - 0.5) * worldSize,
    );
    target.y =
      sampleHeight(world.heightField, target.x, target.z) + Math.max(0.5, worldSize * 0.01);
    const distance = THREE.MathUtils.clamp(
      anchor.radiusNormalized * worldSize * 2.6,
      worldSize * 0.16,
      worldSize * 0.72,
    );
    const reference: VisualCameraReference = {
      view: "oblique",
      azimuthDegrees: azimuths[index]!,
      elevationDegrees: 38,
      target: [...anchor.targetNormalized],
      distanceScale: distance / worldSize,
      projection: "perspective",
      fovDegrees: 48,
      panelCropNormalized: [0, 0, 1, 1],
      description: `Regional view ${index + 1}: ${anchor.name}`,
    };
    const camera = new THREE.PerspectiveCamera(
      reference.fovDegrees,
      aspect,
      Math.max(0.1, worldSize * 0.001),
      Math.max(900, distance + worldSize * 6),
    );
    positionRegisteredCamera(camera, target, reference, worldSize, distance);
    const name = `region-${index + 1}` as PaperCaptureViewName;
    views.push({
      name,
      role: "regional",
      ordinal: index + 1,
      width,
      height,
      camera,
      metadata: {
        view: name,
        role: "regional",
        ordinal: index + 1,
        projection: "perspective",
        position: captureVector3(camera.position),
        targetWorld: captureVector3(target),
        targetNormalized: anchor.targetNormalized,
        up: captureVector3(camera.up),
        near: camera.near,
        far: camera.far,
        fovDegrees: camera.fov,
        region: paperRegionMetadata(anchor),
        ...paperCameraMatrixMetadata(camera),
      },
    });
  }

  for (let index = 0; index < 4; index++) {
    const anchor = anchors[index]!;
    const azimuth = THREE.MathUtils.degToRad(azimuths[index]!);
    const outward: CaptureVector2 = [Math.sin(azimuth), -Math.cos(azimuth)];
    const regionX = (anchor.targetNormalized[0] - 0.5) * worldSize;
    const regionZ = (anchor.targetNormalized[1] - 0.5) * worldSize;
    const standDistance = THREE.MathUtils.clamp(
      anchor.radiusNormalized * worldSize * 0.35,
      4,
      worldSize * 0.08,
    );
    const intended: CaptureVector2 = [
      regionX + outward[0] * standDistance,
      regionZ + outward[1] * standDistance,
    ];
    let safePosition: SafeRegisteredWalkPosition;
    try {
      safePosition = findSafeRegisteredWalkPosition(world, intended, outward, 58);
    } catch {
      const fallback = highestTerrainPaperAnchor(world);
      const fallbackX = (fallback.targetNormalized[0] - 0.5) * worldSize;
      const fallbackZ = (fallback.targetNormalized[1] - 0.5) * worldSize;
      safePosition = findSafeRegisteredWalkPosition(world, [fallbackX, fallbackZ], outward, 58);
    }
    const eyeY = safePosition.terrainHeightMeters + REGISTERED_WALK_EYE_HEIGHT_METERS;
    const position = new THREE.Vector3(safePosition.position[0], eyeY, safePosition.position[1]);
    const lookDistance = THREE.MathUtils.clamp(
      anchor.radiusNormalized * worldSize * 1.2,
      10,
      worldSize * 0.25,
    );
    const target = new THREE.Vector3(
      position.x - outward[0] * lookDistance,
      position.y - 0.45,
      position.z - outward[1] * lookDistance,
    );
    const camera = new THREE.PerspectiveCamera(58, aspect, 0.1, Math.max(900, worldSize * 6));
    camera.position.copy(position);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const adjustmentDistanceMeters = Math.hypot(
      safePosition.position[0] - intended[0],
      safePosition.position[1] - intended[1],
    );
    const name = `walk-${index + 1}` as PaperCaptureViewName;
    views.push({
      name,
      role: "walk",
      ordinal: index + 1,
      width,
      height,
      camera,
      metadata: {
        view: name,
        role: "walk",
        ordinal: index + 1,
        projection: "perspective",
        position: captureVector3(position),
        targetWorld: captureVector3(target),
        targetNormalized: normalizedWorldTarget(worldSize, target),
        up: captureVector3(camera.up),
        near: camera.near,
        far: camera.far,
        fovDegrees: camera.fov,
        eyeHeightMeters: REGISTERED_WALK_EYE_HEIGHT_METERS,
        region: paperRegionMetadata(anchor),
        placementSafety: {
          method: "deterministic-nearby-collider-proxy-search",
          candidateIndex: safePosition.candidateIndex,
          candidatesTested: safePosition.candidatesTested,
          adjusted: adjustmentDistanceMeters > 1e-9,
          adjustmentDistanceMeters,
          terrainHeightMeters: safePosition.terrainHeightMeters,
          collidedObjectIds: safePosition.collidedObjectIds,
          unresolvedObjectIds: safePosition.unresolvedObjectIds,
          boundsClamped: safePosition.boundsClamped,
        },
        ...paperCameraMatrixMetadata(camera),
      },
    });
  }

  return views;
}

function validateCapturePixels(
  pixels: Uint8Array,
  view: string,
  width: number,
  height: number,
): PixelValidation {
  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(pixelCount / 32_768));
  let samples = 0;
  let opaqueSamples = 0;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let minimumLuminance = 255;
  let maximumLuminance = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const alpha = pixels[offset + 3] ?? 0;
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    samples++;
    if (alpha >= 250) opaqueSamples++;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    minimumLuminance = Math.min(minimumLuminance, luminance);
    maximumLuminance = Math.max(maximumLuminance, luminance);
  }

  const opaqueCoverage = opaqueSamples / Math.max(1, samples);
  const mean = luminanceSum / Math.max(1, samples);
  const variance = Math.max(0, luminanceSquaredSum / Math.max(1, samples) - mean * mean);
  const luminanceStandardDeviation = Math.sqrt(variance);
  const luminanceRange = maximumLuminance - minimumLuminance;
  if (opaqueCoverage < 0.5 || luminanceStandardDeviation < 2.5 || luminanceRange < 8) {
    throw new Error(
      `Registered ${view} capture was blank or visually flat ` +
        `(opaque=${opaqueCoverage.toFixed(3)}, deviation=${luminanceStandardDeviation.toFixed(2)}, range=${luminanceRange.toFixed(2)}).`,
    );
  }

  return {
    opaqueCoverage,
    luminanceStandardDeviation,
    luminanceRange,
  };
}

function capturePixelsToDataUrl(
  pixels: Uint8Array,
  width: number,
  height: number,
  minimumDataUrlLength = 10_000,
  preserveAlpha = false,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: preserveAlpha });
  if (!context) {
    throw new Error("Registered capture could not create a 2D encoder.");
  }
  const imageData = context.createImageData(width, height);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const sourceOffset = (height - row - 1) * rowBytes;
    imageData.data.set(pixels.subarray(sourceOffset, sourceOffset + rowBytes), row * rowBytes);
  }
  context.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length < minimumDataUrlLength) {
    throw new Error("Registered capture PNG encoding produced an empty image.");
  }
  return dataUrl;
}

function assertCaptureDeadline(deadline: number, label: string): void {
  if (performance.now() >= deadline) {
    throw new Error(`Registered capture timed out while ${label}.`);
  }
}

export function assertPaperCaptureDeadlineAt(now: number, deadline: number, label: string): void {
  if (!Number.isFinite(now) || !Number.isFinite(deadline) || now >= deadline) {
    throw new Error(`Paper capture timed out while ${label}.`);
  }
}

function assertPaperCaptureDeadline(deadline: number, label: string): void {
  assertPaperCaptureDeadlineAt(performance.now(), deadline, label);
}

function waitForCaptureFrame(
  deadline: number,
  scope = "Registered capture",
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      reject(new Error(`${scope} timed out waiting for a frame.`));
      return;
    }
    let settled = false;
    let animationFrame = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () => {
      window.cancelAnimationFrame(animationFrame);
      finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      window.cancelAnimationFrame(animationFrame);
      finish(new Error(`${scope} timed out waiting for a frame.`));
    }, remaining);
    animationFrame = window.requestAnimationFrame(() => {
      finish();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function sceneHasCaptureContent(scene: THREE.Scene, world: WorldSceneType): boolean {
  let terrainReady = false;
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible && object.userData.terrain === true) {
      terrainReady = true;
    }
  });
  return terrainReady && collectCompiledSlotEvidence(scene, world).matched;
}

async function waitForCaptureContent(
  scene: THREE.Scene,
  world: WorldSceneType,
  deadline: number,
  signal?: AbortSignal,
  scope = "Registered capture",
): Promise<void> {
  const expectsCompiledAssets = world.objects.some((object) => object.browserAsset !== undefined);
  while (!sceneHasCaptureContent(scene, world)) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) {
      throw new Error(
        expectsCompiledAssets
          ? `${scope} timed out before the compiled GLB batches were ready.`
          : `${scope} timed out before the scene was renderable.`,
      );
    }
    await waitForCaptureFrame(deadline, scope, signal);
  }
  signal?.throwIfAborted();
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return window.btoa(chunks.join(""));
}

function encodeCategoryMaskRle(mask: Uint8Array): {
  dataBase64: string;
  runCount: number;
} {
  const encoded: number[] = [];
  let runCount = 0;
  for (let offset = 0; offset < mask.length;) {
    const category = mask[offset]!;
    let length = 1;
    while (offset + length < mask.length && mask[offset + length] === category && length < 0xffff) {
      length++;
    }
    encoded.push(category, length & 0xff, (length >>> 8) & 0xff);
    runCount++;
    offset += length;
  }
  return {
    dataBase64: bytesToBase64(Uint8Array.from(encoded)),
    runCount,
  };
}

function findLiteralTerrainMesh(scene: THREE.Scene): THREE.Mesh {
  let terrain: THREE.Mesh | undefined;
  scene.traverse((object) => {
    if (!terrain && object instanceof THREE.Mesh && object.userData.terrain === true) {
      terrain = object;
    }
  });
  if (!terrain) {
    throw new Error("Registered analysis could not find the rendered terrain geometry.");
  }
  terrain.updateWorldMatrix(true, false);
  return terrain;
}

function cloneLiteralTerrain(source: THREE.Mesh, material: THREE.Material): THREE.Mesh {
  const clone = new THREE.Mesh(source.geometry, material);
  clone.matrixAutoUpdate = false;
  clone.matrix.copy(source.matrixWorld);
  clone.frustumCulled = false;
  return clone;
}

function createEvidenceRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
  });
  target.texture.name = "worldclaw-registered-analysis";
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.magFilter = THREE.NearestFilter;
  target.texture.minFilter = THREE.NearestFilter;
  target.texture.generateMipmaps = false;
  return target;
}

function createPaperFloatDepthRenderTarget(
  renderer: THREE.WebGLRenderer,
  width: number,
  height: number,
): THREE.WebGLRenderTarget {
  if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has("EXT_color_buffer_float")) {
    throw new Error(
      "Paper capture requires WebGL2 EXT_color_buffer_float for auditable linear depth.",
    );
  }
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
  });
  target.texture.name = "worldclaw-paper-linear-depth-float32";
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.magFilter = THREE.NearestFilter;
  target.texture.minFilter = THREE.NearestFilter;
  target.texture.generateMipmaps = false;
  return target;
}

interface PaperLiteralDiagnosticBundle {
  readonly scene: THREE.Scene;
  readonly mapping: readonly PaperCaptureLogicalIdMapping[];
  readonly logicalIdByEncodedId: ReadonlyMap<number, string>;
  readonly logicalTypeById: ReadonlyMap<string, PaperCaptureLogicalIdMapping["logicalType"]>;
  readonly inventory: PaperLiteralGeometryInventory;
  readonly usePass: (pass: "instance" | "depth" | "normal") => void;
  readonly dispose: () => void;
}

function objectIsRendered(object: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  if (object instanceof THREE.Mesh) {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.length === 0 || materials.every((material) => !material.visible)) return false;
  }
  return true;
}

function inheritedPaperLogicalId(object: THREE.Object3D): string | undefined {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (typeof current.userData.objectId === "string") return current.userData.objectId;
    if (typeof current.userData.paperSurfaceId === "string") return current.userData.paperSurfaceId;
    if (current.userData.terrain === true) return PAPER_CAPTURE_TERRAIN_ID;
  }
  return undefined;
}

function createPaperLogicalIdMapping(
  world: WorldSceneType,
  includeWater: boolean,
): PaperCaptureLogicalIdMapping[] {
  const sortedObjects = [...world.objects].sort((left, right) => left.id.localeCompare(right.id));
  const duplicateIds = sortedObjects
    .filter((object, index) => index > 0 && object.id === sortedObjects[index - 1]!.id)
    .map((object) => object.id);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Paper capture found duplicate logical object IDs: ${duplicateIds.join(", ")}.`,
    );
  }
  const logicalEntries: Array<{
    logicalId: string;
    logicalType: PaperCaptureLogicalIdMapping["logicalType"];
    objectKind?: string;
  }> = [
    { logicalId: PAPER_CAPTURE_TERRAIN_ID, logicalType: "terrain" },
    ...(includeWater ? [{ logicalId: PAPER_CAPTURE_WATER_ID, logicalType: "water" as const }] : []),
    ...sortedObjects.map((object) => ({
      logicalId: object.id,
      logicalType: "object" as const,
      objectKind: object.kind,
    })),
  ];
  if (logicalEntries.length > 0xff_ffff) {
    throw new Error("Paper capture exceeds the RGB24 logical ID budget.");
  }
  return logicalEntries.map((entry, index) => {
    const encodedId24 = index + 1;
    const rgb = encodedIdToRgb(encodedId24);
    return {
      ...entry,
      encodedId24,
      rgb,
      colorHex: `#${rgb.map((component) => component.toString(16).padStart(2, "0")).join("")}`,
    };
  });
}

function createPaperMeshIdMaterial(
  rgb: readonly [number, number, number],
): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: {
      logicalIdColor: {
        value: new THREE.Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255),
      },
    },
    vertexShader: `
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 logicalIdColor;
      void main() {
        gl_FragColor = vec4(logicalIdColor, 1.0);
      }
    `,
  });
}

function createPaperInstancedIdMaterial(): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    vertexShader: `
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      attribute mat4 instanceMatrix;
      attribute vec3 instanceColor;
      varying vec3 logicalIdColor;
      void main() {
        logicalIdColor = instanceColor;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 logicalIdColor;
      void main() {
        gl_FragColor = vec4(logicalIdColor, 1.0);
      }
    `,
  });
}

function createPaperLinearDepthMaterial(): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    vertexShader: `
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      in vec3 position;
      #ifdef USE_INSTANCING
        in mat4 instanceMatrix;
      #endif
      out float cameraSpaceDepthMeters;
      void main() {
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        vec4 viewPosition = modelViewMatrix * localPosition;
        cameraSpaceDepthMeters = -viewPosition.z;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      precision highp float;
      in float cameraSpaceDepthMeters;
      layout(location = 0) out vec4 paperDepthOutput;
      void main() {
        bool finiteDepth = !isnan(cameraSpaceDepthMeters) && !isinf(cameraSpaceDepthMeters);
        // R is the literal linear camera-space distance in meters. G marks
        // covered geometry and B is an explicit shader-space finite sentinel.
        // The float readback is validated before a separate PNG preview is made.
        paperDepthOutput = vec4(finiteDepth ? cameraSpaceDepthMeters : 0.0, 1.0,
          finiteDepth ? 1.0 : 0.0, 1.0);
      }
    `,
  });
}

function inspectPaperGeometryAttributes(geometry: THREE.BufferGeometry): {
  valueCount: number;
  nonFiniteValueCount: number;
  missingNormalAttribute: boolean;
} {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  let valueCount = 0;
  let nonFiniteValueCount = 0;
  for (const attribute of [position, normal]) {
    if (!attribute || attribute.itemSize < 3) continue;
    for (let index = 0; index < attribute.count; index++) {
      for (let component = 0; component < 3; component++) {
        valueCount++;
        if (!Number.isFinite(attribute.getComponent(index, component))) {
          nonFiniteValueCount++;
        }
      }
    }
  }
  return {
    valueCount,
    nonFiniteValueCount,
    missingNormalAttribute: !normal || normal.itemSize < 3,
  };
}

function countNonFiniteMatrixValues(matrix: THREE.Matrix4): number {
  let nonFiniteValueCount = 0;
  for (const value of matrix.elements) {
    if (!Number.isFinite(value)) nonFiniteValueCount++;
  }
  return nonFiniteValueCount;
}

function createPaperLiteralDiagnosticBundle(
  liveScene: THREE.Scene,
  world: WorldSceneType,
): PaperLiteralDiagnosticBundle {
  liveScene.updateMatrixWorld(true);
  const includeWater = world.plan.regions.some((region) => region.category === "ocean");
  const mapping = createPaperLogicalIdMapping(world, includeWater);
  const mappingByLogicalId = new Map(mapping.map((entry) => [entry.logicalId, entry]));
  const logicalIdByEncodedId = new Map(
    mapping.map((entry) => [entry.encodedId24, entry.logicalId]),
  );
  const logicalTypeById = new Map(mapping.map((entry) => [entry.logicalId, entry.logicalType]));
  const scene = new THREE.Scene();
  scene.background = null;
  scene.fog = null;
  const meshIdMaterials = new Map<string, THREE.RawShaderMaterial>();
  for (const entry of mapping) {
    meshIdMaterials.set(entry.logicalId, createPaperMeshIdMaterial(entry.rgb));
  }
  const instancedIdMaterial = createPaperInstancedIdMaterial();
  const linearDepthMaterial = createPaperLinearDepthMaterial();
  const normalMaterial = new THREE.MeshNormalMaterial({
    flatShading: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const renderedObjectIds = new Set<string>();
  const unexpectedObjectIds = new Set<string>();
  const compiledAssignments = new Map<string, Set<number>>();
  let terrainMeshCount = 0;
  let waterMeshCount = 0;
  let primitiveOrUnbatchedObjectMeshCount = 0;
  let compiledBatchCount = 0;
  let compiledSubmeshInstanceSlotCount = 0;
  let geometryAttributeValueCount = 0;
  let meshWorldMatrixValueCount = 0;
  let instanceMatrixValueCount = 0;
  let nonFiniteGeometryValueCount = 0;
  let missingNormalAttributeMeshCount = 0;

  liveScene.traverse((source) => {
    if (!objectIsRendered(source)) return;
    if (source instanceof THREE.InstancedMesh) {
      if (source.userData.worldclawCompiledBatch !== true || source.count <= 0) return;
      const attributeInspection = inspectPaperGeometryAttributes(source.geometry);
      geometryAttributeValueCount += attributeInspection.valueCount;
      nonFiniteGeometryValueCount += attributeInspection.nonFiniteValueCount;
      if (attributeInspection.missingNormalAttribute) missingNormalAttributeMeshCount++;
      meshWorldMatrixValueCount += source.matrixWorld.elements.length;
      nonFiniteGeometryValueCount += countNonFiniteMatrixValues(source.matrixWorld);
      const objectIds = source.userData.instanceObjectIds;
      if (!Array.isArray(objectIds) || objectIds.length < source.count) {
        throw new Error(
          "Paper capture found a compiled batch without complete logical object IDs.",
        );
      }
      const clone = new THREE.InstancedMesh(source.geometry, instancedIdMaterial, source.count);
      clone.name = `paper-literal:${source.name || source.uuid}`;
      clone.count = source.count;
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(source.matrixWorld);
      clone.frustumCulled = false;
      clone.renderOrder = source.renderOrder;
      const matrix = new THREE.Matrix4();
      const instanceColors = new Uint8Array(source.count * 3);
      for (let index = 0; index < source.count; index++) {
        source.getMatrixAt(index, matrix);
        instanceMatrixValueCount += matrix.elements.length;
        nonFiniteGeometryValueCount += countNonFiniteMatrixValues(matrix);
        clone.setMatrixAt(index, matrix);
        const logicalId = objectIds[index];
        const entry = typeof logicalId === "string" ? mappingByLogicalId.get(logicalId) : undefined;
        if (!entry || entry.logicalType !== "object") {
          if (typeof logicalId === "string") unexpectedObjectIds.add(logicalId);
          throw new Error(
            `Paper capture could not map compiled instance ${index} in ${source.name || source.uuid}.`,
          );
        }
        instanceColors.set(entry.rgb, index * 3);
        renderedObjectIds.add(entry.logicalId);
        const assignments = compiledAssignments.get(entry.logicalId) ?? new Set<number>();
        assignments.add(entry.encodedId24);
        compiledAssignments.set(entry.logicalId, assignments);
      }
      clone.instanceColor = new THREE.InstancedBufferAttribute(instanceColors, 3, true);
      clone.instanceMatrix.needsUpdate = true;
      clone.instanceColor.needsUpdate = true;
      clone.userData.paperDiagnosticKind = "compiled";
      scene.add(clone);
      compiledBatchCount++;
      compiledSubmeshInstanceSlotCount += source.count;
      return;
    }

    if (!(source instanceof THREE.Mesh)) return;
    if (source instanceof THREE.SkinnedMesh) {
      const logicalId = inheritedPaperLogicalId(source);
      if (logicalId) {
        throw new Error(
          `Paper capture cannot freeze skinned logical mesh ${logicalId} without losing deformation.`,
        );
      }
      return;
    }
    const logicalId = inheritedPaperLogicalId(source);
    if (!logicalId) return;
    const attributeInspection = inspectPaperGeometryAttributes(source.geometry);
    geometryAttributeValueCount += attributeInspection.valueCount;
    nonFiniteGeometryValueCount += attributeInspection.nonFiniteValueCount;
    if (attributeInspection.missingNormalAttribute) missingNormalAttributeMeshCount++;
    meshWorldMatrixValueCount += source.matrixWorld.elements.length;
    nonFiniteGeometryValueCount += countNonFiniteMatrixValues(source.matrixWorld);
    const entry = mappingByLogicalId.get(logicalId);
    if (!entry) {
      unexpectedObjectIds.add(logicalId);
      throw new Error(`Paper capture found rendered geometry for unknown logical ID ${logicalId}.`);
    }
    const material = meshIdMaterials.get(logicalId)!;
    const clone = new THREE.Mesh(source.geometry, material);
    clone.name = `paper-literal:${source.name || source.uuid}`;
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(source.matrixWorld);
    clone.frustumCulled = false;
    clone.renderOrder = source.renderOrder;
    clone.userData.paperLogicalId = logicalId;
    clone.userData.paperDiagnosticKind = entry.logicalType;
    scene.add(clone);
    if (entry.logicalType === "terrain") terrainMeshCount++;
    else if (entry.logicalType === "water") waterMeshCount++;
    else {
      primitiveOrUnbatchedObjectMeshCount++;
      renderedObjectIds.add(logicalId);
    }
  });

  const expectedObjectIds = new Set(world.objects.map((object) => object.id));
  const missingLogicalObjectIds = [...expectedObjectIds]
    .filter((logicalId) => !renderedObjectIds.has(logicalId))
    .sort();
  const unexpectedLogicalObjectIds = [...unexpectedObjectIds].sort();
  const compiledLogicalIdAssignmentsStable = [...compiledAssignments.values()].every(
    (assignments) => assignments.size === 1,
  );
  if (terrainMeshCount === 0) {
    throw new Error("Paper capture could not find the literal rendered terrain mesh.");
  }
  if (includeWater && waterMeshCount === 0) {
    throw new Error(
      "Paper capture expected an ocean surface but found no literal rendered water mesh.",
    );
  }
  if (missingLogicalObjectIds.length > 0 || unexpectedLogicalObjectIds.length > 0) {
    throw new Error(
      `Paper capture literal geometry inventory mismatch (missing=${missingLogicalObjectIds.join(",") || "none"}; ` +
        `unexpected=${unexpectedLogicalObjectIds.join(",") || "none"}).`,
    );
  }
  if (!compiledLogicalIdAssignmentsStable) {
    throw new Error("Paper capture assigned more than one RGB24 ID to a compiled logical object.");
  }
  if (missingNormalAttributeMeshCount > 0 || nonFiniteGeometryValueCount > 0) {
    throw new Error(
      `Paper capture geometry preflight failed (nonFinite=${nonFiniteGeometryValueCount}; ` +
        `missingNormals=${missingNormalAttributeMeshCount}).`,
    );
  }

  const inventory: PaperLiteralGeometryInventory = {
    terrainMeshCount,
    waterMeshCount,
    primitiveOrUnbatchedObjectMeshCount,
    compiledBatchCount,
    compiledSubmeshInstanceSlotCount,
    renderedLogicalObjectCount: renderedObjectIds.size,
    expectedLogicalObjectCount: expectedObjectIds.size,
    missingLogicalObjectIds,
    unexpectedLogicalObjectIds,
    compiledLogicalIdAssignmentsStable,
    geometryAttributeValueCount,
    meshWorldMatrixValueCount,
    instanceMatrixValueCount,
    nonFiniteGeometryValueCount: 0,
    missingNormalAttributeMeshCount: 0,
    geometryFinitePreflightPassed: true,
    diagnosticsUseColliderProxies: false,
  };

  return {
    scene,
    mapping,
    logicalIdByEncodedId,
    logicalTypeById,
    inventory,
    usePass: (pass) => {
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (pass === "instance") {
          if (object instanceof THREE.InstancedMesh) object.material = instancedIdMaterial;
          else object.material = meshIdMaterials.get(object.userData.paperLogicalId)!;
        } else if (pass === "depth") {
          object.material = linearDepthMaterial;
        } else {
          object.material = normalMaterial;
        }
      });
    },
    dispose: () => {
      scene.clear();
      for (const material of meshIdMaterials.values()) material.dispose();
      instancedIdMaterial.dispose();
      linearDepthMaterial.dispose();
      normalMaterial.dispose();
    },
  };
}

function summarizePaperIdPixels(
  pixels: Uint8Array,
  mapping: readonly PaperCaptureLogicalIdMapping[],
  logicalIdByEncodedId: ReadonlyMap<number, string>,
  logicalTypeById: ReadonlyMap<string, PaperCaptureLogicalIdMapping["logicalType"]>,
): PaperCaptureView["instance"]["visibility"] {
  const visiblePixelsByLogicalId: Record<string, number> = {};
  for (const entry of mapping) visiblePixelsByLogicalId[entry.logicalId] = 0;
  let backgroundPixelCount = 0;
  let invalidIdPixelCount = 0;
  const invalidIdSamples = new Map<number, number>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const encodedId24 =
      ((pixels[offset] ?? 0) << 16) | ((pixels[offset + 1] ?? 0) << 8) | (pixels[offset + 2] ?? 0);
    if (encodedId24 === 0) {
      backgroundPixelCount++;
      continue;
    }
    const logicalId = logicalIdByEncodedId.get(encodedId24);
    if (!logicalId) {
      invalidIdPixelCount++;
      if (invalidIdSamples.size < 8 || invalidIdSamples.has(encodedId24)) {
        invalidIdSamples.set(encodedId24, (invalidIdSamples.get(encodedId24) ?? 0) + 1);
      }
      continue;
    }
    visiblePixelsByLogicalId[logicalId] = (visiblePixelsByLogicalId[logicalId] ?? 0) + 1;
  }
  if (invalidIdPixelCount > 0) {
    const samples = [...invalidIdSamples]
      .map(([encodedId24, count]) => `0x${encodedId24.toString(16).padStart(6, "0")}:${count}`)
      .join(",");
    throw new Error(
      `Paper RGB24 pass produced ${invalidIdPixelCount} unmapped pixels (samples ${samples}).`,
    );
  }
  const visibleLogicalIds = Object.entries(visiblePixelsByLogicalId)
    .filter(([, count]) => count > 0)
    .map(([logicalId]) => logicalId)
    .sort();
  const visibleObjectIds = visibleLogicalIds.filter(
    (logicalId) => logicalTypeById.get(logicalId) === "object",
  );
  return {
    stableAcrossViewsAndSubmeshes: true,
    visiblePixelsByLogicalId,
    visibleLogicalIds,
    visibleObjectIds,
    visibleLogicalObjectCount: visibleLogicalIds.length,
    visibleObjectCount: visibleObjectIds.length,
    backgroundPixelCount,
    invalidIdPixelCount,
  };
}

export function summarizePaperDepthPixels(
  pixels: Float32Array,
  near: number,
  far: number,
): {
  summary: Pick<
    PaperCaptureView["depth"],
    | "finiteDepthPixelCount"
    | "nonFiniteDepthPixelCount"
    | "outOfRangeDepthPixelCount"
    | "backgroundPixelCount"
    | "minimumMeters"
    | "maximumMeters"
    | "meanMeters"
  >;
  previewPixels: Uint8Array;
} {
  if (
    pixels.length === 0 ||
    pixels.length % 4 !== 0 ||
    !Number.isFinite(near) ||
    !Number.isFinite(far) ||
    near < 0 ||
    far <= near
  ) {
    throw new Error("Paper linear camera-space depth validation received invalid bounds/data.");
  }
  let finiteDepthPixelCount = 0;
  let nonFiniteDepthPixelCount = 0;
  let outOfRangeDepthPixelCount = 0;
  let backgroundPixelCount = 0;
  let minimumMeters = Number.POSITIVE_INFINITY;
  let maximumMeters = Number.NEGATIVE_INFINITY;
  let sumMeters = 0;
  const previewPixels = new Uint8Array(pixels.length);
  const range = far - near;
  const rangeTolerance = Math.max(0.001, range * 1e-5);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const coverage = pixels[offset + 1] ?? 0;
    if (!(coverage > 0.5)) {
      backgroundPixelCount++;
      continue;
    }
    const meters = pixels[offset] ?? Number.NaN;
    const finiteSentinel = pixels[offset + 2] ?? 0;
    if (!(finiteSentinel > 0.5) || !Number.isFinite(meters)) {
      nonFiniteDepthPixelCount++;
      continue;
    }
    if (meters < near - rangeTolerance || meters > far + rangeTolerance) {
      outOfRangeDepthPixelCount++;
      continue;
    }
    finiteDepthPixelCount++;
    minimumMeters = Math.min(minimumMeters, meters);
    maximumMeters = Math.max(maximumMeters, meters);
    sumMeters += meters;
    const grayscale = Math.round(THREE.MathUtils.clamp((meters - near) / range, 0, 1) * 255);
    previewPixels[offset] = grayscale;
    previewPixels[offset + 1] = grayscale;
    previewPixels[offset + 2] = grayscale;
    previewPixels[offset + 3] = 255;
  }
  if (
    finiteDepthPixelCount === 0 ||
    nonFiniteDepthPixelCount > 0 ||
    outOfRangeDepthPixelCount > 0
  ) {
    throw new Error(
      `Paper linear camera-space depth pass failed closed ` +
        `(finite=${finiteDepthPixelCount}; nonFinite=${nonFiniteDepthPixelCount}; ` +
        `outOfRange=${outOfRangeDepthPixelCount}).`,
    );
  }
  return {
    summary: {
      finiteDepthPixelCount,
      nonFiniteDepthPixelCount,
      outOfRangeDepthPixelCount,
      backgroundPixelCount,
      minimumMeters: Number.isFinite(minimumMeters) ? minimumMeters : null,
      maximumMeters: Number.isFinite(maximumMeters) ? maximumMeters : null,
      meanMeters: finiteDepthPixelCount > 0 ? sumMeters / finiteDepthPixelCount : null,
    },
    previewPixels,
  };
}

function summarizePaperCoveragePixels(pixels: Uint8Array): {
  coveredPixelCount: number;
  backgroundPixelCount: number;
} {
  let coveredPixelCount = 0;
  let backgroundPixelCount = 0;
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if ((pixels[offset] ?? 0) === 0) backgroundPixelCount++;
    else coveredPixelCount++;
  }
  if (coveredPixelCount === 0) throw new Error("Paper geometry-normal pass was empty.");
  return { coveredPixelCount, backgroundPixelCount };
}

function capturePaperCameraState(camera: THREE.Camera): PaperCameraStateSnapshot {
  return {
    uuid: camera.uuid,
    matrix: [...camera.matrix.elements],
    matrixWorld: [...camera.matrixWorld.elements],
    matrixWorldInverse: [...camera.matrixWorldInverse.elements],
    projectionMatrix: [...camera.projectionMatrix.elements],
    projectionMatrixInverse: [...camera.projectionMatrixInverse.elements],
  };
}

function paperCameraStateEquals(
  left: PaperCameraStateSnapshot,
  right: PaperCameraStateSnapshot,
): boolean {
  return (
    left.uuid === right.uuid &&
    left.matrix.every((value, index) => Object.is(value, right.matrix[index])) &&
    left.matrixWorld.every((value, index) => Object.is(value, right.matrixWorld[index])) &&
    left.matrixWorldInverse.every((value, index) =>
      Object.is(value, right.matrixWorldInverse[index]),
    ) &&
    left.projectionMatrix.every((value, index) =>
      Object.is(value, right.projectionMatrix[index]),
    ) &&
    left.projectionMatrixInverse.every((value, index) =>
      Object.is(value, right.projectionMatrixInverse[index]),
    )
  );
}

function paperMaterialValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof THREE.Color) return [value.r, value.g, value.b];
  if (
    value instanceof THREE.Vector2 ||
    value instanceof THREE.Vector3 ||
    value instanceof THREE.Vector4 ||
    value instanceof THREE.Euler ||
    value instanceof THREE.Quaternion
  ) {
    return value.toArray();
  }
  if (value instanceof THREE.Texture) {
    return {
      textureUuid: value.uuid,
      version: value.version,
      colorSpace: value.colorSpace,
      mapping: value.mapping,
      wrapS: value.wrapS,
      wrapT: value.wrapT,
      magFilter: value.magFilter,
      minFilter: value.minFilter,
      anisotropy: value.anisotropy,
      flipY: value.flipY,
      premultiplyAlpha: value.premultiplyAlpha,
      generateMipmaps: value.generateMipmaps,
      offset: value.offset.toArray(),
      repeat: value.repeat.toArray(),
      center: value.center.toArray(),
      rotation: value.rotation,
      matrix: value.matrix.toArray(),
    };
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry !== "object")) {
    return [...value];
  }
  return undefined;
}

function paperMaterialPropertyFingerprint(materials: readonly THREE.Material[]): string {
  return JSON.stringify(
    materials.map((material) => {
      const properties: Record<string, unknown> = { type: material.type };
      for (const key of Object.keys(material).sort()) {
        if (key === "uuid" || key === "id" || key === "_listeners" || key === "userData") {
          continue;
        }
        const normalized = paperMaterialValue(
          (material as unknown as Record<string, unknown>)[key],
        );
        if (normalized !== undefined) properties[key] = normalized;
      }
      return properties;
    }),
  );
}

function capturePaperLiveMaterialSnapshot(scene: THREE.Scene): PaperLiveMaterialSnapshot {
  const entries = new Map<string, PaperLiveMaterialEntry>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (
      object.userData.worldclawCompiledBatch !== true &&
      inheritedPaperLogicalId(object) === undefined
    ) {
      return;
    }
    const references = Array.isArray(object.material) ? [...object.material] : [object.material];
    entries.set(object.uuid, {
      meshUuid: object.uuid,
      references,
      propertyFingerprint: paperMaterialPropertyFingerprint(references),
    });
  });
  return { entries };
}

function assertPaperMaterialSnapshotsEqual(
  expected: PaperLiveMaterialSnapshot,
  actual: PaperLiveMaterialSnapshot,
  requireSameReferences: boolean,
  label: string,
): void {
  if (expected.entries.size !== actual.entries.size) {
    throw new Error(
      `Paper capture ${label} material inventory changed ` +
        `(${expected.entries.size} -> ${actual.entries.size}).`,
    );
  }
  for (const [meshUuid, expectedEntry] of expected.entries) {
    const actualEntry = actual.entries.get(meshUuid);
    if (!actualEntry) {
      throw new Error(`Paper capture ${label} lost live mesh ${meshUuid}.`);
    }
    if (
      requireSameReferences &&
      (expectedEntry.references.length !== actualEntry.references.length ||
        expectedEntry.references.some(
          (material, index) => material !== actualEntry.references[index],
        ))
    ) {
      throw new Error(`Paper capture ${label} replaced a live material on mesh ${meshUuid}.`);
    }
    if (expectedEntry.propertyFingerprint !== actualEntry.propertyFingerprint) {
      throw new Error(
        `Paper capture ${label} mutated live material properties on mesh ${meshUuid}.`,
      );
    }
  }
}

function paperWorldFingerprint(world: WorldSceneType): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const updateByte = (value: number) => {
    first = Math.imul(first ^ value, 0x01000193) >>> 0;
    second = Math.imul(second ^ value, 0x85ebca6b) >>> 0;
  };
  const visit = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      updateByte(91);
      for (const byte of bytes) updateByte(byte);
      updateByte(93);
      return;
    }
    if (value === null || typeof value !== "object") {
      const text = `${typeof value}:${String(value)};`;
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        updateByte(code & 0xff);
        updateByte(code >>> 8);
      }
      return;
    }
    if (Array.isArray(value)) {
      updateByte(91);
      for (const entry of value) visit(entry);
      updateByte(93);
      return;
    }
    updateByte(123);
    for (const key of Object.keys(value).sort()) {
      visit(key);
      visit((value as Record<string, unknown>)[key]);
    }
    updateByte(125);
  };
  visit(world);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function summarizeTerrainWaterMask(pixels: Uint8Array): {
  mask: Uint8Array;
  counts: { background: number; water: number; land: number };
} {
  const size = REGISTERED_ANALYSIS_MASK_SIZE;
  const mask = new Uint8Array(size * size);
  const counts = { background: 0, water: 0, land: 0 };
  for (let row = 0; row < size; row++) {
    const sourceRow = size - row - 1;
    for (let column = 0; column < size; column++) {
      const sourceOffset = (sourceRow * size + column) * 4;
      const red = pixels[sourceOffset] ?? 0;
      const green = pixels[sourceOffset + 1] ?? 0;
      const blue = pixels[sourceOffset + 2] ?? 0;
      let category: 0 | 1 | 2;
      if (red < 4 && green < 4 && blue < 4) {
        category = 0;
        counts.background++;
      } else if (blue > red && blue > green) {
        category = 1;
        counts.water++;
      } else {
        category = 2;
        counts.land++;
      }
      mask[row * size + column] = category;
    }
  }
  if (counts.background === 0 || counts.land === 0) {
    throw new Error("Registered terrain mask did not distinguish background and land geometry.");
  }
  return { mask, counts };
}

interface ProxyEvidenceBundle {
  scene: THREE.Scene;
  mapping: RegisteredObjectProxyMapping[];
  objectIdByEncodedId: Map<number, string>;
  dispose: () => void;
}

function encodedIdToRgb(encodedId24: number): [number, number, number] {
  return [(encodedId24 >>> 16) & 0xff, (encodedId24 >>> 8) & 0xff, encodedId24 & 0xff];
}

function createProxyEvidenceBundle(
  world: WorldSceneType,
  terrain: THREE.Mesh,
): ProxyEvidenceBundle {
  if (world.objects.length >= 0xff_ffff) {
    throw new Error("Registered RGB24 proxy evidence exceeds its object ID budget.");
  }
  const scene = new THREE.Scene();
  const terrainOccluderMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  scene.add(cloneLiteralTerrain(terrain, terrainOccluderMaterial));

  const proxyMaterial = new THREE.RawShaderMaterial({
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    vertexShader: `
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      attribute mat4 instanceMatrix;
      attribute vec3 instanceColor;
      varying vec3 idColor;
      void main() {
        idColor = instanceColor;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 idColor;
      void main() {
        gl_FragColor = vec4(idColor, 1.0);
      }
    `,
  });
  const circleGeometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1, false);
  const obbGeometry = new THREE.BoxGeometry(1, 1, 1);
  const sortedObjects = [...world.objects].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const circleEntries: Array<{
    collider: WorldColliderProxy & { shape: "circle" };
    rgb: [number, number, number];
  }> = [];
  const obbEntries: Array<{
    collider: WorldColliderProxy & { shape: "obb" };
    rgb: [number, number, number];
  }> = [];
  const mapping: RegisteredObjectProxyMapping[] = [];
  const objectIdByEncodedId = new Map<number, string>();

  for (let index = 0; index < sortedObjects.length; index++) {
    const object = sortedObjects[index]!;
    const encodedId24 = index + 1;
    const rgb = encodedIdToRgb(encodedId24);
    const collider = worldColliderForObject(object);
    mapping.push({
      objectId: object.id,
      objectKind: object.kind,
      encodedId24,
      rgb,
      colorHex: `#${rgb.map((component) => component.toString(16).padStart(2, "0")).join("")}`,
      colliderSource: collider.source,
      proxyShape: collider.shape === "circle" ? "vertical-circle-prism" : "vertical-obb-prism",
    });
    objectIdByEncodedId.set(encodedId24, object.id);
    if (collider.shape === "circle") {
      circleEntries.push({ collider, rgb });
    } else {
      obbEntries.push({ collider, rgb });
    }
  }

  const yAxis = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const addInstances = (
    geometry: THREE.BufferGeometry,
    entries: Array<{
      collider: WorldColliderProxy;
      rgb: [number, number, number];
    }>,
  ) => {
    if (entries.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, proxyMaterial, entries.length);
    mesh.frustumCulled = false;
    const instanceColors = new Uint8Array(entries.length * 3);
    for (let index = 0; index < entries.length; index++) {
      const { collider, rgb } = entries[index]!;
      const height = Math.max(0.05, collider.topY - collider.bottomY);
      position.set(collider.centerX, collider.centerY, collider.centerZ);
      quaternion.setFromAxisAngle(yAxis, collider.shape === "obb" ? collider.yaw : 0);
      if (collider.shape === "circle") {
        scale.set(collider.radius, height, collider.radius);
      } else {
        scale.set(collider.halfWidth * 2, height, collider.halfDepth * 2);
      }
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      instanceColors.set(rgb, index * 3);
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(instanceColors, 3, true);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
  };
  addInstances(circleGeometry, circleEntries);
  addInstances(obbGeometry, obbEntries);

  return {
    scene,
    mapping,
    objectIdByEncodedId,
    dispose: () => {
      scene.clear();
      terrainOccluderMaterial.dispose();
      proxyMaterial.dispose();
      circleGeometry.dispose();
      obbGeometry.dispose();
    },
  };
}

function summarizeObjectProxyPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  mapping: readonly RegisteredObjectProxyMapping[],
  objectIdByEncodedId: ReadonlyMap<number, string>,
): Omit<RegisteredObjectProxyView, "pngDataUrl"> {
  const visiblePixelsByObjectId: Record<string, number> = {};
  for (const entry of mapping) visiblePixelsByObjectId[entry.objectId] = 0;
  let backgroundPixels = 0;
  let invalidColorPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const encodedId24 =
      ((pixels[offset] ?? 0) << 16) | ((pixels[offset + 1] ?? 0) << 8) | (pixels[offset + 2] ?? 0);
    if (encodedId24 === 0) {
      backgroundPixels++;
      continue;
    }
    const objectId = objectIdByEncodedId.get(encodedId24);
    if (!objectId) {
      invalidColorPixels++;
      continue;
    }
    visiblePixelsByObjectId[objectId] = (visiblePixelsByObjectId[objectId] ?? 0) + 1;
  }
  if (invalidColorPixels > 0) {
    throw new Error(`Registered RGB24 proxy pass produced ${invalidColorPixels} unmapped pixels.`);
  }
  return {
    width,
    height,
    visiblePixelsByObjectId,
    visibleObjectCount: Object.values(visiblePixelsByObjectId).filter((count) => count > 0).length,
    backgroundPixels,
    invalidColorPixels,
  };
}

function heroReadabilityEvidence(
  world: WorldSceneType,
  views: Readonly<Record<RegisteredCaptureName, RegisteredObjectProxyView>>,
): Readonly<Record<RegisteredCaptureName, RegisteredHeroReadabilityEvidence>> {
  const requestedHeroKinds = new Set(
    Object.entries(world.inferenceMeta?.objectCoverage?.heroRequiredByKind ?? {})
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind),
  );
  if (requestedHeroKinds.size === 0) {
    for (const kind of REGISTERED_HERO_KINDS) requestedHeroKinds.add(kind);
  }
  const heroObjects = world.objects.filter((object) => requestedHeroKinds.has(object.kind));
  const evidence = {} as Record<RegisteredCaptureName, RegisteredHeroReadabilityEvidence>;
  for (const [viewName, view] of Object.entries(views) as [
    RegisteredCaptureName,
    RegisteredObjectProxyView,
  ][]) {
    const viewportPixels = view.width * view.height;
    const instances = heroObjects.map((object) => {
      const visiblePixels = view.visiblePixelsByObjectId[object.id] ?? 0;
      return {
        objectId: object.id,
        objectKind: object.kind,
        visiblePixels,
        viewportRatio: visiblePixels / viewportPixels,
      };
    });
    evidence[viewName] = {
      method: "stable-rgb24-collider-proxy-pixel-coverage",
      structuralOverview: viewName === "map" || viewName === "isometric" || viewName === "oblique",
      instances,
      maximumHeroPixels: Math.max(0, ...instances.map((instance) => instance.visiblePixels)),
      maximumHeroViewportRatio: Math.max(0, ...instances.map((instance) => instance.viewportRatio)),
    };
  }
  return evidence;
}

function unpackRgbaDepth(pixels: Uint8Array, offset: number): number {
  const unpackDownscale = 255 / 256;
  return (
    ((pixels[offset] ?? 0) / 255) * unpackDownscale +
    ((pixels[offset + 1] ?? 0) / 255) * (unpackDownscale / 256) +
    ((pixels[offset + 2] ?? 0) / 255) * (unpackDownscale / 65_536) +
    (pixels[offset + 3] ?? 0) / 255 / 16_777_216
  );
}

function summarizeDepthPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
): RegisteredDepthSummary {
  const totalPixels = width * height;
  let coveredPixels = 0;
  let nonFinitePixels = 0;
  let outOfRangePixels = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let sum = 0;
  let squaredSum = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const depth = unpackRgbaDepth(pixels, offset);
    if (!Number.isFinite(depth)) {
      nonFinitePixels++;
      continue;
    }
    if (depth < -1e-7 || depth > 1 + 1e-7) {
      outOfRangePixels++;
      continue;
    }
    if (depth >= 1 - 1e-7) continue;
    const normalizedDepth = Math.min(1, Math.max(0, depth));
    coveredPixels++;
    minimum = Math.min(minimum, normalizedDepth);
    maximum = Math.max(maximum, normalizedDepth);
    sum += normalizedDepth;
    squaredSum += normalizedDepth * normalizedDepth;
  }
  const mean = coveredPixels > 0 ? sum / coveredPixels : null;
  const variance =
    coveredPixels > 0 && mean !== null
      ? Math.max(0, squaredSum / coveredPixels - mean * mean)
      : null;
  const finiteNormalized = coveredPixels > 0 && nonFinitePixels === 0 && outOfRangePixels === 0;
  if (!finiteNormalized) {
    throw new Error(
      "Registered depth analysis was empty, non-finite, or outside normalized range.",
    );
  }
  return {
    pass: "literal-terrain-plus-collider-proxy-depth",
    width,
    height,
    totalPixels,
    coveredPixels,
    backgroundPixels: totalPixels - coveredPixels,
    coverage: coveredPixels / totalPixels,
    minimum: Number.isFinite(minimum) ? minimum : null,
    maximum: Number.isFinite(maximum) ? maximum : null,
    mean,
    standardDeviation: variance === null ? null : Math.sqrt(variance),
    nonFinitePixels,
    outOfRangePixels,
    finiteNormalized,
  };
}

function collectCompiledSlotEvidence(
  scene: THREE.Scene,
  world: WorldSceneType,
): RegisteredCompiledSlotEvidence {
  const expectedIds = new Set(
    world.objects.filter((object) => object.browserAsset !== undefined).map((object) => object.id),
  );
  const loadedIds = new Set<string>();
  let loadedSubmeshInstanceSlotCount = 0;
  let loadedBatchCount = 0;
  scene.traverse((object) => {
    if (
      !(object instanceof THREE.InstancedMesh) ||
      object.userData.worldclawCompiledBatch !== true
    ) {
      return;
    }
    loadedBatchCount++;
    loadedSubmeshInstanceSlotCount += object.count;
    const objectIds = object.userData.instanceObjectIds;
    if (!Array.isArray(objectIds)) return;
    for (const objectId of objectIds.slice(0, object.count)) {
      if (typeof objectId === "string") loadedIds.add(objectId);
    }
  });
  const missingObjectIds = [...expectedIds].filter((objectId) => !loadedIds.has(objectId)).sort();
  const unexpectedObjectIds = [...loadedIds]
    .filter((objectId) => !expectedIds.has(objectId))
    .sort();
  return {
    expectedCompiledObjectCount: expectedIds.size,
    loadedUniqueObjectSlotCount: loadedIds.size,
    loadedSubmeshInstanceSlotCount,
    loadedBatchCount,
    matched:
      missingObjectIds.length === 0 &&
      unexpectedObjectIds.length === 0 &&
      loadedIds.size === expectedIds.size,
    missingObjectIds,
    unexpectedObjectIds,
    accounting: "unique-object-ids-across-submesh-batches",
  };
}

function createPackedDepthMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
    vertexShader: `
      void main() {
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: `
      const float PackUpscale = 256.0 / 255.0;
      const float ShiftRight8 = 1.0 / 256.0;
      const float Inv255 = 1.0 / 255.0;
      const vec4 PackFactors = vec4(1.0, 256.0, 65536.0, 16777216.0);
      vec4 packDepthToRGBA(const in float value) {
        if (value <= 0.0) return vec4(0.0);
        if (value >= 1.0) return vec4(1.0);
        float valueUpper;
        float alphaFraction = modf(value * PackFactors.a, valueUpper);
        float blueFraction = modf(valueUpper * ShiftRight8, valueUpper);
        float greenFraction = modf(valueUpper * ShiftRight8, valueUpper);
        return vec4(
          valueUpper * Inv255,
          greenFraction * PackUpscale,
          blueFraction * PackUpscale,
          alphaFraction
        );
      }
      void main() {
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }
    `,
  });
}

function renderRegisteredCaptureAnalysis(
  renderer: THREE.WebGLRenderer,
  liveScene: THREE.Scene,
  world: WorldSceneType,
  views: readonly CaptureViewDefinition[],
  deadline: number,
): RegisteredCaptureAnalysis {
  const terrain = findLiteralTerrainMesh(liveScene);
  const waterLevelMeters = world.plan.visualContract!.waterLevelMeters;
  const terrainMaskMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
    uniforms: {
      waterLevel: { value: waterLevelMeters },
    },
    vertexShader: `
      varying float worldY;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        worldY = worldPosition.y;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float waterLevel;
      varying float worldY;
      void main() {
        gl_FragColor = worldY <= waterLevel
          ? vec4(0.09411765, 0.37647059, 0.87843137, 1.0)
          : vec4(0.90980392, 0.86274510, 0.66666667, 1.0);
      }
    `,
  });
  const terrainMaskScene = new THREE.Scene();
  terrainMaskScene.add(cloneLiteralTerrain(terrain, terrainMaskMaterial));
  const proxyBundle = createProxyEvidenceBundle(world, terrain);
  const packedDepthMaterial = createPackedDepthMaterial();
  const renderTarget = createEvidenceRenderTarget(
    REGISTERED_ANALYSIS_MASK_SIZE,
    REGISTERED_ANALYSIS_MASK_SIZE,
  );
  const previousRenderTarget = renderer.getRenderTarget();
  const previousActiveCubeFace = renderer.getActiveCubeFace();
  const previousActiveMipmapLevel = renderer.getActiveMipmapLevel();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousToneMapping = renderer.toneMapping;
  const previousToneMappingExposure = renderer.toneMappingExposure;
  const previousOutputColorSpace = renderer.outputColorSpace;
  const previousAutoClear = renderer.autoClear;
  const previousXrEnabled = renderer.xr.enabled;
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();

  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 1);

    const mapView = views.find((view) => view.name === "map");
    if (!mapView) throw new Error("Registered analysis has no map camera.");
    assertCaptureDeadline(deadline, "rendering the terrain land/water mask");
    renderTarget.setSize(REGISTERED_ANALYSIS_MASK_SIZE, REGISTERED_ANALYSIS_MASK_SIZE);
    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, REGISTERED_ANALYSIS_MASK_SIZE, REGISTERED_ANALYSIS_MASK_SIZE);
    renderer.setScissor(0, 0, REGISTERED_ANALYSIS_MASK_SIZE, REGISTERED_ANALYSIS_MASK_SIZE);
    renderer.clear(true, true, true);
    renderer.render(terrainMaskScene, mapView.camera);
    const terrainMaskPixels = new Uint8Array(
      REGISTERED_ANALYSIS_MASK_SIZE * REGISTERED_ANALYSIS_MASK_SIZE * 4,
    );
    renderer.readRenderTargetPixels(
      renderTarget,
      0,
      0,
      REGISTERED_ANALYSIS_MASK_SIZE,
      REGISTERED_ANALYSIS_MASK_SIZE,
      terrainMaskPixels,
    );
    const terrainMaskSummary = summarizeTerrainWaterMask(terrainMaskPixels);
    const encodedMask = encodeCategoryMaskRle(terrainMaskSummary.mask);
    const rawMaskPayloadSafe =
      encodedMask.dataBase64.length <= REGISTERED_RAW_MASK_MAX_BASE64_CHARS;
    const terrainWaterMask: RegisteredTerrainWaterMask = {
      pass: "literal-terrain-geometry-height-threshold",
      width: REGISTERED_ANALYSIS_MASK_SIZE,
      height: REGISTERED_ANALYSIS_MASK_SIZE,
      orientation: "north-up",
      waterLevelMeters,
      objectsExcluded: true,
      categories: { background: 0, water: 1, land: 2 },
      pixelCounts: terrainMaskSummary.counts,
      pngDataUrl: capturePixelsToDataUrl(
        terrainMaskPixels,
        REGISTERED_ANALYSIS_MASK_SIZE,
        REGISTERED_ANALYSIS_MASK_SIZE,
        128,
      ),
      ...(rawMaskPayloadSafe
        ? {
            rawMask: {
              encoding: "rle-category-u8-count-u16le-base64" as const,
              dataBase64: encodedMask.dataBase64,
              runCount: encodedMask.runCount,
              decodedPixelCount: terrainMaskSummary.mask.length,
            },
          }
        : {
            rawMaskOmittedReason: `RLE base64 exceeded ${REGISTERED_RAW_MASK_MAX_BASE64_CHARS} characters`,
          }),
    };

    const objectViews = {} as Record<RegisteredCaptureName, RegisteredObjectProxyView>;
    const depthViews = {} as Record<RegisteredCaptureName, RegisteredDepthSummary>;
    for (const view of views) {
      assertCaptureDeadline(deadline, `rendering the ${view.name} RGB24 proxy pass`);
      renderTarget.setSize(view.width, view.height);
      renderer.setRenderTarget(renderTarget);
      renderer.setViewport(0, 0, view.width, view.height);
      renderer.setScissor(0, 0, view.width, view.height);
      renderer.setClearColor(0x000000, 1);
      proxyBundle.scene.overrideMaterial = null;
      renderer.clear(true, true, true);
      renderer.render(proxyBundle.scene, view.camera);
      const idPixels = new Uint8Array(view.width * view.height * 4);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, view.width, view.height, idPixels);
      objectViews[view.name] = {
        ...summarizeObjectProxyPixels(
          idPixels,
          view.width,
          view.height,
          proxyBundle.mapping,
          proxyBundle.objectIdByEncodedId,
        ),
        pngDataUrl: capturePixelsToDataUrl(idPixels, view.width, view.height, 128),
      };

      assertCaptureDeadline(deadline, `rendering the ${view.name} depth pass`);
      renderer.setClearColor(0xffffff, 1);
      proxyBundle.scene.overrideMaterial = packedDepthMaterial;
      renderer.clear(true, true, true);
      renderer.render(proxyBundle.scene, view.camera);
      const depthPixels = new Uint8Array(view.width * view.height * 4);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, view.width, view.height, depthPixels);
      depthViews[view.name] = summarizeDepthPixels(depthPixels, view.width, view.height);
    }
    proxyBundle.scene.overrideMaterial = null;
    assertCaptureDeadline(deadline, "finalizing renderer-derived analysis");
    return {
      terrainWaterMask,
      objectProxyVisibility: {
        pass: "stable-rgb24-collider-proxy-visibility",
        geometry: "vertical-prisms-from-worldColliderForObject",
        occlusion: "literal-terrain-depth-plus-proxy-depth",
        literalObjectMeshes: false,
        idEncoding: "sorted-object-id-sequential-rgb24",
        mapping: proxyBundle.mapping,
        views: objectViews,
        heroReadabilityByView: heroReadabilityEvidence(world, objectViews),
      },
      normalizedDepth: depthViews,
      compiledSlots: collectCompiledSlotEvidence(liveScene, world),
    };
  } finally {
    proxyBundle.scene.overrideMaterial = null;
    renderer.xr.enabled = previousXrEnabled;
    renderer.autoClear = previousAutoClear;
    renderer.toneMapping = previousToneMapping;
    renderer.toneMappingExposure = previousToneMappingExposure;
    renderer.outputColorSpace = previousOutputColorSpace;
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setRenderTarget(
      previousRenderTarget,
      previousActiveCubeFace,
      previousActiveMipmapLevel,
    );
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.info.reset();
    renderTarget.dispose();
    terrainMaskScene.clear();
    terrainMaskMaterial.dispose();
    packedDepthMaterial.dispose();
    proxyBundle.dispose();
  }
}

function renderRegisteredCaptureImages(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  world: WorldSceneType,
  views: readonly CaptureViewDefinition[],
  deadline: number,
): Record<RegisteredCaptureName, RegisteredCaptureImage> {
  if (renderer.getContext().isContextLost()) {
    throw new Error("Registered capture cannot run while WebGL is context-lost.");
  }

  const renderTarget = new THREE.WebGLRenderTarget(
    REGISTERED_MAP_CAPTURE_SIZE,
    REGISTERED_MAP_CAPTURE_SIZE,
    {
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
    },
  );
  renderTarget.texture.name = "worldclaw-registered-capture";
  renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  renderTarget.texture.generateMipmaps = false;

  const previousRenderTarget = renderer.getRenderTarget();
  const previousActiveCubeFace = renderer.getActiveCubeFace();
  const previousActiveMipmapLevel = renderer.getActiveMipmapLevel();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousToneMapping = renderer.toneMapping;
  const previousToneMappingExposure = renderer.toneMappingExposure;
  const previousOutputColorSpace = renderer.outputColorSpace;
  const previousAutoClear = renderer.autoClear;
  const previousXrEnabled = renderer.xr.enabled;
  const fog = scene.fog instanceof THREE.Fog ? scene.fog : undefined;
  const previousFog = fog ? { near: fog.near, far: fog.far } : undefined;
  const captures = {} as Record<RegisteredCaptureName, RegisteredCaptureImage>;

  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setScissorTest(false);

    if (fog) {
      const worldSize = world.heightField.worldSize;
      fog.near = worldSize * (world.plan.theme === "volcanic" ? 0.85 : 1.15);
      fog.far =
        worldSize *
        (world.plan.theme === "volcanic" ? 2.6 : world.plan.theme === "desert" ? 3.4 : 3.1);
    }

    scene.updateMatrixWorld(true);
    for (const view of views) {
      assertCaptureDeadline(deadline, `rendering the ${view.name} view`);
      renderTarget.setSize(view.width, view.height);
      renderer.setRenderTarget(renderTarget);
      renderer.setViewport(0, 0, view.width, view.height);
      renderer.setScissor(0, 0, view.width, view.height);
      renderer.clear(true, true, true);
      view.camera.updateMatrixWorld(true);
      renderer.render(scene, view.camera);
      if (renderer.getContext().isContextLost()) {
        throw new Error(`WebGL context was lost while rendering the ${view.name} capture.`);
      }
      const pixels = new Uint8Array(view.width * view.height * 4);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, view.width, view.height, pixels);
      const validation = validateCapturePixels(pixels, view.name, view.width, view.height);
      const dataUrl = capturePixelsToDataUrl(pixels, view.width, view.height);
      assertCaptureDeadline(deadline, `encoding the ${view.name} view`);
      captures[view.name] = {
        dataUrl,
        width: view.width,
        height: view.height,
        camera: view.metadata,
        validation,
      };
    }
    return captures;
  } finally {
    if (fog && previousFog) {
      fog.near = previousFog.near;
      fog.far = previousFog.far;
    }
    renderer.xr.enabled = previousXrEnabled;
    renderer.autoClear = previousAutoClear;
    renderer.toneMapping = previousToneMapping;
    renderer.toneMappingExposure = previousToneMappingExposure;
    renderer.outputColorSpace = previousOutputColorSpace;
    renderer.setRenderTarget(
      previousRenderTarget,
      previousActiveCubeFace,
      previousActiveMipmapLevel,
    );
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.info.reset();
    renderTarget.dispose();
  }
}

function renderPaperCaptureMatrix(
  renderer: THREE.WebGLRenderer,
  liveScene: THREE.Scene,
  world: WorldSceneType,
  allViews: readonly PaperCaptureViewDefinition[],
  capturedViewNames: readonly PaperCaptureViewName[],
  deadline: number,
): Omit<
  WorldClawPaperCaptureMatrix,
  | "binding"
  | "worldPromptSha256"
  | "worldFingerprint"
  | "worldFingerprintAlgorithm"
  | "capturedAt"
  | "regionalReadability"
  | "isolation"
  | "materialAudit"
  | "stateAudit"
> {
  if (renderer.getContext().isContextLost()) {
    throw new Error("Paper capture cannot run while WebGL is context-lost.");
  }
  const requested = new Set(capturedViewNames);
  const views = allViews.filter((view) => requested.has(view.name));
  const diagnosticBundle = createPaperLiteralDiagnosticBundle(liveScene, world);
  const diagnosticRenderTarget = createEvidenceRenderTarget(
    PAPER_CAPTURE_WIDTH,
    PAPER_CAPTURE_HEIGHT,
  );
  const depthRenderTarget = createPaperFloatDepthRenderTarget(
    renderer,
    PAPER_CAPTURE_WIDTH,
    PAPER_CAPTURE_HEIGHT,
  );
  const beautyRenderTarget = new THREE.WebGLRenderTarget(
    PAPER_CAPTURE_WIDTH,
    PAPER_CAPTURE_HEIGHT,
    {
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
    },
  );
  beautyRenderTarget.texture.name = "worldclaw-paper-beauty";
  beautyRenderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  beautyRenderTarget.texture.generateMipmaps = false;
  const previousRenderTarget = renderer.getRenderTarget();
  const previousActiveCubeFace = renderer.getActiveCubeFace();
  const previousActiveMipmapLevel = renderer.getActiveMipmapLevel();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousToneMapping = renderer.toneMapping;
  const previousToneMappingExposure = renderer.toneMappingExposure;
  const previousOutputColorSpace = renderer.outputColorSpace;
  const previousAutoClear = renderer.autoClear;
  const previousXrEnabled = renderer.xr.enabled;
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const fog = liveScene.fog instanceof THREE.Fog ? liveScene.fog : undefined;
  const previousFog = fog ? { near: fog.near, far: fog.far } : undefined;
  const resultViews: Partial<Record<PaperCaptureViewName, PaperCaptureView>> = {};
  const viewDurationMs: Partial<Record<PaperCaptureViewName, number>> = {};
  let encodedPayloadCharacters = 0;
  const captureStartedAt = performance.now();

  const prepareRender = (
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    clearAlpha: number,
    target: THREE.WebGLRenderTarget,
    label: string,
  ) => {
    assertPaperCaptureDeadline(deadline, `starting ${label} render`);
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, PAPER_CAPTURE_WIDTH, PAPER_CAPTURE_HEIGHT);
    renderer.setScissor(0, 0, PAPER_CAPTURE_WIDTH, PAPER_CAPTURE_HEIGHT);
    renderer.setClearColor(0x000000, clearAlpha);
    renderer.clear(true, true, true);
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);
    assertPaperCaptureDeadline(deadline, `finishing ${label} render`);
    if (renderer.getContext().isContextLost()) {
      throw new Error("WebGL context was lost during paper capture.");
    }
  };

  const renderUint8Pixels = (
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    clearAlpha: number,
    target: THREE.WebGLRenderTarget,
    label: string,
  ): Uint8Array => {
    prepareRender(scene, camera, clearAlpha, target, label);
    const pixels = new Uint8Array(PAPER_CAPTURE_WIDTH * PAPER_CAPTURE_HEIGHT * 4);
    renderer.readRenderTargetPixels(
      target,
      0,
      0,
      PAPER_CAPTURE_WIDTH,
      PAPER_CAPTURE_HEIGHT,
      pixels,
    );
    assertPaperCaptureDeadline(deadline, `finishing ${label} readback`);
    return pixels;
  };

  const renderFloat32Pixels = (
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    clearAlpha: number,
    target: THREE.WebGLRenderTarget,
    label: string,
  ): Float32Array => {
    prepareRender(scene, camera, clearAlpha, target, label);
    const pixels = new Float32Array(PAPER_CAPTURE_WIDTH * PAPER_CAPTURE_HEIGHT * 4);
    renderer.readRenderTargetPixels(
      target,
      0,
      0,
      PAPER_CAPTURE_WIDTH,
      PAPER_CAPTURE_HEIGHT,
      pixels,
    );
    assertPaperCaptureDeadline(deadline, `finishing ${label} float32 readback`);
    return pixels;
  };

  let renderFailure: { readonly error: unknown } | null = null;

  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    liveScene.updateMatrixWorld(true);

    for (const view of views) {
      const viewStartedAt = performance.now();
      assertPaperCaptureDeadline(deadline, `starting view ${view.name}`);

      if (fog) {
        fog.near =
          world.heightField.worldSize *
          (view.role === "walk" ? (world.plan.theme === "volcanic" ? 0.3 : 0.45) : 1.15);
        fog.far =
          world.heightField.worldSize *
          (view.role === "walk"
            ? world.plan.theme === "volcanic"
              ? 1.4
              : 1.8
            : world.plan.theme === "volcanic"
              ? 2.6
              : world.plan.theme === "desert"
                ? 3.4
                : 3.1);
      }

      const beauty: PaperCaptureView["beauty"] = (() => {
        const startedAt = performance.now();
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        const pixels = renderUint8Pixels(
          liveScene,
          view.camera,
          1,
          beautyRenderTarget,
          `${view.name} beauty`,
        );
        const validation = validateCapturePixels(
          pixels,
          view.name,
          PAPER_CAPTURE_WIDTH,
          PAPER_CAPTURE_HEIGHT,
        );
        const dataUrl = capturePixelsToDataUrl(pixels, PAPER_CAPTURE_WIDTH, PAPER_CAPTURE_HEIGHT);
        assertPaperCaptureDeadline(deadline, `finishing ${view.name} beauty PNG encode`);
        encodedPayloadCharacters += dataUrl.length;
        return {
          pass: "beauty",
          dataUrl,
          width: PAPER_CAPTURE_WIDTH,
          height: PAPER_CAPTURE_HEIGHT,
          postprocessingBypassed: true,
          durationMs: performance.now() - startedAt,
          renderPipeline: "direct-lit-structural-beauty",
          purpose: "camera-matched-structural-comparison",
          visiblePostprocessingEquivalent: false,
          omittedVisibleEffects: ["N8AO", "Bloom", "Vignette"],
          validation,
        };
      })();

      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      const instance: PaperCaptureView["instance"] = (() => {
        const startedAt = performance.now();
        diagnosticBundle.usePass("instance");
        const pixels = renderUint8Pixels(
          diagnosticBundle.scene,
          view.camera,
          0,
          diagnosticRenderTarget,
          `${view.name} instance ID`,
        );
        const visibility = summarizePaperIdPixels(
          pixels,
          diagnosticBundle.mapping,
          diagnosticBundle.logicalIdByEncodedId,
          diagnosticBundle.logicalTypeById,
        );
        const dataUrl = capturePixelsToDataUrl(
          pixels,
          PAPER_CAPTURE_WIDTH,
          PAPER_CAPTURE_HEIGHT,
          128,
          true,
        );
        assertPaperCaptureDeadline(deadline, `finishing ${view.name} instance PNG encode`);
        encodedPayloadCharacters += dataUrl.length;
        return {
          pass: "instance",
          dataUrl,
          width: PAPER_CAPTURE_WIDTH,
          height: PAPER_CAPTURE_HEIGHT,
          postprocessingBypassed: true,
          durationMs: performance.now() - startedAt,
          geometry: "literal-rendered-terrain-water-and-object-meshes",
          idEncoding: "stable-sorted-logical-id-rgb24",
          backgroundEncodedId24: 0,
          visibility,
        };
      })();

      const depth: PaperCaptureView["depth"] = (() => {
        const startedAt = performance.now();
        diagnosticBundle.usePass("depth");
        const floatPixels = renderFloat32Pixels(
          diagnosticBundle.scene,
          view.camera,
          0,
          depthRenderTarget,
          `${view.name} linear depth`,
        );
        const { summary, previewPixels } = summarizePaperDepthPixels(
          floatPixels,
          view.camera.near,
          view.camera.far,
        );
        const dataUrl = capturePixelsToDataUrl(
          previewPixels,
          PAPER_CAPTURE_WIDTH,
          PAPER_CAPTURE_HEIGHT,
          128,
          true,
        );
        assertPaperCaptureDeadline(deadline, `finishing ${view.name} depth PNG encode`);
        encodedPayloadCharacters += dataUrl.length;
        return {
          pass: "depth",
          dataUrl,
          width: PAPER_CAPTURE_WIDTH,
          height: PAPER_CAPTURE_HEIGHT,
          postprocessingBypassed: true,
          durationMs: performance.now() - startedAt,
          geometry: "literal-rendered-terrain-water-and-object-meshes",
          measurementEncoding: "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel",
          previewEncoding: "linear-near-far-grayscale-u8-alpha-coverage",
          finiteValidation: "geometry-preflight-plus-shader-sentinel-plus-float32-readback",
          runtimeAttestation: "float32-finiteness-and-range-validated-before-lossy-png-preview",
          units: "meters",
          nearMeters: view.camera.near,
          farMeters: view.camera.far,
          ...summary,
        };
      })();

      const normal: PaperCaptureView["normal"] = (() => {
        const startedAt = performance.now();
        diagnosticBundle.usePass("normal");
        const pixels = renderUint8Pixels(
          diagnosticBundle.scene,
          view.camera,
          0,
          diagnosticRenderTarget,
          `${view.name} geometry normal`,
        );
        const coverage = summarizePaperCoveragePixels(pixels);
        const dataUrl = capturePixelsToDataUrl(
          pixels,
          PAPER_CAPTURE_WIDTH,
          PAPER_CAPTURE_HEIGHT,
          128,
          true,
        );
        assertPaperCaptureDeadline(deadline, `finishing ${view.name} normal PNG encode`);
        encodedPayloadCharacters += dataUrl.length;
        return {
          pass: "normal",
          dataUrl,
          width: PAPER_CAPTURE_WIDTH,
          height: PAPER_CAPTURE_HEIGHT,
          postprocessingBypassed: true,
          durationMs: performance.now() - startedAt,
          geometry: "literal-rendered-terrain-water-and-object-meshes",
          encoding: "view-space-geometry-normal-rgb8-alpha-coverage",
          normalMapApplied: false,
          ...coverage,
        };
      })();

      resultViews[view.name] = {
        role: view.role,
        ordinal: view.ordinal,
        width: PAPER_CAPTURE_WIDTH,
        height: PAPER_CAPTURE_HEIGHT,
        camera: view.metadata,
        beauty,
        instance,
        depth,
        normal,
      };
      viewDurationMs[view.name] = performance.now() - viewStartedAt;
      assertPaperCaptureDeadline(deadline, `finishing view ${view.name}`);
    }
    assertPaperCaptureDeadline(deadline, "finishing the requested view set");
  } catch (error: unknown) {
    renderFailure = { error };
  } finally {
    if (fog && previousFog) {
      fog.near = previousFog.near;
      fog.far = previousFog.far;
    }
    renderer.xr.enabled = previousXrEnabled;
    renderer.autoClear = previousAutoClear;
    renderer.toneMapping = previousToneMapping;
    renderer.toneMappingExposure = previousToneMappingExposure;
    renderer.outputColorSpace = previousOutputColorSpace;
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setRenderTarget(
      previousRenderTarget,
      previousActiveCubeFace,
      previousActiveMipmapLevel,
    );
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.info.reset();
    beautyRenderTarget.dispose();
    diagnosticRenderTarget.dispose();
    depthRenderTarget.dispose();
    diagnosticBundle.dispose();
  }

  const restoredViewport = renderer.getViewport(new THREE.Vector4());
  const restoredScissor = renderer.getScissor(new THREE.Vector4());
  const restoredClearColor = renderer.getClearColor(new THREE.Color());
  const rendererStateRestored =
    renderer.getRenderTarget() === previousRenderTarget &&
    restoredViewport.equals(previousViewport) &&
    restoredScissor.equals(previousScissor) &&
    renderer.getScissorTest() === previousScissorTest &&
    renderer.toneMapping === previousToneMapping &&
    renderer.toneMappingExposure === previousToneMappingExposure &&
    renderer.outputColorSpace === previousOutputColorSpace &&
    renderer.autoClear === previousAutoClear &&
    renderer.xr.enabled === previousXrEnabled &&
    restoredClearColor.equals(previousClearColor) &&
    renderer.getClearAlpha() === previousClearAlpha;
  if (renderFailure) throw renderFailure.error;
  if (!rendererStateRestored) {
    throw new Error("Paper capture failed to restore the WebGL renderer state.");
  }
  assertPaperCaptureDeadline(deadline, "finalizing the renderer-restored payload");

  return {
    version: 1,
    worldId: world.id,
    seed: world.seed,
    mimeType: "image/png",
    capturePolicy: {
      availableViews: PAPER_CAPTURE_VIEW_NAMES,
      capturedViews: [...capturedViewNames],
      defaultRequest: "all-nine-views",
      fixedResolution: { width: PAPER_CAPTURE_WIDTH, height: PAPER_CAPTURE_HEIGHT },
      sequential: true,
      maximumViewsPerRequest: 9,
      passesPerView: ["beauty", "instance", "depth", "normal"],
      maximumRawReadbackBytes:
        PAPER_CAPTURE_VIEW_NAMES.length *
        (4 + 4 + 16 + 4) *
        PAPER_CAPTURE_WIDTH *
        PAPER_CAPTURE_HEIGHT,
      maximumSimultaneousRawReadbackBytes: (16 + 4) * PAPER_CAPTURE_WIDTH * PAPER_CAPTURE_HEIGHT,
      rawPixelsRetained: false,
      beautyPipeline: "direct-lit-structural-beauty-not-visible-postprocessed-ui",
      diagnosticPipeline: "literal-geometry-direct-render-postprocessing-bypassed",
    },
    logicalIds: {
      stableAcrossViewsAndCompiledSubmeshes: true,
      source: "world-object-id-and-rendered-surface-id",
      mapping: diagnosticBundle.mapping,
    },
    geometryInventory: diagnosticBundle.inventory,
    views: resultViews,
    performance: {
      totalDurationMs: performance.now() - captureStartedAt,
      encodedPayloadCharacters,
      viewDurationMs,
    },
  };
}

const rendererCaptureTails = new WeakMap<THREE.WebGLRenderer, Promise<void>>();

/** Serialize both public capture APIs because they share one WebGL renderer. */
function enqueueRendererCapture<T>(
  renderer: THREE.WebGLRenderer,
  capture: () => Promise<T>,
): Promise<T> {
  const previous = rendererCaptureTails.get(renderer) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(capture);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  rendererCaptureTails.set(renderer, tail);
  void tail.finally(() => {
    if (rendererCaptureTails.get(renderer) === tail) rendererCaptureTails.delete(renderer);
  });
  return result;
}

function RegisteredMapCamera({ world }: { world: WorldSceneType }) {
  const { size } = useThree();
  const aspect = Math.max(0.1, size.width / Math.max(1, size.height));
  const contentBounds = useMemo(() => registeredContentBounds(world), [world]);
  const framing = fitLiveMapFraming(
    {
      minimumX: contentBounds.box.min.x,
      maximumX: contentBounds.box.max.x,
      minimumZ: contentBounds.box.min.z,
      maximumZ: contentBounds.box.max.z,
    },
    aspect,
  );
  const worldSize = world.heightField.worldSize;
  const cameraY = Math.max(worldSize * 1.25, contentBounds.box.max.y + worldSize);
  return (
    <OrthographicCamera
      makeDefault
      position={[framing.centerX, cameraY, framing.centerZ]}
      rotation={[-Math.PI / 2, 0, 0]}
      left={framing.left}
      right={framing.right}
      top={framing.top}
      bottom={framing.bottom}
      near={0.1}
      far={Math.max(worldSize * 3, cameraY - contentBounds.box.min.y + worldSize)}
      userData={{
        worldclawLiveMapFraming: {
          source: "finite-land-and-authored-collider-envelope",
          centerX: framing.centerX,
          centerZ: framing.centerZ,
          majorAxisFill: framing.majorAxisFill,
        },
      }}
    />
  );
}

interface LiveDiagnosticMaterials {
  readonly instanceByLogicalId: ReadonlyMap<string, THREE.MeshBasicMaterial>;
  readonly compiledInstance: THREE.MeshBasicMaterial;
  readonly instanceColors: ReadonlyMap<string, THREE.Color>;
  readonly linearDepth: THREE.ShaderMaterial;
  readonly dispose: () => void;
}

function createLiveDiagnosticMaterials(world: WorldSceneType): LiveDiagnosticMaterials {
  const logicalIds = [
    PAPER_CAPTURE_TERRAIN_ID,
    PAPER_CAPTURE_WATER_ID,
    ...world.objects.map((object) => object.id),
  ];
  const instanceColors = new Map<string, THREE.Color>();
  const instanceByLogicalId = new Map<string, THREE.MeshBasicMaterial>();
  for (const logicalId of logicalIds) {
    const color = new THREE.Color().fromArray(stableLiveInstanceColor(logicalId));
    instanceColors.set(logicalId, color);
    instanceByLogicalId.set(
      logicalId,
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
    );
  }

  const compiledInstance = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    // Three activates instanceColor automatically for an InstancedMesh. Keep
    // geometry vertex colors disabled: the compact GLB has no color attributes,
    // and enabling both paths multiplies every categorical instance color by 0.
    vertexColors: LIVE_COMPILED_INSTANCE_MATERIAL_VERTEX_COLORS,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const linearDepth = new THREE.ShaderMaterial({
    uniforms: {
      depthNearMeters: { value: Math.max(0.1, world.heightField.worldSize * 0.005) },
      depthFarMeters: { value: Math.max(10, world.heightField.worldSize * 2.25) },
    },
    vertexShader: /* glsl */ `
      varying float vViewDepthMeters;

      void main() {
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        vec4 viewPosition = modelViewMatrix * localPosition;
        vViewDepthMeters = max(0.0, -viewPosition.z);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float depthNearMeters;
      uniform float depthFarMeters;
      varying float vViewDepthMeters;

      void main() {
        float normalizedDepth = clamp(
          (vViewDepthMeters - depthNearMeters) / max(0.000001, depthFarMeters - depthNearMeters),
          0.0,
          1.0
        );
        float luminance = ${LIVE_DEPTH_MINIMUM_LUMINANCE.toFixed(2)} +
          (1.0 - normalizedDepth) * ${LIVE_DEPTH_LUMINANCE_RANGE.toFixed(2)};
        gl_FragColor = vec4(vec3(luminance), 1.0);
      }
    `,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
  });
  linearDepth.name = "WorldClaw live linear depth diagnostic";

  return {
    instanceByLogicalId,
    compiledInstance,
    instanceColors,
    linearDepth,
    dispose: () => {
      for (const material of instanceByLogicalId.values()) material.dispose();
      compiledInstance.dispose();
      linearDepth.dispose();
    },
  };
}

/**
 * Live-only material repair for current Three releases. Paper diagnostics use
 * their own cloned literal scene and RGB24/float materials; lit mode is left
 * entirely to the authored mesh materials so capture isolation remains exact.
 */
function LiveDiagnosticMaterialBridge({ world }: { world: WorldSceneType | null }) {
  const { scene } = useThree();
  const viewMode = useWorldClaw((state) => state.viewMode);
  const materials = useMemo(() => (world ? createLiveDiagnosticMaterials(world) : null), [world]);

  useEffect(() => {
    if (!materials) return;
    return () => materials.dispose();
  }, [materials]);

  const applied = useRef({ signature: "", meshCount: -1, checkedAt: -Infinity });

  useFrame(({ clock }) => {
    if (!world || !materials || (viewMode !== "instance" && viewMode !== "depth")) {
      applied.current.signature = "";
      applied.current.meshCount = -1;
      return;
    }

    const signature = `${world.id}:${viewMode}`;
    const elapsed = clock.elapsedTime;
    const signatureChanged = applied.current.signature !== signature;
    if (!signatureChanged && elapsed - applied.current.checkedAt < 0.25) return;

    let meshCount = 0;
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) meshCount++;
    });
    applied.current.checkedAt = elapsed;
    if (!signatureChanged && applied.current.meshCount === meshCount) return;

    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (
        object instanceof THREE.InstancedMesh &&
        object.userData.worldclawCompiledBatch === true
      ) {
        if (viewMode === "depth") {
          object.material = materials.linearDepth;
          return;
        }
        const instanceObjectIds = object.userData.instanceObjectIds;
        if (!Array.isArray(instanceObjectIds)) return;
        object.material = materials.compiledInstance;
        for (let index = 0; index < Math.min(object.count, instanceObjectIds.length); index++) {
          const logicalId = instanceObjectIds[index];
          if (typeof logicalId !== "string") continue;
          const color = materials.instanceColors.get(logicalId);
          if (color) object.setColorAt(index, color);
        }
        if (object.instanceColor) object.instanceColor.needsUpdate = true;
        return;
      }

      const logicalId = inheritedPaperLogicalId(object);
      if (!logicalId) return;
      object.material =
        viewMode === "depth"
          ? materials.linearDepth
          : (materials.instanceByLogicalId.get(logicalId) ?? materials.compiledInstance);
    });
    applied.current.signature = signature;
    applied.current.meshCount = meshCount;
  });

  return null;
}

interface WalkQaTelemetry {
  enabled: boolean;
  radius: number;
  worldHalfExtent: number;
  safeSpawnCandidate: number | null;
  safeSpawnAccepted: boolean;
  spawnYawRadians: number | null;
  forwardClearanceMeters: number | null;
  dryGroundAccepted: boolean;
  collidedIds: string[];
  unresolvedIds: string[];
  boundsClamped: boolean;
}

interface WorldClawQaSnapshot {
  readonly camera: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly renderer: Readonly<{
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
  }>;
  readonly assets: Readonly<{
    blenderPrototypeInstances: number;
    primitiveFallbackInstances: number;
    prototypeCounts: Readonly<Record<string, number>>;
    libraryUris: readonly string[];
    fallbackKinds: readonly string[];
    compiledBatches: number;
    compiledDrawGroups: number;
    compiledInstanceSlots: number;
  }>;
  readonly world: Readonly<{
    id: string | null;
    seed: number | null;
    prompt: string | null;
    viewMode: string;
    cameraMode: string;
  }>;
  readonly walk: Readonly<{
    enabled: boolean;
    radius: number;
    worldHalfExtent: number;
    safeSpawnCandidate: number | null;
    safeSpawnAccepted: boolean;
    spawnYawRadians: number | null;
    forwardClearanceMeters: number | null;
    dryGroundAccepted: boolean;
    collidedIds: readonly string[];
    unresolvedIds: readonly string[];
    boundsClamped: boolean;
  }>;
}

declare global {
  interface Window {
    __WORLDCLAW_QA__?: WorldClawQaSnapshot;
    __WORLDCLAW_RENDERER_READINESS__?: WorldClawRendererReadiness;
    __WORLDCLAW_CAPTURE_REGISTERED__?: () => Promise<WorldClawRegisteredCapture>;
    __WORLDCLAW_CAPTURE_PAPER_MATRIX__?: (
      request?: PaperCaptureRequest,
    ) => Promise<WorldClawPaperCaptureMatrix>;
  }
}

/**
 * One world-scoped readiness contract shared by the live renderer and final
 * validation. It resolves only after every expected compiled object id is
 * represented by a mounted GLB batch, and rejects after the same bounded
 * 90-second window used by renderer QA.
 */
function RendererReadinessBridge({ world }: { world: WorldSceneType | null }) {
  const { invalidate, scene } = useThree();

  useEffect(() => {
    if (!world) return;
    const controller = new AbortController();
    const deadline = performance.now() + WORLDCLAW_RENDERER_READY_TIMEOUT_MS;
    invalidate();
    const ready = (async () => {
      await waitForCaptureContent(scene, world, deadline, controller.signal, "Renderer readiness");
      await waitForCaptureFrame(deadline, "Renderer readiness", controller.signal);
      controller.signal.throwIfAborted();
      if (useWorldClaw.getState().world !== world) {
        throw new Error("Renderer readiness was cancelled because the active world changed.");
      }
    })();
    // Registration can briefly precede the parent AppShell effect. Retain an
    // attached rejection handler so an early unmount cannot create an
    // unhandled promise while preserving rejection for actual consumers.
    void ready.catch(() => undefined);
    const unregister = registerRendererReadiness(window, { worldId: world.id, ready });
    return () => {
      unregister();
      controller.abort(new DOMException("Renderer readiness superseded", "AbortError"));
    };
  }, [invalidate, scene, world]);

  return null;
}

/** Low-frequency, read-only evidence for assertive browser QA. */
function SceneQaProbe({ world }: { world: WorldSceneType | null }) {
  const { gl: renderer } = useThree();
  const viewMode = useWorldClaw((state) => state.viewMode);
  const cameraMode = useWorldClaw((state) => state.cameraMode);
  const lastUpdate = useRef(-Infinity);
  const ownedSnapshot = useRef<WorldClawQaSnapshot | undefined>(undefined);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const assetSummary = useMemo(() => {
    const prototypeCounts: Record<string, number> = {};
    const libraryUris = new Set<string>();
    const fallbackKinds = new Set<string>();
    let blenderPrototypeInstances = 0;
    let primitiveFallbackInstances = 0;

    for (const object of world?.objects ?? []) {
      if (object.browserAsset) {
        blenderPrototypeInstances++;
        const prototype = object.browserAsset.prototype;
        prototypeCounts[prototype] = (prototypeCounts[prototype] ?? 0) + 1;
        libraryUris.add(object.browserAsset.uri);
      } else {
        primitiveFallbackInstances++;
        fallbackKinds.add(object.kind);
      }
    }

    return {
      blenderPrototypeInstances,
      primitiveFallbackInstances,
      prototypeCounts,
      libraryUris: [...libraryUris].sort(),
      fallbackKinds: [...fallbackKinds].sort(),
    };
  }, [world]);

  useEffect(() => {
    // Accumulate every scene/post-process pass for a frame. Auto-reset leaves
    // only the composer's final fullscreen pass in renderer.info.
    const previousAutoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    return () => {
      renderer.info.autoReset = previousAutoReset;
      renderer.info.reset();
      if (window.__WORLDCLAW_QA__ === ownedSnapshot.current) {
        delete window.__WORLDCLAW_QA__;
      }
    };
  }, [renderer]);

  useFrame(({ camera, clock, gl, scene }) => {
    const frameCalls = gl.info.render.calls;
    const frameTriangles = gl.info.render.triangles;
    gl.info.reset();
    const elapsed = clock.elapsedTime;
    if (elapsed - lastUpdate.current < 0.25) return;
    lastUpdate.current = elapsed;
    camera.getWorldDirection(forward);
    let compiledBatches = 0;
    let compiledDrawGroups = 0;
    let compiledInstanceSlots = 0;
    scene.traverse((object) => {
      if (
        !(object instanceof THREE.InstancedMesh) ||
        object.userData.worldclawCompiledBatch !== true
      ) {
        return;
      }
      compiledBatches++;
      compiledDrawGroups += Number(object.userData.drawGroups ?? 1);
      compiledInstanceSlots += object.count;
    });
    const walkTelemetry = scene.userData.worldclawWalkTelemetry as WalkQaTelemetry | undefined;

    const snapshot: WorldClawQaSnapshot = Object.freeze({
      camera: Object.freeze([camera.position.x, camera.position.y, camera.position.z]) as readonly [
        number,
        number,
        number,
      ],
      forward: Object.freeze([forward.x, forward.y, forward.z]) as readonly [
        number,
        number,
        number,
      ],
      renderer: Object.freeze({
        calls: frameCalls,
        triangles: frameTriangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
      }),
      assets: Object.freeze({
        ...assetSummary,
        prototypeCounts: Object.freeze({ ...assetSummary.prototypeCounts }),
        libraryUris: Object.freeze([...assetSummary.libraryUris]),
        fallbackKinds: Object.freeze([...assetSummary.fallbackKinds]),
        compiledBatches,
        compiledDrawGroups,
        compiledInstanceSlots,
      }),
      world: Object.freeze({
        id: world?.id ?? null,
        seed: world?.seed ?? null,
        prompt: world?.plan.prompt ?? null,
        viewMode,
        cameraMode,
      }),
      walk: Object.freeze({
        enabled: walkTelemetry?.enabled ?? false,
        radius: walkTelemetry?.radius ?? WALK_COLLIDER_RADIUS,
        worldHalfExtent: walkTelemetry?.worldHalfExtent ?? 0,
        safeSpawnCandidate: walkTelemetry?.safeSpawnCandidate ?? null,
        safeSpawnAccepted: walkTelemetry?.safeSpawnAccepted ?? false,
        spawnYawRadians: walkTelemetry?.spawnYawRadians ?? null,
        forwardClearanceMeters: walkTelemetry?.forwardClearanceMeters ?? null,
        dryGroundAccepted: walkTelemetry?.dryGroundAccepted ?? false,
        collidedIds: Object.freeze([...(walkTelemetry?.collidedIds ?? [])]),
        unresolvedIds: Object.freeze([...(walkTelemetry?.unresolvedIds ?? [])]),
        boundsClamped: walkTelemetry?.boundsClamped ?? false,
      }),
    });
    ownedSnapshot.current = snapshot;
    window.__WORLDCLAW_QA__ = snapshot;
  });

  return null;
}

/** On-demand only: fixed-size offscreen validation views with no camera swap. */
function RegisteredCaptureBridge({ world }: { world: WorldSceneType | null }) {
  const { gl: renderer, invalidate, scene } = useThree();
  const captureInFlight = useRef<Promise<WorldClawRegisteredCapture> | null>(null);

  useEffect(() => {
    let mounted = true;
    const captureRegistered = (): Promise<WorldClawRegisteredCapture> => {
      if (captureInFlight.current) return captureInFlight.current;

      const captureTask: Promise<WorldClawRegisteredCapture> = enqueueRendererCapture(
        renderer,
        async () => {
          if (!world) {
            throw new Error("Registered capture requires a completed world.");
          }
          const contract = world.plan.visualContract;
          const views = createRegisteredCaptureViews(world);
          if (!contract) {
            // createRegisteredCaptureViews already rejects this; keep narrowing
            // explicit so the returned metadata cannot claim an absent source.
            throw new Error("Registered capture requires a VisualContract.");
          }

          const deadline = performance.now() + REGISTERED_CAPTURE_TIMEOUT_MS;
          await waitForCaptureContent(scene, world, deadline);
          if (!mounted || useWorldClaw.getState().world !== world) {
            throw new Error("Registered capture was cancelled because the active world changed.");
          }

          const originalState = useWorldClaw.getState();
          useWorldClaw.setState({
            viewMode: "lit",
            selectedObjectId: null,
          });
          invalidate();
          try {
            // Allow React materials and selected-instance transforms to commit.
            await waitForCaptureFrame(deadline);
            await waitForCaptureFrame(deadline);
            assertCaptureDeadline(deadline, "preparing the lit scene");
            if (!mounted || useWorldClaw.getState().world !== world) {
              throw new Error("Registered capture was cancelled because the active world changed.");
            }

            const images = renderRegisteredCaptureImages(renderer, scene, world, views, deadline);
            const analysis = renderRegisteredCaptureAnalysis(
              renderer,
              scene,
              world,
              views,
              deadline,
            );
            return {
              version: 1,
              worldId: world.id,
              seed: world.seed,
              mimeType: "image/png",
              renderPipeline: "direct-lit-validation",
              visualContractSource: contract.source,
              viewports: {
                map: {
                  width: REGISTERED_MAP_CAPTURE_SIZE,
                  height: REGISTERED_MAP_CAPTURE_SIZE,
                },
                multiAngle: {
                  width: REGISTERED_PERSPECTIVE_CAPTURE_WIDTH,
                  height: REGISTERED_PERSPECTIVE_CAPTURE_HEIGHT,
                },
              },
              images,
              analysis,
            };
          } finally {
            const currentState = useWorldClaw.getState();
            useWorldClaw.setState({
              viewMode: originalState.viewMode,
              selectedObjectId:
                currentState.world === world ? originalState.selectedObjectId : null,
            });
            invalidate();
            // Do not resolve while React is still displaying capture-only lit
            // materials or deselected instance matrices.
            const restoreDeadline = performance.now() + 2_000;
            try {
              await waitForCaptureFrame(restoreDeadline);
              await waitForCaptureFrame(restoreDeadline);
            } catch {
              // Store state is already restored synchronously; a hidden/throttled
              // tab may not deliver RAF before the bounded cleanup deadline.
            }
          }
        },
      );

      const trackedTask = captureTask.then(
        (result) => {
          if (captureInFlight.current === trackedTask) {
            captureInFlight.current = null;
          }
          return result;
        },
        (error: unknown) => {
          if (captureInFlight.current === trackedTask) {
            captureInFlight.current = null;
          }
          throw error;
        },
      );
      captureInFlight.current = trackedTask;
      return trackedTask;
    };

    window.__WORLDCLAW_CAPTURE_REGISTERED__ = captureRegistered;
    return () => {
      mounted = false;
      if (window.__WORLDCLAW_CAPTURE_REGISTERED__ === captureRegistered) {
        delete window.__WORLDCLAW_CAPTURE_REGISTERED__;
      }
    };
  }, [invalidate, renderer, scene, world]);

  return null;
}

/**
 * Bounded on-demand paper comparison matrix. Beauty uses the live lit scene;
 * every diagnostic pass uses an isolated scene made from the literal rendered
 * geometry and therefore never swaps a live mesh material or camera.
 */
function PaperCaptureBridge({ world }: { world: WorldSceneType | null }) {
  const { camera: liveCamera, gl: renderer, invalidate, scene } = useThree();
  const capturesInFlight = useRef(new Map<string, Promise<WorldClawPaperCaptureMatrix>>());

  useEffect(() => {
    let mounted = true;
    const capturePaperMatrix = (
      request?: PaperCaptureRequest,
    ): Promise<WorldClawPaperCaptureMatrix> => {
      const capturedViewNames = resolvePaperCaptureViewNames(request);
      const requestedBinding = resolvePaperCaptureBinding(request?.binding);
      const regionalRoles = resolvePaperRegionalRoles(request?.regionalRoles);
      if (requestedBinding && !regionalRoles) {
        throw new Error("Bound paper capture requires preregistered regional roles.");
      }
      if (
        requestedBinding &&
        JSON.stringify(requestedBinding.regionalReadability) !== JSON.stringify(regionalRoles)
      ) {
        throw new Error("Paper capture regional roles drifted from the benchmark binding.");
      }
      if (!requestedBinding && regionalRoles) {
        throw new Error("Paper regional roles require an exact benchmark binding.");
      }
      const requestKey = JSON.stringify({
        views: capturedViewNames,
        binding: requestedBinding,
        regionalRoles,
      });
      const existing = capturesInFlight.current.get(requestKey);
      if (existing) return existing;

      const captureTask: Promise<WorldClawPaperCaptureMatrix> = enqueueRendererCapture(
        renderer,
        async (): Promise<WorldClawPaperCaptureMatrix> => {
          if (!world) throw new Error("Paper capture requires a completed world.");
          const worldPromptSha256 = await paperPromptSha256(world.plan.prompt);
          if (requestedBinding && requestedBinding.promptSha256 !== worldPromptSha256) {
            throw new Error("Paper capture prompt hash does not match the active world.");
          }
          const deadline = performance.now() + PAPER_CAPTURE_TIMEOUT_MS;
          await waitForCaptureContent(scene, world, deadline, undefined, "Paper capture");
          if (!mounted || useWorldClaw.getState().world !== world) {
            throw new Error("Paper capture was cancelled because the active world changed.");
          }

          const originalState = useWorldClaw.getState();
          const originalWorldFingerprint = paperWorldFingerprint(world);
          const originalMaterialSnapshot = capturePaperLiveMaterialSnapshot(scene);
          let litMaterialSnapshot: PaperLiveMaterialSnapshot | undefined;
          let rendered:
            | Omit<
                WorldClawPaperCaptureMatrix,
                | "binding"
                | "worldPromptSha256"
                | "worldFingerprint"
                | "worldFingerprintAlgorithm"
                | "capturedAt"
                | "regionalReadability"
                | "isolation"
                | "materialAudit"
                | "stateAudit"
              >
            | undefined;
          let captureFailure: { readonly error: unknown } | null = null;
          let restorationFailure: { readonly error: unknown } | null = null;
          let restorationFrameFailure: { readonly error: unknown } | null = null;

          useWorldClaw.setState({ viewMode: "lit", selectedObjectId: null });
          invalidate();
          try {
            // Commit lit materials and unselected instance matrices before the
            // live-scene structural beauty pass. Diagnostics only reference
            // cloned Mesh objects, so the live material references remain intact.
            await waitForCaptureFrame(deadline, "Paper capture");
            await waitForCaptureFrame(deadline, "Paper capture");
            assertPaperCaptureDeadline(deadline, "preparing the direct-lit scene");
            if (!mounted || useWorldClaw.getState().world !== world) {
              throw new Error("Paper capture was cancelled because the active world changed.");
            }
            litMaterialSnapshot = capturePaperLiveMaterialSnapshot(scene);
            const cameraBeforeDiagnostics = capturePaperCameraState(liveCamera);
            const allViews = createPaperCaptureViews(world, regionalRoles);
            rendered = renderPaperCaptureMatrix(
              renderer,
              scene,
              world,
              allViews,
              capturedViewNames,
              deadline,
            );
            const materialsAfterDiagnostics = capturePaperLiveMaterialSnapshot(scene);
            assertPaperMaterialSnapshotsEqual(
              litMaterialSnapshot,
              materialsAfterDiagnostics,
              true,
              "diagnostic isolation",
            );
            const cameraAfterDiagnostics = capturePaperCameraState(liveCamera);
            if (!paperCameraStateEquals(cameraBeforeDiagnostics, cameraAfterDiagnostics)) {
              throw new Error("Paper capture mutated the live camera state.");
            }
            assertPaperCaptureDeadline(deadline, "validating live scene isolation");
          } catch (error: unknown) {
            captureFailure = { error };
          }

          try {
            const currentState = useWorldClaw.getState();
            useWorldClaw.setState({
              viewMode: originalState.viewMode,
              selectedObjectId:
                currentState.world === world ? originalState.selectedObjectId : null,
            });
            invalidate();
          } catch (error: unknown) {
            restorationFailure = { error };
          }

          if (!restorationFailure) {
            const restoreDeadline = performance.now() + 4_000;
            try {
              await waitForCaptureFrame(restoreDeadline, "Paper capture restoration");
              await waitForCaptureFrame(restoreDeadline, "Paper capture restoration");
            } catch (error: unknown) {
              // Hidden/throttled tabs may not deliver RAF. Validation below is
              // authoritative; this bounded wait must never mask a capture error.
              restorationFrameFailure = { error };
            }
            try {
              const restoredState = useWorldClaw.getState();
              if (
                restoredState.viewMode !== originalState.viewMode ||
                restoredState.selectedObjectId !== originalState.selectedObjectId
              ) {
                throw new Error("Paper capture failed to restore the UI material/selection state.");
              }
              assertPaperMaterialSnapshotsEqual(
                originalMaterialSnapshot,
                capturePaperLiveMaterialSnapshot(scene),
                false,
                "restoration",
              );
              if (paperWorldFingerprint(world) !== originalWorldFingerprint) {
                throw new Error("Paper capture mutated the retained world data.");
              }
            } catch (error: unknown) {
              restorationFailure = { error };
            }
          }

          if (captureFailure) throw captureFailure.error;
          if (restorationFailure) throw restorationFailure.error;
          // A missed restoration RAF is harmless only when the synchronous UI
          // state plus live material/world validation above prove restoration.
          void restorationFrameFailure;
          if (!rendered || !litMaterialSnapshot) {
            throw new Error("Paper capture completed without a retained payload.");
          }
          const restoredPromptSha256 = await paperPromptSha256(world.plan.prompt);
          if (restoredPromptSha256 !== worldPromptSha256) {
            throw new Error("Paper capture mutated the active world prompt.");
          }
          return {
            ...rendered,
            binding: requestedBinding,
            worldPromptSha256,
            worldFingerprint: originalWorldFingerprint,
            worldFingerprintAlgorithm: "fnv1a-dual32-canonical-world",
            capturedAt: new Date().toISOString(),
            regionalReadability: regionalRoles ?? undefined,
            materialAudit: {
              verification: "live-mesh-uuid-material-reference-and-property-fingerprint",
              originalMaterialEntryCount: originalMaterialSnapshot.entries.size,
              litMaterialEntryCount: litMaterialSnapshot.entries.size,
              liveMaterialReferencesUnchangedDuringDiagnostics: true,
              liveMaterialPropertiesUnchangedDuringDiagnostics: true,
              originalMaterialPropertiesRestored: true,
            },
            stateAudit: {
              directLitBeautyReportedAsVisiblePostprocessingEquivalent: false,
              liveMaterialStateVerified: true,
              liveCameraStateVerified: true,
              worldFingerprintVerified: true,
            },
            isolation: {
              worldDataMutated: false,
              liveCameraMutated: false,
              liveMaterialsUsedForDiagnostics: false,
              diagnosticPostprocessingBypassed: true,
              rendererStateRestored: true,
              uiViewModeRestored: true,
              uiSelectionRestored: true,
            },
          };
        },
      );

      const trackedTask = captureTask.then(
        (result) => {
          if (capturesInFlight.current.get(requestKey) === trackedTask) {
            capturesInFlight.current.delete(requestKey);
          }
          return result;
        },
        (error: unknown) => {
          if (capturesInFlight.current.get(requestKey) === trackedTask) {
            capturesInFlight.current.delete(requestKey);
          }
          throw error;
        },
      );
      capturesInFlight.current.set(requestKey, trackedTask);
      return trackedTask;
    };

    window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__ = capturePaperMatrix;
    return () => {
      mounted = false;
      if (window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__ === capturePaperMatrix) {
        delete window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__;
      }
    };
  }, [invalidate, liveCamera, renderer, scene, world]);

  return null;
}

interface SafeWalkSpawn {
  position: [number, number];
  candidateIndex: number;
  yaw: number;
  forwardClearanceMeters: number;
  dryGroundAccepted: boolean;
  collidedIds: string[];
  boundsClamped: boolean;
}

function liveWalkHeadingObstacles(
  colliders: readonly WorldColliderProxy[],
): LiveWalkHeadingObstacle[] {
  return colliders.map((collider) => ({
    centerX: collider.centerX,
    centerZ: collider.centerZ,
    radius:
      collider.shape === "circle"
        ? collider.radius
        : Math.hypot(collider.halfWidth, collider.halfDepth),
  }));
}

/**
 * Deterministic bounded search. A live spawn must be collider-clear, on dry
 * ground, separated from authored colliders, and start with an open heading.
 */
function findSafeWalkSpawn(
  world: WorldSceneType,
  colliders: readonly WorldColliderProxy[],
  worldHalfExtent: number,
  seed: number,
): SafeWalkSpawn | undefined {
  const limit = Math.max(WALK_COLLIDER_RADIUS + 0.1, worldHalfExtent);
  const preferredZ = Math.min(16, limit - WALK_COLLIDER_RADIUS);
  const candidateCount = 768;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const phase = ((seed >>> 0) / 0xffff_ffff) * Math.PI * 2;
  const waterLevelMeters = world.plan.visualContract?.waterLevelMeters ?? 0;
  const hasWaterRegion = world.plan.regions.some(
    (region) => region.category === "ocean" || region.category === "river",
  );
  const headingObstacles = liveWalkHeadingObstacles(colliders);

  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    let candidate: [number, number];
    if (candidateIndex === 0) {
      candidate = [0, preferredZ];
    } else {
      const progress = Math.sqrt(candidateIndex / (candidateCount - 1));
      const radius = progress * Math.max(0, limit - WALK_COLLIDER_RADIUS - 0.25);
      const angle = phase + candidateIndex * goldenAngle;
      candidate = [Math.cos(angle) * radius, Math.sin(angle) * radius];
    }

    const resolution = resolveCircleMovementXZ({
      start: candidate,
      delta: [0, 0],
      radius: WALK_COLLIDER_RADIUS,
      colliders,
      worldHalfExtent: limit,
      maxPushIterations: 12,
    });
    if (resolution.unresolvedIds.length > 0) continue;
    const terrainHeightMeters = sampleHeight(
      world.heightField,
      resolution.position[0],
      resolution.position[1],
    );
    const dryGroundAccepted =
      Number.isFinite(terrainHeightMeters) &&
      (!hasWaterRegion ||
        (terrainHeightMeters >= waterLevelMeters + REGISTERED_WALK_LAND_MARGIN_METERS &&
          dryNeighborhoodRadiusMeters(world, resolution.position) >=
            LIVE_WALK_MINIMUM_DRY_NEIGHBORHOOD_METERS));
    if (!dryGroundAccepted) continue;
    const minimumColliderClearanceMeters = colliders.reduce(
      (minimum, collider) => Math.min(minimum, distanceToColliderXZ(resolution.position, collider)),
      Number.POSITIVE_INFINITY,
    );
    const heading = selectLiveWalkHeading(resolution.position, headingObstacles, {
      preferredYaw: 0,
      maximumSightlineMeters: Math.max(
        LIVE_WALK_MINIMUM_FORWARD_SIGHTLINE_METERS,
        world.heightField.worldSize * 0.1,
      ),
      clearanceRadiusMeters: WALK_COLLIDER_RADIUS,
      worldHalfExtent: limit,
    });
    const safeSpawn: SafeWalkSpawn = {
      position: resolution.position,
      candidateIndex,
      yaw: heading.yaw,
      forwardClearanceMeters: heading.clearanceMeters,
      dryGroundAccepted,
      collidedIds: resolution.collidedIds,
      boundsClamped: resolution.boundsClamped,
    };
    if (
      isLiveWalkSpawnSafe(
        {
          unresolvedColliderCount: resolution.unresolvedIds.length,
          dryGroundAccepted,
          minimumColliderClearanceMeters,
          forwardClearanceMeters: heading.clearanceMeters,
        },
        {
          minimumColliderClearanceMeters: LIVE_WALK_MINIMUM_SPAWN_CLEARANCE_METERS,
          minimumForwardSightlineMeters: LIVE_WALK_MINIMUM_FORWARD_SIGHTLINE_METERS,
        },
      )
    ) {
      return safeSpawn;
    }
  }

  return undefined;
}

function WalkController({ enabled, world }: { enabled: boolean; world: WorldSceneType | null }) {
  const { camera, scene } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);
  const pitch = useRef(0.12);
  const pos = useRef(WALK_POSITION);
  const primed = useRef(false);
  const safeSpawnCandidate = useRef<number | null>(null);
  const safeSpawnAccepted = useRef(false);
  const telemetry = useRef<WalkQaTelemetry>({
    enabled: false,
    radius: WALK_COLLIDER_RADIUS,
    worldHalfExtent: 0,
    safeSpawnCandidate: null,
    safeSpawnAccepted: false,
    spawnYawRadians: null,
    forwardClearanceMeters: null,
    dryGroundAccepted: false,
    collidedIds: [],
    unresolvedIds: [],
    boundsClamped: false,
  });
  const colliders = useMemo(
    () => world?.objects.map(worldColliderForObject) ?? [],
    [world?.objects],
  );
  const worldHalfExtent = (world?.heightField.worldSize ?? 100) * 0.48;

  useEffect(() => {
    scene.userData.worldclawWalkTelemetry = telemetry.current;
    return () => {
      if (scene.userData.worldclawWalkTelemetry === telemetry.current) {
        delete scene.userData.worldclawWalkTelemetry;
      }
    };
  }, [scene]);

  useEffect(() => {
    if (!enabled) {
      primed.current = false;
      safeSpawnCandidate.current = null;
      safeSpawnAccepted.current = false;
      telemetry.current = {
        ...telemetry.current,
        enabled: false,
        safeSpawnCandidate: null,
        safeSpawnAccepted: false,
        spawnYawRadians: null,
        forwardClearanceMeters: null,
        dryGroundAccepted: false,
        collidedIds: [],
        unresolvedIds: [],
        boundsClamped: false,
      };
      scene.userData.worldclawWalkTelemetry = telemetry.current;
      return;
    }
    if (!primed.current) {
      const spawn = world
        ? findSafeWalkSpawn(world, colliders, worldHalfExtent, world.seed)
        : undefined;
      safeSpawnCandidate.current = spawn?.candidateIndex ?? null;
      safeSpawnAccepted.current = spawn !== undefined;
      const spawnX = spawn?.position[0] ?? pos.current.x;
      const spawnZ = spawn?.position[1] ?? pos.current.z;
      const h = world ? sampleHeight(world.heightField, spawnX, spawnZ) : 2;
      pos.current.set(spawnX, Math.max(h + 1.7, 2), spawnZ);
      yaw.current = spawn?.yaw ?? 0;
      pitch.current = 0.1;
      primed.current = true;
      telemetry.current = {
        enabled: true,
        radius: WALK_COLLIDER_RADIUS,
        worldHalfExtent,
        safeSpawnCandidate: safeSpawnCandidate.current,
        safeSpawnAccepted: safeSpawnAccepted.current,
        spawnYawRadians: spawn?.yaw ?? null,
        forwardClearanceMeters: spawn?.forwardClearanceMeters ?? null,
        dryGroundAccepted: spawn?.dryGroundAccepted ?? false,
        collidedIds: spawn?.collidedIds ?? [],
        unresolvedIds: [],
        boundsClamped: spawn?.boundsClamped ?? false,
      };
      scene.userData.worldclawWalkTelemetry = telemetry.current;
    }

    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      // prevent page scroll on space
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [colliders, enabled, scene, world, worldHalfExtent]);

  useFrame((_, rawDelta) => {
    if (!enabled) return;
    const position = pos.current;
    const delta = Math.min(rawDelta, 0.05);
    const speed = (keys.current["ShiftLeft"] || keys.current["ShiftRight"] ? 24 : 12) * delta;

    // A = left, D = right (local)
    WALK_FORWARD.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    WALK_RIGHT.set(Math.cos(yaw.current), 0, -Math.sin(yaw.current));

    let proposedX = 0;
    let proposedZ = 0;
    if (keys.current["KeyW"] || keys.current["ArrowUp"]) {
      proposedX += WALK_FORWARD.x * speed;
      proposedZ += WALK_FORWARD.z * speed;
    }
    if (keys.current["KeyS"] || keys.current["ArrowDown"]) {
      proposedX -= WALK_FORWARD.x * speed;
      proposedZ -= WALK_FORWARD.z * speed;
    }
    if (keys.current["KeyA"] || keys.current["ArrowLeft"]) {
      proposedX -= WALK_RIGHT.x * speed;
      proposedZ -= WALK_RIGHT.z * speed;
    }
    if (keys.current["KeyD"] || keys.current["ArrowRight"]) {
      proposedX += WALK_RIGHT.x * speed;
      proposedZ += WALK_RIGHT.z * speed;
    }

    const resolution = resolveCircleMovementXZ({
      start: [position.x, position.z],
      delta: [proposedX, proposedZ],
      radius: WALK_COLLIDER_RADIUS,
      colliders,
      worldHalfExtent,
    });
    position.x = resolution.position[0];
    position.z = resolution.position[1];
    const walkTelemetry = telemetry.current;
    walkTelemetry.enabled = true;
    walkTelemetry.radius = WALK_COLLIDER_RADIUS;
    walkTelemetry.worldHalfExtent = worldHalfExtent;
    walkTelemetry.safeSpawnCandidate = safeSpawnCandidate.current;
    walkTelemetry.safeSpawnAccepted = safeSpawnAccepted.current;
    walkTelemetry.collidedIds = resolution.collidedIds;
    walkTelemetry.unresolvedIds = resolution.unresolvedIds;
    walkTelemetry.boundsClamped = resolution.boundsClamped;
    scene.userData.worldclawWalkTelemetry = walkTelemetry;

    // Fly boost with Q/E still available
    if (keys.current["KeyQ"]) position.y += speed;
    if (keys.current["KeyE"]) position.y -= speed;

    // Snap to terrain when not flying
    if (world && !keys.current["KeyQ"] && !keys.current["KeyE"]) {
      const th = sampleHeight(world.heightField, position.x, position.z);
      const targetY = Math.max(th + 1.65, 0.5);
      position.y += (targetY - position.y) * Math.min(1, 10 * delta);
    }

    position.y = Math.max(0.5, Math.min(45, position.y));
    if (keys.current["KeyJ"]) yaw.current += 1.5 * delta;
    if (keys.current["KeyL"]) yaw.current -= 1.5 * delta;
    if (keys.current["KeyI"]) pitch.current = Math.min(1.2, pitch.current + 1.1 * delta);
    if (keys.current["KeyK"]) pitch.current = Math.max(-1.2, pitch.current - 1.1 * delta);

    camera.position.copy(position);
    WALK_LOOK.set(
      position.x - Math.sin(yaw.current) * Math.cos(pitch.current),
      position.y + Math.sin(pitch.current),
      position.z - Math.cos(yaw.current) * Math.cos(pitch.current),
    );
    camera.lookAt(WALK_LOOK);
  });

  return null;
}

function SceneContent({ world }: { world: WorldSceneType }) {
  const viewMode = useWorldClaw((s) => s.viewMode);
  const cameraMode = useWorldClaw((s) => s.cameraMode);
  const selectedObjectId = useWorldClaw((s) => s.selectedObjectId);
  const setSelectedObjectId = useWorldClaw((s) => s.setSelectedObjectId);
  const theme = world.plan.theme;
  const { compiledObjects, primitiveObjects } = useMemo(() => {
    const compiledObjects: WorldSceneType["objects"] = [];
    const primitiveObjects: WorldSceneType["objects"] = [];
    for (const object of world.objects) {
      (object.browserAsset ? compiledObjects : primitiveObjects).push(object);
    }
    return { compiledObjects, primitiveObjects };
  }, [world.objects]);

  // The current surface is one global plane, so only an ocean semantic region
  // can justify it. Rivers need their own masked/ribbon surface rather than an
  // infinite plane, and dry theme names alone must not create water.
  const showWater = world.plan.regions.some((region) => region.category === "ocean");

  const sunPos: [number, number, number] =
    theme === "volcanic"
      ? [20, 12, -10]
      : theme === "snow"
        ? [30, 40, 10]
        : theme === "desert"
          ? [40, 50, 5]
          : [25, 35, 15];

  return (
    <>
      <color
        attach="background"
        args={[
          theme === "volcanic"
            ? "#1a0a08"
            : theme === "snow"
              ? "#b8c8d8"
              : theme === "desert"
                ? "#c8b080"
                : theme === "tropical" || theme === "island"
                  ? "#6aa8d0"
                  : "#8ab0c8",
        ]}
      />
      {theme !== "volcanic" && (
        <Sky
          distance={700}
          sunPosition={sunPos}
          inclination={0.52}
          azimuth={0.25}
          mieCoefficient={theme === "desert" ? 0.008 : 0.005}
          rayleigh={theme === "snow" ? 0.6 : 1}
        />
      )}
      {theme === "volcanic" && <Stars radius={320} depth={80} count={2400} factor={5} />}

      <ambientLight intensity={theme === "volcanic" ? 0.25 : theme === "snow" ? 0.55 : 0.42} />
      <hemisphereLight
        args={[
          theme === "desert" ? "#ffe8c0" : "#c8e0f0",
          theme === "volcanic" ? "#2a1008" : "#3a4a30",
          0.35,
        ]}
      />
      {/* normalBias is in WORLD units: keep it at ~1-2 shadow texels
          (140-unit span / 2048 map ≈ 0.068/texel) so small props keep
          contact shadows instead of peter-panning. */}
      <directionalLight
        castShadow
        position={sunPos}
        intensity={theme === "desert" ? 1.65 : theme === "volcanic" ? 0.95 : 1.3}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={220}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-bias={-0.0002}
        shadow-normalBias={0.08}
        color={theme === "volcanic" ? "#ff8844" : "#fff5e6"}
      />
      {theme === "volcanic" && (
        <pointLight position={[0, 2, 0]} intensity={2.5} distance={40} color="#ff4400" />
      )}

      {/* Aerial haze, not a curtain. Orbit: fog only begins beyond the world
          radius so zooming the camera out never washes the scene toward the
          sky color. Walk: a closer band restores ground-level atmospheric
          perspective and softens the terrain/sky seam at the horizon. */}
      <fog
        attach="fog"
        args={[
          theme === "volcanic"
            ? "#1a0a08"
            : theme === "snow"
              ? "#c8d4e0"
              : theme === "desert"
                ? "#d4c090"
                : "#7aacc8",
          world.heightField.worldSize *
            (cameraMode === "walk"
              ? theme === "volcanic"
                ? 0.3
                : 0.45
              : theme === "volcanic"
                ? 0.85
                : 1.15),
          world.heightField.worldSize *
            (cameraMode === "walk"
              ? theme === "volcanic"
                ? 1.4
                : 1.8
              : theme === "volcanic"
                ? 2.6
                : theme === "desert"
                  ? 3.4
                  : 3.1),
        ]}
      />

      <TerrainMesh
        heightField={world.heightField}
        plan={world.plan}
        viewMode={viewMode}
        seed={world.seed}
      />

      {showWater && (
        <group userData={{ paperSurfaceId: PAPER_CAPTURE_WATER_ID }}>
          <WaterPlane
            worldSize={world.heightField.worldSize}
            y={world.plan.visualContract?.waterLevelMeters ?? (theme === "canyon" ? -0.85 : -0.35)}
            viewMode={viewMode}
            color={
              theme === "canyon"
                ? "#2a6a8a"
                : theme === "snow"
                  ? "#6a90a8"
                  : theme === "volcanic"
                    ? "#3a1808"
                    : "#1a5f8a"
            }
          />
        </group>
      )}

      {primitiveObjects.map((obj) => (
        <ObjectMesh
          key={obj.id}
          obj={obj}
          viewMode={viewMode}
          selected={selectedObjectId === obj.id}
          onSelect={setSelectedObjectId}
        />
      ))}

      {compiledObjects.length > 0 && (
        <Suspense
          fallback={compiledObjects.map((obj) => (
            <ObjectMesh
              key={obj.id}
              obj={obj}
              viewMode={viewMode}
              selected={selectedObjectId === obj.id}
              onSelect={setSelectedObjectId}
              forcePrimitive
            />
          ))}
        >
          <CompiledAssetBatches
            objects={compiledObjects}
            viewMode={viewMode}
            selectedObjectId={selectedObjectId}
            onSelect={setSelectedObjectId}
          />
        </Suspense>
      )}

      {cameraMode === "orbit" && (
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={6}
          maxDistance={240}
          maxPolarAngle={Math.PI * 0.48}
          target={[0, 2, 0]}
        />
      )}
      <WalkController enabled={cameraMode === "walk"} world={world} />

      {/* Post stack only for the lit view — diagnostic modes (depth /
          normal / instance) must stay untouched raster output. */}
      {viewMode === "lit" && (
        <EffectComposer multisampling={2}>
          <N8AO
            halfRes
            quality="performance"
            aoRadius={2.2}
            distanceFalloff={2.5}
            intensity={2.4}
            color="#06121a"
          />
          <Bloom mipmapBlur intensity={0.45} luminanceThreshold={0.85} luminanceSmoothing={0.18} />
          <Vignette eskil={false} offset={0.24} darkness={0.48} />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      )}
    </>
  );
}

function EmptyScene() {
  return (
    <>
      <color attach="background" args={["#0c0c0e"]} />
      <ambientLight intensity={0.4} />
      <gridHelper args={[80, 40, "#2a2a30", "#1a1a20"]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#121214" />
      </mesh>
      <OrbitControls makeDefault enableDamping />
    </>
  );
}

export function WorldViewport() {
  const world = useWorldClaw((s) => s.world);
  const cameraMode = useWorldClaw((s) => s.cameraMode);
  const [ready, setReady] = useState(false);
  // Render at native dpr where the GPU keeps up; PerformanceMonitor drops
  // the cap under sustained load so weaker GPUs degrade resolution instead
  // of frame rate.
  const [dpr, setDpr] = useState(2);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-sm text-fg-muted">
        Initializing viewport…
      </div>
    );
  }

  return (
    <Canvas
      shadows
      dpr={[1, dpr]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      className="h-full w-full touch-none"
      onPointerMissed={() => useWorldClaw.getState().setSelectedObjectId(null)}
    >
      <PerformanceMonitor onDecline={() => setDpr(1.4)} onIncline={() => setDpr(2)} />
      {cameraMode === "map" && world ? (
        <RegisteredMapCamera world={world} />
      ) : (
        <PerspectiveCamera
          makeDefault
          position={cameraMode === "walk" ? [0, 4, 18] : [42, 34, 42]}
          fov={50}
          near={0.2}
          far={900}
        />
      )}
      <RendererReadinessBridge world={world} />
      <SceneQaProbe world={world} />
      <RegisteredCaptureBridge world={world} />
      <PaperCaptureBridge world={world} />
      {world ? <SceneContent world={world} /> : <EmptyScene />}
      <LiveDiagnosticMaterialBridge world={world} />
    </Canvas>
  );
}

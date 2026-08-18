/** WorldClaw data model — mirrors paper Sections 2.1–2.3 */

export type SceneTheme =
  | "tropical"
  | "canyon"
  | "desert"
  | "snow"
  | "medieval"
  | "volcanic"
  | "island"
  | "forest"
  | "custom";

export type VisualStyle = "realistic" | "stylized" | "cartoon" | "game" | "sci-fi" | "fantasy";

export type TerrainCategory =
  | "ocean"
  | "beach"
  | "grass"
  | "forest"
  | "hill"
  | "mountain"
  | "rock"
  | "desert"
  | "sand"
  | "canyon"
  | "river"
  | "snow"
  | "ice"
  | "lava"
  | "road"
  | "settlement"
  | "cliff";

export interface RegionSpec {
  id: string;
  name: string;
  category: TerrainCategory;
  /** Normalized center in layout [0,1] x [0,1] */
  center: [number, number];
  /** Approximate coverage radius in layout space */
  radius: number;
  /** Functional role for regional planning */
  role: string;
  /** Base elevation bias */
  baseElevation: number;
  /** Noise / geomorphic weights */
  roughness: number;
  peakStrength: number;
  color: string;
}

export interface ObjectRequirement {
  category: string;
  count: number;
  density?: number;
  appearance?: string;
  scale?: number;
}

export type VisualReferenceView = "isometric" | "oblique" | "walk";

export interface VisualCameraReference {
  view: VisualReferenceView;
  /** Clockwise direction around the world, in degrees. */
  azimuthDegrees: number;
  /** 0 = horizon, 90 = straight down. */
  elevationDegrees: number;
  /** Normalized map coordinate the reference camera is centered on. */
  target: [number, number];
  /** Camera distance relative to the world width. */
  distanceScale: number;
  projection: "orthographic" | "perspective";
  /** Perspective vertical field of view; absent for orthographic cameras. */
  fovDegrees?: number;
  /** Visible vertical span as a fraction of world width. */
  orthographicScale?: number;
  /** Panel crop in the generated sheet as normalized x/y/width/height. */
  panelCropNormalized: [number, number, number, number];
  description: string;
}

/**
 * Bounded, auditable reconciliation of the map and perspective references.
 * The top-down map remains authoritative for X/Z layout; this contract only
 * constrains appearance, relief, density, silhouettes, and reference cameras.
 */
export interface VisualContract {
  source: "gemini-3.6-flash" | "model-committee" | "local-defaults";
  terrainReliefScale: number;
  terrainMicroDetailScale: number;
  vegetationDensityScale: number;
  objectDensityScale: number;
  waterLevelMeters: number;
  palette: string[];
  dominantSilhouettes: string[];
  compositionNotes: string[];
  cameras: VisualCameraReference[];
  /** Explicit vision comparison; absent only on legacy saved worlds. */
  judgement?: {
    passed: boolean;
    agreementScore: number;
    missingSubjects: string[];
    conflicts: string[];
  };
}

export interface FinalRenderJudgement {
  source: "gemini-3.6-flash" | "model-committee";
  passed: boolean;
  agreementScore: number;
  metrics: {
    mapRegistration: number;
    referenceAgreement: number;
    heroObjectCoverage: number;
    constructionFidelity: number;
    waterIntegrity: number;
  };
  missingSubjects: string[];
  conflicts: string[];
  observations: string[];
  deterministicChecks?: {
    objectSatisfactionRatio: number;
    heroRequiredByKind: Record<string, number>;
    missingHeroKinds: string[];
    heroCountFailures: string[];
    heroVisibilityFailures: string[];
    constructionConflicts: string[];
    materialFamilyMacroF1: number;
    waterMaxMeters: number | null;
    landMinMeters: number | null;
    waterLevelMeters: number;
    mapNorthUp: boolean;
    cameraMatricesPassed: boolean;
    compiledSlotsMatched: boolean;
    depthPassesFinite: boolean;
    landWaterIoU: number;
    landIoU: number;
    waterIoU: number;
    shorelineBoundaryF1: number;
    shorelineP95DistancePixels: number;
    maskSize: number;
    orientationSuspicious: boolean;
    bestAlternateOrientation: string;
    alternateOrientationImprovement: number;
    leakageBoundaryTolerancePixels: number;
    rawFalseWaterOnLandRatio: number;
    falseWaterOnLandRatio: number;
    rawMissingCanonicalWaterRatio: number;
    missingCanonicalWaterRatio: number;
    referenceWaterComponents: number;
    renderedWaterComponents: number;
    failures: string[];
  };
}

export interface FinalRenderValidation {
  status: "running" | "passed" | "failed" | "error" | "unavailable";
  judgement?: FinalRenderJudgement;
  captures?: Partial<Record<"map" | "isometric" | "oblique" | "walk", string>>;
  comparisonArtifacts?: {
    canonicalLandWaterMask: string;
    renderedLandWaterMask: string;
    shorelineOverlay: string;
    landWaterDifference: string;
  };
  error?: string;
}

export interface ScenePlan {
  prompt: string;
  sceneType: string;
  theme: SceneTheme;
  visualStyle: VisualStyle;
  atmosphere: string;
  regions: RegionSpec[];
  terrainAssets: string[];
  objectRequirements: Record<string, ObjectRequirement[]>;
  spatialNotes: string[];
  mainObjects: string[];
  /** I_layout image from Imagine (paper §2.2) */
  layoutImageUrl?: string;
  layoutImageDataUrl?: string;
  /** Multi-angle image reference produced before geometry construction. */
  perspectiveImageUrl?: string;
  perspectiveImageDataUrl?: string;
  /** Retained model or model-committee reconciliation of map and multi-angle references. */
  visualContract?: VisualContract;
  /** True when plan came from the live LLM committee, not local templates */
  inferenceSource?: "llm" | "template";
}

export interface TerrainSpec {
  layout: TerrainCategory[][];
  resolution: number;
  worldSize: number;
  heightScale: number;
  materials: Record<TerrainCategory, MaterialDef>;
  assetPrototypes: TerrainAssetDef[];
  source: "image_guided" | "procedural";
}

export interface MaterialDef {
  albedo: string;
  roughness: number;
  metalness: number;
  label: string;
}

export interface TerrainAssetDef {
  kind: "rock" | "tree" | "bush" | "cactus" | "ice" | "crystal" | "debris";
  categoryAffinity: TerrainCategory[];
  density: number;
  scaleRange: [number, number];
}

export interface HeightField {
  resolution: number;
  worldSize: number;
  /** Row-major heights */
  data: Float32Array;
  /** Soft region weights per cell (regionIndex -> weight), packed as r*res+c for primary region id */
  regionId: Uint8Array;
  /** How the height field was produced */
  source?: "image_guided" | "procedural";
}

export type BrowserAssetPrototype =
  | "palm"
  | "tree"
  | "pine"
  | "rock"
  | "cactus"
  | "hut"
  | "building"
  | "watchtower"
  | "ship"
  | "tank"
  | "pagoda"
  | "torii"
  | "bridge"
  | "dragon"
  | "windmill"
  | "mine"
  | "crystal"
  | "antenna"
  | "satellite"
  | "dock"
  | "tent"
  | "well"
  | "statue"
  | "fence"
  | "campfire"
  | "crate"
  | "market";

export type BrowserAssetCollider =
  | {
      type: "box";
      centerMeters: [number, number, number];
      sizeMeters: [number, number, number];
    }
  | {
      type: "capsule";
      centerMeters: [number, number, number];
      radiusMeters: number;
      heightMeters: number;
    }
  | {
      type: "sphere";
      centerMeters: [number, number, number];
      radiusMeters: number;
    };

/** Browser-ready reference emitted by the offline Blender asset compiler. */
export interface BrowserAssetMetadata {
  prototype: BrowserAssetPrototype;
  uri: string;
  node: string;
  source: "blender_procedural";
  targetHeightMeters: number;
  collider: BrowserAssetCollider;
  variantId?: string;
  appearanceTerms?: string[];
  materialIds?: string[];
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
  provenance?: {
    paperPages?: number[];
    researchReferenceIds?: string[];
    note?: string;
  };
  evidence?: {
    turnaroundUri?: string;
  };
}

export interface PlacedObject {
  id: string;
  kind: ObjectKind;
  regionId: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  color: string;
  secondaryColor?: string;
  label: string;
  /** Contact quality after refinement 0–1 */
  contactScore: number;
  refined: boolean;
  /** Optional compiled browser asset; absent means use the primitive fallback. */
  browserAsset?: BrowserAssetMetadata;
}

export type ObjectKind =
  | "hut"
  | "house"
  | "tower"
  | "dock"
  | "ship"
  | "tree"
  | "palm"
  | "pine"
  | "rock"
  | "boulder"
  | "cactus"
  | "vehicle"
  | "tank"
  | "building"
  | "antenna"
  | "fence"
  | "campfire"
  | "tent"
  | "bridge"
  | "statue"
  | "crystal"
  | "mine"
  | "dragon"
  | "windmill"
  | "well"
  | "crate"
  | "watchtower"
  | "satellite"
  | "bunker"
  | "boat"
  | "pagoda"
  | "torii"
  | "barn"
  | "market";

export type EnsembleProviderId = "xai" | "gemini" | "openai" | "anthropic";

export type EnsembleStage =
  "planning" | "layout" | "multiview" | "asset_variant" | "critique" | "final_judge";

export type EnsembleArtifactStatus = "candidate" | "selected" | "rejected" | "error";

/**
 * Retained committee evidence is deliberately bounded before it reaches a
 * WorldScene. Producers should enforce these caps; consumers must still slice
 * defensively because saved worlds can predate validation.
 */
export const WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS = {
  providers: 4,
  iterations: 8,
  artifacts: 128,
  parentArtifactIds: 12,
  metricsPerArtifact: 24,
  observationsPerArtifact: 12,
  conflictsPerArtifact: 12,
  rationaleItems: 12,
  identifierCharacters: 120,
  modelCharacters: 160,
  responseIdentifierCharacters: 256,
  roleCharacters: 240,
  textCharacters: 600,
  imageDataUrlCharacters: 5_500_000,
  imageArtifacts: 12,
  imageDataUrlCharactersTotal: 24_000_000,
  imageMaximumDimensionPixels: 2_048,
  structuredOutputCharacters: 32_000,
  structuredOutputArtifacts: 64,
  structuredOutputCharactersTotal: 1_000_000,
} as const;

export interface EnsembleProviderStatus {
  provider: EnsembleProviderId;
  /** Provider was selected in this run's committee configuration. */
  configured: boolean;
  /** Credentials passed the provider's bounded authentication check. */
  authenticated: boolean;
  /** The configured model was callable when this evidence was recorded. */
  available: boolean;
  /** Exact configured model identifier, not a friendly provider label. */
  model: string;
  /** Preview committees may stop after a parse-valid quorum and omit slower providers. */
  skipped?: boolean;
  error?: string;
}

export interface EnsembleArtifact {
  /** Stable identifier, capped at 120 characters. */
  id: string;
  /** One-based committee iteration, capped by ensemble.maxIterations (maximum 8). */
  iteration: number;
  stage: EnsembleStage;
  provider: EnsembleProviderId;
  /** Exact producing model identifier, capped at 160 characters. */
  model: string;
  /** Exact model identifier placed on the provider request. */
  requestedModel?: string;
  /** Provider-issued response identifier when that endpoint exposes one. */
  responseId?: string;
  /** Whether `model` came from the response or is honestly request-only. */
  identityAttestation?: "provider-response" | "request-only" | "unattested";
  /** Bounded description of this candidate's responsibility, capped at 240 characters. */
  role: string;
  status: EnsembleArtifactStatus;
  /**
   * Retained image artifact; capped at 5.5M data-URL characters. Across an
   * ensemble, producers retain at most 12 images / 24M characters, and no
   * decoded image dimension may exceed 2048px.
   */
  imageDataUrl?: string;
  /**
   * Normalized, data-URL-free JSON produced or consumed by this stage. This is
   * the inspectable model/process record, not hidden reasoning. Producers cap
   * each value at 32K characters and the merged ensemble at 1M characters.
   */
  structuredOutput?: string;
  /** Stable lineage references, capped at 12 entries. */
  parentArtifactIds: string[];
  /** Normalized model or consensus score in [0, 1], when the stage is scored. */
  score?: number;
  passed?: boolean;
  /** Finite numeric metrics, capped at 24 entries with 120-character keys. */
  metrics: Record<string, number>;
  /** Each list is capped at 12 entries; each entry is capped at 600 characters. */
  observations: string[];
  conflicts: string[];
  error?: string;
}

export interface EnsembleSelection {
  chosenLayoutArtifactId?: string;
  chosenMultiviewArtifactId?: string;
  /** Normalized cross-model consensus in [0, 1]. */
  consensusScore: number;
  /** Final synthesis rationale, capped at 12 entries of 600 characters each. */
  rationale: string[];
}

export interface EnsembleEvidence {
  /** At most one status row per supported provider (maximum 4). */
  providers: EnsembleProviderStatus[];
  /** Chronological candidate ledger, capped at 128 retained artifacts. */
  artifacts: EnsembleArtifact[];
  selection?: EnsembleSelection;
  /** Completed bounded passes, clamped by the producer to [0, maxIterations]. */
  completedIterations: number;
  /** Configured iteration ceiling in [1, 8]. */
  maxIterations: number;
}

/**
 * Client-safe metadata frozen when a generation stops after emitting partial
 * committee evidence. The committee payload itself remains in
 * `ensembleProgress`; this record deliberately contains counts rather than a
 * second copy of image data URLs.
 */
export const WORLDCLAW_GENERATION_FAILURE_MESSAGE_MAX_CHARS = 1_200;

export interface GenerationFailureEvidence {
  status: "failed";
  /** Whitespace-normalized and capped at 1,200 characters by the store. */
  message: string;
  /** Last pipeline stage observed before the store transitioned to `error`. */
  stage: PipelineStage;
  /** Last finite pipeline progress, clamped to [0, 1]. */
  progress: number;
  committee: {
    retained: boolean;
    providerCount: number;
    artifactCount: number;
    imageArtifactCount: number;
    completedIterations: number;
    maxIterations: number;
  };
}

export interface WorldScene {
  id: string;
  plan: ScenePlan;
  terrainSpec: TerrainSpec;
  heightField: HeightField;
  objects: PlacedObject[];
  seed: number;
  generatedAt: number;
  /** Agent reasoning breadcrumbs */
  inferenceMeta?: {
    layoutImageUrl?: string;
    layoutPrompt?: string;
    planSource: "llm" | "template";
    terrainSource: "image_guided" | "procedural";
    planProvider?: string;
    terrainProvider?: string;
    perspectiveProvider?: string;
    visualAnalysisProvider?: string;
    /** Optional retained multi-provider candidate, critique, and selection ledger. */
    ensemble?: EnsembleEvidence;
    objectCoverage?: {
      requestedByKind: Record<string, number>;
      placedByKind: Record<string, number>;
      heroRequiredByKind: Record<string, number>;
      missingKinds: string[];
      missingHeroKinds: ObjectKind[];
      satisfactionRatio: number;
    };
  };
}

export type PipelineStage =
  | "idle"
  | "intent"
  | "planning"
  | "terrain_plan"
  | "terrain_assets"
  | "terrain_build"
  | "terrain_refine"
  | "regional_plan"
  | "object_gen"
  | "object_place"
  | "scene_refine"
  | "compose"
  | "render_validate"
  | "done"
  | "error";

export interface AgentLogEntry {
  id: string;
  t: number;
  stage: PipelineStage;
  agent: string;
  message: string;
  level: "info" | "success" | "warn" | "detail";
}

export interface PipelineState {
  stage: PipelineStage;
  progress: number;
  logs: AgentLogEntry[];
  world: WorldScene | null;
  error: string | null;
  running: boolean;
}

export type ViewMode = "lit" | "instance" | "depth" | "normal";
export type CameraMode = "orbit" | "map" | "walk";

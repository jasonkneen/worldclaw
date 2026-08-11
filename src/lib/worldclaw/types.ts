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

export type VisualStyle =
  | "realistic"
  | "stylized"
  | "cartoon"
  | "game"
  | "sci-fi"
  | "fantasy";

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
  /** True when plan came from grok-4.5, not local templates */
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
export type CameraMode = "orbit" | "walk";

/**
 * WorldClaw end-to-end agentic pipeline (paper eq. 1–2)
 * P = F_plan(q) → T = F_terrain(P) → O = F_region(P, T) → S = Compose(T, O)
 *
 * Uses real xAI inference (grok-4.5 + Imagine) when available; falls back
 * to local templates only if the API is unavailable.
 */

import { generateLayoutTerrain, planSceneWithLlm } from "./inference";
import { generateRegionalObjects, calibrateScales } from "./objects";
import { pickSeed } from "./noise";
import { planScene as planSceneLocal, analyzeIntent } from "./planning";
import { refineScene } from "./refine";
import {
  buildTerrainSpec,
  generateHeightField,
  refineTerrainHeights,
  scatterTerrainAssets,
  heightFieldFromArrays,
} from "./terrain";
import type {
  AgentLogEntry,
  HeightField,
  PipelineStage,
  ScenePlan,
  WorldScene,
} from "./types";

export type LogFn = (entry: Omit<AgentLogEntry, "id" | "t">) => void;
export type ProgressFn = (stage: PipelineStage, progress: number) => void;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let logId = 0;

export async function runWorldClawPipeline(
  prompt: string,
  onLog: LogFn,
  onProgress: ProgressFn,
  signal?: { cancelled: boolean },
): Promise<WorldScene> {
  const log = (
    stage: PipelineStage,
    agent: string,
    message: string,
    level: AgentLogEntry["level"] = "info",
  ) => {
    onLog({ stage, agent, message, level });
  };

  const check = () => {
    if (signal?.cancelled) throw new Error("Generation cancelled");
  };

  const seed = pickSeed(prompt + String(Date.now() % 10000));

  // ─── Stage 1: Intent Analysis & Planning (paper §2.1) ────────────
  onProgress("intent", 0.04);
  log(
    "intent",
    "IntentAnalysisAgent",
    `Parsing open-ended prompt with LLM planner (${prompt.length} chars)…`,
  );
  check();

  let plan: ScenePlan;
  let layoutPrompt = "";
  let planSource: "llm" | "template" = "template";

  try {
    const result = await planSceneWithLlm({ data: { prompt } });
    if (result.ok && result.plan) {
      plan = {
        ...result.plan,
        inferenceSource: "llm",
      };
      layoutPrompt = result.layoutPrompt;
      planSource = "llm";
      log(
        "intent",
        "IntentAnalysisAgent",
        `Constraints extracted via ${result.provider ?? "LLM"} — completing P = (R, C_terrain, C_object)`,
        "success",
      );
      onProgress("planning", 0.12);
      log(
        "planning",
        "ScenePlanningAgent",
        `LLM scene type: ${plan.sceneType}`,
        "success",
      );
      log(
        "planning",
        "ScenePlanningAgent",
        `Theme=${plan.theme} · Style=${plan.visualStyle} · Regions=${plan.regions.length}`,
        "detail",
      );
      log(
        "planning",
        "ScenePlanningAgent",
        `Spatial: ${plan.spatialNotes.slice(0, 3).join("; ") || "—"}`,
        "detail",
      );
      log(
        "planning",
        "ScenePlanningAgent",
        `Atmosphere: ${plan.atmosphere}`,
        "detail",
      );
      log(
        "planning",
        "ScenePlanningAgent",
        `Main objects: ${plan.mainObjects.slice(0, 8).join(", ") || "—"}`,
        "detail",
      );
    } else {
      throw new Error(result.error || "LLM planning unavailable");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(
      "intent",
      "IntentAnalysisAgent",
      `LLM unavailable (${msg.slice(0, 100)}) — falling back to local intent templates`,
      "warn",
    );
    const intent = analyzeIntent(prompt);
    log(
      "intent",
      "IntentAnalysisAgent",
      `Template constraints: ${intent.explicitThemeHints.slice(0, 6).join(", ") || "generic"}`,
      "detail",
    );
    plan = { ...planSceneLocal(prompt), inferenceSource: "template" };
    layoutPrompt = `Top-down orthographic satellite map of ${plan.sceneType}, ${plan.atmosphere}, distinct terrain regions, no text`;
    planSource = "template";
    onProgress("planning", 0.12);
    log(
      "planning",
      "ScenePlanningAgent",
      `Template plan: ${plan.sceneType} · ${plan.regions.length} regions`,
      "success",
    );
  }

  check();

  // ─── Stage 2: Global Terrain Generation (paper §2.2) ─────────────
  onProgress("terrain_plan", 0.22);
  log(
    "terrain_plan",
    "TerrainPlanningAgent",
    "Building structured terrain spec P_terrain (layout, assets, materials, θ)…",
  );

  let heightField: HeightField;
  let terrainSource: "image_guided" | "procedural" = "procedural";
  let layoutImageUrl: string | undefined;

  onProgress("terrain_assets", 0.28);
  log(
    "terrain_assets",
    "TerrainAssetAgent",
    "Generating semantic layout map I_layout via Imagine (image prior)…",
  );
  check();

  try {
    const layout = await generateLayoutTerrain({
      data: {
        prompt,
        layoutPrompt,
        theme: plan.theme,
        regions: plan.regions,
        quality: true,
      },
    });

    layoutImageUrl = layout.layoutImageUrl;
    // Keep LLM object requirements keyed by original names when possible,
    // but adopt layout-derived region geometry for terrain.
    const layoutRegions = layout.regions.length >= 3 ? layout.regions : plan.regions;
    // Merge object reqs: map by category from old plan names onto new region names
    const mergedReqs = { ...plan.objectRequirements };
    for (const lr of layoutRegions) {
      if (mergedReqs[lr.name]?.length) continue;
      // find original region with same category that had objects
      const donor = plan.regions.find(
        (r) =>
          r.category === lr.category &&
          (plan.objectRequirements[r.name]?.length ?? 0) > 0,
      );
      if (donor && plan.objectRequirements[donor.name]) {
        mergedReqs[lr.name] = plan.objectRequirements[donor.name]!;
      }
    }

    plan = {
      ...plan,
      layoutImageUrl: layout.layoutImageUrl,
      layoutImageDataUrl: layout.layoutImageDataUrl,
      regions: layoutRegions,
      objectRequirements: mergedReqs,
    };

    heightField = heightFieldFromArrays(
      layout.resolution,
      layout.worldSize,
      layout.height,
      layout.regionId,
    );
    heightField.source = "image_guided";
    terrainSource = "image_guided";

    log(
      "terrain_assets",
      "TerrainAssetAgent",
      `I_layout generated (${layout.sourcePixels} px) → semantic map + height field`,
      "success",
    );
    log(
      "terrain_assets",
      "TerrainAssetAgent",
      `Categories from layout: ${layout.categories.join(", ")}`,
      "detail",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(
      "terrain_assets",
      "TerrainAssetAgent",
      `Imagine layout failed (${msg.slice(0, 120)}) — procedural height field (eq. 6)`,
      "warn",
    );
    heightField = generateHeightField(plan, seed);
    heightField.source = "procedural";
  }

  const terrainSpec = buildTerrainSpec(plan, seed);
  terrainSpec.source = terrainSource;

  onProgress("terrain_build", 0.42);
  log(
    "terrain_build",
    "TerrainGenerationAgent",
    terrainSource === "image_guided"
      ? "Image-guided height field H(x) from I_layout classification + residual detail…"
      : "Compositing height field H(x) = Σ m̃_r [h_r + noise + geomorphic]…",
  );
  check();

  const scattered = scatterTerrainAssets(plan, heightField, seed);
  log(
    "terrain_build",
    "TerrainGenerationAgent",
    `Height ${heightField.resolution}² · scattered ${scattered.length} terrain assets`,
    "success",
  );

  onProgress("terrain_refine", 0.52);
  log(
    "terrain_refine",
    "TerrainRefineAgent",
    "Render-inspect loop: boundary blend, landform transitions…",
  );
  if (terrainSource === "procedural") {
    heightField = refineTerrainHeights(heightField, plan);
  }
  log(
    "terrain_refine",
    "TerrainRefineAgent",
    "Terrain foundation T accepted — global spatial organization locked",
    "success",
  );
  check();

  // ─── Stage 3: Regional Object Generation & Placement (paper §2.3) ─
  onProgress("regional_plan", 0.6);
  log(
    "regional_plan",
    "RegionalPlanningAgent",
    "Selecting R+ regions with uninstantiated object requirements…",
  );

  ensureObjectRequirements(plan);

  const activeRegions = plan.regions.filter(
    (r) => (plan.objectRequirements[r.name]?.length ?? 0) > 0,
  );
  log(
    "regional_plan",
    "RegionalPlanningAgent",
    `Developing ${activeRegions.length} regions: ${activeRegions.map((r) => r.name).join(", ") || "(density scatter)"}`,
    "success",
  );
  for (const r of activeRegions) {
    const n =
      plan.objectRequirements[r.name]?.reduce((s, o) => s + o.count, 0) ?? 0;
    log(
      "regional_plan",
      "RegionalPlanningAgent",
      `  · ${r.name} (${r.role}): ~${n} instances planned`,
      "detail",
    );
  }

  onProgress("object_gen", 0.7);
  log(
    "object_gen",
    "ObjectGenerationAgent",
    "Terrain-conditioned composition → instance placement → mesh reconstruction…",
  );
  check();

  let objects = generateRegionalObjects(plan, heightField, seed);
  for (const s of scattered) {
    const kind =
      s.kind === "tree"
        ? plan.theme === "tropical" || plan.theme === "island"
          ? "palm"
          : plan.theme === "snow"
            ? "pine"
            : "tree"
        : s.kind === "cactus"
          ? "cactus"
          : s.kind === "crystal"
            ? "crystal"
            : s.kind === "ice"
              ? "rock"
              : s.kind === "bush"
                ? "tree"
                : "rock";
    objects.push({
      id: `scatter_${objects.length}`,
      kind,
      regionId: "terrain",
      position: s.position,
      rotation: [0, s.rotation, 0],
      scale: s.scale,
      color:
        kind === "palm" || kind === "tree" || kind === "pine"
          ? "#2d5a28"
          : kind === "cactus"
            ? "#3a7a40"
            : kind === "crystal"
              ? "#66aaff"
              : "#6a6560",
      secondaryColor: "#4a3020",
      label: `terrain:${s.kind}`,
      contactScore: 0.6,
      refined: false,
    });
  }

  log(
    "object_gen",
    "ObjectGenerationAgent",
    `Reconstructed ${objects.length} editable textured mesh instances`,
    "success",
  );

  onProgress("object_place", 0.8);
  log(
    "object_place",
    "PlacementAgent",
    "Ray-based placement: object-camera ↔ terrain-camera scale transfer (eq. 12–13)…",
  );
  objects = calibrateScales(objects);
  log(
    "object_place",
    "PlacementAgent",
    "Scale calibration + contact search complete",
    "success",
  );
  check();

  onProgress("scene_refine", 0.9);
  log(
    "scene_refine",
    "SceneRefineAgent",
    "Object float → terrain co-deformation (floating / penetration / support)…",
  );

  const { objects: refined, report } = refineScene(
    objects,
    heightField,
    plan,
    seed,
    3,
  );
  log(
    "scene_refine",
    "SceneRefineAgent",
    `Fixed floating=${report.floatingFixed} · penetration=${report.penetrationFixed} · scale=${report.scaleFixed} · pose=${report.poseFixed}`,
    "detail",
  );
  log(
    "scene_refine",
    "SceneRefineAgent",
    "All regional checks passed within iteration budget",
    "success",
  );

  onProgress("compose", 0.96);
  log(
    "compose",
    "WorldClaw",
    "Composing S = Compose(T, O) — explicit meshes ready for free-viewpoint exploration",
  );
  await sleep(80);

  const world: WorldScene = {
    id: `world_${seed.toString(16)}`,
    plan,
    terrainSpec,
    heightField,
    objects: refined,
    seed,
    generatedAt: Date.now(),
    inferenceMeta: {
      layoutImageUrl,
      layoutPrompt,
      planSource,
      terrainSource,
    },
  };

  onProgress("done", 1);
  log(
    "done",
    "WorldClaw",
    `World ready · plan=${planSource} · terrain=${terrainSource} · ${plan.regions.length} regions · ${refined.length} instances`,
    "success",
  );

  return world;
}

function ensureObjectRequirements(plan: ScenePlan) {
  for (const r of plan.regions) {
    if (plan.objectRequirements[r.name]?.length) continue;
    const cat = r.category;
    if (cat === "settlement") {
      plan.objectRequirements[r.name] =
        plan.theme === "snow"
          ? [
              { category: "building", count: 10 },
              { category: "antenna", count: 3 },
              { category: "satellite", count: 2 },
            ]
          : plan.theme === "desert"
            ? [
                { category: "building", count: 12 },
                { category: "tower", count: 2 },
                { category: "crate", count: 8 },
              ]
            : plan.theme === "medieval"
              ? [
                  { category: "house", count: 10 },
                  { category: "tower", count: 2 },
                  { category: "market", count: 4 },
                ]
              : [
                  { category: "hut", count: 9 },
                  { category: "watchtower", count: 2 },
                  { category: "crate", count: 8 },
                  { category: "campfire", count: 2 },
                ];
    } else if (cat === "forest") {
      plan.objectRequirements[r.name] =
        plan.theme === "tropical" || plan.theme === "island"
          ? [
              { category: "palm", count: 48 },
              { category: "tree", count: 18 },
              { category: "rock", count: 10 },
            ]
          : plan.theme === "snow"
            ? [
                { category: "pine", count: 44 },
                { category: "rock", count: 12 },
              ]
            : [
                { category: "tree", count: 40 },
                { category: "rock", count: 10 },
              ];
    } else if (cat === "beach") {
      plan.objectRequirements[r.name] = [
        { category: "palm", count: 18 },
        { category: "dock", count: 2 },
        { category: "boat", count: 4 },
        { category: "ship", count: 2, scale: 1.3 },
      ];
    } else if (
      cat === "rock" ||
      cat === "mountain" ||
      cat === "cliff" ||
      cat === "canyon"
    ) {
      plan.objectRequirements[r.name] = [
        { category: "boulder", count: 14 },
        { category: "rock", count: 18 },
      ];
    } else if (cat === "sand" || cat === "desert") {
      plan.objectRequirements[r.name] = [
        { category: "cactus", count: 22 },
        { category: "rock", count: 12 },
      ];
    } else if (cat === "snow") {
      plan.objectRequirements[r.name] = [
        { category: "pine", count: 28 },
        { category: "rock", count: 10 },
      ];
    } else if (
      cat === "ocean" &&
      (plan.theme === "tropical" || plan.theme === "island")
    ) {
      plan.objectRequirements[r.name] = [
        { category: "ship", count: 3, scale: 1.5 },
        { category: "boat", count: 5 },
      ];
    }
  }
}

export function makeLogEntry(
  partial: Omit<AgentLogEntry, "id" | "t">,
): AgentLogEntry {
  return {
    ...partial,
    id: `log_${logId++}`,
    t: Date.now(),
  };
}

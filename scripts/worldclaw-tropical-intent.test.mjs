import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureObjectRequirements,
  terrainScatterObjectKind,
} from "../src/lib/worldclaw/pipeline.ts";
import { hasTropicalIntent, planTerrainAssets } from "../src/lib/worldclaw/terrain.ts";

function islandPlan(prompt) {
  return {
    prompt,
    sceneType: "island archipelago",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear",
    regions: [],
    terrainAssets: [],
    objectRequirements: {},
    spatialNotes: [],
    mainObjects: [],
  };
}

test("only explicit tropical language enables palm scatter on an island", () => {
  const japanese = islandPlan(
    "Japanese archipelago with fishing towns, bamboo terraces, and cherry blossom groves",
  );
  const pirate = islandPlan(
    "Tropical pirate island with palm-lined beaches and dense rainforest jungle",
  );

  assert.equal(hasTropicalIntent(japanese), false);
  assert.equal(hasTropicalIntent(pirate), true);
  assert.equal(terrainScatterObjectKind(japanese, "tree"), "tree");
  assert.equal(terrainScatterObjectKind(pirate, "tree"), "palm");

  const japaneseTree = planTerrainAssets(japanese).find((asset) => asset.kind === "tree");
  const pirateTree = planTerrainAssets(pirate).find((asset) => asset.kind === "tree");
  assert.ok(japaneseTree);
  assert.ok(pirateTree);
  assert.ok(japaneseTree.density <= 0.18, "non-tropical island dressing must remain sparse");
  assert.deepEqual(japaneseTree.categoryAffinity, ["beach", "grass"]);
  assert.equal(japaneseTree.categoryAffinity.includes("forest"), false);
  assert.equal(japaneseTree.categoryAffinity.includes("settlement"), false);
  assert.ok(pirateTree.density > japaneseTree.density);
});

test("tropical intent parsing is bounded and respects explicit non-tropical wording", () => {
  assert.equal(hasTropicalIntent("non-tropical Japanese island"), false);
  assert.equal(hasTropicalIntent("Japanese island with no tropical palms"), false);
  assert.equal(hasTropicalIntent("Japanese island without a rainforest or jungle"), false);
  assert.equal(hasTropicalIntent(`Japanese island ${"x".repeat(4_096)} tropical`), false);
  assert.equal(hasTropicalIntent("palm-lined rainforest jungle"), true);
});

test("Japanese island defaults do not reintroduce palms into forests or beaches", () => {
  const japanese = islandPlan("Japanese archipelago with cedar woods and fishing beaches");
  const forest = {
    id: "r0",
    name: "Cedar Forest",
    category: "forest",
    center: [0.35, 0.5],
    radius: 0.2,
    role: "temperate woodland",
    baseElevation: 0.8,
    roughness: 0.1,
    peakStrength: 0,
    color: "#58734e",
  };
  const beach = {
    ...forest,
    id: "r1",
    name: "Fishing Beach",
    category: "beach",
    center: [0.7, 0.5],
    role: "working harbor shore",
  };
  japanese.regions = [forest, beach];
  japanese.objectRequirements = { [forest.name]: [], [beach.name]: [] };

  ensureObjectRequirements(japanese);
  assert.equal(
    Object.values(japanese.objectRequirements)
      .flat()
      .some((requirement) => requirement.category === "palm"),
    false,
  );

  const pirate = islandPlan("tropical pirate island with palm beaches");
  pirate.regions = [forest, beach];
  pirate.objectRequirements = { [forest.name]: [], [beach.name]: [] };
  ensureObjectRequirements(pirate);
  assert.equal(
    Object.values(pirate.objectRequirements)
      .flat()
      .some((requirement) => requirement.category === "palm"),
    true,
  );
});

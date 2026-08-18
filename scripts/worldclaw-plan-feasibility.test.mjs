import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizePlan,
  planningAdaptiveRepairDecision,
} from "../src/lib/worldclaw/inference.ts";

const JAPANESE_PROMPT =
  "A Japanese archipelago with two organized coastal towns, a terraced bamboo forest, a cherry blossom grove, a volcanic rock ridge, one prominent Shinto torii gate and one pagoda, and a fishing harbor with four clearly separated boats. Buildings use exposed dark timber frames, white plaster infill, recessed wooden doors and windows, and overlapping dark slate tile roofs.";

function retainedFailurePlan() {
  return normalizePlan(
    {
      sceneType: "Japanese coastal archipelago",
      theme: "island",
      visualStyle: "stylized",
      regions: [
        {
          name: "Surrounding Ocean",
          category: "ocean",
          center: [0.5, 0.5],
          radius: 0.55,
          role: "deep ocean around every island edge",
        },
        {
          name: "Main Island Uplands",
          category: "hill",
          center: [0.5, 0.5],
          radius: 0.42,
          role: "broad rolling main-island terrain",
        },
        {
          name: "Terraced Bamboo Forest",
          category: "forest",
          center: [0.32, 0.43],
          radius: 0.15,
          role: "terraced Japanese bamboo forest",
        },
        {
          name: "Cherry Blossom Grove",
          category: "forest",
          center: [0.67, 0.5],
          radius: 0.12,
          role: "cherry blossom grove and pagoda clearing",
        },
        {
          name: "West Coastal Town",
          category: "settlement",
          center: [0.28, 0.58],
          radius: 0.1,
          role: "organized western coastal town",
        },
        {
          name: "East Coastal Town",
          category: "settlement",
          center: [0.72, 0.57],
          radius: 0.1,
          role: "organized eastern coastal town",
        },
        {
          name: "Volcanic Rock Ridge",
          category: "rock",
          center: [0.51, 0.22],
          radius: 0.15,
          role: "restrained northern basalt ridge",
        },
        {
          name: "Fishing Harbor",
          category: "settlement",
          center: [0.422, 0.66],
          radius: 0.06,
          role: "fishing harbor with moored boats and timber piers",
        },
        {
          name: "Sacred Torii Cape",
          category: "rock",
          center: [0.84, 0.48],
          radius: 0.07,
          role: "clear torii landmark",
        },
      ],
      objectRequirements: {
        "Terraced Bamboo Forest": [{ category: "tree", count: 24, appearance: "bamboo" }],
        "Cherry Blossom Grove": [
          { category: "tree", count: 18, appearance: "sakura" },
          { category: "pagoda", count: 1 },
        ],
        "West Coastal Town": [{ category: "building", count: 12 }],
        "East Coastal Town": [{ category: "building", count: 12 }],
        "Fishing Harbor": [
          { category: "boat", count: 4 },
          { category: "dock", count: 3 },
        ],
        "Sacred Torii Cape": [{ category: "torii", count: 1 }],
      },
    },
    JAPANESE_PROMPT,
  );
}

test("critical normalized-plan conflicts force bounded repair despite 0.936 consensus", () => {
  const decision = planningAdaptiveRepairDecision(0.936, JAPANESE_PROMPT, retainedFailurePlan());

  assert.equal(decision.required, true);
  assert.equal(decision.scoreTriggered, false);
  assert.equal(decision.feasibilityTriggered, true);
  assert.ok(decision.criticalConflicts.some((conflict) => /exactly 2 town/i.test(conflict)));
  assert.ok(decision.criticalConflicts.some((conflict) => /water basin/i.test(conflict)));
  assert.ok(decision.criticalConflicts.some((conflict) => /dry.*support/i.test(conflict)));
  assert.ok(decision.criticalConflicts.some((conflict) => /underlay/i.test(conflict)));
});

test("a paired harbor and declared terrain underlay do not trigger a high-score repair", () => {
  const plan = normalizePlan(
    {
      sceneType: "Japanese coastal archipelago",
      theme: "island",
      visualStyle: "stylized",
      regions: [
        {
          name: "Surrounding Ocean",
          category: "ocean",
          center: [0.5, 0.5],
          radius: 0.55,
          role: "deep ocean around every island edge",
        },
        {
          name: "Main Island Ground",
          category: "grass",
          center: [0.5, 0.48],
          radius: 0.38,
          role: "non-competing terrain underlay beneath all named semantic regions",
        },
        {
          name: "Terraced Bamboo Forest",
          category: "forest",
          center: [0.3, 0.42],
          radius: 0.13,
          role: "terraced Japanese bamboo forest",
        },
        {
          name: "Cherry Blossom Grove",
          category: "forest",
          center: [0.66, 0.44],
          radius: 0.11,
          role: "cherry blossom grove and pagoda clearing",
        },
        {
          name: "West Coastal Town",
          category: "settlement",
          center: [0.28, 0.58],
          radius: 0.09,
          role: "organized western coastal town",
        },
        {
          name: "East Coastal Town",
          category: "settlement",
          center: [0.71, 0.57],
          radius: 0.09,
          role: "organized eastern coastal town",
        },
        {
          name: "Volcanic Rock Ridge",
          category: "rock",
          center: [0.5, 0.2],
          radius: 0.13,
          role: "restrained northern basalt ridge",
        },
        {
          name: "Fishing Harbor Water Basin",
          category: "ocean",
          center: [0.5, 0.75],
          radius: 0.1,
          role: "sheltered navigable fishing harbor basin with four separated berths",
        },
        {
          name: "Fishing Harbor Dry Quay",
          category: "beach",
          center: [0.5, 0.68],
          radius: 0.07,
          role: "dry non-town harbor support for piers and shore access",
        },
      ],
      objectRequirements: {
        "Terraced Bamboo Forest": [{ category: "tree", count: 24, appearance: "bamboo" }],
        "Cherry Blossom Grove": [
          { category: "tree", count: 18, appearance: "sakura" },
          { category: "pagoda", count: 1 },
        ],
        "West Coastal Town": [{ category: "building", count: 12 }],
        "East Coastal Town": [
          { category: "building", count: 12 },
          { category: "torii", count: 1 },
        ],
        "Fishing Harbor Water Basin": [{ category: "boat", count: 4 }],
        "Fishing Harbor Dry Quay": [{ category: "dock", count: 3 }],
      },
    },
    JAPANESE_PROMPT,
  );

  const decision = planningAdaptiveRepairDecision(0.936, JAPANESE_PROMPT, plan);

  assert.deepEqual(decision, {
    passed: true,
    criticalConflicts: [],
    required: false,
    scoreTriggered: false,
    feasibilityTriggered: false,
  });
});

test("the paper multiple-scattered-towns prompt rejects one broad settlement disk", () => {
  const prompt =
    "Please create an island scene with multiple Japanese-style towns scattered across the island, surrounded by the ocean.";
  const plan = normalizePlan(
    {
      sceneType: "Japanese island towns",
      theme: "island",
      visualStyle: "stylized",
      regions: [
        {
          name: "Surrounding Ocean",
          category: "ocean",
          center: [0.5, 0.5],
          radius: 0.55,
          role: "ocean around the island",
        },
        {
          name: "Northern Granite Mountain",
          category: "mountain",
          center: [0.35, 0.18],
          radius: 0.18,
          role: "northern mountain",
        },
        {
          name: "Eastern Japanese Cedar Forest",
          category: "forest",
          center: [0.75, 0.25],
          radius: 0.2,
          role: "cedar forest",
        },
        {
          name: "Western Flowering Cherry Foothills",
          category: "forest",
          center: [0.25, 0.45],
          radius: 0.17,
          role: "cherry foothills",
        },
        {
          name: "Scattered Japanese Towns",
          category: "settlement",
          center: [0.5, 0.7],
          radius: 0.21,
          role: "three separated town clusters with grass gaps",
        },
      ],
      objectRequirements: {
        "Scattered Japanese Towns": [
          { category: "building", count: 36 },
          { category: "pagoda", count: 3 },
          { category: "torii", count: 3 },
        ],
      },
      mainObjects: ["three pagodas", "three torii gates"],
    },
    prompt,
  );

  const decision = planningAdaptiveRepairDecision(0.98, prompt, plan);
  assert.equal(decision.required, true);
  assert.equal(decision.scoreTriggered, false);
  assert.equal(decision.feasibilityTriggered, true);
  assert.ok(decision.criticalConflicts.some((conflict) => /at least 2/i.test(conflict)));
  assert.ok(decision.criticalConflicts.some((conflict) => /independently buildable/i.test(conflict)));
});

test("multiple scattered towns pass only as distinct independently programmed regions", () => {
  const prompt =
    "Please create an island scene with multiple Japanese-style towns scattered across the island, surrounded by the ocean.";
  const plan = normalizePlan(
    {
      sceneType: "Japanese island towns",
      theme: "island",
      visualStyle: "stylized",
      regions: [
        {
          name: "Surrounding Ocean",
          category: "ocean",
          center: [0.5, 0.5],
          radius: 0.55,
          role: "ocean around the island",
        },
        {
          name: "West Town",
          category: "settlement",
          center: [0.25, 0.67],
          radius: 0.1,
          role: "separated western Japanese town",
        },
        {
          name: "East Town",
          category: "settlement",
          center: [0.74, 0.58],
          radius: 0.1,
          role: "separated eastern Japanese town",
        },
        {
          name: "North Town",
          category: "settlement",
          center: [0.53, 0.32],
          radius: 0.09,
          role: "separated northern Japanese town",
        },
        {
          name: "Mountain",
          category: "mountain",
          center: [0.22, 0.2],
          radius: 0.13,
          role: "mountain",
        },
      ],
      objectRequirements: {
        "West Town": [{ category: "building", count: 8 }],
        "East Town": [{ category: "house", count: 8 }],
        "North Town": [{ category: "building", count: 6 }],
      },
    },
    prompt,
  );

  assert.deepEqual(planningAdaptiveRepairDecision(0.94, prompt, plan), {
    passed: true,
    criticalConflicts: [],
    required: false,
    scoreTriggered: false,
    feasibilityTriggered: false,
  });
});

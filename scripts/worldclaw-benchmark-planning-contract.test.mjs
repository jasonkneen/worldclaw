import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizePlan,
  planningAdaptiveRepairDecision,
  validateBenchmarkGenerationContract,
  validatePromptInput,
} from "../src/lib/worldclaw/inference.ts";

const JAPANESE_PROMPT =
  "Please create an island scene with multiple Japanese-style towns scattered across the island, surrounded by the ocean.";

const JAPANESE_CONTRACT = {
  caseId: "figure-12-japanese-island-towns",
  promptSha256: "6c790cee03f9d6badc7e4db792ba0877e8c68362fd98082a5b5962a4bb0d327e",
  regionalReadability: ["coastal town", "hill town", "shrine district", "waterside settlement"],
  terrainRelationships: ["ocean coastline", "vegetated hills", "multiple separated settlements"],
  objectFamilies: ["Japanese houses", "shrines", "vegetation", "town props"],
};

test("benchmark generation contracts are bound to the exact planning prompt hash", () => {
  const validated = validateBenchmarkGenerationContract(
    { ...JAPANESE_CONTRACT, caseToken: "must-never-reach-a-model" },
    JAPANESE_PROMPT,
  );

  assert.deepEqual(validated, JAPANESE_CONTRACT);
  assert.equal("caseToken" in validated, false);
  assert.deepEqual(
    validatePromptInput({
      prompt: `  ${JAPANESE_PROMPT}  `,
      benchmarkContract: { ...JAPANESE_CONTRACT, caseToken: "must-never-reach-a-model" },
    }),
    { prompt: JAPANESE_PROMPT, benchmarkContract: JAPANESE_CONTRACT },
  );
  assert.throws(
    () =>
      validateBenchmarkGenerationContract(
        { ...JAPANESE_CONTRACT, promptSha256: "0".repeat(64) },
        JAPANESE_PROMPT,
      ),
    /prompt sha-256.*does not match/i,
  );
});

test("malformed benchmark contracts are rejected instead of truncated or defaulted", () => {
  assert.throws(
    () =>
      validateBenchmarkGenerationContract(
        { ...JAPANESE_CONTRACT, regionalReadability: ["one", "two", "three"] },
        JAPANESE_PROMPT,
      ),
    /exactly 4 strings/i,
  );
  assert.throws(
    () =>
      validateBenchmarkGenerationContract(
        { ...JAPANESE_CONTRACT, terrainRelationships: [] },
        JAPANESE_PROMPT,
      ),
    /terrainRelationships.*1-8/i,
  );
  assert.throws(
    () =>
      validateBenchmarkGenerationContract(
        { ...JAPANESE_CONTRACT, objectFamilies: ["x".repeat(121)] },
        JAPANESE_PROMPT,
      ),
    /objectFamilies.*1-120/i,
  );
});

function twoTownJapanesePlan() {
  return normalizePlan(
    {
      sceneType: "Japanese island towns",
      theme: "island",
      visualStyle: "stylized",
      regions: [
        {
          name: "Surrounding Ocean Coastline",
          category: "ocean",
          center: [0.5, 0.5],
          radius: 0.52,
          role: "ocean coastline around the island",
        },
        {
          name: "Vegetated Hills",
          category: "hill",
          center: [0.5, 0.3],
          radius: 0.12,
          role: "vegetated hills with cedar and bamboo",
        },
        {
          name: "Coastal Town",
          category: "settlement",
          center: [0.2, 0.7],
          radius: 0.09,
          role: "separated Japanese coastal town",
        },
        {
          name: "Waterside Settlement",
          category: "settlement",
          center: [0.78, 0.68],
          radius: 0.09,
          role: "separated Japanese waterside settlement with a shrine precinct",
        },
        {
          name: "Rocky Interior",
          category: "rock",
          center: [0.5, 0.55],
          radius: 0.08,
          role: "small volcanic rock landmark",
        },
      ],
      objectRequirements: {
        "Vegetated Hills": [
          { category: "tree", count: 18, appearance: "Japanese cedar and bamboo vegetation" },
        ],
        "Coastal Town": [
          {
            category: "building",
            count: 10,
            appearance: "Japanese house with dark timber frame, white plaster and tiled roof",
          },
          { category: "market", count: 1, appearance: "organized town market prop" },
        ],
        "Waterside Settlement": [
          {
            category: "house",
            count: 9,
            appearance: "Japanese timber house with plaster infill and slate tile roof",
          },
          { category: "pagoda", count: 1, appearance: "Japanese shrine pagoda" },
          { category: "torii", count: 1, appearance: "vermilion Shinto shrine gate" },
          { category: "well", count: 1, appearance: "town well prop" },
        ],
      },
      spatialNotes: ["Multiple separated settlements occupy opposite island shores."],
      mainObjects: ["Japanese houses", "shrines", "vegetation", "town props"],
    },
    JAPANESE_PROMPT,
  );
}

test("a high-consensus two-town plan is unchanged unbound but fails the bound four-role gate", () => {
  const plan = twoTownJapanesePlan();
  const unbound = planningAdaptiveRepairDecision(0.99, JAPANESE_PROMPT, plan);
  assert.equal(unbound.required, false);
  assert.equal(unbound.passed, true);

  const bound = planningAdaptiveRepairDecision(0.99, JAPANESE_PROMPT, plan, JAPANESE_CONTRACT);
  assert.equal(bound.scoreTriggered, false);
  assert.equal(bound.feasibilityTriggered, true);
  assert.equal(bound.required, true, "the first selected plan must enter bounded repair");
  assert.equal(bound.passed, false, "the same plan must be rejected by the final plan gate");
  assert.ok(bound.criticalConflicts.some((conflict) => /hill town/i.test(conflict)));
  assert.ok(bound.criticalConflicts.some((conflict) => /shrine district/i.test(conflict)));
  assert.ok(bound.criticalConflicts.some((conflict) => /four distinct|4 distinct/i.test(conflict)));
});

function completeFourRoleJapanesePlan() {
  return normalizePlan(
    {
      sceneType: "Japanese island towns",
      theme: "island",
      visualStyle: "stylized",
      regions: [
        {
          name: "Surrounding Ocean Coastline",
          category: "ocean",
          center: [0.5, 0.5],
          radius: 0.52,
          role: "ocean coastline around every island shore",
        },
        {
          name: "Coastal Town",
          category: "settlement",
          center: [0.18, 0.72],
          radius: 0.08,
          role: "distinct western Japanese coastal town",
        },
        {
          name: "Terraced Hill Town",
          category: "settlement",
          center: [0.35, 0.2],
          radius: 0.08,
          role: "distinct hill town built into vegetated hills",
        },
        {
          name: "Shrine District",
          category: "settlement",
          center: [0.78, 0.25],
          radius: 0.08,
          role: "distinct sacred shrine district and temple precinct",
        },
        {
          name: "Waterside Settlement",
          category: "settlement",
          center: [0.76, 0.72],
          radius: 0.08,
          role: "distinct eastern Japanese waterside settlement",
        },
      ],
      objectRequirements: {
        "Coastal Town": [
          {
            category: "building",
            count: 9,
            appearance: "Japanese machiya house with timber frame, plaster and tiled roof",
          },
          { category: "market", count: 1, appearance: "organized town market prop" },
        ],
        "Terraced Hill Town": [
          {
            category: "house",
            count: 7,
            appearance: "Japanese timber house with white plaster and dark slate tile roof",
          },
          { category: "tree", count: 16, appearance: "cedar and bamboo hillside vegetation" },
        ],
        "Shrine District": [
          { category: "pagoda", count: 1, appearance: "Japanese shrine pagoda" },
          { category: "torii", count: 1, appearance: "vermilion Shinto shrine gate" },
          { category: "tree", count: 10, appearance: "Japanese cherry blossom grove" },
        ],
        "Waterside Settlement": [
          {
            category: "building",
            count: 8,
            appearance: "Japanese timber-frame waterside house with plaster and tile roof",
          },
          { category: "well", count: 1, appearance: "stone town well prop" },
          { category: "crate", count: 3, appearance: "waterside town cargo props" },
        ],
      },
      spatialNotes: ["Four multiple separated settlements occupy non-overlapping island regions."],
      mainObjects: ["Japanese houses", "pagoda and torii shrines", "town props"],
    },
    JAPANESE_PROMPT,
  );
}

test("a complete four-role Japanese plan satisfies the bound planning contract", () => {
  const decision = planningAdaptiveRepairDecision(
    0.99,
    JAPANESE_PROMPT,
    completeFourRoleJapanesePlan(),
    JAPANESE_CONTRACT,
  );

  assert.deepEqual(decision, {
    passed: true,
    criticalConflicts: [],
    required: false,
    scoreTriggered: false,
    feasibilityTriggered: false,
  });
});

test("one semantic region cannot satisfy both coastal-town and waterside-settlement roles", () => {
  const plan = completeFourRoleJapanesePlan();
  const combined = plan.regions.find((region) => region.name === "Coastal Town");
  assert.ok(combined);
  combined.role = "distinct Japanese coastal town and waterside settlement";
  plan.regions = plan.regions.filter((region) => region.name !== "Waterside Settlement");
  delete plan.objectRequirements["Waterside Settlement"];

  const decision = planningAdaptiveRepairDecision(0.99, JAPANESE_PROMPT, plan, JAPANESE_CONTRACT);

  assert.equal(decision.passed, false);
  assert.equal(decision.required, true);
  assert.ok(decision.criticalConflicts.some((conflict) => /one-to-one/i.test(conflict)));
  assert.ok(decision.criticalConflicts.some((conflict) => /matched 3\/4/i.test(conflict)));
});

test("unsupported benchmark object families fail closed at planning", () => {
  const contract = validateBenchmarkGenerationContract(
    { ...JAPANESE_CONTRACT, objectFamilies: ["animals"] },
    JAPANESE_PROMPT,
  );
  const decision = planningAdaptiveRepairDecision(
    0.99,
    JAPANESE_PROMPT,
    completeFourRoleJapanesePlan(),
    contract,
  );

  assert.equal(decision.passed, false);
  assert.ok(decision.criticalConflicts.some((conflict) => /animals.*unsupported/i.test(conflict)));
});

test("appearance-specific families are not satisfied by generic object categories", () => {
  const plan = completeFourRoleJapanesePlan();
  plan.mainObjects = [];
  for (const requirements of Object.values(plan.objectRequirements)) {
    for (const requirement of requirements) {
      if (requirement.category === "house" || requirement.category === "building") {
        delete requirement.appearance;
      }
    }
  }
  const contract = validateBenchmarkGenerationContract(
    { ...JAPANESE_CONTRACT, objectFamilies: ["Japanese houses"] },
    JAPANESE_PROMPT,
  );

  const decision = planningAdaptiveRepairDecision(0.99, JAPANESE_PROMPT, plan, contract);
  assert.equal(decision.passed, false);
  assert.ok(
    decision.criticalConflicts.some((conflict) =>
      /Japanese houses.*appearance vocabulary/i.test(conflict),
    ),
  );
});

test("terrain relationships require a complete predicate in one plan clause", () => {
  const plan = completeFourRoleJapanesePlan();
  const hillTown = plan.regions.find((region) => region.name === "Terraced Hill Town");
  assert.ok(hillTown);
  hillTown.role = "distinct Japanese hill town";
  plan.objectRequirements[hillTown.name] = plan.objectRequirements[hillTown.name].filter(
    (requirement) => requirement.category !== "tree",
  );
  const contract = validateBenchmarkGenerationContract(
    {
      ...JAPANESE_CONTRACT,
      terrainRelationships: ["vegetated hills"],
      objectFamilies: ["Japanese houses"],
    },
    JAPANESE_PROMPT,
  );

  const decision = planningAdaptiveRepairDecision(0.99, JAPANESE_PROMPT, plan, contract);
  assert.equal(decision.passed, false);
  assert.ok(
    decision.criticalConflicts.some((conflict) => /vegetated hills.*multi-token/i.test(conflict)),
  );
});

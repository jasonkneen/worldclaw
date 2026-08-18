import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import jpeg from "jpeg-js";
import {
  ensureRequiredObjectKinds,
  footprintsOverlapXZ,
  generateRegionalObjects,
  kindBaseScale,
  objectFootprintXZ,
  repairRegionalObjectCoverage,
  resolveObjectKind,
} from "../src/lib/worldclaw/objects.ts";
import {
  canonicalizeSettlementStructureKinds,
  ensureObjectRequirements,
  heroRequiredCounts,
  objectCoverage,
  parseExplicitObjectCounts,
  propagateSettlementConstructionAppearance,
  reconcileExplicitObjectRequirements,
  reconcileExplicitSettlementPrograms,
  remapObjectRequirements,
  repairRequestedObjectCoverage,
  sceneReferenceSummary,
} from "../src/lib/worldclaw/pipeline.ts";
import { heightFromLayout } from "../src/lib/worldclaw/inference.ts";
import {
  heightFieldFromArrays,
  refineTerrainHeights,
  sampleHeight,
} from "../src/lib/worldclaw/terrain.ts";

const JAPANESE_PROMPT =
  "Create two Japanese coastal towns with one vermilion torii, one dark-tile pagoda, and four wooden boats in the harbor.";

test("noun-adjacent prompt counts ignore unrelated earlier region counts", () => {
  assert.deepEqual(Object.fromEntries(parseExplicitObjectCounts(JAPANESE_PROMPT)), {
    torii: 1,
    pagoda: 1,
    boat: 4,
  });
  assert.equal(parseExplicitObjectCounts("one three-tier pagoda").get("pagoda"), 1);
  assert.deepEqual(
    Object.fromEntries(
      parseExplicitObjectCounts("two towns with vermilion torii and a dark-tile pagoda"),
    ),
    {},
  );
});

function heightField(resolution, worldSize, heightAtWorld) {
  const data = new Float32Array(resolution * resolution);
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const worldX = (x / (resolution - 1) - 0.5) * worldSize;
      const worldZ = (z / (resolution - 1) - 0.5) * worldSize;
      data[z * resolution + x] = heightAtWorld(worldX, worldZ);
    }
  }
  return {
    resolution,
    worldSize,
    data,
    regionId: new Uint8Array(resolution * resolution),
    source: "image_guided",
  };
}

function japanesePlan() {
  const shrine = {
    id: "r0",
    name: "Shrine Town",
    category: "settlement",
    center: [0.68, 0.42],
    radius: 0.19,
    role: "organized Japanese shrine plaza",
    baseElevation: 0.8,
    roughness: 0.05,
    peakStrength: 0,
    color: "#8a7b54",
  };
  const grove = {
    ...shrine,
    id: "r1",
    name: "Temple Grove",
    category: "forest",
    center: [0.67, 0.72],
    radius: 0.16,
    role: "wooded inland grove",
  };
  const harbor = {
    ...shrine,
    id: "r2",
    name: "Coastal Harbor",
    category: "ocean",
    center: [0.18, 0.5],
    radius: 0.23,
    role: "protected harbor water",
    baseElevation: -1.2,
  };
  return {
    prompt: JAPANESE_PROMPT,
    sceneType: "Japanese coastal towns",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear morning",
    regions: [shrine, grove, harbor],
    terrainAssets: [],
    objectRequirements: {
      [shrine.name]: [
        { category: "torii gates", count: 3, appearance: "vermilion Myojin gate" },
        { category: "Japanese pagodas", count: 2, appearance: "dark tile three tier" },
        { category: "crate", count: 8 },
      ],
      [grove.name]: [{ category: "trees", count: 10 }],
      [harbor.name]: [
        { category: "wooden boats", count: 5 },
        { category: "boat", count: 4 },
        { category: "sail ships", count: 7 },
      ],
    },
    spatialNotes: [],
    mainObjects: [
      "one vermilion torii",
      "one dark-tile pagoda",
      "four wooden boats in the harbor",
      "seven sail ships around the coast",
    ],
    visualContract: {
      source: "gemini-3.6-flash",
      terrainReliefScale: 1,
      terrainMicroDetailScale: 1,
      vegetationDensityScale: 0.25,
      objectDensityScale: 0.25,
      waterLevelMeters: -0.25,
      palette: [],
      dominantSilhouettes: [],
      compositionNotes: [],
      cameras: [],
    },
  };
}

function rawRequirementTotal(plan, kind) {
  return Object.values(plan.objectRequirements)
    .flat()
    .filter((requirement) => resolveObjectKind(requirement.category) === kind)
    .reduce((sum, requirement) => sum + requirement.count, 0);
}

test("explicit Japanese counts reconcile inflated model totals before generation", () => {
  const plan = japanesePlan();
  const explicit = parseExplicitObjectCounts(plan.prompt);
  reconcileExplicitObjectRequirements(plan, explicit);

  assert.equal(rawRequirementTotal(plan, "torii"), 1);
  assert.equal(rawRequirementTotal(plan, "pagoda"), 1);
  assert.equal(rawRequirementTotal(plan, "boat"), 4);
  assert.equal(rawRequirementTotal(plan, "ship"), 0);
  assert.deepEqual(Object.fromEntries(heroRequiredCounts(plan, explicit)), {
    torii: 1,
    pagoda: 1,
    boat: 4,
  });
});

test("exact boats and the implicit dock hero move to the named harbor anchor", () => {
  const plan = japanesePlan();
  const outerOcean = {
    ...plan.regions[2],
    id: "r_outer",
    name: "Outer Ocean",
    center: [0.12, 0.3],
    role: "open western water",
  };
  const fishingHarbor = {
    ...plan.regions[2],
    id: "r_harbor",
    name: "Southeast Fishing Harbor",
    center: [0.76, 0.73],
    radius: 0.14,
    role: "sheltered fishing cove with separated berths",
  };
  plan.regions = [outerOcean, plan.regions[0], plan.regions[1], fishingHarbor];
  plan.objectRequirements = {
    [outerOcean.name]: [
      { category: "boat", count: 9 },
      { category: "ship", count: 7 },
      { category: "dock", count: 6 },
    ],
    [plan.regions[1].name]: [{ category: "building", count: 6 }],
    [plan.regions[2].name]: [{ category: "tree", count: 12 }],
    [fishingHarbor.name]: [
      { category: "wooden boats", count: 2, appearance: "traditional fishing boats" },
      { category: "pier", count: 5, appearance: "working timber pier" },
    ],
  };
  plan.mainObjects = [
    "one working dock in the sheltered fishing harbor",
    "four clearly separated boats",
  ];

  const explicit = parseExplicitObjectCounts(plan.prompt);
  reconcileExplicitObjectRequirements(plan, explicit);

  assert.equal(rawRequirementTotal(plan, "boat"), 4);
  assert.equal(rawRequirementTotal(plan, "ship"), 0);
  assert.equal(rawRequirementTotal(plan, "dock"), 1);
  assert.deepEqual(
    plan.objectRequirements[fishingHarbor.name].map((requirement) => [
      resolveObjectKind(requirement.category),
      requirement.count,
    ]),
    [
      ["boat", 4],
      ["dock", 1],
    ],
  );
  assert.equal(plan.objectRequirements[outerOcean.name].length, 0);
});

test("a named fishing harbor outranks earlier town prose mentioning docks", () => {
  const plan = japanesePlan();
  const workingTown = {
    ...plan.regions[0],
    id: "working-town",
    name: "WestCoastTown",
    center: [0.25, 0.43],
    role: "organized coastal town with six buildings and a supporting timber dock",
  };
  const fishingHarbor = {
    ...plan.regions[2],
    id: "fishing-harbor",
    name: "FishingHarbor",
    category: "beach",
    center: [0.5, 0.81],
    radius: 0.07,
    role: "sheltered fishing cove with four separated berths",
  };
  plan.regions = [workingTown, fishingHarbor];
  plan.objectRequirements = {
    [workingTown.name]: [
      { category: "building", count: 6 },
      { category: "dock", count: 1 },
      { category: "boat", count: 7 },
    ],
    [fishingHarbor.name]: [{ category: "boat", count: 2 }],
  };

  const explicit = parseExplicitObjectCounts(plan.prompt);
  reconcileExplicitObjectRequirements(plan, explicit);

  assert.equal(rawRequirementTotal(plan, "boat"), 4);
  assert.equal(
    plan.objectRequirements[workingTown.name].some(
      (requirement) => resolveObjectKind(requirement.category) === "boat",
    ),
    false,
  );
  assert.equal(
    plan.objectRequirements[fishingHarbor.name].find(
      (requirement) => resolveObjectKind(requirement.category) === "boat",
    )?.count,
    4,
  );
});

test("an exact two-town prompt removes a model-invented third harbor building program", () => {
  const plan = japanesePlan();
  const west = {
    ...plan.regions[0],
    id: "west-town",
    name: "West Coastal Town",
    role: "organized western coastal town",
  };
  const east = {
    ...plan.regions[0],
    id: "east-town",
    name: "East Coastal Town",
    role: "organized eastern coastal town",
  };
  const harbor = {
    ...plan.regions[2],
    id: "fishing-harbor",
    name: "Fishing Harbor",
    category: "settlement",
    role: "protected fishing cove with separated berths",
  };
  plan.prompt =
    "A Japanese archipelago with two organized coastal towns and a fishing harbor with four clearly separated boats.";
  plan.regions = [west, east, harbor];
  plan.objectRequirements = {
    [west.name]: [{ category: "building", count: 9 }],
    [east.name]: [{ category: "building", count: 8 }],
    [harbor.name]: [
      { category: "building", count: 6 },
      { category: "dock", count: 3 },
      { category: "boat", count: 4 },
    ],
  };

  reconcileExplicitSettlementPrograms(plan);

  assert.deepEqual(
    plan.objectRequirements[harbor.name].map((requirement) =>
      resolveObjectKind(requirement.category),
    ),
    ["dock", "boat"],
  );
  assert.equal(rawRequirementTotal(plan, "building"), 17);

  plan.prompt = "Two coastal towns and one fishing harbor town with four boats.";
  plan.objectRequirements[harbor.name].unshift({ category: "building", count: 6 });
  reconcileExplicitSettlementPrograms(plan);
  assert.equal(
    plan.objectRequirements[harbor.name].some(
      (requirement) => resolveObjectKind(requirement.category) === "building",
    ),
    true,
    "an explicitly requested harbor town retains its building program",
  );
});

test("selected adaptive canonical raster retains four boats at FishingHarbor", () => {
  const sourceRegions = [
    {
      id: "north-ocean",
      name: "NorthOcean",
      category: "ocean",
      center: [0.5, 0.08],
      radius: 0.2,
      role: "northern ocean framing",
      baseElevation: -1.2,
      roughness: 0.04,
      peakStrength: 0,
      color: "#1e5a8a",
    },
    {
      id: "west-town",
      name: "WestCoastTown",
      category: "settlement",
      center: [0.27, 0.43],
      radius: 0.16,
      role: "organized coastal town with six buildings and a timber dock",
      baseElevation: 0.8,
      roughness: 0.08,
      peakStrength: 0,
      color: "#a89060",
    },
    {
      id: "east-town",
      name: "EastCoastTown",
      category: "settlement",
      center: [0.76, 0.55],
      radius: 0.16,
      role: "organized harbor town with six buildings and a timber dock",
      baseElevation: 0.8,
      roughness: 0.08,
      peakStrength: 0,
      color: "#a89060",
    },
    {
      id: "ridge",
      name: "VolcanicRidge",
      category: "rock",
      center: [0.67, 0.29],
      radius: 0.16,
      role: "dark volcanic ridge",
      baseElevation: 1.5,
      roughness: 0.7,
      peakStrength: 0.7,
      color: "#343238",
    },
    {
      id: "bamboo",
      name: "BambooTerraces",
      category: "forest",
      center: [0.3, 0.63],
      radius: 0.24,
      role: "six stepped bamboo terraces",
      baseElevation: 0.8,
      roughness: 0.2,
      peakStrength: 0.1,
      color: "#2f6b35",
    },
    {
      id: "harbor",
      name: "FishingHarbor",
      category: "beach",
      center: [0.5, 0.82],
      radius: 0.1,
      role: "sheltered fishing cove with four separated berths",
      baseElevation: 0.4,
      roughness: 0.08,
      peakStrength: 0,
      color: "#e8d5a3",
    },
  ];
  const sourcePlan = {
    prompt: JAPANESE_PROMPT,
    sceneType: "Japanese archipelago",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "misty morning",
    regions: sourceRegions,
    terrainAssets: [],
    objectRequirements: {
      NorthOcean: [],
      WestCoastTown: [
        { category: "building", count: 6 },
        { category: "dock", count: 1 },
      ],
      EastCoastTown: [
        { category: "building", count: 6 },
        { category: "dock", count: 1 },
      ],
      VolcanicRidge: [],
      BambooTerraces: [{ category: "tree", count: 16, appearance: "bamboo" }],
      FishingHarbor: [{ category: "boat", count: 6, appearance: "wooden fishing boat" }],
    },
    spatialNotes: [],
    mainObjects: ["four wooden boats in the harbor"],
  };
  const image = jpeg.decode(
    readFileSync(
      new URL(
        "../screenshots/reference-validation/runs/2026-08-12T02-25-00-978Z/committee-layout-i2-gemini-adaptive-repair.jpg",
        import.meta.url,
      ),
    ),
    { useTArray: true },
  );
  const layout = heightFromLayout(
    image.data,
    image.width,
    image.height,
    "island",
    128,
    sourceRegions,
  );
  const plan = {
    ...sourcePlan,
    regions: layout.regions,
    objectRequirements: remapObjectRequirements(sourcePlan, layout.regions),
  };
  const explicit = parseExplicitObjectCounts(plan.prompt);
  reconcileExplicitObjectRequirements(plan, explicit);
  const harbor = plan.regions.find((region) => region.name === "FishingHarbor");
  assert.ok(harbor, "the selected raster must retain its authored harbor component");
  assert.equal(
    plan.objectRequirements[harbor.name].find(
      (requirement) => resolveObjectKind(requirement.category) === "boat",
    )?.count,
    4,
  );

  let hf = heightFieldFromArrays(
    layout.resolution,
    layout.worldSize,
    layout.height,
    layout.regionId,
    "image_guided",
  );
  hf = refineTerrainHeights(hf, plan);
  const required = new Map([["boat", 4]]);
  const telemetry = [];
  let objects = generateRegionalObjects(plan, hf, 0x58414934, required);
  objects = ensureRequiredObjectKinds(plan, hf, 0x58414934, objects, required, telemetry);
  const boats = objects.filter((object) => object.kind === "boat");
  assert.equal(boats.length, 4);
  assert.ok(boats.every((boat) => boat.regionId === harbor.id));
  assert.ok(boats.every((boat) => sampleHeight(hf, boat.position[0], boat.position[2]) <= 0.35));
  for (let left = 0; left < boats.length; left++) {
    for (let right = left + 1; right < boats.length; right++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(boats[left]), objectFootprintXZ(boats[right]), 1.2),
        false,
      );
    }
  }
});

test("02-49 selected raster reserves every constrained coastal town minimum", () => {
  const sourceRegion = (id, name, category, center, radius, role) => ({
    id,
    name,
    category,
    center,
    radius,
    role,
    baseElevation: category === "ocean" ? -1.2 : 0.8,
    roughness: category === "rock" ? 0.7 : 0.1,
    peakStrength: category === "rock" ? 0.7 : 0,
    color: "#888888",
  });
  const sourceRegions = [
    sourceRegion("ocean", "Outer Ocean", "ocean", [0.5, 0.5], 0.5, "surrounding ocean"),
    sourceRegion(
      "ridge",
      "Volcanic Ridge",
      "rock",
      [0.5, 0.18],
      0.18,
      "jagged northern volcanic ridge",
    ),
    sourceRegion(
      "saddle",
      "Sacred Saddle",
      "grass",
      [0.5, 0.34],
      0.1,
      "open shrine plaza",
    ),
    sourceRegion(
      "west",
      "West Coastal Town",
      "settlement",
      [0.25, 0.42],
      0.18,
      "organized western coastal town and landmark site",
    ),
    sourceRegion(
      "east",
      "East Coastal Town",
      "settlement",
      [0.75, 0.43],
      0.17,
      "organized eastern coastal town",
    ),
    sourceRegion(
      "bamboo",
      "Terraced Bamboo Forest",
      "forest",
      [0.28, 0.64],
      0.18,
      "six stepped bamboo terraces",
    ),
    sourceRegion(
      "cherry",
      "Cherry Blossom Grove",
      "forest",
      [0.7, 0.65],
      0.18,
      "spacious cherry grove",
    ),
    sourceRegion(
      "harbor",
      "Fishing Harbor",
      "settlement",
      [0.5, 0.8],
      0.12,
      "protected southern fishing harbor town and cove",
    ),
    sourceRegion(
      "islets",
      "Offshore Islets",
      "grass",
      [0.85, 0.82],
      0.08,
      "southeast islets",
    ),
  ];
  const prompt =
    "A Japanese archipelago with two organized coastal towns, terraced bamboo forest, cherry blossom grove, volcanic ridge, one torii, one pagoda, and a fishing harbor with four separated boats.";
  const sourcePlan = {
    prompt,
    sceneType: "Japanese coastal archipelago",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "spring morning",
    regions: sourceRegions,
    terrainAssets: [],
    objectRequirements: {
      "Sacred Saddle": [{ category: "building", count: 6 }],
      "West Coastal Town": [
        { category: "building", count: 18 },
        { category: "torii", count: 1 },
        { category: "pagoda", count: 1 },
      ],
      "East Coastal Town": [{ category: "building", count: 16 }],
      "Terraced Bamboo Forest": [{ category: "tree", count: 24, appearance: "bamboo" }],
      "Cherry Blossom Grove": [{ category: "tree", count: 34, appearance: "sakura" }],
      "Fishing Harbor": [
        { category: "building", count: 6 },
        { category: "dock", count: 3 },
        { category: "boat", count: 4 },
      ],
    },
    spatialNotes: [],
    mainObjects: ["one torii", "one pagoda", "four separated boats"],
  };
  const image = jpeg.decode(
    readFileSync(
      new URL(
        "../screenshots/reference-validation/runs/2026-08-12T02-49-21-350Z/committee-layout-i2-gemini-adaptive-repair.jpg",
        import.meta.url,
      ),
    ),
    { useTArray: true },
  );

  const build = () => {
    const layout = heightFromLayout(
      image.data,
      image.width,
      image.height,
      "island",
      128,
      sourceRegions,
    );
    const plan = {
      ...structuredClone(sourcePlan),
      regions: layout.regions,
      objectRequirements: remapObjectRequirements(sourcePlan, layout.regions),
    };
    const exact = parseExplicitObjectCounts(prompt);
    reconcileExplicitObjectRequirements(plan, exact);
    let hf = heightFieldFromArrays(
      layout.resolution,
      layout.worldSize,
      layout.height,
      layout.regionId,
      "image_guided",
    );
    hf = refineTerrainHeights(hf, plan);
    const seed = 0x2a166fba;
    const generated = generateRegionalObjects(plan, hf, seed, exact);
    return repairRegionalObjectCoverage(plan, hf, seed, generated, exact);
  };

  const repaired = build();
  assert.deepEqual(repaired.deficits, []);
  const coastalTownDecisions = repaired.decisions.filter((decision) =>
    /West Coastal Town|East Coastal Town/.test(decision.regionName),
  );
  assert.equal(coastalTownDecisions.length, 2);
  for (const decision of coastalTownDecisions) {
    assert.ok(decision.capacity >= 4);
    assert.ok(decision.chosen >= 4);
    assert.equal(decision.placed, decision.chosen);
    assert.ok(decision.attempts > 0);
    assert.ok(
      Object.values(decision.rejected).every(
        (count) => Number.isInteger(count) && count >= 0 && count <= decision.attempts,
      ),
    );
  }
  const buildings = repaired.objects.filter((object) => object.kind === "building");
  for (let left = 0; left < buildings.length; left++) {
    for (let right = left + 1; right < buildings.length; right++) {
      assert.equal(
        footprintsOverlapXZ(
          objectFootprintXZ(buildings[left]),
          objectFootprintXZ(buildings[right]),
          0.3,
        ),
        false,
        `${buildings[left].id} overlaps ${buildings[right].id}`,
      );
    }
  }
  assert.deepEqual(repaired, build(), "selected-raster reservation must be deterministic");
});

test("03-19 retained xAI raster keeps exactly two viable town programs", () => {
  const region = (id, name, category, center, radius, role) => ({
    id,
    name,
    category,
    center,
    radius,
    role,
    baseElevation: category === "ocean" ? -1.2 : 0.8,
    roughness: category === "rock" ? 0.7 : 0.1,
    peakStrength: category === "rock" ? 0.7 : 0,
    color: "#888888",
  });
  const sourceRegions = [
    region("ocean", "Outer Ocean", "ocean", [0.5, 0.5], 0.5, "surrounding ocean"),
    region(
      "bamboo",
      "Terraced Bamboo Forest",
      "forest",
      [0.27, 0.25],
      0.2,
      "six stepped bamboo terraces",
    ),
    region(
      "precinct",
      "Pagoda Precinct",
      "settlement",
      [0.34, 0.27],
      0.08,
      "open pagoda precinct",
    ),
    region(
      "cherry",
      "Cherry Blossom Grove",
      "forest",
      [0.72, 0.25],
      0.18,
      "spacious cherry grove",
    ),
    region(
      "west",
      "West Coastal Town",
      "settlement",
      [0.2, 0.58],
      0.16,
      "organized western coastal town",
    ),
    region(
      "east",
      "East Coastal Town",
      "settlement",
      [0.75, 0.43],
      0.16,
      "organized eastern coastal town",
    ),
    region(
      "ridge",
      "Volcanic Ridge",
      "rock",
      [0.58, 0.72],
      0.2,
      "jagged volcanic rock ridge",
    ),
    region(
      "harbor",
      "Fishing Harbor",
      "settlement",
      [0.22, 0.78],
      0.11,
      "protected fishing cove with separated berths",
    ),
  ];
  const prompt =
    "A Japanese archipelago with two organized coastal towns, a terraced bamboo forest, a cherry blossom grove, a volcanic rock ridge, one prominent Shinto torii gate and one pagoda, and a fishing harbor with four clearly separated boats. Buildings use exposed dark timber frames, white plaster infill, recessed wooden doors and windows, and overlapping dark slate tile roofs.";
  const sourcePlan = {
    prompt,
    sceneType: "Japanese coastal archipelago",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "spring morning",
    regions: sourceRegions,
    terrainAssets: [],
    objectRequirements: {
      "Pagoda Precinct": [{ category: "pagoda", count: 1 }],
      "West Coastal Town": [{ category: "building", count: 18, scale: 1.7 }],
      "East Coastal Town": [
        { category: "building", count: 16, scale: 1.7 },
        { category: "torii", count: 1 },
        { category: "market", count: 1 },
      ],
      "Fishing Harbor": [
        { category: "building", count: 6, scale: 1.7 },
        { category: "dock", count: 3 },
        { category: "boat", count: 4 },
      ],
    },
    spatialNotes: [],
    mainObjects: ["one torii", "one pagoda", "four clearly separated boats"],
  };
  reconcileExplicitSettlementPrograms(sourcePlan);
  assert.equal(
    sourcePlan.objectRequirements["Fishing Harbor"].some(
      (requirement) => resolveObjectKind(requirement.category) === "building",
    ),
    false,
  );

  const image = jpeg.decode(
    readFileSync(
      new URL(
        "../screenshots/reference-validation/runs/2026-08-12T03-19-30-127Z/committee-layout-i1-xai-candidate-grok-imagine-image-quality.jpg",
        import.meta.url,
      ),
    ),
    { useTArray: true },
  );
  const layout = heightFromLayout(
    image.data,
    image.width,
    image.height,
    "island",
    128,
    sourceRegions,
  );
  const plan = {
    ...sourcePlan,
    regions: layout.regions,
    objectRequirements: remapObjectRequirements(sourcePlan, layout.regions),
  };
  reconcileExplicitSettlementPrograms(plan);
  const exact = parseExplicitObjectCounts(prompt);
  reconcileExplicitObjectRequirements(plan, exact);
  let hf = heightFieldFromArrays(
    layout.resolution,
    layout.worldSize,
    layout.height,
    layout.regionId,
    "image_guided",
  );
  hf = refineTerrainHeights(hf, plan);
  const generated = generateRegionalObjects(plan, hf, 0xabdfe093, exact);
  const repaired = repairRegionalObjectCoverage(plan, hf, 0xabdfe093, generated, exact);

  assert.deepEqual(repaired.deficits, []);
  assert.equal(
    repaired.decisions.some((decision) => decision.regionName === "Fishing Harbor"),
    false,
  );
  const towns = repaired.decisions.filter((decision) => /Coastal Town/.test(decision.regionName));
  assert.equal(towns.length, 2);
  for (const town of towns) {
    assert.ok(town.capacity >= 4, `${town.regionName} must physically fit one street block`);
    assert.ok(town.chosen >= 4);
    assert.equal(town.placed, town.chosen);
    assert.ok(town.scaleFactor >= 0.74 && town.scaleFactor <= 1);
  }
  assert.equal(generated.filter((object) => object.kind === "boat").length, 4);
});

test("04-30 retained xAI raster reserves the grove pagoda and a complete four-boat harbor", () => {
  const prompt =
    "A Japanese archipelago with two organized coastal towns, a terraced bamboo forest, a cherry blossom grove, a volcanic rock ridge, one prominent Shinto torii gate and one pagoda, and a fishing harbor with four clearly separated boats. Buildings use exposed dark timber frames, white plaster infill, recessed wooden doors and windows, and overlapping dark slate tile roofs.";
  const region = (id, name, category, center, radius, role) => ({
    id,
    name,
    category,
    center,
    radius,
    role,
    baseElevation: category === "ocean" ? -1.2 : 0.8,
    roughness: category === "rock" ? 0.65 : 0.1,
    peakStrength: category === "rock" ? 0.7 : 0,
    color: "#888888",
  });
  // The ledger retained the OpenAI winner summary but not its raw JSON. This
  // bounded fixture therefore marks the plan as inferred while using the exact
  // selected xAI bytes and the centers/radii recorded by the failure ledger.
  const sourceRegions = [
    region("uplands", "Main Island Uplands", "grass", [0.5, 0.5], 0.42, "broad island underlay"),
    region("ridge", "Volcanic Rock Ridge", "rock", [0.5, 0.18], 0.2, "jagged northern volcanic ridge"),
    region("bamboo", "Terraced Bamboo Forest", "forest", [0.25, 0.35], 0.18, "six stepped bamboo terraces"),
    region("cherry", "Cherry Blossom Grove", "forest", [0.7, 0.4], 0.2, "cherry grove around a central pagoda clearing"),
    region("west", "West Coastal Town", "settlement", [0.28, 0.62], 0.18, "organized western coastal town"),
    region("east", "East Coastal Town", "settlement", [0.7, 0.62], 0.18, "organized eastern coastal town"),
    region("harbor", "Fishing Harbor", "settlement", [0.5, 0.8], 0.16, "semicircular fishing harbor with open-water berths"),
    region("cape", "Sacred Torii Cape", "rock", [0.88, 0.5], 0.09, "rocky sacred torii islet"),
    region("beaches", "Coastal Beaches", "beach", [0.5, 0.55], 0.4, "island beach rim"),
  ];
  const sourcePlan = {
    prompt,
    sceneType: "Japanese coastal archipelago",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "spring morning",
    regions: sourceRegions,
    terrainAssets: [],
    objectRequirements: {
      "Volcanic Rock Ridge": [{ category: "rock", count: 24 }],
      "Terraced Bamboo Forest": [{ category: "tree", count: 40, appearance: "segmented bamboo culms" }],
      "Cherry Blossom Grove": [
        { category: "tree", count: 40, appearance: "branching cherry blossom trees" },
        { category: "pagoda", count: 1 },
      ],
      "West Coastal Town": [{ category: "building", count: 16 }],
      "East Coastal Town": [{ category: "building", count: 14 }],
      "Fishing Harbor": [
        { category: "dock", count: 3 },
        { category: "building", count: 3 },
        { category: "boat", count: 4, scale: 2 },
      ],
      "Sacred Torii Cape": [{ category: "torii", count: 1 }],
    },
    spatialNotes: [],
    mainObjects: ["one pagoda", "one torii", "four boats"],
  };
  reconcileExplicitSettlementPrograms(sourcePlan);

  const imageBytes = readFileSync(
    new URL(
      "../screenshots/reference-validation/runs/2026-08-12T04-30-12-843Z/committee-layout-i1-xai-candidate-grok-imagine-image-quality.jpg",
      import.meta.url,
    ),
  );
  assert.equal(
    createHash("sha256").update(imageBytes).digest("hex"),
    "a34da2f29b269b566c4965f161c0a91bbd17ea2e091d8273efe10b5a7496784c",
  );
  const image = jpeg.decode(imageBytes, { useTArray: true });
  const layout = heightFromLayout(
    image.data,
    image.width,
    image.height,
    "island",
    256,
    sourceRegions,
  );
  const plan = {
    ...sourcePlan,
    regions: layout.regions,
    objectRequirements: remapObjectRequirements(sourcePlan, layout.regions),
  };
  reconcileExplicitSettlementPrograms(plan);
  const exact = parseExplicitObjectCounts(prompt);
  reconcileExplicitObjectRequirements(plan, exact);
  const cherry = plan.regions.find((candidate) => candidate.name === "Cherry Blossom Grove");
  const harbor = plan.regions.find((candidate) => candidate.name === "Fishing Harbor");
  assert.ok(cherry && harbor);
  assert.deepEqual(cherry.center, [0.741, 0.535]);
  assert.equal(cherry.radius, 0.06);
  assert.deepEqual(harbor.center, [0.422, 0.66]);
  assert.equal(harbor.radius, 0.06);

  let hf = heightFieldFromArrays(
    layout.resolution,
    layout.worldSize,
    layout.height,
    layout.regionId,
  );
  hf = refineTerrainHeights(hf, plan);
  const objects = generateRegionalObjects(plan, hf, 0xabdfe093, exact);
  const pagodas = objects.filter((object) => object.kind === "pagoda");
  const boats = objects.filter((object) => object.kind === "boat");
  assert.equal(pagodas.length, 1, "the landmark must reserve its grove clearing before trees");
  assert.equal(pagodas[0].regionId, cherry.id);
  assert.equal(boats.length, 4, "the harbor preflight commits only a complete exact fleet");
  assert.ok(boats.every((boat) => boat.regionId === harbor.id));
  assert.ok(boats.every((boat) => sampleHeight(hf, boat.position[0], boat.position[2]) <= 0.35));
  assert.ok(boats.every((boat) => boat.scale < 2.8), "provider scale may shrink to harbor capacity");
  const harborScaleSteps = [1, 0.9, 0.82, 0.74].map(
    (factor) => kindBaseScale("boat") * 2 * factor * 0.96,
  );
  assert.ok(
    harborScaleSteps.some((scale) =>
      boats.every((boat) => Math.abs(boat.scale - scale) < 1e-8),
    ),
    "the retained basin should fit a single bounded harbor-capacity step",
  );
  for (let left = 0; left < boats.length; left++) {
    for (let right = left + 1; right < boats.length; right++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(boats[left]), objectFootprintXZ(boats[right]), 1.2),
        false,
      );
    }
  }
  const telemetry = [];
  const rescued = ensureRequiredObjectKinds(
    plan,
    hf,
    0xabdfe093,
    objects,
    heroRequiredCounts(plan, exact),
    telemetry,
  );
  assert.deepEqual(rescued, objects);
  assert.deepEqual(telemetry, []);
  assert.deepEqual(
    objects,
    generateRegionalObjects(plan, hf, 0xabdfe093, exact),
    "retained-raster landmark and fleet preflight must be deterministic",
  );
});

test("prompt construction authority propagates to every settlement building", () => {
  const plan = japanesePlan();
  plan.prompt = `${plan.prompt} Buildings use exposed dark timber frames, white plaster infill, recessed wooden doors and windows, and overlapping dark slate tile roofs.`;
  plan.objectRequirements[plan.regions[0].name].push(
    { category: "building", count: 6, appearance: "coastal town buildings" },
    { category: "house", count: 4 },
  );
  const pagodaBefore = plan.objectRequirements[plan.regions[0].name].find(
    (requirement) => resolveObjectKind(requirement.category) === "pagoda",
  ).appearance;

  propagateSettlementConstructionAppearance(plan);

  const constructed = plan.objectRequirements[plan.regions[0].name].filter((requirement) =>
    ["building", "house"].includes(resolveObjectKind(requirement.category)),
  );
  assert.equal(constructed.length, 2);
  for (const requirement of constructed) {
    assert.match(requirement.appearance, /Japanese house/i);
    assert.match(requirement.appearance, /exposed dark timber frame/i);
    assert.match(requirement.appearance, /white lime plaster infill/i);
    assert.match(requirement.appearance, /recessed wooden doors/i);
    assert.match(requirement.appearance, /recessed lattice windows/i);
    assert.match(requirement.appearance, /overlapping dark charcoal roof tiles/i);
  }
  const pagodaAfter = plan.objectRequirements[plan.regions[0].name].find(
    (requirement) => resolveObjectKind(requirement.category) === "pagoda",
  ).appearance;
  assert.equal(pagodaAfter, pagodaBefore, "house doors and windows must not leak onto the pagoda");
});

test("Japanese building prompts canonicalize unrequested settlement huts and watchtowers", () => {
  const plan = japanesePlan();
  plan.prompt +=
    " Buildings use exposed dark timber frames, white plaster infill, recessed wooden doors and windows, and overlapping dark slate tile roofs.";
  const settlement = plan.regions[0];
  plan.regions = [settlement];
  plan.objectRequirements = { [settlement.name]: [] };
  plan.mainObjects = ["two generic watchtowers", "organized coastal houses"];

  ensureObjectRequirements(plan);
  canonicalizeSettlementStructureKinds(plan);
  propagateSettlementConstructionAppearance(plan);

  assert.equal(rawRequirementTotal(plan, "hut"), 0);
  assert.equal(rawRequirementTotal(plan, "watchtower"), 0);
  assert.equal(rawRequirementTotal(plan, "building"), 11);
  assert.equal(
    plan.mainObjects.some((description) => /watchtower/i.test(description)),
    false,
  );
  for (const requirement of plan.objectRequirements[settlement.name].filter(
    (candidate) => resolveObjectKind(candidate.category) === "building",
  )) {
    assert.match(requirement.appearance, /Japanese house/i);
    assert.match(requirement.appearance, /overlapping dark charcoal roof tiles/i);
  }
});

test("two authored towns prevent an image-classified third settlement from receiving defaults", () => {
  const plan = japanesePlan();
  const northernTown = plan.regions[0];
  const southernTown = {
    ...northernTown,
    id: "r_south",
    name: "SouthernTown",
    center: [0.32, 0.76],
    role: "organized southern coastal town",
  };
  const ridgeFalsePositive = {
    ...northernTown,
    id: "r_false",
    name: "Settlement 2",
    center: [0.75, 0.49],
    role: "settlement",
  };
  plan.regions = [northernTown, ridgeFalsePositive, southernTown];
  plan.objectRequirements = {
    [northernTown.name]: [{ category: "building", count: 7 }],
    [ridgeFalsePositive.name]: [],
    [southernTown.name]: [{ category: "building", count: 6 }],
  };

  ensureObjectRequirements(plan);

  assert.equal(rawRequirementTotal(plan, "building"), 13);
  assert.deepEqual(plan.objectRequirements[ridgeFalsePositive.name], []);
});

test("explicitly requested huts and watchtowers are never canonicalized away", () => {
  const plan = japanesePlan();
  const settlement = plan.regions[0];
  plan.prompt =
    "A Japanese town with three huts and one watchtower; buildings use dark timber frames.";
  plan.regions = [settlement];
  plan.objectRequirements = {
    [settlement.name]: [
      { category: "hut", count: 3 },
      { category: "watchtower", count: 1 },
    ],
  };

  canonicalizeSettlementStructureKinds(plan);

  assert.equal(rawRequirementTotal(plan, "hut"), 3);
  assert.equal(rawRequirementTotal(plan, "watchtower"), 1);
  assert.equal(rawRequirementTotal(plan, "building"), 0);
});

test("reference summary suppresses conflicting model hero counts and watercraft synonyms", () => {
  const plan = japanesePlan();
  plan.mainObjects = ["nine wooden boats", "seven sail ships", "three pagodas", "six torii gates"];
  const explicit = parseExplicitObjectCounts(plan.prompt);
  const summary = sceneReferenceSummary(plan, explicit);

  assert.match(summary, /hero subject=boat x4; count authority=user prompt exact/);
  assert.match(summary, /hero subject=pagoda x1; count authority=user prompt exact/);
  assert.match(summary, /hero subject=torii x1; count authority=user prompt exact/);
  assert.doesNotMatch(summary, /nine wooden boats|seven sail ships|three pagodas|six torii gates/i);
});

function buildCoverageRepair() {
  const plan = japanesePlan();
  const explicit = parseExplicitObjectCounts(plan.prompt);
  reconcileExplicitObjectRequirements(plan, explicit);
  const hf = heightField(97, 96, (x) => (x < -5 ? -1.2 : 0.8));
  const seed = 0x4a415041;
  let objects = generateRegionalObjects(plan, hf, seed, explicit);
  objects = ensureRequiredObjectKinds(plan, hf, seed, objects, heroRequiredCounts(plan, explicit));
  const before = objectCoverage(plan, objects, explicit);
  objects = repairRequestedObjectCoverage(plan, hf, seed, objects, explicit);
  return {
    plan,
    explicit,
    hf,
    seed,
    before,
    objects,
    coverage: objectCoverage(plan, objects, explicit),
  };
}

test("aggregate coverage repair reaches the real 95% gate with bounded separated placements", () => {
  const result = buildCoverageRepair();
  const repeated = buildCoverageRepair();

  assert.ok(result.before.satisfactionRatio < 0.95, "the fixture must exercise aggregate repair");
  assert.ok(result.coverage.satisfactionRatio >= 0.95);
  assert.deepEqual(result.coverage.missingHeroKinds, []);
  assert.deepEqual(result.objects, repeated.objects);
  assert.equal(result.objects.filter((object) => object.kind === "torii").length, 1);
  assert.equal(result.objects.filter((object) => object.kind === "pagoda").length, 1);
  assert.equal(result.objects.filter((object) => object.kind === "boat").length, 4);
  assert.equal(result.objects.filter((object) => object.kind === "ship").length, 0);

  const worldLimit = result.hf.worldSize * 0.5 * 0.96 + 1e-8;
  for (const object of result.objects) {
    const footprint = objectFootprintXZ(object);
    const cosine = Math.abs(Math.cos(footprint.yaw));
    const sine = Math.abs(Math.sin(footprint.yaw));
    const extentX = cosine * footprint.halfX + sine * footprint.halfZ;
    const extentZ = sine * footprint.halfX + cosine * footprint.halfZ;
    assert.ok(Math.abs(footprint.centerX) + extentX <= worldLimit);
    assert.ok(Math.abs(footprint.centerZ) + extentZ <= worldLimit);
    if (object.kind === "boat") {
      assert.ok(sampleHeight(result.hf, footprint.centerX, footprint.centerZ) <= 0.35);
    }
  }
  for (let a = 0; a < result.objects.length; a++) {
    for (let b = a + 1; b < result.objects.length; b++) {
      assert.equal(
        footprintsOverlapXZ(
          objectFootprintXZ(result.objects[a]),
          objectFootprintXZ(result.objects[b]),
        ),
        false,
        `${result.objects[a].id} overlaps ${result.objects[b].id}`,
      );
    }
  }
});

test("coverage repair reports physically impossible landmarks instead of fabricating a pass", () => {
  const ocean = {
    id: "r0",
    name: "Open Water",
    category: "ocean",
    center: [0.5, 0.5],
    radius: 0.3,
    role: "deep water only",
    baseElevation: -1.2,
    roughness: 0,
    peakStrength: 0,
    color: "#277da1",
  };
  const plan = {
    prompt: "one pagoda",
    sceneType: "impossible landmark fixture",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear",
    regions: [ocean],
    terrainAssets: [],
    objectRequirements: { [ocean.name]: [{ category: "pagoda", count: 1 }] },
    spatialNotes: [],
    mainObjects: ["one pagoda"],
  };
  const explicit = parseExplicitObjectCounts(plan.prompt);
  const hf = heightField(33, 32, () => -1.2);
  const repaired = repairRequestedObjectCoverage(plan, hf, 17, [], explicit);
  const coverage = objectCoverage(plan, repaired, explicit);

  assert.equal(repaired.length, 0);
  assert.equal(coverage.satisfactionRatio, 0);
  assert.deepEqual(coverage.missingKinds, ["pagoda"]);
  assert.deepEqual(coverage.missingHeroKinds, ["pagoda"]);
});

test("forest defaults preserve named bamboo and sakura species", () => {
  const region = (id, name, role) => ({
    id,
    name,
    category: "forest",
    center: [0.5, 0.5],
    radius: 0.2,
    role,
    baseElevation: 0.8,
    roughness: 0.1,
    peakStrength: 0,
    color: "#67834f",
  });
  const bamboo = region("r0", "Bamboo Forest", "quiet bamboo grove");
  const sakura = region("r1", "Sakura Hills", "cherry blossom grove");
  const plan = {
    prompt: "Japanese forests",
    sceneType: "forest test",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear",
    regions: [bamboo, sakura],
    terrainAssets: [],
    objectRequirements: { [bamboo.name]: [], [sakura.name]: [] },
    spatialNotes: [],
    mainObjects: [],
  };

  ensureObjectRequirements(plan);
  const bambooTrees = plan.objectRequirements[bamboo.name].filter(
    (requirement) => requirement.category === "tree",
  );
  const sakuraTrees = plan.objectRequirements[sakura.name].filter(
    (requirement) => requirement.category === "tree",
  );
  assert.equal(
    plan.objectRequirements[bamboo.name].some((item) => item.category === "palm"),
    false,
  );
  assert.equal(bambooTrees.length, 1);
  assert.match(bambooTrees[0].appearance, /segmented bamboo/i);
  assert.equal(sakuraTrees.length, 1);
  assert.match(sakuraTrees[0].appearance, /branching.*pale-pink blossom/i);
});

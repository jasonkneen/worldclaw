import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeNamedTerrainRegions,
  planTerrainAssets,
  refineTerrainHeights,
} from "../src/lib/worldclaw/terrain.ts";

test("island scatter cannot overwrite model-authored forest or settlement species", () => {
  const assets = planTerrainAssets({ theme: "island" });
  const genericTree = assets.find((asset) => asset.kind === "tree");

  assert.ok(genericTree, "island terrain should retain limited generic shoreline dressing");
  assert.deepEqual(genericTree.categoryAffinity, ["beach", "grass"]);
  assert.ok(genericTree.density <= 0.45);
  assert.equal(genericTree.categoryAffinity.includes("forest"), false);
  assert.equal(genericTree.categoryAffinity.includes("settlement"), false);
});

function region(overrides = {}) {
  return {
    id: "r0",
    name: "Test Region",
    category: "grass",
    center: [0.5, 0.5],
    radius: 0.32,
    role: "test",
    baseElevation: 1,
    roughness: 0.1,
    peakStrength: 0,
    color: "#67834f",
    ...overrides,
  };
}

function planFor(testRegion) {
  return {
    prompt: "regional terrain construction fixture",
    sceneType: "fixture",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear",
    regions: [testRegion],
    terrainAssets: [],
    objectRequirements: { [testRegion.name]: [] },
    spatialNotes: [],
    mainObjects: [],
    visualContract: {
      source: "test",
      terrainReliefScale: 1,
      terrainMicroDetailScale: 1,
      vegetationDensityScale: 1,
      objectDensityScale: 1,
      waterLevelMeters: -0.25,
      palette: [],
      dominantSilhouettes: [],
      compositionNotes: [],
      cameras: [],
    },
  };
}

function terrainField(resolution = 65, worldSize = 64, valueAt = () => 1) {
  const data = new Float32Array(resolution * resolution);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const wx = (x / (resolution - 1) - 0.5) * worldSize;
      const wz = (y / (resolution - 1) - 0.5) * worldSize;
      data[y * resolution + x] = valueAt(wx, wz);
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

function fieldValue(field, x, y) {
  return field.data[y * field.resolution + x];
}

test("named bamboo terrain becomes six bounded geometric terrace levels", () => {
  const bamboo = region({
    name: "Terraced Bamboo Forest",
    category: "forest",
    role: "stepped bamboo terraces on inland slopes",
  });
  const field = terrainField();
  const refined = refineTerrainHeights(field, planFor(bamboo));
  const y = 32;
  const samples = [32, 38, 44, 49, 52].map((x) => fieldValue(refined, x, y));
  assert.ok(samples[0] > samples.at(-1) + 1.3, "terraces need visible center-to-edge relief");
  assert.ok(
    new Set(samples.map((height) => Math.round(height * 5) / 5)).size >= 4,
    "the height field should contain multiple discrete retaining levels",
  );
  assert.deepEqual(
    Array.from(refined.data),
    Array.from(refineTerrainHeights(field, planFor(bamboo)).data),
  );
});

test("a small named bamboo component expands into broad connected terrace bands", () => {
  const grass = region({
    id: "grass",
    name: "Inland Grass",
    category: "grass",
    center: [0.5, 0.5],
    radius: 0.45,
    role: "dry island interior",
  });
  const bamboo = region({
    id: "bamboo",
    name: "BambooTerraces",
    category: "forest",
    center: [0.42, 0.5],
    radius: 0.06,
    role: "broad stepped bamboo terrace slopes",
  });
  const town = region({
    id: "town",
    name: "SouthernTown",
    category: "settlement",
    center: [0.76, 0.5],
    radius: 0.1,
    role: "organized southern town",
  });
  const plan = {
    ...planFor(bamboo),
    regions: [grass, bamboo, town],
    objectRequirements: {
      [grass.name]: [],
      [bamboo.name]: [{ category: "tree", count: 24, appearance: "bamboo culms" }],
      [town.name]: [{ category: "building", count: 5 }],
    },
  };
  const field = terrainField(65, 64, () => 1);
  field.regionId.fill(0);
  for (let y = 18; y <= 46; y++) {
    for (let x = 16; x <= 23; x++) field.regionId[y * field.resolution + x] = 1;
    for (let x = 31; x <= 38; x++) field.regionId[y * field.resolution + x] = 1;
  }
  for (let y = 24; y <= 40; y++) {
    for (let x = 45; x <= 55; x++) field.regionId[y * field.resolution + x] = 2;
  }

  const refined = refineTerrainHeights(field, plan);
  const middleBand = [];
  for (let x = 16; x <= 38; x++) {
    const index = 32 * field.resolution + x;
    middleBand.push(refined.data[index]);
    assert.equal(refined.regionId[index], 1, "generic dry gaps should join the terrace system");
  }
  assert.ok(
    new Set(middleBand.map((height) => Math.round(height * 4) / 4)).size >= 4,
    "the connected broad footprint must retain several readable terrace levels",
  );
  assert.equal(refined.regionId[32 * field.resolution + 50], 2);
});

test("named terrain semantics recover dry bamboo and basalt material categories", () => {
  const bamboo = region({
    id: "bamboo",
    name: "BambooTerraces",
    category: "grass",
    role: "stepped bamboo hillside",
    color: "#aaaa88",
  });
  const ridge = region({
    id: "ridge",
    name: "VolcanicRidge",
    category: "beach",
    role: "dark basalt spine",
    color: "#ddddbb",
  });
  const ocean = region({
    id: "ocean",
    name: "Volcanic Ocean",
    category: "ocean",
    role: "surrounding water",
    color: "#1e5aa0",
  });
  const plan = { ...planFor(bamboo), regions: [bamboo, ridge, ocean] };

  normalizeNamedTerrainRegions(plan);

  assert.equal(bamboo.category, "forest");
  assert.equal(bamboo.color, "#315c2b");
  assert.equal(ridge.category, "rock");
  assert.equal(ridge.color, "#343238");
  assert.equal(ocean.category, "ocean", "named semantics must never rewrite water");
});

test("structural region anchoring expands only across dry cells and preserves the shoreline mask", () => {
  const ocean = region({
    id: "ocean",
    name: "Outer Ocean",
    category: "ocean",
    center: [0.15, 0.5],
    radius: 0.35,
    role: "surrounding water",
  });
  const bamboo = region({
    id: "bamboo",
    name: "BambooTerraces",
    category: "forest",
    center: [0.68, 0.5],
    radius: 0.24,
    role: "stepped bamboo hillside",
  });
  const grass = region({
    id: "grass",
    name: "Inland Grass",
    category: "grass",
    center: [0.72, 0.5],
    radius: 0.4,
    role: "dry island interior",
  });
  const plan = { ...planFor(bamboo), regions: [ocean, bamboo, grass] };
  const field = terrainField(65, 64, (x) => (x < 0 ? -1.2 : 1));
  for (let y = 0; y < field.resolution; y++) {
    for (let x = 0; x < field.resolution; x++) {
      field.regionId[y * field.resolution + x] = x < 32 ? 0 : 2;
    }
  }

  const refined = refineTerrainHeights(field, plan);
  let reassignedDryCells = 0;
  for (let index = 0; index < field.regionId.length; index++) {
    if (field.regionId[index] === 0) {
      assert.equal(refined.regionId[index], 0);
      assert.ok(refined.data[index] <= -0.63);
    } else if (refined.regionId[index] === 1) {
      reassignedDryCells++;
    }
  }
  assert.ok(reassignedDryCells > 100, "the named terrace radius should reclaim dry semantic noise");
});

test("named volcanic ridge produces an elongated high silhouette instead of a flat color patch", () => {
  const ridge = region({
    name: "Volcanic Rock Ridge",
    category: "rock",
    role: "dark basalt cliff spine in the northeast",
    roughness: 0.5,
    peakStrength: 0.7,
  });
  const field = terrainField(65, 64, (x, z) => 0.9 + Math.sin(x * 0.2 + z * 0.17) * 0.08);
  const refined = refineTerrainHeights(field, planFor(ridge));
  const heights = Array.from(refined.data);
  const maximum = Math.max(...heights);
  const minimum = Math.min(...heights);
  const highCells = heights.filter((height) => height > 3.2).length;

  assert.ok(maximum - minimum > 3, "ridge spine needs a strong oblique silhouette");
  assert.ok(highCells > 12, "ridge must extend across multiple cells rather than form one spike");
  assert.ok(highCells < heights.length * 0.2, "ridge relief must stay bounded to its named region");
});

test("a named ridge reunites aligned generic rock segments without consuming an authored town", () => {
  const grass = region({ id: "grass", name: "Inland Grass", radius: 0.5 });
  const ridge = region({
    id: "ridge",
    name: "VolcanicRidge",
    category: "rock",
    center: [0.5, 0.5],
    radius: 0.06,
    role: "elongated dark basalt ridge backbone",
  });
  const rockNorth = region({
    id: "rock-north",
    name: "Rock 1",
    category: "rock",
    center: [0.5, 0.22],
    radius: 0.07,
    role: "rock",
  });
  const rockSouth = region({
    id: "rock-south",
    name: "Rock 3",
    category: "rock",
    center: [0.5, 0.78],
    radius: 0.07,
    role: "rock",
  });
  const falseSettlement = region({
    id: "false-settlement",
    name: "Settlement 2",
    category: "settlement",
    center: [0.5, 0.36],
    radius: 0.06,
    role: "settlement",
  });
  const authoredTown = region({
    id: "town",
    name: "NorthernTown",
    category: "settlement",
    center: [0.2, 0.5],
    radius: 0.1,
    role: "organized northern coastal town",
  });
  const plan = {
    ...planFor(ridge),
    regions: [grass, ridge, rockNorth, rockSouth, falseSettlement, authoredTown],
    objectRequirements: {
      [grass.name]: [],
      [ridge.name]: [],
      [rockNorth.name]: [],
      [rockSouth.name]: [],
      [falseSettlement.name]: [],
      [authoredTown.name]: [{ category: "building", count: 4 }],
    },
  };
  const field = terrainField(65, 64, () => 1);
  field.regionId.fill(0);
  for (let y = 8; y <= 20; y++) {
    for (let x = 29; x <= 35; x++) field.regionId[y * field.resolution + x] = 2;
  }
  for (let y = 27; y <= 37; y++) {
    for (let x = 29; x <= 35; x++) field.regionId[y * field.resolution + x] = 1;
  }
  for (let y = 44; y <= 56; y++) {
    for (let x = 29; x <= 35; x++) field.regionId[y * field.resolution + x] = 3;
  }
  for (let y = 21; y <= 26; y++) {
    for (let x = 29; x <= 35; x++) field.regionId[y * field.resolution + x] = 4;
  }
  for (let y = 25; y <= 40; y++) {
    for (let x = 8; x <= 18; x++) field.regionId[y * field.resolution + x] = 5;
  }

  const refined = refineTerrainHeights(field, plan);

  for (const y of [14, 23, 32, 49]) {
    assert.equal(refined.regionId[y * field.resolution + 32], 1);
    assert.ok(refined.data[y * field.resolution + 32] > 2.5);
  }
  assert.equal(
    refined.regionId[32 * field.resolution + 13],
    5,
    "an authored settlement footprint must not be absorbed into the ridge",
  );
});

test("a named town reclaims adjacent generic roof blocks without stealing water or another town", () => {
  const ocean = region({
    id: "ocean",
    name: "Outer Ocean",
    category: "ocean",
    role: "surrounding water",
  });
  const east = region({
    id: "east",
    name: "East Coastal Town",
    category: "settlement",
    center: [0.66, 0.5],
    radius: 0.08,
    role: "organized eastern coastal town",
  });
  const generic = region({
    id: "generic",
    name: "Settlement 2",
    category: "settlement",
    center: [0.57, 0.5],
    radius: 0.06,
    role: "settlement",
  });
  const west = region({
    id: "west",
    name: "West Coastal Town",
    category: "settlement",
    center: [0.24, 0.5],
    radius: 0.1,
    role: "organized western coastal town",
  });
  const plan = {
    ...planFor(east),
    regions: [ocean, east, generic, west],
    objectRequirements: {
      [ocean.name]: [],
      [east.name]: [{ category: "building", count: 8 }],
      [generic.name]: [],
      [west.name]: [{ category: "building", count: 6 }],
    },
  };
  const field = terrainField(65, 64, () => -1.2);
  field.regionId.fill(0);
  for (let y = 25; y <= 39; y++) {
    for (let x = 40; x <= 44; x++) {
      const index = y * field.resolution + x;
      field.data[index] = 0.9;
      field.regionId[index] = 1;
    }
    for (let x = 35; x <= 39; x++) {
      const index = y * field.resolution + x;
      field.data[index] = 0.9;
      field.regionId[index] = 2;
    }
    for (let x = 12; x <= 20; x++) {
      const index = y * field.resolution + x;
      field.data[index] = 0.9;
      field.regionId[index] = 3;
    }
  }

  const refined = refineTerrainHeights(field, plan);
  let reclaimed = 0;
  for (let index = 0; index < field.regionId.length; index++) {
    if (field.regionId[index] === 0) {
      assert.equal(refined.regionId[index], 0, "town anchoring must preserve the shoreline mask");
    }
    if (field.regionId[index] === 2 && refined.regionId[index] === 1) reclaimed++;
    if (field.regionId[index] === 3) {
      assert.equal(refined.regionId[index], 3, "an authored neighboring town remains independent");
    }
  }
  assert.ok(reclaimed >= 40, "the named town should recover the adjacent generic roof component");
});

test("settlement terrain is flattened into buildable lots without changing the shoreline class", () => {
  const town = region({
    name: "South Coastal Town",
    category: "settlement",
    role: "organized town blocks at the harbor approach",
  });
  const field = terrainField(65, 64, (x, z) => 1 + Math.sin(x * 0.9) * 0.35 + Math.cos(z) * 0.25);
  const refined = refineTerrainHeights(field, planFor(town));
  const centralIndices = [];
  for (let y = 22; y <= 42; y++) {
    for (let x = 22; x <= 42; x++) centralIndices.push(y * field.resolution + x);
  }
  const spread = (values) => Math.max(...values) - Math.min(...values);
  const before = centralIndices.map((index) => field.data[index]);
  const after = centralIndices.map((index) => refined.data[index]);

  assert.ok(spread(after) < spread(before) * 0.7, "town lots should be materially flatter");
  assert.ok(Math.min(...after) > -0.09, "dry settlement cells must remain above water");
});

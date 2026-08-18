import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveRequirementCount,
  ensureRequiredObjectKinds,
  footprintsOverlapXZ,
  generateRegionalObjects,
  objectFootprintXZ,
  repairRegionalObjectCoverage,
} from "../src/lib/worldclaw/objects.ts";

function heightField(resolution, worldSize, heightAtWorld) {
  const data = new Float32Array(resolution * resolution);
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const wx = (x / (resolution - 1) - 0.5) * worldSize;
      const wz = (z / (resolution - 1) - 0.5) * worldSize;
      data[z * resolution + x] = heightAtWorld(wx, wz);
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

function planFor(region, requirements, visualContract) {
  return {
    prompt: "test composition",
    sceneType: "test",
    theme: "tropical",
    visualStyle: "stylized",
    atmosphere: "clear",
    regions: [region],
    terrainAssets: [],
    objectRequirements: { [region.name]: requirements },
    spatialNotes: [],
    mainObjects: [],
    visualContract,
  };
}

const baseRegion = {
  id: "r0",
  name: "Test Region",
  category: "settlement",
  center: [0.5, 0.5],
  radius: 0.14,
  role: "town center",
  baseElevation: 0,
  roughness: 0.1,
  peakStrength: 0,
  color: "#999999",
};

test("nominal compiled ship footprint is 9.4 by 3.6 authored meters", () => {
  const footprint = objectFootprintXZ({
    kind: "ship",
    scale: 3.2,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  assert.equal(footprint.halfX, 4.7);
  assert.equal(footprint.halfZ, 1.8);
  assert.equal(footprint.source, "compiled-prototype");

  const nearby = { ...footprint, centerZ: 4 };
  const separated = { ...footprint, centerZ: 5 };
  assert.equal(footprintsOverlapXZ(footprint, nearby, 0.6), true);
  assert.equal(footprintsOverlapXZ(footprint, separated, 0.6), false);
});

test("harbor ships use non-overlapping water positions tangent to a terrain-guided arc", () => {
  const hf = heightField(65, 64, (x) => (x > 0 ? -1.2 : 1.5));
  const region = {
    ...baseRegion,
    name: "Harbor Cove",
    category: "beach",
    role: "docking harbor",
    radius: 0.11,
  };
  const plan = planFor(region, [{ category: "ship", count: 3 }]);
  const objects = generateRegionalObjects(plan, hf, 1234);

  assert.equal(objects.length, 3);
  for (const object of objects) {
    assert.equal(object.kind, "ship");
    assert.ok(object.position[0] > 0, "terrain-guided harbor bearing should select water");
    const radialX = object.position[0];
    const radialZ = object.position[2];
    const radialLength = Math.hypot(radialX, radialZ);
    const longAxisX = Math.cos(object.rotation[1]);
    const longAxisZ = -Math.sin(object.rotation[1]);
    const radialDot = Math.abs((longAxisX * radialX + longAxisZ * radialZ) / radialLength);
    assert.ok(radialDot < 0.2, "ship long axis should follow the harbor tangent");
  }
  for (let a = 0; a < objects.length; a++) {
    for (let b = a + 1; b < objects.length; b++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(objects[a]), objectFootprintXZ(objects[b]), 1.2),
        false,
      );
    }
  }
  assert.deepEqual(objects, generateRegionalObjects(plan, hf, 1234));
});

test("settlement structures form deterministic parallel street blocks around a clear lane", () => {
  const hf = heightField(65, 64, () => 0.8);
  const plan = planFor(baseRegion, [
    { category: "hut", count: 6 },
    { category: "watchtower", count: 2 },
  ]);
  const objects = generateRegionalObjects(plan, hf, 77);

  assert.equal(objects.length, 8);
  assert.deepEqual(objects, generateRegionalObjects(plan, hf, 77));
  const distances = objects.map((object) => Math.hypot(object.position[0], object.position[2]));
  assert.ok(Math.min(...distances) >= 3.5, "the central plaza should remain clear");
  const occupiedQuadrants = new Set(
    objects.map((object) => {
      const angle = Math.atan2(object.position[2], object.position[0]);
      return Math.floor(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2));
    }),
  );
  assert.equal(occupiedQuadrants.size, 4);

  const normalizedYaws = objects.map((object) => {
    const yaw = object.rotation[1] % Math.PI;
    return yaw < 0 ? yaw + Math.PI : yaw;
  });
  assert.ok(
    Math.max(...normalizedYaws) - Math.min(...normalizedYaws) < 1e-8,
    "both building rows should share one coherent street axis",
  );

  for (let a = 0; a < objects.length; a++) {
    for (let b = a + 1; b < objects.length; b++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(objects[a]), objectFootprintXZ(objects[b]), 0.9),
        false,
      );
    }
  }
});

test("regional repair keeps two town requirements exact, separated, and inside their own footprint", () => {
  const resolution = 65;
  const worldSize = 64;
  const hf = heightField(resolution, worldSize, () => 0.8);
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      hf.regionId[z * resolution + x] = x < resolution / 2 ? 0 : 1;
    }
  }
  const northernTown = {
    ...baseRegion,
    id: "north",
    name: "NorthernTown",
    center: [0.34, 0.5],
    radius: 0.12,
    role: "organized northern coastal town",
  };
  const southernTown = {
    ...baseRegion,
    id: "south",
    name: "SouthernTown",
    center: [0.66, 0.5],
    radius: 0.12,
    role: "organized southern coastal town",
  };
  const plan = {
    ...planFor(northernTown, [{ category: "building", count: 7 }]),
    prompt: "two organized Japanese coastal towns",
    regions: [northernTown, southernTown],
    objectRequirements: {
      [northernTown.name]: [{ category: "building", count: 7 }],
      [southernTown.name]: [{ category: "building", count: 6 }],
    },
  };

  const generated = generateRegionalObjects(plan, hf, 77);
  assert.equal(generated.filter((object) => object.regionId === "north").length, 7);
  const southGenerated = generated.filter((object) => object.regionId === "south").length;
  assert.ok(
    southGenerated >= 5 && southGenerated <= 6,
    "the later town may sit just under or at its requested count before repair",
  );

  const repaired = repairRegionalObjectCoverage(plan, hf, 77, generated);
  assert.deepEqual(repaired.deficits, []);
  assert.equal(
    repaired.objects.filter((object) => object.regionId === "north" && object.kind === "building")
      .length,
    7,
  );
  assert.equal(
    repaired.objects.filter((object) => object.regionId === "south" && object.kind === "building")
      .length,
    6,
  );
  assert.ok(
    repaired.objects
      .filter((object) => object.regionId === "north" && object.kind === "building")
      .every((object) => object.position[0] <= 2.5),
    "northern buildings must remain within one building-width of their semantic half",
  );
  assert.ok(
    repaired.objects
      .filter((object) => object.regionId === "south" && object.kind === "building")
      .every((object) => object.position[0] >= -2.5),
    "southern buildings must remain within one building-width of their semantic half",
  );
  for (let left = 0; left < repaired.objects.length; left++) {
    for (let right = left + 1; right < repaired.objects.length; right++) {
      assert.equal(
        footprintsOverlapXZ(
          objectFootprintXZ(repaired.objects[left]),
          objectFootprintXZ(repaired.objects[right]),
          0.9,
        ),
        false,
      );
    }
  }
  assert.deepEqual(repaired, repairRegionalObjectCoverage(plan, hf, 77, generated));
  assert.deepEqual(
    ensureRequiredObjectKinds(plan, hf, 77, repaired.objects, new Map([["building", 13]])),
    repaired.objects,
    "aggregate rescue must have nothing left to relocate globally",
  );
});

test("regional repair reports a physical town deficit instead of relocating it", () => {
  const hf = heightField(65, 64, () => -1.2);
  const plan = planFor(baseRegion, [{ category: "building", count: 3 }]);
  const repaired = repairRegionalObjectCoverage(plan, hf, 91, []);

  assert.deepEqual(repaired.objects, []);
  assert.deepEqual(repaired.deficits, [
    {
      regionId: baseRegion.id,
      regionName: baseRegion.name,
      kind: "building",
      required: 4,
      placed: 0,
      missing: 4,
    },
  ]);
  assert.deepEqual(repaired.decisions, [
    {
      regionId: baseRegion.id,
      regionName: baseRegion.name,
      kind: "building",
      requested: 3,
      capacity: 0,
      chosen: 0,
      placed: 0,
      minimum: 4,
      exact: false,
      scaleFactor: 1,
      attempts: 0,
      rejected: { world: 0, terrain: 0, region: 0, collision: 0 },
    },
  ]);
});

test("a small quay accepts its probed building capacity for model-suggested density", () => {
  const resolution = 65;
  const worldSize = 64;
  const hf = heightField(resolution, worldSize, () => -1.2);
  for (let z = 30; z <= 34; z++) {
    for (let x = 30; x <= 34; x++) {
      const index = z * resolution + x;
      hf.data[index] = 0.8;
      hf.regionId[index] = 1;
    }
  }
  const ocean = {
    ...baseRegion,
    id: "ocean",
    name: "Outer Ocean",
    category: "ocean",
    role: "surrounding ocean",
  };
  const quay = {
    ...baseRegion,
    id: "dry-quay",
    name: "Dry Timber Quay",
    radius: 0.06,
    role: "small dry timber quay district",
  };
  const plan = {
    ...planFor(quay, []),
    prompt: "harbor with a dry timber quay",
    regions: [ocean, quay],
    objectRequirements: {
      [ocean.name]: [],
      [quay.name]: [{ category: "building", count: 8, scale: 1.2 }],
    },
  };

  const repaired = repairRegionalObjectCoverage(plan, hf, 77, []);
  assert.deepEqual(repaired.deficits, []);
  assert.equal(repaired.decisions.length, 1);
  assert.deepEqual(
    {
      requested: repaired.decisions[0].requested,
      capacity: repaired.decisions[0].capacity,
      chosen: repaired.decisions[0].chosen,
      placed: repaired.decisions[0].placed,
      minimum: repaired.decisions[0].minimum,
      exact: repaired.decisions[0].exact,
      scaleFactor: repaired.decisions[0].scaleFactor,
    },
    {
      requested: 8,
      capacity: 4,
      chosen: 4,
      placed: 4,
      minimum: 4,
      exact: false,
      scaleFactor: 0.9,
    },
  );
  assert.equal(plan.objectRequirements[quay.name][0].count, 4);
  assert.equal(repaired.objects.filter((object) => object.kind === "building").length, 4);
});

test("regional capacity never reduces an explicit user building count", () => {
  const hf = heightField(65, 64, () => -1.2);
  const plan = planFor(baseRegion, [{ category: "building", count: 5 }]);
  const repaired = repairRegionalObjectCoverage(plan, hf, 91, [], new Map([["building", 5]]));

  assert.equal(plan.objectRequirements[baseRegion.name][0].count, 5);
  assert.deepEqual(repaired.deficits, [
    {
      regionId: baseRegion.id,
      regionName: baseRegion.name,
      kind: "building",
      required: 5,
      placed: 0,
      missing: 5,
    },
  ]);
  assert.deepEqual(repaired.decisions, [
    {
      regionId: baseRegion.id,
      regionName: baseRegion.name,
      kind: "building",
      requested: 5,
      capacity: 0,
      chosen: 5,
      placed: 0,
      minimum: 5,
      exact: true,
      scaleFactor: 1,
      attempts: 10800,
      rejected: { world: 0, terrain: 10800, region: 0, collision: 0 },
    },
  ]);
});

test("small image-derived towns reconcile 9/8 suggestions to balanced physical capacity", () => {
  const resolution = 65;
  const worldSize = 64;
  const hf = heightField(resolution, worldSize, () => -1.2);
  const ocean = {
    ...baseRegion,
    id: "ocean",
    name: "Outer Ocean",
    category: "ocean",
    center: [0.5, 0.5],
    radius: 0.5,
    role: "surrounding ocean",
  };
  const north = {
    ...baseRegion,
    id: "north",
    name: "NorthCoastTown",
    center: [0.31, 0.29],
    radius: 0.09,
    role: "organized northern coastal town",
  };
  const south = {
    ...baseRegion,
    id: "south",
    name: "SouthCoastTown",
    center: [0.7, 0.72],
    radius: 0.09,
    role: "organized southern coastal town",
  };
  const paintTown = (centerX, centerZ, regionIndex) => {
    for (let z = centerZ - 4; z <= centerZ + 4; z++) {
      for (let x = centerX - 4; x <= centerX + 4; x++) {
        const index = z * resolution + x;
        hf.data[index] = 0.8;
        hf.regionId[index] = regionIndex;
      }
    }
  };
  paintTown(20, 19, 1);
  paintTown(45, 46, 2);
  const plan = {
    ...planFor(north, []),
    prompt: "two organized coastal towns",
    regions: [ocean, north, south],
    objectRequirements: {
      [ocean.name]: [],
      [north.name]: [
        { category: "building", count: 9 },
        { category: "tree", count: 8 },
        { category: "crate", count: 5 },
      ],
      [south.name]: [
        { category: "building", count: 8 },
        { category: "tree", count: 8 },
        { category: "crate", count: 5 },
      ],
    },
  };
  const generated = generateRegionalObjects(plan, hf, 77);
  const repaired = repairRegionalObjectCoverage(plan, hf, 77, generated, new Map());

  assert.deepEqual(repaired.deficits, []);
  assert.equal(repaired.decisions.length, 2);
  const northDecision = repaired.decisions.find((decision) => decision.regionId === north.id);
  const southDecision = repaired.decisions.find((decision) => decision.regionId === south.id);
  assert.ok(northDecision && southDecision);
  assert.equal(northDecision.requested, 9);
  assert.equal(southDecision.requested, 8);
  for (const decision of repaired.decisions) {
    assert.equal(decision.exact, false);
    assert.ok(decision.capacity >= 4);
    assert.ok(decision.chosen >= 4);
    assert.ok(decision.chosen <= decision.requested);
    assert.equal(decision.placed, decision.chosen);
  }
  assert.ok(
    Math.abs(northDecision.chosen / 9 - southDecision.chosen / 8) <= 0.15,
    "capacity reconciliation should retain the model's relative town density",
  );
  assert.equal(
    plan.objectRequirements[north.name].find((requirement) => requirement.category === "building")
      .count,
    northDecision.chosen,
  );
  assert.equal(
    plan.objectRequirements[south.name].find((requirement) => requirement.category === "building")
      .count,
    southDecision.chosen,
  );
  const buildings = repaired.objects.filter((object) => object.kind === "building");
  assert.equal(buildings.length, northDecision.chosen + southDecision.chosen);
  for (let left = 0; left < repaired.objects.length; left++) {
    for (let right = left + 1; right < repaired.objects.length; right++) {
      assert.equal(
        footprintsOverlapXZ(
          objectFootprintXZ(repaired.objects[left]),
          objectFootprintXZ(repaired.objects[right]),
          0.3,
        ),
        false,
      );
    }
  }
  const repeatedPlan = structuredClone(plan);
  repeatedPlan.objectRequirements[north.name][0].count = 9;
  repeatedPlan.objectRequirements[south.name][0].count = 8;
  assert.deepEqual(
    repaired,
    repairRegionalObjectCoverage(repeatedPlan, hf, 77, generated, new Map()),
  );
});

test("a fragmented town keeps the four-building street minimum with bounded readable scale", () => {
  const resolution = 65;
  const worldSize = 64;
  const hf = heightField(resolution, worldSize, () => -1.2);
  for (let z = 29; z <= 35; z++) {
    for (let x = 29; x <= 35; x++) {
      const index = z * resolution + x;
      hf.data[index] = 0.8;
      hf.regionId[index] = 1;
    }
  }
  const ocean = {
    ...baseRegion,
    id: "ocean",
    name: "Outer Ocean",
    category: "ocean",
    role: "surrounding ocean",
  };
  const town = {
    ...baseRegion,
    id: "east-town",
    name: "East Coastal Town",
    radius: 0.07,
    role: "organized eastern coastal town",
  };
  const plan = {
    ...planFor(town, []),
    prompt: "two organized coastal towns",
    regions: [ocean, town],
    objectRequirements: {
      [ocean.name]: [],
      [town.name]: [{ category: "building", count: 8, scale: 1.2 }],
    },
  };

  const repaired = repairRegionalObjectCoverage(plan, hf, 77, []);
  assert.deepEqual(repaired.deficits, []);
  assert.equal(repaired.decisions.length, 1);
  assert.equal(repaired.decisions[0].capacity, 4);
  assert.equal(repaired.decisions[0].chosen, 4);
  assert.equal(repaired.decisions[0].placed, 4);
  assert.ok(
    repaired.decisions[0].scaleFactor >= 0.9,
    "four street buildings should fit at a readable scale",
  );
  assert.ok(repaired.objects.every((object) => object.regionId === town.id));
  for (let left = 0; left < repaired.objects.length; left++) {
    for (let right = left + 1; right < repaired.objects.length; right++) {
      assert.equal(
        footprintsOverlapXZ(
          objectFootprintXZ(repaired.objects[left]),
          objectFootprintXZ(repaired.objects[right]),
          0.9,
        ),
        false,
      );
    }
  }
  const repeatedPlan = structuredClone(plan);
  repeatedPlan.objectRequirements[town.name][0].count = 8;
  assert.deepEqual(repaired, repairRegionalObjectCoverage(repeatedPlan, hf, 77, []));
});

test("reference-derived density and requirement density scale counts deterministically", () => {
  const contract = {
    source: "gemini-3.6-flash",
    terrainReliefScale: 1,
    terrainMicroDetailScale: 1,
    vegetationDensityScale: 0.5,
    objectDensityScale: 0.8,
    waterLevelMeters: -0.25,
    palette: [],
    dominantSilhouettes: [],
    compositionNotes: [],
    cameras: [],
  };
  const plan = planFor(baseRegion, [], contract);

  assert.equal(
    effectiveRequirementCount(plan, { category: "tree", count: 10, density: 0.5 }, "tree"),
    3,
  );
  assert.equal(
    effectiveRequirementCount(plan, { category: "building", count: 10, density: 0.5 }, "building"),
    4,
  );
  assert.equal(effectiveRequirementCount(plan, { category: "ship", count: 0 }, "ship"), 0);
  assert.equal(
    effectiveRequirementCount(plan, { category: "dock", count: 1, density: 2 }, "dock"),
    1,
    "global reference density must not multiply a discrete hero dock",
  );
});

test("maritime hero rescue prioritizes a named southeast harbor over the first outer ocean", () => {
  const hf = heightField(97, 96, () => -1.2);
  const outerOcean = {
    ...baseRegion,
    id: "outer",
    name: "Outer Ocean",
    category: "ocean",
    center: [0.18, 0.24],
    radius: 0.2,
    role: "open western water",
  };
  const harbor = {
    ...baseRegion,
    id: "harbor",
    name: "Southeast Fishing Harbor",
    category: "ocean",
    center: [0.72, 0.7],
    radius: 0.14,
    role: "sheltered fishing cove and separated berths",
  };
  const plan = {
    ...planFor(outerOcean, [], undefined),
    prompt: "a fishing harbor with four clearly separated boats",
    regions: [outerOcean, harbor],
    objectRequirements: {
      [outerOcean.name]: [],
      [harbor.name]: [{ category: "boat", count: 4 }],
    },
    mainObjects: ["four clearly separated boats in the fishing harbor"],
  };

  const rescued = ensureRequiredObjectKinds(plan, hf, 0x48415242, [], new Map([["boat", 4]]));
  assert.equal(rescued.length, 4);
  assert.ok(rescued.every((object) => object.regionId === harbor.id));
  const harborX = (harbor.center[0] - 0.5) * hf.worldSize;
  const harborZ = (harbor.center[1] - 0.5) * hf.worldSize;
  const outerX = (outerOcean.center[0] - 0.5) * hf.worldSize;
  const outerZ = (outerOcean.center[1] - 0.5) * hf.worldSize;
  for (const object of rescued) {
    const harborDistance = Math.hypot(object.position[0] - harborX, object.position[2] - harborZ);
    const outerDistance = Math.hypot(object.position[0] - outerX, object.position[2] - outerZ);
    assert.ok(
      harborDistance < outerDistance,
      "rescued boats must remain at the named harbor anchor",
    );
  }
  for (let a = 0; a < rescued.length; a++) {
    for (let b = a + 1; b < rescued.length; b++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(rescued[a]), objectFootprintXZ(rescued[b]), 1.2),
        false,
      );
    }
  }
  assert.deepEqual(
    rescued,
    ensureRequiredObjectKinds(plan, hf, 0x48415242, [], new Map([["boat", 4]])),
  );
});

test("four exact boats use compact separated berths in a small image-derived harbor", () => {
  const worldSize = 96;
  const harbor = {
    ...baseRegion,
    id: "selected-harbor",
    name: "Fishing Harbor",
    category: "beach",
    center: [0.5, 0.74],
    radius: 0.025,
    role: "small south-facing fishing cove with four separated boats",
  };
  const centerZ = (harbor.center[1] - 0.5) * worldSize;
  const hf = heightField(97, worldSize, (_x, z) => (z > centerZ + 0.5 ? -1.2 : 0.8));
  const plan = {
    ...planFor(harbor, [{ category: "boat", count: 4 }]),
    prompt: "a fishing harbor with exactly four clearly separated boats",
    mainObjects: ["exactly four clearly separated boats in the fishing harbor"],
  };
  const required = new Map([["boat", 4]]);
  const boats = ensureRequiredObjectKinds(plan, hf, 0x58414934, [], required);

  assert.equal(boats.length, 4);
  assert.ok(boats.every((boat) => boat.regionId === harbor.id));
  const centerX = (harbor.center[0] - 0.5) * worldSize;
  for (const boat of boats) {
    assert.ok(boat.position[2] > centerZ + 0.5, "every compact berth must remain in water");
    assert.ok(
      Math.hypot(boat.position[0] - centerX, boat.position[2] - centerZ) <= 12.6,
      "compact berths must stay inside the named small-harbor envelope",
    );
  }
  for (let left = 0; left < boats.length; left++) {
    for (let right = left + 1; right < boats.length; right++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(boats[left]), objectFootprintXZ(boats[right]), 1.2),
        false,
      );
    }
  }
  assert.deepEqual(boats, ensureRequiredObjectKinds(plan, hf, 0x58414934, [], required));
});

test("failed harbor rescue reports bounded rejection counters and authored anchor metadata", () => {
  const hf = heightField(65, 64, () => 0.8);
  const harbor = {
    ...baseRegion,
    id: "dry-harbor",
    name: "FishingHarbor",
    category: "beach",
    center: [0.5, 0.72],
    radius: 0.08,
    role: "fishing harbor",
  };
  const plan = {
    ...planFor(harbor, [{ category: "boat", count: 4 }]),
    prompt: "exactly four boats in the fishing harbor",
  };
  const telemetry = [];
  const boats = ensureRequiredObjectKinds(
    plan,
    hf,
    0x54454c45,
    [],
    new Map([["boat", 4]]),
    telemetry,
  );

  assert.deepEqual(boats, []);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].kind, "boat");
  assert.equal(telemetry[0].placed, 0);
  assert.equal(telemetry[0].authoredRegionLock, true);
  assert.equal(telemetry[0].regions.length, 1);
  const report = telemetry[0].regions[0];
  assert.deepEqual(
    {
      id: report.regionId,
      name: report.regionName,
      category: report.category,
      center: report.center,
      radius: report.radius,
    },
    {
      id: harbor.id,
      name: harbor.name,
      category: harbor.category,
      center: harbor.center,
      radius: harbor.radius,
    },
  );
  assert.equal(report.attempts, 256);
  assert.equal(
    Object.values(report.rejected).reduce((sum, count) => sum + count, 0),
    report.attempts,
  );
  assert.ok(report.rejected.terrain > 0);
});

test("hero rescue fails closed instead of moving an authored torii to another region", () => {
  const hf = heightField(65, 64, (x) => (x < 0 ? -1.2 : 0.8));
  const wetSettlement = {
    ...baseRegion,
    id: "r0",
    name: "Flooded Shrine",
    center: [0.18, 0.5],
    radius: 0.05,
  };
  const flatGrove = {
    ...baseRegion,
    id: "r1",
    name: "Flat Grove",
    category: "grass",
    center: [0.76, 0.5],
    radius: 0.12,
  };
  const plan = {
    ...planFor(wetSettlement, [{ category: "torii", count: 1 }]),
    prompt: "one torii in the Flooded Shrine",
    regions: [wetSettlement, flatGrove],
    objectRequirements: {
      [wetSettlement.name]: [{ category: "torii", count: 1 }],
      [flatGrove.name]: [],
    },
    mainObjects: ["one vermilion torii gate"],
  };
  const required = new Map([["torii", 1]]);
  const telemetry = [];
  const rescued = ensureRequiredObjectKinds(plan, hf, 99, [], required, telemetry);
  assert.deepEqual(rescued, []);
  assert.equal(telemetry[0].locationAuthority, "user-explicit");
  assert.equal(telemetry[0].relocated, false);
  assert.equal(telemetry[0].regions.length, 1);
  assert.deepEqual(rescued, ensureRequiredObjectKinds(plan, hf, 99, [], required));
});

test("a model-suggested singleton relocates only after its authored region fails preflight", () => {
  const hf = heightField(65, 64, (x) => (x < 0 ? -1.2 : 0.8));
  const flooded = {
    ...baseRegion,
    id: "flooded",
    name: "Flooded Precinct",
    center: [0.38, 0.5],
    radius: 0.05,
    role: "model-suggested pagoda precinct",
  };
  const clearing = {
    ...baseRegion,
    id: "clearing",
    name: "Dry Clearing",
    category: "grass",
    center: [0.62, 0.5],
    radius: 0.1,
    role: "open ceremonial clearing",
  };
  const plan = {
    ...planFor(flooded, [{ category: "pagoda", count: 1 }]),
    prompt: "one pagoda beside a spring grove",
    regions: [flooded, clearing],
    objectRequirements: {
      [flooded.name]: [{ category: "pagoda", count: 1 }],
      [clearing.name]: [],
    },
    mainObjects: ["one pagoda"],
  };
  const telemetry = [];
  const rescued = ensureRequiredObjectKinds(
    plan,
    hf,
    0x4d4f444c,
    [],
    new Map([["pagoda", 1]]),
    telemetry,
  );

  assert.equal(rescued.length, 1);
  assert.equal(rescued[0].regionId, clearing.id);
  assert.ok(rescued[0].position[0] > 0);
  assert.equal(telemetry[0].locationAuthority, "model-suggested");
  assert.deepEqual(telemetry[0].sourceRegionIds, [flooded.id]);
  assert.equal(telemetry[0].selectedRegionId, clearing.id);
  assert.equal(telemetry[0].relocated, true);
  assert.equal(telemetry[0].regions[0].regionId, flooded.id);
  assert.equal(telemetry[0].regions[0].placed, 0);
  assert.equal(telemetry[0].regions[1].regionId, clearing.id);
  assert.equal(telemetry[0].regions[1].placed, 1);
  assert.equal(plan.objectRequirements[flooded.name].length, 0);
  assert.equal(plan.objectRequirements[clearing.name][0].category, "pagoda");
});

test("settlement landmarks reserve their authored semantic site before ordinary buildings", () => {
  const hf = heightField(97, 96, () => 0.8);
  for (let z = 0; z < hf.resolution; z++) {
    for (let x = 0; x < hf.resolution; x++) {
      hf.regionId[z * hf.resolution + x] = x < hf.resolution / 2 ? 0 : 1;
    }
  }
  const northTown = {
    ...baseRegion,
    id: "north",
    name: "NorthCoastTown",
    center: [0.34, 0.3],
    radius: 0.16,
    role: "organized Japanese coastal town and shrine site",
  };
  const bamboo = {
    ...baseRegion,
    id: "bamboo",
    name: "BambooTerraces",
    category: "forest",
    center: [0.7, 0.58],
    radius: 0.2,
    role: "six stepped bamboo terraces",
  };
  const plan = {
    ...planFor(northTown, []),
    regions: [northTown, bamboo],
    objectRequirements: {
      [northTown.name]: [
        { category: "building", count: 9 },
        { category: "pagoda", count: 1 },
        { category: "torii", count: 1 },
      ],
      [bamboo.name]: [{ category: "tree", count: 12, appearance: "bamboo" }],
    },
    mainObjects: ["one pagoda", "one torii"],
  };
  const exact = new Map([
    ["pagoda", 1],
    ["torii", 1],
  ]);
  const generated = generateRegionalObjects(plan, hf, 0x4e4f5254, exact);
  const objects = ensureRequiredObjectKinds(plan, hf, 0x4e4f5254, generated, exact);
  for (const kind of ["pagoda", "torii"]) {
    const landmarks = objects.filter((object) => object.kind === kind);
    assert.equal(landmarks.length, 1);
    assert.equal(landmarks[0].regionId, northTown.id);
    const u = landmarks[0].position[0] / hf.worldSize + 0.5;
    const v = landmarks[0].position[2] / hf.worldSize + 0.5;
    const gridX = Math.min(
      hf.resolution - 1,
      Math.max(0, Math.round(u * (hf.resolution - 1))),
    );
    const gridZ = Math.min(
      hf.resolution - 1,
      Math.max(0, Math.round(v * (hf.resolution - 1))),
    );
    assert.equal(
      hf.regionId[gridZ * hf.resolution + gridX],
      0,
      `${kind} must remain on the northern town mask`,
    );
  }
});

test("authored bamboo and cherry vegetation cannot cross semantic region masks", () => {
  const hf = heightField(65, 64, () => 0.8);
  for (let z = 0; z < hf.resolution; z++) {
    for (let x = 0; x < hf.resolution; x++) {
      hf.regionId[z * hf.resolution + x] = x < hf.resolution / 2 ? 0 : 1;
    }
  }
  const bamboo = {
    ...baseRegion,
    id: "bamboo",
    name: "BambooTerraces",
    category: "forest",
    center: [0.45, 0.5],
    radius: 0.18,
    role: "terraced bamboo forest",
  };
  const cherry = {
    ...baseRegion,
    id: "cherry",
    name: "CherryGrove",
    category: "forest",
    center: [0.55, 0.5],
    radius: 0.18,
    role: "dense cherry grove",
  };
  const plan = {
    ...planFor(bamboo, []),
    regions: [bamboo, cherry],
    objectRequirements: {
      [bamboo.name]: [{ category: "tree", count: 16, appearance: "bamboo" }],
      [cherry.name]: [{ category: "tree", count: 16, appearance: "cherry blossom" }],
    },
  };
  const objects = generateRegionalObjects(plan, hf, 0x53414b55);
  assert.ok(objects.length >= 24, "both authored groves should retain dense coverage");
  for (const object of objects) {
    const expectedRegion = object.label.includes("bamboo") ? bamboo : cherry;
    assert.equal(object.regionId, expectedRegion.id);
    const gridX = Math.round((object.position[0] / hf.worldSize + 0.5) * (hf.resolution - 1));
    const gridZ = Math.round((object.position[2] / hf.worldSize + 0.5) * (hf.resolution - 1));
    assert.equal(
      hf.regionId[gridZ * hf.resolution + gridX],
      expectedRegion.id === bamboo.id ? 0 : 1,
      `${object.label} crossed into the other authored grove`,
    );
  }
  assert.deepEqual(objects, generateRegionalObjects(plan, hf, 0x53414b55));
});

test("hero rescue fills the exact requested count shortfall without duplicating existing heroes", () => {
  const hf = heightField(65, 64, () => 0.8);
  const plan = {
    ...planFor(baseRegion, [{ category: "torii", count: 3 }]),
    mainObjects: ["three torii gates"],
  };
  const existing = ensureRequiredObjectKinds(plan, hf, 7, [], new Map([["torii", 1]]));
  const filled = ensureRequiredObjectKinds(plan, hf, 7, existing, new Map([["torii", 3]]));
  assert.equal(filled.filter((object) => object.kind === "torii").length, 3);
  assert.equal(new Set(filled.map((object) => object.id)).size, filled.length);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureRequiredObjectKinds,
  footprintsOverlapXZ,
  generateRegionalObjects,
  objectFootprintXZ,
} from "../src/lib/worldclaw/objects.ts";
import { objectCoverage } from "../src/lib/worldclaw/pipeline.ts";
import { sampleHeight } from "../src/lib/worldclaw/terrain.ts";

test("baseline bridge proxy matches the authored 16 by 3.4 meter contract", () => {
  const footprint = objectFootprintXZ({
    kind: "bridge",
    scale: 3.5,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });

  assert.equal(footprint.source, "compiled-prototype");
  assert.equal(footprint.halfX * 2, 16);
  assert.equal(footprint.halfZ * 2, 3.4);
});

function channelHeightField(resolution = 129, worldSize = 64) {
  const data = new Float32Array(resolution * resolution);
  const regionId = new Uint8Array(resolution * resolution);
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const worldX = (x / (resolution - 1) - 0.5) * worldSize;
      const index = z * resolution + x;
      if (worldX < -6) {
        data[index] = 0.9;
        regionId[index] = 0;
      } else if (worldX > 6) {
        data[index] = 1;
        regionId[index] = 1;
      } else {
        data[index] = -1.2;
        regionId[index] = 2;
      }
    }
  }
  return { resolution, worldSize, data, regionId, source: "image_guided" };
}

function crossingPlan() {
  const region = (id, name, center) => ({
    id,
    name,
    category: "settlement",
    center,
    radius: 0.22,
    role: `${name} on one shore`,
    baseElevation: 0.9,
    roughness: 0.05,
    peakStrength: 0,
    color: "#7f8b58",
  });
  const west = region("r0", "West Town", [0.25, 0.5]);
  const east = region("r1", "East Town", [0.75, 0.5]);
  const channel = {
    ...region("r2", "Central Channel", [0.5, 0.5]),
    category: "river",
    role: "water channel separating the towns",
    baseElevation: -1.2,
  };
  return {
    prompt: "two island towns joined by one bridge across the water channel",
    sceneType: "disjoint island towns",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear",
    regions: [west, east, channel],
    terrainAssets: [],
    objectRequirements: {
      [west.name]: [
        { category: "bridge", count: 1 },
        { category: "house", count: 1 },
      ],
      [east.name]: [{ category: "house", count: 1 }],
      [channel.name]: [],
    },
    spatialNotes: [],
    mainObjects: ["one bridge"],
  };
}

test("bridge placement connects dry opposing shores across a mostly-water interior", () => {
  const hf = channelHeightField();
  const plan = crossingPlan();
  const objects = generateRegionalObjects(plan, hf, 0x42524944);
  const repeated = generateRegionalObjects(plan, hf, 0x42524944);
  const bridge = objects.find((object) => object.kind === "bridge");

  assert.ok(bridge, "a valid physical crossing should produce a bridge");
  assert.deepEqual(objects, repeated);
  const footprint = objectFootprintXZ(bridge);
  const directionX = Math.cos(footprint.yaw);
  const directionZ = -Math.sin(footprint.yaw);
  const endpointA = [
    footprint.centerX - directionX * footprint.halfX,
    footprint.centerZ - directionZ * footprint.halfX,
  ];
  const endpointB = [
    footprint.centerX + directionX * footprint.halfX,
    footprint.centerZ + directionZ * footprint.halfX,
  ];

  assert.ok(sampleHeight(hf, endpointA[0], endpointA[1]) >= 0.05);
  assert.ok(sampleHeight(hf, endpointB[0], endpointB[1]) >= 0.05);
  assert.ok(sampleHeight(hf, footprint.centerX, footprint.centerZ) <= 0.05);
  const interiorHeights = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75].map((t) =>
    sampleHeight(
      hf,
      footprint.centerX + directionX * footprint.halfX * t,
      footprint.centerZ + directionZ * footprint.halfX * t,
    ),
  );
  assert.ok(interiorHeights.filter((height) => height <= 0.05).length >= 5);
  assert.ok(Math.abs(directionX) >= 0.9, "bridge span should cross the north-south channel");
  assert.ok(footprint.halfX * 2 >= 12 && footprint.halfX * 2 <= 24);
  const cosine = Math.abs(Math.cos(footprint.yaw));
  const sine = Math.abs(Math.sin(footprint.yaw));
  const worldLimit = hf.worldSize * 0.5 * 0.96;
  assert.ok(
    Math.abs(footprint.centerX) + cosine * footprint.halfX + sine * footprint.halfZ <= worldLimit,
  );
  assert.ok(
    Math.abs(footprint.centerZ) + sine * footprint.halfX + cosine * footprint.halfZ <= worldLimit,
  );

  for (const object of objects) {
    if (object.id === bridge.id) continue;
    assert.equal(
      footprintsOverlapXZ(footprint, objectFootprintXZ(object)),
      false,
      `${bridge.id} overlaps ${object.id}`,
    );
  }
});

test("bridge generation and required-count rescue fail closed without a water crossing", () => {
  const hf = channelHeightField();
  hf.data.fill(0.9);
  const plan = crossingPlan();
  plan.objectRequirements["West Town"] = [{ category: "bridge", count: 1 }];
  plan.objectRequirements["East Town"] = [];
  let objects = generateRegionalObjects(plan, hf, 0x42524944);
  objects = ensureRequiredObjectKinds(plan, hf, 0x42524944, objects, new Map([["bridge", 1]]));
  const coverage = objectCoverage(plan, objects, new Map([["bridge", 1]]));

  assert.equal(
    objects.some((object) => object.kind === "bridge"),
    false,
  );
  assert.equal(coverage.satisfactionRatio, 0);
  assert.deepEqual(coverage.missingKinds, ["bridge"]);
  assert.deepEqual(coverage.missingHeroKinds, ["bridge"]);
});

test("required-count rescue uses the same physical crossing contract", () => {
  const hf = channelHeightField();
  const plan = crossingPlan();
  const rescued = ensureRequiredObjectKinds(plan, hf, 0x42524944, [], new Map([["bridge", 1]]));
  const repeated = ensureRequiredObjectKinds(plan, hf, 0x42524944, [], new Map([["bridge", 1]]));
  const bridge = rescued.find((object) => object.kind === "bridge");

  assert.ok(bridge);
  assert.deepEqual(rescued, repeated);
  const footprint = objectFootprintXZ(bridge);
  const directionX = Math.cos(footprint.yaw);
  const directionZ = -Math.sin(footprint.yaw);
  assert.ok(sampleHeight(hf, footprint.centerX, footprint.centerZ) <= 0.05);
  assert.ok(
    sampleHeight(
      hf,
      footprint.centerX - directionX * footprint.halfX,
      footprint.centerZ - directionZ * footprint.halfX,
    ) >= 0.05,
  );
  assert.ok(
    sampleHeight(
      hf,
      footprint.centerX + directionX * footprint.halfX,
      footprint.centerZ + directionZ * footprint.halfX,
    ) >= 0.05,
  );
});

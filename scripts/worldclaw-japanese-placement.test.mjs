import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ensureRequiredObjectKinds,
  footprintsOverlapXZ,
  generateRegionalObjects,
  objectFootprintXZ,
} from "../src/lib/worldclaw/objects.ts";
import { sampleHeight } from "../src/lib/worldclaw/terrain.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../assets/worldclaw/asset-library.json", import.meta.url), "utf8"),
);

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

function footprintCorners(footprint) {
  const cosine = Math.cos(footprint.yaw);
  const sine = Math.sin(footprint.yaw);
  const axisX = [cosine, -sine];
  const axisZ = [sine, cosine];
  const corners = [];
  for (const signX of [-1, 1]) {
    for (const signZ of [-1, 1]) {
      corners.push([
        footprint.centerX + axisX[0] * footprint.halfX * signX + axisZ[0] * footprint.halfZ * signZ,
        footprint.centerZ + axisX[1] * footprint.halfX * signX + axisZ[1] * footprint.halfZ * signZ,
      ]);
    }
  }
  return corners;
}

function assertFootprintInsideWorld(footprint, worldHalfExtent) {
  const limit = worldHalfExtent * 0.96 + 1e-8;
  for (const [x, z] of footprintCorners(footprint)) {
    assert.ok(Math.abs(x) <= limit, `footprint X ${x} escaped ${limit}`);
    assert.ok(Math.abs(z) <= limit, `footprint Z ${z} escaped ${limit}`);
  }
}

function japanesePlan() {
  const shrine = {
    id: "r0",
    name: "Hill Shrine Precinct",
    category: "settlement",
    center: [0.7, 0.46],
    radius: 0.18,
    role: "Japanese shrine plaza",
    baseElevation: 0.8,
    roughness: 0.1,
    peakStrength: 0,
    color: "#a89060",
  };
  const grove = {
    id: "r1",
    name: "Temple Grove",
    category: "grass",
    center: [0.58, 0.68],
    radius: 0.15,
    role: "secondary temple grounds",
    baseElevation: 0.8,
    roughness: 0.1,
    peakStrength: 0,
    color: "#6f9d58",
  };
  const harbor = {
    id: "r2",
    name: "Eastern Harbor Waters",
    category: "ocean",
    center: [0.2, 0.5],
    radius: 0.2,
    role: "protected harbor",
    baseElevation: -1.2,
    roughness: 0.05,
    peakStrength: 0,
    color: "#277da1",
  };
  return {
    prompt:
      "A Japanese island town with exactly two pagodas, four vermilion torii gates, and four harbor boats",
    sceneType: "Japanese island shrine harbor",
    theme: "island",
    visualStyle: "stylized",
    atmosphere: "clear coastal morning",
    regions: [shrine, grove, harbor],
    terrainAssets: [],
    objectRequirements: {
      [shrine.name]: [
        { category: "pagoda", count: 2, appearance: "three tier dark tile" },
        { category: "torii", count: 4, appearance: "Myojin vermilion" },
      ],
      [grove.name]: [],
      [harbor.name]: [{ category: "boat", count: 4 }],
    },
    spatialNotes: ["Shrine landmarks remain inland", "Boats follow the harbor arc"],
    mainObjects: [
      "exactly two pagodas",
      "exactly four vermilion torii gates",
      "exactly four harbor boats",
    ],
  };
}

function buildJapanesePlacement(plan, hf, seed) {
  const generated = generateRegionalObjects(plan, hf, seed);
  const initial = [
    ...generated.filter((object) => object.kind === "boat"),
    ...generated.filter((object) => object.kind === "pagoda").slice(0, 1),
    ...generated.filter((object) => object.kind === "torii").slice(0, 1),
  ];
  return ensureRequiredObjectKinds(
    plan,
    hf,
    seed,
    initial,
    new Map([
      ["pagoda", 2],
      ["torii", 4],
      ["boat", 4],
    ]),
  );
}

test("compiled Japanese landmark footprints follow the staged meter contract", () => {
  const scalePolicy = manifest.library.instanceScalePolicy.legacyBaseScaleByKind;
  assert.equal(scalePolicy.pagoda, 2.8);
  assert.equal(scalePolicy.torii, 2.2);
  assert.equal(manifest.aliases.pagoda, "pagoda");
  assert.equal(manifest.aliases.torii, "torii");

  const pagoda = objectFootprintXZ({
    kind: "pagoda",
    scale: scalePolicy.pagoda,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  assert.equal(pagoda.source, "compiled-prototype");
  const pagodaCollider = manifest.prototypes.pagoda.collider;
  assert.equal(pagodaCollider.type, "box");
  assert.equal(pagodaCollider.sizeMeters[0], 7.9);
  assert.equal(pagodaCollider.sizeMeters[2], 7.9);
  assert.equal(pagoda.halfX * 2, pagodaCollider.sizeMeters[0]);
  assert.equal(pagoda.halfZ * 2, pagodaCollider.sizeMeters[2]);

  const toriiCollider = manifest.prototypes.torii.collider;
  assert.equal(toriiCollider.type, "box");
  const torii = objectFootprintXZ({
    kind: "torii",
    scale: scalePolicy.torii,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  assert.equal(torii.source, "compiled-prototype");
  assert.equal(torii.halfX * 2, toriiCollider.sizeMeters[0]);
  assert.equal(torii.halfZ * 2, toriiCollider.sizeMeters[2]);
});

test("Japanese hero rescue preserves exact counts, water-only boats, and physical separation", () => {
  const hf = heightField(97, 96, (x) => (x < -5 ? -1.2 : 0.8));
  const plan = japanesePlan();
  const seed = 0x4a415041;
  const objects = buildJapanesePlacement(plan, hf, seed);

  assert.deepEqual(objects, buildJapanesePlacement(plan, hf, seed));
  assert.equal(objects.filter((object) => object.kind === "pagoda").length, 2);
  assert.equal(objects.filter((object) => object.kind === "torii").length, 4);

  const boats = objects.filter((object) => object.kind === "boat");
  assert.equal(boats.length, 4);
  for (const boat of boats) {
    const footprint = objectFootprintXZ(boat);
    for (const [x, z] of footprintCorners(footprint)) {
      assert.ok(
        sampleHeight(hf, x, z) <= 0.35,
        `boat ${boat.id} footprint escaped water at ${x}, ${z}`,
      );
    }
  }

  const worldHalfExtent = hf.worldSize * 0.5;
  for (const object of objects) {
    assertFootprintInsideWorld(objectFootprintXZ(object), worldHalfExtent);
  }
  for (let a = 0; a < objects.length; a++) {
    for (let b = a + 1; b < objects.length; b++) {
      assert.equal(
        footprintsOverlapXZ(objectFootprintXZ(objects[a]), objectFootprintXZ(objects[b])),
        false,
        `${objects[a].id} overlaps ${objects[b].id}`,
      );
    }
  }
});

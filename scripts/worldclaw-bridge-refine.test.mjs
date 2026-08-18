import assert from "node:assert/strict";
import { test } from "node:test";
import { refineScene } from "../src/lib/worldclaw/refine.ts";

const plan = {
  prompt: "two settlements joined by one bridge",
  sceneType: "channel crossing",
  theme: "island",
  visualStyle: "stylized",
  atmosphere: "clear",
  regions: [],
  terrainAssets: [],
  objectRequirements: {},
  spatialNotes: [],
  mainObjects: ["one bridge"],
};

function channelHeightField(resolution = 65, worldSize = 32) {
  const data = new Float32Array(resolution * resolution);
  for (let gridZ = 0; gridZ < resolution; gridZ++) {
    for (let gridX = 0; gridX < resolution; gridX++) {
      const worldX = (gridX / (resolution - 1) - 0.5) * worldSize;
      const worldZ = (gridZ / (resolution - 1) - 0.5) * worldSize;
      data[gridZ * resolution + gridX] = Math.abs(worldX) >= 6.5 ? 1 : -2 + worldZ * 0.12;
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

function bridgeObject() {
  return {
    id: "bridge-1",
    kind: "bridge",
    regionId: "channel",
    position: [0, 1.08, 0],
    rotation: [0.2, Math.PI / 12, -0.15],
    scale: 3.5,
    color: "#76513a",
    label: "Japanese timber bridge",
    contactScore: 0,
    refined: false,
    browserAsset: {
      prototype: "bridge",
      uri: "/worldclaw/assets/worldclaw-kit.glb",
      node: "ASSET_bridge",
      source: "blender_procedural",
      targetHeightMeters: 2.4,
      collider: {
        type: "box",
        centerMeters: [0, 1.1, 0],
        sizeMeters: [16, 2.2, 3.4],
      },
    },
  };
}

test("bridge remains level without flattening its water channel", () => {
  const heightField = channelHeightField();
  const authoredTerrain = [...heightField.data];
  const result = refineScene([bridgeObject()], heightField, plan, 42, 2);
  const bridge = result.objects[0];

  assert.equal(bridge.rotation[0], 0);
  assert.equal(bridge.rotation[1], Math.PI / 12);
  assert.equal(bridge.rotation[2], 0);
  assert.deepEqual([...heightField.data], authoredTerrain);
  assert.equal(result.report.terrainCellsDeformed, 0);
  assert.equal(result.report.terrainObjectsDeformed, 0);
  assert.equal(result.report.poseFixed, 1);
});

test("bridge contact uses its dry endpoint supports instead of the submerged interior", () => {
  const heightField = channelHeightField();
  const result = refineScene([bridgeObject()], heightField, plan, 42, 1);
  const bridge = result.objects[0];

  assert.equal(bridge.position[1], 1);
  assert.equal(bridge.contactScore, 1);
  assert.equal(result.report.maxSupportGap, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  circleIntersectsColliderXZ,
  colliderSupportPointsXZ,
  resolveCircleMovementXZ,
  worldColliderForObject,
} from "../src/lib/worldclaw/collision.ts";
import { refineScene } from "../src/lib/worldclaw/refine.ts";

function placedObject(overrides = {}) {
  return {
    id: "test-object",
    kind: "building",
    regionId: "r0",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 2.4,
    color: "#888888",
    label: "test",
    contactScore: 0,
    refined: false,
    ...overrides,
  };
}

function browserAsset(collider, prototype = "building") {
  return {
    prototype,
    uri: "/worldclaw/assets/worldclaw-kit.glb",
    node: `ASSET_${prototype}`,
    source: "blender_procedural",
    targetHeightMeters: 8,
    collider,
  };
}

function heightField(resolution, worldSize, heightAtCell) {
  const data = new Float32Array(resolution * resolution);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      data[y * resolution + x] = heightAtCell(x, y);
    }
  }
  return {
    resolution,
    worldSize,
    data,
    regionId: new Uint8Array(resolution * resolution),
    source: "procedural",
  };
}

const plan = {
  prompt: "test",
  sceneType: "test",
  theme: "custom",
  visualStyle: "stylized",
  atmosphere: "clear",
  regions: [],
  terrainAssets: [],
  objectRequirements: {},
  spatialNotes: [],
  mainObjects: [],
};

test("authored box collider applies instance scale, center offset, and yaw", () => {
  const object = placedObject({
    position: [10, 3, 20],
    rotation: [0, Math.PI / 2, 0],
    browserAsset: browserAsset({
      type: "box",
      centerMeters: [1, 2, 0],
      sizeMeters: [4, 4, 2],
    }),
  });

  const proxy = worldColliderForObject(object);
  assert.equal(proxy.source, "browser-asset");
  assert.equal(proxy.shape, "obb");
  assert.ok(Math.abs(proxy.centerX - 10) < 1e-9);
  assert.ok(Math.abs(proxy.centerZ - 19) < 1e-9);
  assert.equal(proxy.centerY, 5);
  assert.equal(proxy.bottomY, 3);
  assert.equal(proxy.topY, 7);
  assert.equal(proxy.halfWidth, 2);
  assert.equal(proxy.halfDepth, 1);

  const points = colliderSupportPointsXZ(proxy);
  assert.equal(points.length, 9);
  assert.ok(points.some(([x, z]) => Math.abs(x - 11) < 1e-9 && Math.abs(z - 17) < 1e-9));
});

test("capsule and sphere assets become finite circular XZ proxies", () => {
  const capsule = worldColliderForObject(
    placedObject({
      kind: "tree",
      scale: 1.4,
      browserAsset: browserAsset(
        {
          type: "capsule",
          centerMeters: [0, 2, 0],
          radiusMeters: 0.6,
          heightMeters: 4,
        },
        "tree",
      ),
    }),
  );
  const sphere = worldColliderForObject(
    placedObject({
      kind: "rock",
      scale: 0.8,
      browserAsset: browserAsset(
        {
          type: "sphere",
          centerMeters: [0, 1, 0],
          radiusMeters: 1.1,
        },
        "rock",
      ),
    }),
  );

  assert.equal(capsule.shape, "circle");
  assert.equal(capsule.radius, 0.6);
  assert.equal(capsule.bottomY, 0);
  assert.equal(capsule.topY, 4);
  assert.equal(sphere.shape, "circle");
  assert.equal(sphere.radius, 1.1);
  assert.ok(Math.abs(sphere.bottomY + 0.1) < 1e-9);
  assert.ok(Math.abs(sphere.topY - 2.1) < 1e-9);
});

test("circle movement pushes out, remains bounded, and slides along a yawed box", () => {
  const obstacle = worldColliderForObject(
    placedObject({
      browserAsset: browserAsset({
        type: "box",
        centerMeters: [0, 1, 0],
        sizeMeters: [2, 2, 4],
      }),
      rotation: [0, Math.PI / 8, 0],
    }),
  );

  const result = resolveCircleMovementXZ({
    start: [-4, -1.5],
    delta: [6, 3],
    radius: 0.45,
    colliders: [obstacle],
    worldHalfExtent: 6,
  });

  assert.ok(result.collidedIds.includes("test-object"));
  assert.ok(result.position.every(Number.isFinite));
  assert.ok(Math.abs(result.position[0]) <= 5.55 + 1e-9);
  assert.ok(Math.abs(result.position[1]) <= 5.55 + 1e-9);
  assert.equal(circleIntersectsColliderXZ(result.position, 0.45, obstacle), false);
  assert.deepEqual(result.unresolvedIds, []);
  assert.ok(result.position[1] > -1.5, "tangential motion should be preserved");

  const injected = resolveCircleMovementXZ({
    start: [Number.NaN, Number.POSITIVE_INFINITY],
    delta: [Number.NaN, 0],
    radius: Number.NaN,
    colliders: [obstacle],
    worldHalfExtent: Number.POSITIVE_INFINITY,
  });
  assert.ok(injected.position.every(Number.isFinite));
  assert.equal(circleIntersectsColliderXZ(injected.position, injected.radius, obstacle), false);
});

test("flat footprint contact repairs floating and penetrating placements", () => {
  for (const [startY, expectedCounter] of [
    [8, "floatingFixed"],
    [-4, "penetrationFixed"],
  ]) {
    const hf = heightField(9, 8, () => 2);
    const object = placedObject({
      position: [0, startY, 0],
      browserAsset: browserAsset({
        type: "box",
        centerMeters: [0, 1, 0],
        sizeMeters: [2, 2, 2],
      }),
    });
    const { objects, report } = refineScene([object], hf, plan, 42, 1);
    assert.equal(objects[0].position[1], 2);
    assert.equal(report[expectedCounter], 1);
    assert.equal(objects[0].contactScore, 1);
    assert.equal(report.supportSamples, 9);
    assert.equal(report.terrainCellsDeformed, 0);
  }
});

test("sloped structure contact deterministically flattens only an interior footprint", () => {
  const source = heightField(9, 8, (x) => (x - 4) * 0.55);
  const object = placedObject({
    position: [0, 0, 0],
    browserAsset: browserAsset({
      type: "box",
      centerMeters: [0, 2, 0],
      sizeMeters: [4, 4, 3],
    }),
  });

  const a = { ...source, data: new Float32Array(source.data) };
  const b = { ...source, data: new Float32Array(source.data) };
  const resultA = refineScene([object], a, plan, 99, 2);
  const resultB = refineScene([object], b, plan, 99, 2);

  assert.ok(resultA.report.maxSupportSpread > 0.45);
  assert.equal(resultA.report.terrainObjectsDeformed, 1);
  assert.ok(resultA.report.terrainCellsDeformed > 0);
  assert.deepEqual([...a.data], [...b.data]);
  assert.deepEqual(resultA, resultB);

  const res = source.resolution;
  for (let i = 0; i < res; i++) {
    assert.equal(a.data[i], source.data[i], "top border must remain authored");
    assert.equal(a.data[(res - 1) * res + i], source.data[(res - 1) * res + i]);
    assert.equal(a.data[i * res], source.data[i * res], "left border must remain authored");
    assert.equal(a.data[i * res + res - 1], source.data[i * res + res - 1]);
  }
});

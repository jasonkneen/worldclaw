import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import {
  fitLiveMapFraming,
  isLiveWalkSpawnSafe,
  LIVE_COMPILED_INSTANCE_MATERIAL_VERTEX_COLORS,
  liveDepthLuminance,
  selectLiveWalkHeading,
  stableLiveInstanceColor,
} from "../src/components/worldclaw/renderer-readiness.ts";

test("compiled live instance colors do not depend on an absent geometry color attribute", () => {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: LIVE_COMPILED_INSTANCE_MATERIAL_VERTEX_COLORS,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  const categoricalColor = new THREE.Color().fromArray(stableLiveInstanceColor("obj_70"));
  mesh.setColorAt(0, categoricalColor);

  assert.equal(geometry.getAttribute("color"), undefined);
  assert.equal(material.vertexColors, false);
  assert.ok(mesh.instanceColor, "setColorAt must create Three's instanceColor attribute");
  const storedColor = Array.from(mesh.instanceColor.array.slice(0, 3));
  categoricalColor.toArray().forEach((channel, index) => {
    assert.ok(Math.abs(storedColor[index] - channel) < 1e-6);
  });

  geometry.dispose();
  material.dispose();
});

test("live instance colors are stable, finite, non-white, and distinguish adjacent IDs", () => {
  const ids = ["surface:terrain", "surface:water", "obj_70", "obj_71"];
  const colors = ids.map(stableLiveInstanceColor);

  assert.deepEqual(stableLiveInstanceColor("obj_70"), stableLiveInstanceColor("obj_70"));
  assert.equal(
    new Set(colors.map((color) => color.map((channel) => channel.toFixed(6)).join(","))).size,
    ids.length,
  );
  for (const color of colors) {
    assert.equal(color.length, 3);
    assert.ok(color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1));
    assert.ok(
      color.some((channel) => channel < 0.95),
      `expected a categorical color, got ${color}`,
    );
  }
});

test("live depth uses a bounded linear display range instead of perspective depth packing", () => {
  const near = liveDepthLuminance(2, 2, 160);
  const middle = liveDepthLuminance(60, 2, 160);
  const far = liveDepthLuminance(160, 2, 160);

  assert.ok(near > middle && middle > far);
  assert.ok(middle > 0.45, `representative world geometry should remain readable, got ${middle}`);
  assert.ok(far >= 0.08, `far geometry should not collapse to black, got ${far}`);
  assert.equal(liveDepthLuminance(Number.POSITIVE_INFINITY, 2, 160), far);
});

test("live map framing centers and fills the finite content envelope at viewport aspect", () => {
  const frame = fitLiveMapFraming(
    { minimumX: -36, maximumX: 44, minimumZ: -50, maximumZ: 30 },
    1.44,
  );

  assert.equal(frame.centerX, 4);
  assert.equal(frame.centerZ, -10);
  assert.ok(frame.minimumVisibleX <= -36 && frame.maximumVisibleX >= 44);
  assert.ok(frame.minimumVisibleZ <= -50 && frame.maximumVisibleZ >= 30);
  assert.ok(frame.majorAxisFill >= 0.89 && frame.majorAxisFill <= 0.91);
});

test("live map fixture framing includes the real north terrain component and authored objects", () => {
  const frame = fitLiveMapFraming(
    { minimumX: -41.193, maximumX: 31.321, minimumZ: -60, maximumZ: 48.887 },
    1.44,
  );

  assert.ok(Math.abs(frame.centerX - -4.936) < 0.001);
  assert.ok(Math.abs(frame.centerZ - -5.5565) < 0.001);
  assert.ok(frame.minimumVisibleZ <= -60 && frame.maximumVisibleZ >= 48.887);
  assert.ok(frame.halfVertical * 2 < 121.1);
  assert.ok(Math.abs(frame.majorAxisFill - 0.9) < 1e-12);
});

test("live walk heading turns away from an immediate forward blocker", () => {
  const blocked = selectLiveWalkHeading([0, 0], [{ centerX: 0, centerZ: -2.25, radius: 1.5 }], {
    preferredYaw: 0,
    maximumSightlineMeters: 9,
    clearanceRadiusMeters: 0.45,
  });
  assert.ok(
    Math.abs(blocked.yaw) > Math.PI / 8,
    `expected a clear heading, got yaw ${blocked.yaw}`,
  );
  assert.ok(blocked.clearanceMeters >= 8.9);

  const open = selectLiveWalkHeading([0, 0], [], {
    preferredYaw: 0,
    maximumSightlineMeters: 9,
    clearanceRadiusMeters: 0.45,
  });
  assert.equal(open.yaw, 0);
  assert.equal(open.clearanceMeters, 9);
});

test("live walk does not label a barely pushed-out hut overlap as safe", () => {
  assert.equal(
    isLiveWalkSpawnSafe(
      {
        unresolvedColliderCount: 0,
        dryGroundAccepted: true,
        minimumColliderClearanceMeters: 0.19,
        forwardClearanceMeters: 9,
      },
      { minimumColliderClearanceMeters: 2.25, minimumForwardSightlineMeters: 7 },
    ),
    false,
  );
  assert.equal(
    isLiveWalkSpawnSafe(
      {
        unresolvedColliderCount: 0,
        dryGroundAccepted: true,
        minimumColliderClearanceMeters: 2.25,
        forwardClearanceMeters: 7,
      },
      { minimumColliderClearanceMeters: 2.25, minimumForwardSightlineMeters: 7 },
    ),
    true,
  );
});

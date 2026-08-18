import assert from "node:assert/strict";
import { test } from "node:test";
import { browserAssetInstanceScale } from "../src/lib/worldclaw/assets.ts";
import {
  WORLD_OBJECT_FIT,
  kindBaseScale,
  objectFootprintXZ,
} from "../src/lib/worldclaw/objects.ts";

test("world object fit shrinks placed buildings without changing authored meter colliders", () => {
  assert.ok(WORLD_OBJECT_FIT > 0.5 && WORLD_OBJECT_FIT < 0.8);
  assert.equal(kindBaseScale("building"), 2.4 * WORLD_OBJECT_FIT);

  const authored = objectFootprintXZ({
    kind: "building",
    scale: 2.4,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  const fitted = objectFootprintXZ({
    kind: "building",
    scale: kindBaseScale("building"),
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  assert.ok(fitted.halfX < authored.halfX * 0.8);
  assert.ok(fitted.halfZ < authored.halfZ * 0.8);
  assert.ok(Math.abs(fitted.halfX / authored.halfX - WORLD_OBJECT_FIT) < 0.001);
});

test("runtime GLB instance scale follows the smaller placed scale against the unchanged legacy base", () => {
  const visual = browserAssetInstanceScale({
    id: "obj_fit",
    kind: "building",
    regionId: "r0",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: kindBaseScale("building"),
    color: "#888",
    secondaryColor: "#444",
    label: "building",
    contactScore: 1,
    refined: false,
  });
  assert.ok(Math.abs(visual - WORLD_OBJECT_FIT) < 0.001);
});

test("hero and boat kinds shrink with the same world fit so towns do not swallow the terrain", () => {
  assert.equal(kindBaseScale("pagoda"), 2.8 * WORLD_OBJECT_FIT);
  assert.equal(kindBaseScale("boat"), 1.4 * WORLD_OBJECT_FIT);
  const boat = objectFootprintXZ({
    kind: "boat",
    scale: kindBaseScale("boat"),
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  assert.ok(boat.halfX * 2 < 7, "fitted fishing boats should be shorter than the 9.4m authored hull");
});

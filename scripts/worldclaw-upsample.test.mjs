import assert from "node:assert/strict";
import { test } from "node:test";
import { upsampleHeightField } from "../src/lib/worldclaw/upsample.ts";

function heightField(resolution, worldSize, heightAtCell, regionAtCell) {
  const data = new Float32Array(resolution * resolution);
  const regionId = new Uint8Array(resolution * resolution);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const index = y * resolution + x;
      data[index] = heightAtCell(x, y);
      regionId[index] = regionAtCell?.(x, y) ?? 0;
    }
  }
  return { resolution, worldSize, data, regionId, source: "procedural" };
}

test("factor <= 1 and malformed factors preserve the authored field", () => {
  const source = heightField(3, 12, (x, y) => x + y);
  for (const factor of [1, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
    const render = upsampleHeightField(source, factor, 9);
    assert.equal(render.resolution, source.resolution);
    assert.strictEqual(render.data, source.data);
    assert.strictEqual(render.regionId, source.regionId);
  }
});

test("upsampling preserves every source-grid height and output dimensions", () => {
  const source = heightField(4, 18, (x, y) => x * 0.75 + y * 1.25);
  const factor = 3;
  const render = upsampleHeightField(source, factor, 17, 0);

  assert.equal(render.resolution, (source.resolution - 1) * factor + 1);
  assert.equal(render.data.length, render.resolution ** 2);
  for (let y = 0; y < source.resolution; y++) {
    for (let x = 0; x < source.resolution; x++) {
      assert.ok(
        Math.abs(
          render.data[y * factor * render.resolution + x * factor] -
            source.data[y * source.resolution + x],
        ) < 1e-6,
      );
    }
  }
  assert.ok([...render.data].every(Number.isFinite));
});

test("semantic region ids use deterministic nearest-neighbour assignment", () => {
  const source = heightField(
    2,
    10,
    () => 1,
    (x, y) => y * 2 + x,
  );
  const render = upsampleHeightField(source, 2, 1, 0);
  assert.deepEqual([...render.regionId], [0, 1, 1, 2, 3, 3, 2, 3, 3]);
});

test("micro-detail is seed deterministic, finite, and contact bounded", () => {
  const source = heightField(6, 30, (x, y) => 2 + x * 0.08 + y * 0.05);
  const detailAmp = 0.06;
  const first = upsampleHeightField(source, 2, 20260811, detailAmp);
  const replay = upsampleHeightField(source, 2, 20260811, detailAmp);
  const alternate = upsampleHeightField(source, 2, 20260812, detailAmp);

  assert.deepEqual([...first.data], [...replay.data]);
  assert.ok(first.data.some((value, index) => value !== alternate.data[index]));
  assert.ok([...first.data].every(Number.isFinite));

  for (let y = 0; y < source.resolution; y++) {
    for (let x = 0; x < source.resolution; x++) {
      const gameplayHeight = source.data[y * source.resolution + x];
      const renderHeight = first.data[(y * 2) * first.resolution + x * 2];
      assert.ok(
        Math.abs(renderHeight - gameplayHeight) <= detailAmp + 1e-5,
        "render-only detail must stay within the contact tolerance",
      );
    }
  }
});

test("factor and detail caps prevent unbounded render allocations or relief", () => {
  const source = heightField(3, 12, () => 1);
  const capped = upsampleHeightField(source, 999, 3, 999);
  const baseline = upsampleHeightField(source, 4, 3, 0);
  assert.equal(capped.resolution, 9);
  for (let index = 0; index < capped.data.length; index++) {
    assert.ok(Number.isFinite(capped.data[index]));
    assert.ok(Math.abs(capped.data[index] - baseline.data[index]) <= 0.25 + 1e-5);
  }
});

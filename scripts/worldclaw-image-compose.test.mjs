import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import {
  composeHorizontalImageStrip,
  splitHorizontalImageStrip,
} from "../src/lib/worldclaw/image-compose.server.ts";

function solid(width, height, color) {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) {
    png.data.set(color, index * 4);
  }
  return { mime: "image/png", b64: PNG.sync.write(png).toString("base64") };
}

test("registered view compositor creates deterministic equal ordered panels", async () => {
  const images = [
    solid(4, 8, [255, 0, 0, 255]),
    solid(8, 4, [0, 255, 0, 255]),
    solid(6, 6, [0, 0, 255, 255]),
  ];
  const first = await composeHorizontalImageStrip(images, 64, 64);
  const second = await composeHorizontalImageStrip(images, 64, 64);
  assert.equal(first.mime, "image/png");
  assert.equal(first.width, 192);
  assert.equal(first.height, 64);
  assert.equal(first.b64, second.b64);

  const png = PNG.sync.read(Buffer.from(first.b64, "base64"));
  const pixel = (x, y) => [
    ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4),
  ];
  assert.deepEqual(pixel(20, 20), [255, 0, 0, 255]);
  assert.deepEqual(pixel(84, 20), [0, 255, 0, 255]);
  assert.deepEqual(pixel(148, 20), [0, 0, 255, 255]);
});

test("provider contact sheets split into deterministic registered panels", async () => {
  const sheet = await composeHorizontalImageStrip(
    [
      solid(64, 64, [240, 10, 10, 255]),
      solid(64, 64, [10, 240, 10, 255]),
      solid(64, 64, [10, 10, 240, 255]),
    ],
    64,
    64,
  );
  const panels = await splitHorizontalImageStrip(sheet, 3, 64);
  assert.equal(panels.length, 3);
  const centerPixel = (panel) => {
    const png = PNG.sync.read(Buffer.from(panel.b64, "base64"));
    return [...png.data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)];
  };
  assert.deepEqual(centerPixel(panels[0]), [240, 10, 10, 255]);
  assert.deepEqual(centerPixel(panels[1]), [10, 240, 10, 255]);
  assert.deepEqual(centerPixel(panels[2]), [10, 10, 240, 255]);
});

test("registered view compositor rejects invalid counts, dimensions, and payloads", async () => {
  const panel = solid(4, 4, [255, 255, 255, 255]);
  await assert.rejects(composeHorizontalImageStrip([panel]), /requires 2-6 panels/);
  await assert.rejects(composeHorizontalImageStrip([panel, panel], 32, 64), /Panel width/);
  await assert.rejects(
    composeHorizontalImageStrip([panel, { mime: "image/png", b64: "not base64!" }]),
    /inline image budget/,
  );
});

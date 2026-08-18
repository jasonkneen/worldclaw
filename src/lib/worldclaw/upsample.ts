/**
 * Render-resolution upsampling of the simulation height field.
 *
 * The pipeline authors terrain at data resolution (160² by default) so the
 * agents stay fast; the viewport upsamples with Catmull-Rom bicubic
 * interpolation plus a whisper of high-frequency detail so silhouettes and
 * slope shading render smoothly at ~2× vertex density. Gameplay sampling
 * (walk collision, object contact) keeps reading the original field — the
 * added detail amplitude is kept far below contact tolerances.
 */

import { fbm } from "./noise";
import type { HeightField } from "./types";

export interface RenderField {
  resolution: number;
  worldSize: number;
  data: Float32Array;
  regionId: Uint8Array;
}

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (3 * p1 - 3 * p2 + p0 - p3) * t3)
  );
}

/** Bicubic height lookup in source-grid coordinates. */
export function bicubicHeight(hf: HeightField, gx: number, gy: number): number {
  const { resolution, data } = hf;
  const clamp = (v: number) => Math.max(0, Math.min(resolution - 1, v));
  const x1 = Math.floor(gx);
  const y1 = Math.floor(gy);
  const fx = gx - x1;
  const fy = gy - y1;

  const rows = new Array<number>(4);
  for (let j = -1; j <= 2; j++) {
    const y = clamp(y1 + j);
    const x0 = clamp(x1 - 1);
    const xa = clamp(x1);
    const xb = clamp(x1 + 1);
    const xc = clamp(x1 + 2);
    rows[j + 1] = catmullRom(
      data[y * resolution + x0] ?? 0,
      data[y * resolution + xa] ?? 0,
      data[y * resolution + xb] ?? 0,
      data[y * resolution + xc] ?? 0,
      fx,
    );
  }
  return catmullRom(rows[0]!, rows[1]!, rows[2]!, rows[3]!, fy);
}

/**
 * Upsample a height field for rendering. Heights are bicubic; region ids use
 * nearest-neighbour so semantic boundaries stay crisp. `detailAmp` adds a
 * subtle land-only micro-relief (skipped underwater to keep shorelines clean).
 */
export function upsampleHeightField(
  hf: HeightField,
  factor: number,
  seed = 0,
  detailAmp = 0.06,
): RenderField {
  const safeFactor = Number.isFinite(factor)
    ? Math.min(4, Math.max(1, Math.floor(factor)))
    : 1;
  if (safeFactor <= 1 || hf.resolution < 2) {
    return {
      resolution: hf.resolution,
      worldSize: hf.worldSize,
      data: hf.data,
      regionId: hf.regionId,
    };
  }

  const srcRes = hf.resolution;
  const res = (srcRes - 1) * safeFactor + 1;
  const data = new Float32Array(res * res);
  const regionId = new Uint8Array(res * res);
  const toSrc = (srcRes - 1) / (res - 1);
  const safeDetailAmp = Number.isFinite(detailAmp)
    ? Math.min(0.25, Math.max(0, detailAmp))
    : 0;

  for (let y = 0; y < res; y++) {
    const gy = y * toSrc;
    const ny = Math.min(srcRes - 1, Math.round(gy));
    for (let x = 0; x < res; x++) {
      const gx = x * toSrc;
      let h = bicubicHeight(hf, gx, gy);
      if (safeDetailAmp > 0 && h > 0.12) {
        const wx = (gx / (srcRes - 1) - 0.5) * hf.worldSize;
        const wz = (gy / (srcRes - 1) - 0.5) * hf.worldSize;
        // fbm is unsigned [0,1] — recenter so the render mesh stays
        // zero-mean around the gameplay field (objects/walk sample that).
        h +=
          (fbm(wx * 0.55, wz * 0.55, seed + 977, 2, 2.1, 0.5) - 0.5) *
          2 *
          safeDetailAmp;
      }
      data[y * res + x] = h;
      regionId[y * res + x] =
        hf.regionId[ny * srcRes + Math.min(srcRes - 1, Math.round(gx))] ?? 0;
    }
  }

  return { resolution: res, worldSize: hf.worldSize, data, regionId };
}

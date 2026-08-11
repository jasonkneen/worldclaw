/** Deterministic value / fbm noise for terrain (paper eq. 6 noise terms) */

export function hash2(x: number, y: number, seed: number): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

export function valueNoise2(
  x: number,
  y: number,
  seed: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Peak / mountain geomorphic operator G_peak */
export function geomorphicPeak(
  dx: number,
  dy: number,
  radius: number,
  sharpness = 2.2,
): number {
  const d = Math.sqrt(dx * dx + dy * dy) / Math.max(radius, 1e-6);
  if (d > 1.4) return 0;
  return Math.pow(Math.max(0, 1 - d), sharpness);
}

/** Dune / ridge operator */
export function geomorphicDune(
  x: number,
  y: number,
  seed: number,
  scale: number,
): number {
  const n = fbm(x * scale, y * scale * 0.35, seed, 3, 2.1, 0.55);
  return Math.pow(Math.abs(n * 2 - 1), 1.4);
}

/** Terrace steps */
export function geomorphicTerrace(h: number, steps: number): number {
  const s = Math.max(2, steps);
  return Math.floor(h * s) / s + (h % (1 / s)) * 0.15;
}

/** Simple erosion-like smoothing weight */
export function erosionFactor(
  x: number,
  y: number,
  seed: number,
): number {
  return 0.7 + 0.3 * fbm(x * 0.8, y * 0.8, seed + 7, 3);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickSeed(prompt: string): number {
  let h = 2166136261;
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * WorldClaw server inference — real LLM planning + Imagine layout maps.
 * createServerFn entry points are client-callable; heavy deps load only in handlers.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  ObjectRequirement,
  RegionSpec,
  ScenePlan,
  SceneTheme,
  TerrainCategory,
  VisualStyle,
} from "./types";

const VALID_THEMES: SceneTheme[] = [
  "tropical",
  "canyon",
  "desert",
  "snow",
  "medieval",
  "volcanic",
  "island",
  "forest",
  "custom",
];

const VALID_CATS: TerrainCategory[] = [
  "ocean",
  "beach",
  "grass",
  "forest",
  "hill",
  "mountain",
  "rock",
  "desert",
  "sand",
  "canyon",
  "river",
  "snow",
  "ice",
  "lava",
  "road",
  "settlement",
  "cliff",
];

const CAT_COLORS: Record<TerrainCategory, string> = {
  ocean: "#1e5aa0",
  beach: "#e8d5a3",
  grass: "#5a9e4a",
  forest: "#2f6b35",
  hill: "#7ab05a",
  mountain: "#8a8a94",
  rock: "#9a9080",
  desert: "#d4b06a",
  sand: "#efd99a",
  canyon: "#c47a4a",
  river: "#3a8ab0",
  snow: "#f0f4f8",
  ice: "#c8e0f0",
  lava: "#5a2018",
  road: "#555558",
  settlement: "#a89060",
  cliff: "#6a6055",
};

const BASE_H: Record<TerrainCategory, number> = {
  ocean: -2.8,
  beach: 0.4,
  grass: 0.95,
  forest: 1.4,
  hill: 3.0,
  mountain: 7.5,
  rock: 4.0,
  desert: 0.95,
  sand: 0.75,
  canyon: 4.5,
  river: -1.0,
  snow: 1.8,
  ice: 0.1,
  lava: -1.2,
  road: 1.0,
  settlement: 1.1,
  cliff: 5.0,
};

const ROUGH: Record<TerrainCategory, number> = {
  ocean: 0.04,
  beach: 0.08,
  grass: 0.15,
  forest: 0.28,
  hill: 0.4,
  mountain: 0.75,
  rock: 0.6,
  desert: 0.22,
  sand: 0.3,
  canyon: 0.65,
  river: 0.05,
  snow: 0.35,
  ice: 0.1,
  lava: 0.25,
  road: 0.05,
  settlement: 0.08,
  cliff: 0.7,
};

interface LlmPlanRaw {
  sceneType?: string;
  theme?: string;
  visualStyle?: string;
  atmosphere?: string;
  regions?: {
    name?: string;
    category?: string;
    center?: number[];
    radius?: number;
    role?: string;
    baseElevation?: number;
    roughness?: number;
    peakStrength?: number;
  }[];
  terrainAssets?: string[];
  objectRequirements?: Record<
    string,
    { category?: string; count?: number; appearance?: string; scale?: number }[]
  >;
  spatialNotes?: string[];
  mainObjects?: string[];
  layoutPrompt?: string;
}

const PLAN_SYSTEM = `You are WorldClaw IntentAnalysisAgent + ScenePlanningAgent from the paper "WorldClaw: Agentic 3D Open-World Generation at Scale".

Convert an open-ended user prompt q into a structured scene specification P = (R, C_terrain, C_object).

Rules:
- Output ONLY valid JSON (no markdown, no commentary).
- 5–9 regions covering the full layout in normalized [0,1]x[0,1] coordinates (center + radius).
- Regions must tile the world: oceans/water at edges for islands, mountains framing valleys, etc.
- category MUST be one of: ocean, beach, grass, forest, hill, mountain, rock, desert, sand, canyon, river, snow, ice, lava, road, settlement, cliff
- theme MUST be one of: tropical, canyon, desert, snow, medieval, volcanic, island, forest, custom
- visualStyle: realistic | stylized | cartoon | game | sci-fi | fantasy
- objectRequirements keys MUST match region names exactly. Only detail-demanding regions need objects.
- object category kinds: hut, house, tower, dock, ship, tree, palm, pine, rock, boulder, cactus, vehicle, tank, building, antenna, fence, campfire, tent, bridge, statue, crystal, mine, windmill, well, crate, watchtower, satellite, bunker, boat, pagoda, torii, barn, market
- layoutPrompt: a detailed TOP-DOWN orthographic satellite map prompt for image generation of I_layout (colorful distinct terrain regions, no text/labels/UI).

JSON schema:
{
  "sceneType": string,
  "theme": string,
  "visualStyle": string,
  "atmosphere": string,
  "regions": [{"name":string,"category":string,"center":[u,v],"radius":number,"role":string,"baseElevation":number,"roughness":number,"peakStrength":number}],
  "terrainAssets": string[],
  "objectRequirements": { "RegionName": [{"category":string,"count":number,"appearance":string,"scale":number}] },
  "spatialNotes": string[],
  "mainObjects": string[],
  "layoutPrompt": string
}`;

function normalizePlan(raw: LlmPlanRaw, prompt: string): ScenePlan {
  const theme = (VALID_THEMES.includes(raw.theme as SceneTheme)
    ? raw.theme
    : "custom") as SceneTheme;

  const regions: RegionSpec[] = (raw.regions ?? []).slice(0, 12).map((r, i) => {
    let cat = (r.category ?? "grass") as TerrainCategory;
    if (!VALID_CATS.includes(cat)) cat = "grass";
    const cx = Math.min(1, Math.max(0, Number(r.center?.[0] ?? 0.5)));
    const cy = Math.min(1, Math.max(0, Number(r.center?.[1] ?? 0.5)));
    const radius = Math.min(0.55, Math.max(0.05, Number(r.radius ?? 0.15)));
    return {
      id: `r${i}`,
      name: r.name?.trim() || `Region ${i + 1}`,
      category: cat,
      center: [cx, cy],
      radius,
      role: r.role?.trim() || cat,
      baseElevation:
        typeof r.baseElevation === "number"
          ? r.baseElevation
          : (BASE_H[cat] ?? 1),
      roughness:
        typeof r.roughness === "number" ? r.roughness : (ROUGH[cat] ?? 0.2),
      peakStrength:
        typeof r.peakStrength === "number"
          ? r.peakStrength
          : cat === "mountain" || cat === "rock" || cat === "cliff"
            ? 0.7
            : 0.1,
      color: CAT_COLORS[cat],
    };
  });

  if (regions.length < 3) {
    regions.push(
      {
        id: "r0",
        name: "Ocean",
        category: "ocean",
        center: [0.2, 0.5],
        radius: 0.4,
        role: "water",
        baseElevation: -2.5,
        roughness: 0.1,
        peakStrength: 0,
        color: CAT_COLORS.ocean,
      },
      {
        id: "r1",
        name: "Land",
        category: "grass",
        center: [0.55, 0.5],
        radius: 0.28,
        role: "landmass",
        baseElevation: 1.2,
        roughness: 0.3,
        peakStrength: 0.2,
        color: CAT_COLORS.grass,
      },
      {
        id: "r2",
        name: "Settlement",
        category: "settlement",
        center: [0.55, 0.55],
        radius: 0.1,
        role: "habitation",
        baseElevation: 1.0,
        roughness: 0.15,
        peakStrength: 0.05,
        color: CAT_COLORS.settlement,
      },
    );
  }

  const objectRequirements: Record<string, ObjectRequirement[]> = {};
  for (const [k, list] of Object.entries(raw.objectRequirements ?? {})) {
    objectRequirements[k] = (list ?? [])
      .filter((o) => o.category && (o.count ?? 0) > 0)
      .map((o) => ({
        category: String(o.category),
        count: Math.min(40, Math.max(1, Number(o.count) || 1)),
        appearance: o.appearance,
        scale: o.scale,
      }));
  }

  return {
    prompt,
    sceneType: raw.sceneType?.trim() || "open world scene",
    theme,
    visualStyle: (raw.visualStyle as VisualStyle) || "stylized",
    atmosphere: raw.atmosphere?.trim() || "natural daylight",
    regions,
    terrainAssets: raw.terrainAssets ?? [],
    objectRequirements,
    spatialNotes: raw.spatialNotes ?? [],
    mainObjects: raw.mainObjects ?? [],
  };
}

function boxBlur(data: Float32Array, res: number, k: number): Float32Array {
  const kernel = new Float32Array(k).fill(1 / k);
  const pad = Math.floor(k / 2);
  const tmp = new Float32Array(res * res);
  const out = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let s = 0;
      for (let i = 0; i < k; i++) {
        const xx = Math.min(res - 1, Math.max(0, x + i - pad));
        s += data[y * res + xx]! * kernel[i]!;
      }
      tmp[y * res + x] = s;
    }
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let s = 0;
      for (let i = 0; i < k; i++) {
        const yy = Math.min(res - 1, Math.max(0, y + i - pad));
        s += tmp[yy * res + x]! * kernel[i]!;
      }
      out[y * res + x] = s;
    }
  }
  return out;
}

function classifyPixel(
  r: number,
  g: number,
  b: number,
  theme: SceneTheme,
): TerrainCategory {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const water = b > r + 8 && b > g - 8 && b > 45;
  const green = g > r + 3 && g > b && g > 40;
  const sand = r > 140 && g > 110 && b < 175 && sat < 100 && !water;
  const rockGray =
    sat < 50 && lum > 50 && lum < 200 && Math.abs(r - g) < 35 && !water;
  const settle =
    r > 40 && g < 120 && b < 110 && lum < 140 && r >= g * 0.9 && !water;
  const snow = lum > 175 && sat < 60;
  const ice = b > r && b > 115 && g > 95 && lum > 85 && lum < 220;
  const canyonRock =
    r > 90 && g < r * 0.92 && b < g * 0.92 && lum < 175 && sat > 20;
  const lava = r > 80 && g < 50 && b < 40 && lum < 100;

  if (theme === "snow") {
    if (ice) return "ice";
    if (green && lum < 120) return "forest";
    if (settle) return "settlement";
    if (snow) return "snow";
    if (rockGray || lum < 160) return "mountain";
    return "snow";
  }
  if (theme === "desert" || theme === "canyon") {
    if (settle) return "settlement";
    if (canyonRock || rockGray) return theme === "canyon" ? "canyon" : "rock";
    if (sand || (r > 150 && g > 100)) return "sand";
    if (water) return "river";
    return "desert";
  }
  if (theme === "volcanic") {
    if (lava) return "lava";
    if (rockGray || canyonRock) return "rock";
    if (settle) return "settlement";
    return "cliff";
  }
  if (water) return "ocean";
  if (settle) return "settlement";
  if (green && g > 70) return "forest";
  if (sand) return "beach";
  if (rockGray) return "rock";
  if (green) return "grass";
  return "beach";
}

function heightFromLayout(
  rgba: Uint8Array,
  width: number,
  height: number,
  theme: SceneTheme,
  targetRes: number,
  planRegions: RegionSpec[],
) {
  const side = Math.min(width, height);
  const ox = Math.floor((width - side) / 2);
  const oy = Math.floor((height - side) / 2);
  const res = targetRes;
  const cats: TerrainCategory[] = [];
  const regionId = new Uint8Array(res * res);
  const heightArr = new Float32Array(res * res);
  const lumArr = new Float32Array(res * res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const sx = ox + Math.floor((x / (res - 1)) * (side - 1));
      const sy = oy + Math.floor((y / (res - 1)) * (side - 1));
      const i = (sy * width + sx) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const cat = classifyPixel(r, g, b, theme);
      let ci = cats.indexOf(cat);
      if (ci < 0) {
        cats.push(cat);
        ci = cats.length - 1;
      }
      regionId[y * res + x] = ci;
      lumArr[y * res + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  const blur = boxBlur(lumArr, res, 7);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const idx = y * res + x;
      const cat = cats[regionId[idx]!]!;
      const lum = lumArr[idx]!;
      const detail = (lum - blur[idx]!) / 255;
      const base = BASE_H[cat] ?? 1;
      const rough = ROUGH[cat] ?? 0.2;
      let h = base;
      if (
        cat === "mountain" ||
        cat === "rock" ||
        cat === "cliff" ||
        cat === "canyon"
      ) {
        h =
          base +
          (1 - lum / 255) * 6.0 * Math.max(rough, 0.4) +
          detail * 2.8;
      } else if (cat === "ocean" || cat === "river") {
        h = base + detail * 0.2;
      } else if (cat === "ice") {
        h = base + (1 - lum / 255) * 0.9;
      } else if (cat === "settlement" || cat === "road") {
        h = base + detail * 0.12;
      } else if (cat === "forest" || cat === "grass") {
        h = base + (1 - lum / 255) * 1.5 + detail * 2.0;
      } else if (cat === "sand" || cat === "desert" || cat === "beach") {
        h = base + detail * 2.4 + (1 - lum / 255) * 1.1;
      } else if (cat === "snow") {
        h = base + (1 - lum / 255) * 6.5 + detail * 1.6;
      } else if (cat === "lava") {
        h = base + detail * 0.4;
      } else {
        h = base + detail * rough * 3;
      }
      heightArr[idx] = h;
    }
  }
  const smoothed = boxBlur(heightArr, res, 3);

  const regions: RegionSpec[] = cats.map((cat, i) => {
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (let p = 0; p < res * res; p++) {
      if (regionId[p] === i) {
        sumX += p % res;
        sumY += Math.floor(p / res);
        n++;
      }
    }
    const cx = n ? sumX / n / (res - 1) : 0.5;
    const cy = n ? sumY / n / (res - 1) : 0.5;
    const coverage = n / (res * res);
    const radius = Math.max(0.06, Math.min(0.45, Math.sqrt(coverage) * 0.6));
    const match = planRegions.find((r) => r.category === cat);
    return {
      id: `r${i}`,
      name:
        match?.name ??
        cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      category: cat,
      center: [Number(cx.toFixed(3)), Number(cy.toFixed(3))],
      radius: Number(radius.toFixed(3)),
      role: match?.role ?? cat,
      baseElevation: BASE_H[cat] ?? 1,
      roughness: ROUGH[cat] ?? 0.2,
      peakStrength:
        cat === "mountain" ||
        cat === "rock" ||
        cat === "cliff" ||
        cat === "canyon"
          ? 0.55
          : 0.1,
      color: CAT_COLORS[cat],
    };
  });

  return {
    resolution: res,
    worldSize: 120,
    height: Array.from(smoothed).map((v) => Math.round(v * 1000) / 1000),
    regionId: Array.from(regionId),
    categories: cats,
    regions,
  };
}

export const checkInferenceAvailable = createServerFn({ method: "GET" }).handler(
  async () => {
    const { hasXaiKey } = await import("./xai.server");
    const { hasGeminiKey } = await import("./gemini.server");
    return { available: hasXaiKey() || hasGeminiKey() };
  },
);

export const planSceneWithLlm = createServerFn({ method: "POST" })
  .validator((input: { prompt: string }) => input)
  .handler(async ({ data }) => {
    const prompt = data.prompt.trim();
    if (!prompt) throw new Error("Empty prompt");

    const { hasXaiKey, xaiChat, parseJsonFromLlm } = await import(
      "./xai.server"
    );
    const { hasGeminiKey, geminiChat } = await import("./gemini.server");
    if (!hasXaiKey() && !hasGeminiKey()) {
      return {
        ok: false as const,
        error: "No inference key available (XAI_API_KEY / GEMINI_API_KEY)",
        plan: null as ScenePlan | null,
        layoutPrompt: "",
        raw: "",
        provider: "none",
      };
    }

    const user = `User prompt q:\n"""${prompt}"""\n\nProduce the complete scene specification P as JSON.`;
    // The fallback must cover unusable-but-successful responses too (empty
    // content, unparseable JSON), so each attempt parses before it counts.
    let text: string;
    let raw: LlmPlanRaw;
    let provider: string;
    try {
      if (!hasXaiKey()) throw new Error("XAI_API_KEY not available");
      text = await xaiChat({
        system: PLAN_SYSTEM,
        user,
        maxTokens: 3500,
        temperature: 0.35,
      });
      raw = parseJsonFromLlm<LlmPlanRaw>(text);
      provider = "grok-4.5";
    } catch (xaiErr) {
      if (!hasGeminiKey()) throw xaiErr;
      text = await geminiChat({
        system: PLAN_SYSTEM,
        user,
        maxTokens: 8192,
        temperature: 0.35,
      });
      raw = parseJsonFromLlm<LlmPlanRaw>(text);
      provider = process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash";
    }

    const plan = normalizePlan(raw, prompt);
    return {
      ok: true as const,
      plan,
      layoutPrompt:
        raw.layoutPrompt ||
        `Top-down orthographic satellite map of ${plan.sceneType}, ${plan.atmosphere}, distinct terrain regions, no text labels, game world map quality`,
      raw: text.slice(0, 500),
      error: null as string | null,
      provider,
    };
  });

export const generateLayoutTerrain = createServerFn({ method: "POST" })
  .validator(
    (input: {
      prompt: string;
      layoutPrompt: string;
      theme: SceneTheme;
      regions: RegionSpec[];
      quality?: boolean;
    }) => input,
  )
  .handler(async ({ data }) => {
    const { hasXaiKey, xaiImage } = await import("./xai.server");
    const { hasGeminiKey, geminiImage } = await import("./gemini.server");
    if (!hasXaiKey() && !hasGeminiKey()) {
      throw new Error("No image key available (XAI_API_KEY / GEMINI_API_KEY)");
    }

    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const layoutPrompt = [
      "Strict top-down orthographic aerial view, camera looking straight down, square composition.",
      "AAA open-world game satellite map, high contrast distinct terrain biomes, no text, no UI, no labels, no watermark.",
      data.layoutPrompt,
      `Theme: ${data.theme}. Scene: ${data.prompt.slice(0, 200)}.`,
      `Regions present: ${data.regions.map((r) => `${r.name}(${r.category})`).join(", ")}.`,
    ].join(" ");

    let b64: string;
    let mime: string;
    try {
      if (!hasXaiKey()) throw new Error("XAI_API_KEY not available");
      ({ b64, mime } = await xaiImage({
        prompt: layoutPrompt,
        quality: data.quality !== false,
      }));
    } catch (xaiErr) {
      if (!hasGeminiKey()) throw xaiErr;
      ({ b64, mime } = await geminiImage({ prompt: layoutPrompt }));
    }

    const buf = Buffer.from(b64, "base64");
    const isPng = mime.includes("png") || buf.subarray(1, 4).toString() === "PNG";

    let rgba: Uint8Array;
    let width: number;
    let height: number;
    if (isPng) {
      const { PNG } = await import("pngjs");
      const png = PNG.sync.read(buf);
      rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
      width = png.width;
      height = png.height;
    } else {
      const jpeg = await import("jpeg-js");
      const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      rgba = decoded.data as Uint8Array;
      width = decoded.width;
      height = decoded.height;
    }

    const ext = isPng ? "png" : "jpg";
    const dir = join(process.cwd(), "public", "worldclaw", "layouts", "gen");
    await mkdir(dir, { recursive: true });
    const slug = `${data.theme}_${Date.now().toString(36)}`;
    await writeFile(join(dir, `${slug}.${ext}`), buf);

    const terrain = heightFromLayout(
      rgba,
      width,
      height,
      data.theme,
      256,
      data.regions,
    );

    return {
      ...terrain,
      layoutImageDataUrl: `data:${isPng ? "image/png" : "image/jpeg"};base64,${b64}`,
      layoutImageUrl: `/worldclaw/layouts/gen/${slug}.${ext}`,
      sourcePixels: width * height,
    };
  });

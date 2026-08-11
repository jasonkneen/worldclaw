/**
 * Stage 1 — Intent Analysis & Scene Planning (paper §2.1)
 * Extracts explicit constraints, then completes a structured scene specification P.
 */

import { REGION_LAYOUT_COLORS } from "./materials";
import type {
  ObjectRequirement,
  RegionSpec,
  ScenePlan,
  SceneTheme,
  TerrainCategory,
  VisualStyle,
} from "./types";

interface ThemeTemplate {
  theme: SceneTheme;
  sceneType: string;
  visualStyle: VisualStyle;
  atmosphere: string;
  keywords: string[];
  regions: Omit<RegionSpec, "id" | "color">[];
  terrainAssets: string[];
  objects: Record<string, ObjectRequirement[]>;
  mainObjects: string[];
  spatialNotes: string[];
}

const TEMPLATES: ThemeTemplate[] = [
  {
    theme: "tropical",
    sceneType: "tropical island stronghold",
    visualStyle: "stylized",
    atmosphere: "warm humid sea breeze, bright sun, adventure",
    keywords: [
      "pirate",
      "tropical",
      "island",
      "one piece",
      "coastal",
      "palm",
      "dock",
      "ship",
    ],
    regions: [
      { name: "Open Ocean", category: "ocean", center: [0.15, 0.5], radius: 0.42, role: "water body", baseElevation: -2.5, roughness: 0.15, peakStrength: 0 },
      { name: "Southern Sea", category: "ocean", center: [0.85, 0.55], radius: 0.38, role: "water body", baseElevation: -2.2, roughness: 0.12, peakStrength: 0 },
      { name: "Sandy Beach", category: "beach", center: [0.42, 0.55], radius: 0.22, role: "shoreline", baseElevation: 0.4, roughness: 0.2, peakStrength: 0.05 },
      { name: "Jungle Interior", category: "forest", center: [0.48, 0.42], radius: 0.18, role: "dense vegetation", baseElevation: 1.2, roughness: 0.45, peakStrength: 0.2 },
      { name: "Pirate Settlement", category: "settlement", center: [0.52, 0.58], radius: 0.12, role: "habitation", baseElevation: 0.8, roughness: 0.2, peakStrength: 0.05 },
      { name: "Rocky Ridge", category: "rock", center: [0.62, 0.35], radius: 0.14, role: "lookout ridge", baseElevation: 3.5, roughness: 0.55, peakStrength: 0.7 },
      { name: "Harbor Cove", category: "beach", center: [0.38, 0.68], radius: 0.1, role: "docking", baseElevation: 0.2, roughness: 0.15, peakStrength: 0 },
    ],
    terrainAssets: ["palm clusters", "coastal rocks", "driftwood"],
    objects: {
      "Pirate Settlement": [
        { category: "hut", count: 6, appearance: "thatch roofs" },
        { category: "watchtower", count: 2 },
        { category: "crate", count: 8 },
        { category: "campfire", count: 2 },
      ],
      "Harbor Cove": [
        { category: "dock", count: 2 },
        { category: "ship", count: 2, scale: 1.4 },
        { category: "boat", count: 3 },
      ],
      "Jungle Interior": [
        { category: "palm", count: 28 },
        { category: "tree", count: 12 },
        { category: "rock", count: 10 },
      ],
      "Rocky Ridge": [
        { category: "boulder", count: 8 },
        { category: "watchtower", count: 1 },
      ],
      "Sandy Beach": [
        { category: "palm", count: 14 },
        { category: "rock", count: 6 },
      ],
    },
    mainObjects: ["ships", "huts", "palms", "docks"],
    spatialNotes: [
      "Island surrounded by ocean",
      "Settlement inland from harbor",
      "Ridge overlooks bay",
    ],
  },
  {
    theme: "canyon",
    sceneType: "river canyon with tribal settlements",
    visualStyle: "stylized",
    atmosphere: "dry warm air, layered cliffs, river mist",
    keywords: ["canyon", "river", "tribal", "cliff", "valley", "primitive"],
    regions: [
      { name: "River Corridor", category: "river", center: [0.5, 0.5], radius: 0.12, role: "water artery", baseElevation: -1.5, roughness: 0.1, peakStrength: 0 },
      { name: "Valley Floor", category: "grass", center: [0.48, 0.42], radius: 0.16, role: "fertile flats", baseElevation: 0.5, roughness: 0.25, peakStrength: 0.05 },
      { name: "West Cliffs", category: "canyon", center: [0.22, 0.5], radius: 0.22, role: "canyon wall", baseElevation: 5.5, roughness: 0.5, peakStrength: 0.55 },
      { name: "East Cliffs", category: "canyon", center: [0.78, 0.48], radius: 0.2, role: "canyon wall", baseElevation: 5.2, roughness: 0.48, peakStrength: 0.5 },
      { name: "North Mesa", category: "rock", center: [0.5, 0.18], radius: 0.16, role: "high plateau", baseElevation: 4.0, roughness: 0.4, peakStrength: 0.35 },
      { name: "Tribal Village A", category: "settlement", center: [0.38, 0.55], radius: 0.09, role: "habitation", baseElevation: 0.8, roughness: 0.15, peakStrength: 0 },
      { name: "Tribal Village B", category: "settlement", center: [0.62, 0.38], radius: 0.08, role: "habitation", baseElevation: 1.0, roughness: 0.15, peakStrength: 0 },
      { name: "Riverbank Woods", category: "forest", center: [0.52, 0.62], radius: 0.11, role: "vegetation", baseElevation: 0.6, roughness: 0.35, peakStrength: 0.1 },
    ],
    terrainAssets: ["canyon rocks", "scrub brush", "river stones"],
    objects: {
      "Tribal Village A": [
        { category: "hut", count: 7 },
        { category: "campfire", count: 2 },
        { category: "totem" as unknown as string, count: 0 },
        { category: "well", count: 1 },
        { category: "fence", count: 4 },
      ],
      "Tribal Village B": [
        { category: "hut", count: 5 },
        { category: "watchtower", count: 1 },
        { category: "crate", count: 4 },
      ],
      "Riverbank Woods": [
        { category: "tree", count: 18 },
        { category: "rock", count: 8 },
      ],
      "West Cliffs": [
        { category: "boulder", count: 12 },
        { category: "rock", count: 10 },
      ],
      "Valley Floor": [
        { category: "tree", count: 8 },
        { category: "bridge", count: 1 },
      ],
    },
    mainObjects: ["huts", "cliffs", "river", "bridges"],
    spatialNotes: [
      "River cuts continuous canyon axis",
      "Villages on valley terraces",
      "Cliffs frame both sides",
    ],
  },
  {
    theme: "desert",
    sceneType: "desert battlefield",
    visualStyle: "game",
    atmosphere: "harsh sun, dust haze, open combat sightlines",
    keywords: ["desert", "battlefield", "pubg", "pvp", "compound", "sandy", "arid"],
    regions: [
      { name: "Open Dunes", category: "sand", center: [0.5, 0.5], radius: 0.28, role: "combat flats", baseElevation: 0.6, roughness: 0.35, peakStrength: 0.15 },
      { name: "North Ridges", category: "rock", center: [0.45, 0.18], radius: 0.18, role: "high ground", baseElevation: 4.5, roughness: 0.55, peakStrength: 0.65 },
      { name: "South Mesa", category: "desert", center: [0.55, 0.82], radius: 0.16, role: "plateau", baseElevation: 3.2, roughness: 0.4, peakStrength: 0.4 },
      { name: "West Compound", category: "settlement", center: [0.22, 0.48], radius: 0.1, role: "fortified base", baseElevation: 1.0, roughness: 0.15, peakStrength: 0 },
      { name: "East Compound", category: "settlement", center: [0.78, 0.52], radius: 0.1, role: "fortified base", baseElevation: 1.1, roughness: 0.15, peakStrength: 0 },
      { name: "Central Ruin", category: "road", center: [0.5, 0.48], radius: 0.08, role: "contested zone", baseElevation: 0.9, roughness: 0.2, peakStrength: 0.05 },
      { name: "Rocky Scree", category: "cliff", center: [0.3, 0.28], radius: 0.12, role: "cover terrain", baseElevation: 2.8, roughness: 0.5, peakStrength: 0.45 },
    ],
    terrainAssets: ["boulders", "wreckage piles", "cacti"],
    objects: {
      "West Compound": [
        { category: "building", count: 5 },
        { category: "bunker", count: 2 },
        { category: "watchtower", count: 2 },
        { category: "vehicle", count: 3 },
        { category: "crate", count: 10 },
      ],
      "East Compound": [
        { category: "building", count: 4 },
        { category: "antenna", count: 1 },
        { category: "tank", count: 2 },
        { category: "crate", count: 8 },
      ],
      "Central Ruin": [
        { category: "building", count: 3 },
        { category: "crate", count: 6 },
        { category: "vehicle", count: 2 },
      ],
      "Open Dunes": [
        { category: "cactus", count: 16 },
        { category: "rock", count: 14 },
        { category: "vehicle", count: 2 },
      ],
      "North Ridges": [
        { category: "boulder", count: 12 },
        { category: "watchtower", count: 1 },
      ],
    },
    mainObjects: ["compounds", "vehicles", "bunkers", "cacti"],
    spatialNotes: [
      "Open combat area between compounds",
      "Ridges provide elevation advantage",
      "Roads connect compounds",
    ],
  },
  {
    theme: "snow",
    sceneType: "snow mountain valley with high-tech facilities",
    visualStyle: "sci-fi",
    atmosphere: "cold overcast light, snow glare, industrial outposts",
    keywords: [
      "snow",
      "mountain",
      "winter",
      "red alert",
      "command",
      "conquer",
      "futuristic",
      "high-tech",
      "valley",
    ],
    regions: [
      { name: "Enclosing Peaks N", category: "mountain", center: [0.5, 0.12], radius: 0.22, role: "mountain wall", baseElevation: 7.5, roughness: 0.55, peakStrength: 0.85 },
      { name: "Enclosing Peaks S", category: "mountain", center: [0.5, 0.88], radius: 0.18, role: "mountain wall", baseElevation: 6.5, roughness: 0.5, peakStrength: 0.75 },
      { name: "West Ridge", category: "snow", center: [0.15, 0.5], radius: 0.18, role: "snow ridge", baseElevation: 4.5, roughness: 0.4, peakStrength: 0.45 },
      { name: "East Ridge", category: "ice", center: [0.85, 0.5], radius: 0.16, role: "ice ridge", baseElevation: 4.2, roughness: 0.35, peakStrength: 0.4 },
      { name: "Valley Floor", category: "snow", center: [0.5, 0.5], radius: 0.2, role: "facility zone", baseElevation: 1.0, roughness: 0.2, peakStrength: 0.05 },
      { name: "Command Base", category: "settlement", center: [0.42, 0.45], radius: 0.1, role: "HQ complex", baseElevation: 1.2, roughness: 0.12, peakStrength: 0 },
      { name: "Radar Outpost", category: "settlement", center: [0.62, 0.58], radius: 0.08, role: "comms", baseElevation: 1.5, roughness: 0.15, peakStrength: 0.05 },
      { name: "Frozen Stream", category: "ice", center: [0.5, 0.62], radius: 0.08, role: "ice path", baseElevation: 0.4, roughness: 0.1, peakStrength: 0 },
    ],
    terrainAssets: ["snow drifts", "ice shards", "pine clusters"],
    objects: {
      "Command Base": [
        { category: "building", count: 6, appearance: "futuristic" },
        { category: "antenna", count: 3 },
        { category: "satellite", count: 2 },
        { category: "vehicle", count: 4 },
        { category: "crate", count: 8 },
      ],
      "Radar Outpost": [
        { category: "antenna", count: 4 },
        { category: "building", count: 3 },
        { category: "tower", count: 2 },
        { category: "tank", count: 2 },
      ],
      "Valley Floor": [
        { category: "pine", count: 20 },
        { category: "rock", count: 10 },
        { category: "vehicle", count: 2 },
      ],
      "West Ridge": [
        { category: "pine", count: 12 },
        { category: "boulder", count: 8 },
      ],
      "Enclosing Peaks N": [
        { category: "boulder", count: 10 },
        { category: "rock", count: 8 },
      ],
    },
    mainObjects: ["facilities", "antennas", "vehicles", "pines"],
    spatialNotes: [
      "Valley enclosed by mountains",
      "Facilities on valley floor",
      "Radar on elevated knoll",
    ],
  },
  {
    theme: "medieval",
    sceneType: "medieval village in rolling hills",
    visualStyle: "fantasy",
    atmosphere: "soft daylight, chimney smoke, pastoral calm",
    keywords: ["medieval", "village", "castle", "fantasy", "farm", "hobbit", "windmill"],
    regions: [
      { name: "Village Green", category: "settlement", center: [0.48, 0.5], radius: 0.14, role: "town center", baseElevation: 0.8, roughness: 0.15, peakStrength: 0 },
      { name: "Farmland", category: "grass", center: [0.35, 0.62], radius: 0.16, role: "fields", baseElevation: 0.6, roughness: 0.2, peakStrength: 0.05 },
      { name: "Woodland", category: "forest", center: [0.7, 0.4], radius: 0.16, role: "timber", baseElevation: 1.2, roughness: 0.4, peakStrength: 0.2 },
      { name: "North Hills", category: "hill", center: [0.5, 0.22], radius: 0.18, role: "rolling hills", baseElevation: 2.8, roughness: 0.35, peakStrength: 0.3 },
      { name: "Stream", category: "river", center: [0.55, 0.58], radius: 0.08, role: "water", baseElevation: -0.4, roughness: 0.1, peakStrength: 0 },
      { name: "Mill Rise", category: "hill", center: [0.32, 0.4], radius: 0.1, role: "windmill hill", baseElevation: 2.2, roughness: 0.25, peakStrength: 0.25 },
      { name: "Distant Peaks", category: "mountain", center: [0.8, 0.15], radius: 0.14, role: "backdrop", baseElevation: 5.5, roughness: 0.5, peakStrength: 0.7 },
    ],
    terrainAssets: ["oaks", "stone walls", "hedgerows"],
    objects: {
      "Village Green": [
        { category: "house", count: 8 },
        { category: "market", count: 2 },
        { category: "well", count: 1 },
        { category: "barn", count: 2 },
        { category: "fence", count: 6 },
      ],
      "Mill Rise": [
        { category: "windmill", count: 1 },
        { category: "house", count: 2 },
      ],
      "Woodland": [
        { category: "tree", count: 30 },
        { category: "rock", count: 8 },
      ],
      "Farmland": [
        { category: "barn", count: 2 },
        { category: "fence", count: 8 },
        { category: "tree", count: 6 },
      ],
      "Stream": [{ category: "bridge", count: 1 }, { category: "tree", count: 4 }],
    },
    mainObjects: ["houses", "windmill", "market", "trees"],
    spatialNotes: ["Village centered on green", "Mill on western rise", "Forest east"],
  },
  {
    theme: "volcanic",
    sceneType: "volcanic demon lair",
    visualStyle: "fantasy",
    atmosphere: "ember glow, ash haze, heat shimmer",
    keywords: ["volcan", "lava", "demon", "hell", "fire", "obsidian", "infernal"],
    regions: [
      { name: "Lava Lake", category: "lava", center: [0.5, 0.55], radius: 0.16, role: "molten core", baseElevation: -1.5, roughness: 0.2, peakStrength: 0.1 },
      { name: "Obsidian Shelf", category: "rock", center: [0.42, 0.4], radius: 0.14, role: "lair platform", baseElevation: 2.0, roughness: 0.45, peakStrength: 0.3 },
      { name: "Ash Wastes", category: "desert", center: [0.55, 0.7], radius: 0.18, role: "ash flats", baseElevation: 0.5, roughness: 0.35, peakStrength: 0.15 },
      { name: "Crag Peaks", category: "mountain", center: [0.25, 0.3], radius: 0.18, role: "volcanic peaks", baseElevation: 6.5, roughness: 0.6, peakStrength: 0.9 },
      { name: "East Crags", category: "cliff", center: [0.78, 0.35], radius: 0.16, role: "cliffs", baseElevation: 5.0, roughness: 0.55, peakStrength: 0.7 },
      { name: "Ritual Circle", category: "settlement", center: [0.48, 0.42], radius: 0.09, role: "lair", baseElevation: 2.2, roughness: 0.2, peakStrength: 0.1 },
    ],
    terrainAssets: ["obsidian shards", "ash cones", "basalt pillars"],
    objects: {
      "Ritual Circle": [
        { category: "statue", count: 4 },
        { category: "tower", count: 3 },
        { category: "crystal", count: 6 },
        { category: "campfire", count: 4 },
      ],
      "Obsidian Shelf": [
        { category: "boulder", count: 10 },
        { category: "crystal", count: 5 },
        { category: "rock", count: 8 },
      ],
      "Ash Wastes": [
        { category: "rock", count: 16 },
        { category: "boulder", count: 8 },
      ],
      "Crag Peaks": [{ category: "boulder", count: 12 }],
    },
    mainObjects: ["statues", "crystals", "lava", "towers"],
    spatialNotes: ["Lava at center low", "Lair on elevated shelf", "Peaks rim the crater"],
  },
  {
    theme: "island",
    sceneType: "japanese-style island towns",
    visualStyle: "stylized",
    atmosphere: "soft mist, cherry dusk light, calm sea",
    keywords: ["japan", "pagoda", "torii", "zen", "asian", "oriental", "shrine"],
    regions: [
      { name: "Sea", category: "ocean", center: [0.2, 0.5], radius: 0.35, role: "water", baseElevation: -2.0, roughness: 0.12, peakStrength: 0 },
      { name: "Harbor Town", category: "settlement", center: [0.48, 0.55], radius: 0.12, role: "port town", baseElevation: 0.7, roughness: 0.15, peakStrength: 0 },
      { name: "Hill Shrine", category: "hill", center: [0.62, 0.35], radius: 0.12, role: "shrine grounds", baseElevation: 3.0, roughness: 0.3, peakStrength: 0.35 },
      { name: "Bamboo Forest", category: "forest", center: [0.55, 0.42], radius: 0.12, role: "woods", baseElevation: 1.2, roughness: 0.35, peakStrength: 0.15 },
      { name: "Beach", category: "beach", center: [0.4, 0.62], radius: 0.1, role: "shore", baseElevation: 0.3, roughness: 0.15, peakStrength: 0 },
      { name: "Inland Hills", category: "grass", center: [0.7, 0.55], radius: 0.14, role: "fields", baseElevation: 1.5, roughness: 0.25, peakStrength: 0.15 },
      { name: "Distant Peak", category: "mountain", center: [0.82, 0.25], radius: 0.12, role: "fuji-like peak", baseElevation: 6.0, roughness: 0.45, peakStrength: 0.85 },
    ],
    terrainAssets: ["pines", "stone lanterns", "coastal rocks"],
    objects: {
      "Harbor Town": [
        { category: "house", count: 7 },
        { category: "pagoda", count: 1 },
        { category: "dock", count: 2 },
        { category: "boat", count: 3 },
        { category: "market", count: 2 },
      ],
      "Hill Shrine": [
        { category: "torii", count: 3 },
        { category: "pagoda", count: 1 },
        { category: "statue", count: 2 },
        { category: "pine", count: 8 },
      ],
      "Bamboo Forest": [
        { category: "tree", count: 22 },
        { category: "pine", count: 10 },
      ],
      "Beach": [{ category: "boat", count: 2 }, { category: "rock", count: 6 }],
      "Inland Hills": [{ category: "tree", count: 10 }, { category: "house", count: 2 }],
    },
    mainObjects: ["pagoda", "torii", "harbor houses", "boats"],
    spatialNotes: ["Town by harbor", "Shrine on hill", "Peak in distance"],
  },
  {
    theme: "forest",
    sceneType: "gemstone mining valley",
    visualStyle: "fantasy",
    atmosphere: "dappled forest light, crystal glints, cool air",
    keywords: ["mine", "gem", "crystal", "mining", "ore", "quarry"],
    regions: [
      { name: "Mine Site", category: "settlement", center: [0.5, 0.48], radius: 0.12, role: "extraction", baseElevation: 1.0, roughness: 0.25, peakStrength: 0.1 },
      { name: "Crystal Veins", category: "rock", center: [0.42, 0.38], radius: 0.12, role: "ore veins", baseElevation: 2.5, roughness: 0.5, peakStrength: 0.4 },
      { name: "Forest Cover", category: "forest", center: [0.6, 0.55], radius: 0.18, role: "woods", baseElevation: 1.2, roughness: 0.4, peakStrength: 0.2 },
      { name: "Stream", category: "river", center: [0.48, 0.62], radius: 0.08, role: "runoff", baseElevation: -0.3, roughness: 0.1, peakStrength: 0 },
      { name: "Hills", category: "hill", center: [0.3, 0.55], radius: 0.14, role: "foothills", baseElevation: 2.0, roughness: 0.35, peakStrength: 0.25 },
      { name: "Peaks", category: "mountain", center: [0.7, 0.25], radius: 0.16, role: "backdrop", baseElevation: 5.5, roughness: 0.5, peakStrength: 0.7 },
    ],
    terrainAssets: ["ore carts debris", "pines", "boulders"],
    objects: {
      "Mine Site": [
        { category: "mine", count: 3 },
        { category: "building", count: 3 },
        { category: "crate", count: 10 },
        { category: "tent", count: 3 },
        { category: "campfire", count: 2 },
      ],
      "Crystal Veins": [
        { category: "crystal", count: 14 },
        { category: "boulder", count: 8 },
        { category: "rock", count: 10 },
      ],
      "Forest Cover": [
        { category: "tree", count: 28 },
        { category: "pine", count: 12 },
      ],
      "Hills": [{ category: "tree", count: 10 }, { category: "rock", count: 8 }],
    },
    mainObjects: ["crystals", "mine shafts", "camp", "forest"],
    spatialNotes: ["Mine at valley center", "Crystals on rock veins", "Forest surrounds"],
  },
];

function scoreTemplate(prompt: string, t: ThemeTemplate): number {
  const p = prompt.toLowerCase();
  let score = 0;
  for (const kw of t.keywords) {
    if (p.includes(kw)) score += 3;
  }
  // partial word hits
  for (const kw of t.keywords) {
    if (kw.length > 4 && p.includes(kw.slice(0, 4))) score += 0.5;
  }
  return score;
}

function detectStyle(prompt: string, fallback: VisualStyle): VisualStyle {
  const p = prompt.toLowerCase();
  if (/cartoon|anime|toon/.test(p)) return "cartoon";
  if (/sci-?fi|futur|high-?tech|command|red alert/.test(p)) return "sci-fi";
  if (/fantasy|magic|demon|hobbit|dragon/.test(p)) return "fantasy";
  if (/pubg|pvp|game|battlefield/.test(p)) return "game";
  if (/realistic|photo/.test(p)) return "realistic";
  if (/stylized|stylised/.test(p)) return "stylized";
  return fallback;
}

/** Intent analysis: only extract what is explicit in the prompt */
export function analyzeIntent(prompt: string): {
  explicitThemeHints: string[];
  explicitObjects: string[];
  explicitStyle: VisualStyle | null;
  sceneTypeGuess: string;
} {
  const p = prompt.toLowerCase();
  const explicitThemeHints: string[] = [];
  const allKw = TEMPLATES.flatMap((t) => t.keywords);
  for (const kw of allKw) {
    if (p.includes(kw) && !explicitThemeHints.includes(kw)) {
      explicitThemeHints.push(kw);
    }
  }
  const objectHints = [
    "ship",
    "hut",
    "house",
    "tower",
    "vehicle",
    "tank",
    "pagoda",
    "windmill",
    "dragon",
    "mine",
    "crystal",
    "bridge",
    "dock",
    "antenna",
  ];
  const explicitObjects = objectHints.filter((o) => p.includes(o));
  let explicitStyle: VisualStyle | null = null;
  if (/cartoon|anime/.test(p)) explicitStyle = "cartoon";
  else if (/sci-?fi|futur/.test(p)) explicitStyle = "sci-fi";
  else if (/fantasy|magic/.test(p)) explicitStyle = "fantasy";
  else if (/realistic/.test(p)) explicitStyle = "realistic";

  return {
    explicitThemeHints,
    explicitObjects,
    explicitStyle,
    sceneTypeGuess: prompt.slice(0, 80),
  };
}

/** Scene-level planning: complete unspecified fields into structured P */
export function planScene(prompt: string): ScenePlan {
  const intent = analyzeIntent(prompt);
  let best = TEMPLATES[0];
  let bestScore = -1;
  for (const t of TEMPLATES) {
    const s = scoreTemplate(prompt, t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  // If no keyword match, synthesize a custom blend from grass/forest/hills
  if (bestScore < 1) {
    best = TEMPLATES.find((t) => t.theme === "medieval") ?? TEMPLATES[0];
  }

  const visualStyle =
    intent.explicitStyle ?? detectStyle(prompt, best.visualStyle);

  const regions: RegionSpec[] = best.regions.map((r, i) => ({
    ...r,
    id: `r${i}`,
    color: REGION_LAYOUT_COLORS[r.category],
  }));

  // Filter invalid object categories
  const objects: Record<string, ObjectRequirement[]> = {};
  for (const [k, list] of Object.entries(best.objects)) {
    objects[k] = list.filter((o) => o.count > 0);
  }

  return {
    prompt,
    sceneType: best.sceneType,
    theme: best.theme,
    visualStyle,
    atmosphere: best.atmosphere,
    regions,
    terrainAssets: best.terrainAssets,
    objectRequirements: objects,
    spatialNotes: best.spatialNotes,
    mainObjects: [
      ...new Set([...best.mainObjects, ...intent.explicitObjects]),
    ],
  };
}

export function listPresets(): { label: string; prompt: string }[] {
  return [
    {
      label: "Tropical pirate island",
      prompt:
        "Please create a tropical island that serves as a pirate stronghold, inspired by the adventurous atmosphere of One Piece.",
    },
    {
      label: "Canyon tribal villages",
      prompt:
        "Please create a canyon scene with a river flowing through the entire canyon. Primitive tribal villages are scattered along the surrounding cliffs and valley floor.",
    },
    {
      label: "Desert battlefield",
      prompt:
        "Please create a desert battlefield inspired by PUBG's desert maps, designed as an open environment suitable for large-scale PvP combat.",
    },
    {
      label: "Snow tech valley",
      prompt:
        "Please create a realistic snow-covered mountain valley inspired by the style of Command & Conquer: Red Alert, featuring a variety of futuristic high-tech buildings scattered throughout the landscape.",
    },
    {
      label: "Medieval village",
      prompt:
        "A peaceful medieval village with a windmill on the hill, market square, farmland, and a small stream, fantasy game art style.",
    },
    {
      label: "Volcanic demon lair",
      prompt:
        "A volcanic demon lair with a lava lake, obsidian platforms, ritual towers, and glowing crystals in a fantasy style.",
    },
    {
      label: "Japanese island towns",
      prompt:
        "An island with Japanese-style towns, a hilltop shrine with torii gates, pagodas, harbor boats, and a distant mountain peak.",
    },
    {
      label: "Gemstone mine",
      prompt:
        "A gemstone mining site in a forested mountain valley with crystal veins, mine shafts, worker camp, and a stream.",
    },
  ];
}

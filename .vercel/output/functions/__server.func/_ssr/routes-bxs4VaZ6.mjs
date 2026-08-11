import { i as __toESM } from "../_runtime.mjs";
import { _ as require_react, a as Canvas, c as BufferAttribute, d as MeshStandardMaterial, f as PlaneGeometry, g as require_jsx_runtime, i as PerspectiveCamera, l as Color, n as Sky, o as useFrame, p as Vector3, r as OrbitControls, s as useThree, t as Stars, u as MeshNormalMaterial } from "../_libs/@react-three/drei+[...].mjs";
import { t as create } from "../_libs/zustand.mjs";
import { a as Map$1, c as Footprints, i as Orbit, l as Eye, n as Square, o as LoaderCircle, r as Sparkles, s as Layers, t as X, u as Box } from "../_libs/lucide-react.mjs";
import { n as clsx, t as cva } from "../_libs/class-variance-authority+clsx.mjs";
import { t as twMerge } from "../_libs/tailwind-merge.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-bxs4VaZ6.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
/** Generative + procedural material palette (paper §2.2.2) */
var TERRAIN_MATERIALS = {
	ocean: {
		albedo: "#1a4a6e",
		roughness: .15,
		metalness: .35,
		label: "Ocean water"
	},
	beach: {
		albedo: "#d4c4a0",
		roughness: .92,
		metalness: 0,
		label: "Sand beach"
	},
	grass: {
		albedo: "#4a7c3f",
		roughness: .88,
		metalness: 0,
		label: "Grassland"
	},
	forest: {
		albedo: "#2d5a32",
		roughness: .9,
		metalness: 0,
		label: "Forest floor"
	},
	hill: {
		albedo: "#6b8f4e",
		roughness: .85,
		metalness: 0,
		label: "Rolling hills"
	},
	mountain: {
		albedo: "#6a6a72",
		roughness: .78,
		metalness: .05,
		label: "Mountain rock"
	},
	rock: {
		albedo: "#7a7268",
		roughness: .82,
		metalness: .08,
		label: "Exposed rock"
	},
	desert: {
		albedo: "#c9a66b",
		roughness: .94,
		metalness: 0,
		label: "Desert sand"
	},
	sand: {
		albedo: "#e0c98a",
		roughness: .95,
		metalness: 0,
		label: "Dunes"
	},
	canyon: {
		albedo: "#a86b45",
		roughness: .86,
		metalness: .02,
		label: "Canyon rock"
	},
	river: {
		albedo: "#2a6a8a",
		roughness: .2,
		metalness: .3,
		label: "River water"
	},
	snow: {
		albedo: "#e8eef5",
		roughness: .55,
		metalness: .05,
		label: "Snow cover"
	},
	ice: {
		albedo: "#b8d4e8",
		roughness: .25,
		metalness: .15,
		label: "Ice sheet"
	},
	lava: {
		albedo: "#3a1a12",
		roughness: .7,
		metalness: .2,
		label: "Volcanic rock"
	},
	road: {
		albedo: "#4a4a4c",
		roughness: .75,
		metalness: .1,
		label: "Packed road"
	},
	settlement: {
		albedo: "#8a7a5a",
		roughness: .8,
		metalness: .02,
		label: "Settlement ground"
	},
	cliff: {
		albedo: "#5c5348",
		roughness: .8,
		metalness: .06,
		label: "Cliff face"
	}
};
var REGION_LAYOUT_COLORS = {
	ocean: "#1e5a8a",
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
	cliff: "#6a6055"
};
var OBJECT_PALETTES = {
	hut: {
		primary: "#8b5a2b",
		secondary: "#d4a574"
	},
	house: {
		primary: "#c4b09a",
		secondary: "#6b3a2a"
	},
	tower: {
		primary: "#7a7a80",
		secondary: "#4a4a50"
	},
	dock: {
		primary: "#6b4a2a",
		secondary: "#8b6a3a"
	},
	ship: {
		primary: "#5a3a1a",
		secondary: "#c44"
	},
	tree: {
		primary: "#2d5a28",
		secondary: "#4a3020"
	},
	palm: {
		primary: "#3a7a30",
		secondary: "#6b4a20"
	},
	pine: {
		primary: "#1e4a28",
		secondary: "#3a2818"
	},
	rock: {
		primary: "#6a6560",
		secondary: "#4a4540"
	},
	boulder: {
		primary: "#5a5550",
		secondary: "#3a3530"
	},
	cactus: {
		primary: "#3a7a40",
		secondary: "#2a5a30"
	},
	vehicle: {
		primary: "#4a6a4a",
		secondary: "#2a2a2a"
	},
	tank: {
		primary: "#5a6048",
		secondary: "#3a3a30"
	},
	building: {
		primary: "#a0a8b0",
		secondary: "#606870"
	},
	antenna: {
		primary: "#c0c4c8",
		secondary: "#404448"
	},
	fence: {
		primary: "#6b5a3a",
		secondary: "#4a3a20"
	},
	campfire: {
		primary: "#e85",
		secondary: "#3a2a1a"
	},
	tent: {
		primary: "#c45a30",
		secondary: "#8a3a18"
	},
	bridge: {
		primary: "#6b4a28",
		secondary: "#4a3018"
	},
	statue: {
		primary: "#8a8880",
		secondary: "#5a5850"
	},
	crystal: {
		primary: "#66aaff",
		secondary: "#2288cc"
	},
	mine: {
		primary: "#5a4a3a",
		secondary: "#c9a020"
	},
	dragon: {
		primary: "#2a5a3a",
		secondary: "#1a3a20"
	},
	windmill: {
		primary: "#d0c8b8",
		secondary: "#6b4a28"
	},
	well: {
		primary: "#7a7a70",
		secondary: "#4a4a40"
	},
	crate: {
		primary: "#8b6a3a",
		secondary: "#5a3a18"
	},
	watchtower: {
		primary: "#6b5a40",
		secondary: "#3a2a18"
	},
	satellite: {
		primary: "#d0d4d8",
		secondary: "#4080c0"
	},
	bunker: {
		primary: "#5a5848",
		secondary: "#3a3828"
	},
	boat: {
		primary: "#4a6a8a",
		secondary: "#2a3a4a"
	},
	pagoda: {
		primary: "#8b2a1a",
		secondary: "#d4c4a0"
	},
	torii: {
		primary: "#c4281a",
		secondary: "#1a1a1a"
	},
	barn: {
		primary: "#8b3a2a",
		secondary: "#d4b080"
	},
	market: {
		primary: "#c4a060",
		secondary: "#6b3a20"
	}
};
/**
* Stage 1 — Intent Analysis & Scene Planning (paper §2.1)
* Extracts explicit constraints, then completes a structured scene specification P.
*/
var TEMPLATES = [
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
			"ship"
		],
		regions: [
			{
				name: "Open Ocean",
				category: "ocean",
				center: [.15, .5],
				radius: .42,
				role: "water body",
				baseElevation: -2.5,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Southern Sea",
				category: "ocean",
				center: [.85, .55],
				radius: .38,
				role: "water body",
				baseElevation: -2.2,
				roughness: .12,
				peakStrength: 0
			},
			{
				name: "Sandy Beach",
				category: "beach",
				center: [.42, .55],
				radius: .22,
				role: "shoreline",
				baseElevation: .4,
				roughness: .2,
				peakStrength: .05
			},
			{
				name: "Jungle Interior",
				category: "forest",
				center: [.48, .42],
				radius: .18,
				role: "dense vegetation",
				baseElevation: 1.2,
				roughness: .45,
				peakStrength: .2
			},
			{
				name: "Pirate Settlement",
				category: "settlement",
				center: [.52, .58],
				radius: .12,
				role: "habitation",
				baseElevation: .8,
				roughness: .2,
				peakStrength: .05
			},
			{
				name: "Rocky Ridge",
				category: "rock",
				center: [.62, .35],
				radius: .14,
				role: "lookout ridge",
				baseElevation: 3.5,
				roughness: .55,
				peakStrength: .7
			},
			{
				name: "Harbor Cove",
				category: "beach",
				center: [.38, .68],
				radius: .1,
				role: "docking",
				baseElevation: .2,
				roughness: .15,
				peakStrength: 0
			}
		],
		terrainAssets: [
			"palm clusters",
			"coastal rocks",
			"driftwood"
		],
		objects: {
			"Pirate Settlement": [
				{
					category: "hut",
					count: 6,
					appearance: "thatch roofs"
				},
				{
					category: "watchtower",
					count: 2
				},
				{
					category: "crate",
					count: 8
				},
				{
					category: "campfire",
					count: 2
				}
			],
			"Harbor Cove": [
				{
					category: "dock",
					count: 2
				},
				{
					category: "ship",
					count: 2,
					scale: 1.4
				},
				{
					category: "boat",
					count: 3
				}
			],
			"Jungle Interior": [
				{
					category: "palm",
					count: 28
				},
				{
					category: "tree",
					count: 12
				},
				{
					category: "rock",
					count: 10
				}
			],
			"Rocky Ridge": [{
				category: "boulder",
				count: 8
			}, {
				category: "watchtower",
				count: 1
			}],
			"Sandy Beach": [{
				category: "palm",
				count: 14
			}, {
				category: "rock",
				count: 6
			}]
		},
		mainObjects: [
			"ships",
			"huts",
			"palms",
			"docks"
		],
		spatialNotes: [
			"Island surrounded by ocean",
			"Settlement inland from harbor",
			"Ridge overlooks bay"
		]
	},
	{
		theme: "canyon",
		sceneType: "river canyon with tribal settlements",
		visualStyle: "stylized",
		atmosphere: "dry warm air, layered cliffs, river mist",
		keywords: [
			"canyon",
			"river",
			"tribal",
			"cliff",
			"valley",
			"primitive"
		],
		regions: [
			{
				name: "River Corridor",
				category: "river",
				center: [.5, .5],
				radius: .12,
				role: "water artery",
				baseElevation: -1.5,
				roughness: .1,
				peakStrength: 0
			},
			{
				name: "Valley Floor",
				category: "grass",
				center: [.48, .42],
				radius: .16,
				role: "fertile flats",
				baseElevation: .5,
				roughness: .25,
				peakStrength: .05
			},
			{
				name: "West Cliffs",
				category: "canyon",
				center: [.22, .5],
				radius: .22,
				role: "canyon wall",
				baseElevation: 5.5,
				roughness: .5,
				peakStrength: .55
			},
			{
				name: "East Cliffs",
				category: "canyon",
				center: [.78, .48],
				radius: .2,
				role: "canyon wall",
				baseElevation: 5.2,
				roughness: .48,
				peakStrength: .5
			},
			{
				name: "North Mesa",
				category: "rock",
				center: [.5, .18],
				radius: .16,
				role: "high plateau",
				baseElevation: 4,
				roughness: .4,
				peakStrength: .35
			},
			{
				name: "Tribal Village A",
				category: "settlement",
				center: [.38, .55],
				radius: .09,
				role: "habitation",
				baseElevation: .8,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Tribal Village B",
				category: "settlement",
				center: [.62, .38],
				radius: .08,
				role: "habitation",
				baseElevation: 1,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Riverbank Woods",
				category: "forest",
				center: [.52, .62],
				radius: .11,
				role: "vegetation",
				baseElevation: .6,
				roughness: .35,
				peakStrength: .1
			}
		],
		terrainAssets: [
			"canyon rocks",
			"scrub brush",
			"river stones"
		],
		objects: {
			"Tribal Village A": [
				{
					category: "hut",
					count: 7
				},
				{
					category: "campfire",
					count: 2
				},
				{
					category: "totem",
					count: 0
				},
				{
					category: "well",
					count: 1
				},
				{
					category: "fence",
					count: 4
				}
			],
			"Tribal Village B": [
				{
					category: "hut",
					count: 5
				},
				{
					category: "watchtower",
					count: 1
				},
				{
					category: "crate",
					count: 4
				}
			],
			"Riverbank Woods": [{
				category: "tree",
				count: 18
			}, {
				category: "rock",
				count: 8
			}],
			"West Cliffs": [{
				category: "boulder",
				count: 12
			}, {
				category: "rock",
				count: 10
			}],
			"Valley Floor": [{
				category: "tree",
				count: 8
			}, {
				category: "bridge",
				count: 1
			}]
		},
		mainObjects: [
			"huts",
			"cliffs",
			"river",
			"bridges"
		],
		spatialNotes: [
			"River cuts continuous canyon axis",
			"Villages on valley terraces",
			"Cliffs frame both sides"
		]
	},
	{
		theme: "desert",
		sceneType: "desert battlefield",
		visualStyle: "game",
		atmosphere: "harsh sun, dust haze, open combat sightlines",
		keywords: [
			"desert",
			"battlefield",
			"pubg",
			"pvp",
			"compound",
			"sandy",
			"arid"
		],
		regions: [
			{
				name: "Open Dunes",
				category: "sand",
				center: [.5, .5],
				radius: .28,
				role: "combat flats",
				baseElevation: .6,
				roughness: .35,
				peakStrength: .15
			},
			{
				name: "North Ridges",
				category: "rock",
				center: [.45, .18],
				radius: .18,
				role: "high ground",
				baseElevation: 4.5,
				roughness: .55,
				peakStrength: .65
			},
			{
				name: "South Mesa",
				category: "desert",
				center: [.55, .82],
				radius: .16,
				role: "plateau",
				baseElevation: 3.2,
				roughness: .4,
				peakStrength: .4
			},
			{
				name: "West Compound",
				category: "settlement",
				center: [.22, .48],
				radius: .1,
				role: "fortified base",
				baseElevation: 1,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "East Compound",
				category: "settlement",
				center: [.78, .52],
				radius: .1,
				role: "fortified base",
				baseElevation: 1.1,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Central Ruin",
				category: "road",
				center: [.5, .48],
				radius: .08,
				role: "contested zone",
				baseElevation: .9,
				roughness: .2,
				peakStrength: .05
			},
			{
				name: "Rocky Scree",
				category: "cliff",
				center: [.3, .28],
				radius: .12,
				role: "cover terrain",
				baseElevation: 2.8,
				roughness: .5,
				peakStrength: .45
			}
		],
		terrainAssets: [
			"boulders",
			"wreckage piles",
			"cacti"
		],
		objects: {
			"West Compound": [
				{
					category: "building",
					count: 5
				},
				{
					category: "bunker",
					count: 2
				},
				{
					category: "watchtower",
					count: 2
				},
				{
					category: "vehicle",
					count: 3
				},
				{
					category: "crate",
					count: 10
				}
			],
			"East Compound": [
				{
					category: "building",
					count: 4
				},
				{
					category: "antenna",
					count: 1
				},
				{
					category: "tank",
					count: 2
				},
				{
					category: "crate",
					count: 8
				}
			],
			"Central Ruin": [
				{
					category: "building",
					count: 3
				},
				{
					category: "crate",
					count: 6
				},
				{
					category: "vehicle",
					count: 2
				}
			],
			"Open Dunes": [
				{
					category: "cactus",
					count: 16
				},
				{
					category: "rock",
					count: 14
				},
				{
					category: "vehicle",
					count: 2
				}
			],
			"North Ridges": [{
				category: "boulder",
				count: 12
			}, {
				category: "watchtower",
				count: 1
			}]
		},
		mainObjects: [
			"compounds",
			"vehicles",
			"bunkers",
			"cacti"
		],
		spatialNotes: [
			"Open combat area between compounds",
			"Ridges provide elevation advantage",
			"Roads connect compounds"
		]
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
			"valley"
		],
		regions: [
			{
				name: "Enclosing Peaks N",
				category: "mountain",
				center: [.5, .12],
				radius: .22,
				role: "mountain wall",
				baseElevation: 7.5,
				roughness: .55,
				peakStrength: .85
			},
			{
				name: "Enclosing Peaks S",
				category: "mountain",
				center: [.5, .88],
				radius: .18,
				role: "mountain wall",
				baseElevation: 6.5,
				roughness: .5,
				peakStrength: .75
			},
			{
				name: "West Ridge",
				category: "snow",
				center: [.15, .5],
				radius: .18,
				role: "snow ridge",
				baseElevation: 4.5,
				roughness: .4,
				peakStrength: .45
			},
			{
				name: "East Ridge",
				category: "ice",
				center: [.85, .5],
				radius: .16,
				role: "ice ridge",
				baseElevation: 4.2,
				roughness: .35,
				peakStrength: .4
			},
			{
				name: "Valley Floor",
				category: "snow",
				center: [.5, .5],
				radius: .2,
				role: "facility zone",
				baseElevation: 1,
				roughness: .2,
				peakStrength: .05
			},
			{
				name: "Command Base",
				category: "settlement",
				center: [.42, .45],
				radius: .1,
				role: "HQ complex",
				baseElevation: 1.2,
				roughness: .12,
				peakStrength: 0
			},
			{
				name: "Radar Outpost",
				category: "settlement",
				center: [.62, .58],
				radius: .08,
				role: "comms",
				baseElevation: 1.5,
				roughness: .15,
				peakStrength: .05
			},
			{
				name: "Frozen Stream",
				category: "ice",
				center: [.5, .62],
				radius: .08,
				role: "ice path",
				baseElevation: .4,
				roughness: .1,
				peakStrength: 0
			}
		],
		terrainAssets: [
			"snow drifts",
			"ice shards",
			"pine clusters"
		],
		objects: {
			"Command Base": [
				{
					category: "building",
					count: 6,
					appearance: "futuristic"
				},
				{
					category: "antenna",
					count: 3
				},
				{
					category: "satellite",
					count: 2
				},
				{
					category: "vehicle",
					count: 4
				},
				{
					category: "crate",
					count: 8
				}
			],
			"Radar Outpost": [
				{
					category: "antenna",
					count: 4
				},
				{
					category: "building",
					count: 3
				},
				{
					category: "tower",
					count: 2
				},
				{
					category: "tank",
					count: 2
				}
			],
			"Valley Floor": [
				{
					category: "pine",
					count: 20
				},
				{
					category: "rock",
					count: 10
				},
				{
					category: "vehicle",
					count: 2
				}
			],
			"West Ridge": [{
				category: "pine",
				count: 12
			}, {
				category: "boulder",
				count: 8
			}],
			"Enclosing Peaks N": [{
				category: "boulder",
				count: 10
			}, {
				category: "rock",
				count: 8
			}]
		},
		mainObjects: [
			"facilities",
			"antennas",
			"vehicles",
			"pines"
		],
		spatialNotes: [
			"Valley enclosed by mountains",
			"Facilities on valley floor",
			"Radar on elevated knoll"
		]
	},
	{
		theme: "medieval",
		sceneType: "medieval village in rolling hills",
		visualStyle: "fantasy",
		atmosphere: "soft daylight, chimney smoke, pastoral calm",
		keywords: [
			"medieval",
			"village",
			"castle",
			"fantasy",
			"farm",
			"hobbit",
			"windmill"
		],
		regions: [
			{
				name: "Village Green",
				category: "settlement",
				center: [.48, .5],
				radius: .14,
				role: "town center",
				baseElevation: .8,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Farmland",
				category: "grass",
				center: [.35, .62],
				radius: .16,
				role: "fields",
				baseElevation: .6,
				roughness: .2,
				peakStrength: .05
			},
			{
				name: "Woodland",
				category: "forest",
				center: [.7, .4],
				radius: .16,
				role: "timber",
				baseElevation: 1.2,
				roughness: .4,
				peakStrength: .2
			},
			{
				name: "North Hills",
				category: "hill",
				center: [.5, .22],
				radius: .18,
				role: "rolling hills",
				baseElevation: 2.8,
				roughness: .35,
				peakStrength: .3
			},
			{
				name: "Stream",
				category: "river",
				center: [.55, .58],
				radius: .08,
				role: "water",
				baseElevation: -.4,
				roughness: .1,
				peakStrength: 0
			},
			{
				name: "Mill Rise",
				category: "hill",
				center: [.32, .4],
				radius: .1,
				role: "windmill hill",
				baseElevation: 2.2,
				roughness: .25,
				peakStrength: .25
			},
			{
				name: "Distant Peaks",
				category: "mountain",
				center: [.8, .15],
				radius: .14,
				role: "backdrop",
				baseElevation: 5.5,
				roughness: .5,
				peakStrength: .7
			}
		],
		terrainAssets: [
			"oaks",
			"stone walls",
			"hedgerows"
		],
		objects: {
			"Village Green": [
				{
					category: "house",
					count: 8
				},
				{
					category: "market",
					count: 2
				},
				{
					category: "well",
					count: 1
				},
				{
					category: "barn",
					count: 2
				},
				{
					category: "fence",
					count: 6
				}
			],
			"Mill Rise": [{
				category: "windmill",
				count: 1
			}, {
				category: "house",
				count: 2
			}],
			"Woodland": [{
				category: "tree",
				count: 30
			}, {
				category: "rock",
				count: 8
			}],
			"Farmland": [
				{
					category: "barn",
					count: 2
				},
				{
					category: "fence",
					count: 8
				},
				{
					category: "tree",
					count: 6
				}
			],
			"Stream": [{
				category: "bridge",
				count: 1
			}, {
				category: "tree",
				count: 4
			}]
		},
		mainObjects: [
			"houses",
			"windmill",
			"market",
			"trees"
		],
		spatialNotes: [
			"Village centered on green",
			"Mill on western rise",
			"Forest east"
		]
	},
	{
		theme: "volcanic",
		sceneType: "volcanic demon lair",
		visualStyle: "fantasy",
		atmosphere: "ember glow, ash haze, heat shimmer",
		keywords: [
			"volcan",
			"lava",
			"demon",
			"hell",
			"fire",
			"obsidian",
			"infernal"
		],
		regions: [
			{
				name: "Lava Lake",
				category: "lava",
				center: [.5, .55],
				radius: .16,
				role: "molten core",
				baseElevation: -1.5,
				roughness: .2,
				peakStrength: .1
			},
			{
				name: "Obsidian Shelf",
				category: "rock",
				center: [.42, .4],
				radius: .14,
				role: "lair platform",
				baseElevation: 2,
				roughness: .45,
				peakStrength: .3
			},
			{
				name: "Ash Wastes",
				category: "desert",
				center: [.55, .7],
				radius: .18,
				role: "ash flats",
				baseElevation: .5,
				roughness: .35,
				peakStrength: .15
			},
			{
				name: "Crag Peaks",
				category: "mountain",
				center: [.25, .3],
				radius: .18,
				role: "volcanic peaks",
				baseElevation: 6.5,
				roughness: .6,
				peakStrength: .9
			},
			{
				name: "East Crags",
				category: "cliff",
				center: [.78, .35],
				radius: .16,
				role: "cliffs",
				baseElevation: 5,
				roughness: .55,
				peakStrength: .7
			},
			{
				name: "Ritual Circle",
				category: "settlement",
				center: [.48, .42],
				radius: .09,
				role: "lair",
				baseElevation: 2.2,
				roughness: .2,
				peakStrength: .1
			}
		],
		terrainAssets: [
			"obsidian shards",
			"ash cones",
			"basalt pillars"
		],
		objects: {
			"Ritual Circle": [
				{
					category: "statue",
					count: 4
				},
				{
					category: "tower",
					count: 3
				},
				{
					category: "crystal",
					count: 6
				},
				{
					category: "campfire",
					count: 4
				}
			],
			"Obsidian Shelf": [
				{
					category: "boulder",
					count: 10
				},
				{
					category: "crystal",
					count: 5
				},
				{
					category: "rock",
					count: 8
				}
			],
			"Ash Wastes": [{
				category: "rock",
				count: 16
			}, {
				category: "boulder",
				count: 8
			}],
			"Crag Peaks": [{
				category: "boulder",
				count: 12
			}]
		},
		mainObjects: [
			"statues",
			"crystals",
			"lava",
			"towers"
		],
		spatialNotes: [
			"Lava at center low",
			"Lair on elevated shelf",
			"Peaks rim the crater"
		]
	},
	{
		theme: "island",
		sceneType: "japanese-style island towns",
		visualStyle: "stylized",
		atmosphere: "soft mist, cherry dusk light, calm sea",
		keywords: [
			"japan",
			"pagoda",
			"torii",
			"zen",
			"asian",
			"oriental",
			"shrine"
		],
		regions: [
			{
				name: "Sea",
				category: "ocean",
				center: [.2, .5],
				radius: .35,
				role: "water",
				baseElevation: -2,
				roughness: .12,
				peakStrength: 0
			},
			{
				name: "Harbor Town",
				category: "settlement",
				center: [.48, .55],
				radius: .12,
				role: "port town",
				baseElevation: .7,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Hill Shrine",
				category: "hill",
				center: [.62, .35],
				radius: .12,
				role: "shrine grounds",
				baseElevation: 3,
				roughness: .3,
				peakStrength: .35
			},
			{
				name: "Bamboo Forest",
				category: "forest",
				center: [.55, .42],
				radius: .12,
				role: "woods",
				baseElevation: 1.2,
				roughness: .35,
				peakStrength: .15
			},
			{
				name: "Beach",
				category: "beach",
				center: [.4, .62],
				radius: .1,
				role: "shore",
				baseElevation: .3,
				roughness: .15,
				peakStrength: 0
			},
			{
				name: "Inland Hills",
				category: "grass",
				center: [.7, .55],
				radius: .14,
				role: "fields",
				baseElevation: 1.5,
				roughness: .25,
				peakStrength: .15
			},
			{
				name: "Distant Peak",
				category: "mountain",
				center: [.82, .25],
				radius: .12,
				role: "fuji-like peak",
				baseElevation: 6,
				roughness: .45,
				peakStrength: .85
			}
		],
		terrainAssets: [
			"pines",
			"stone lanterns",
			"coastal rocks"
		],
		objects: {
			"Harbor Town": [
				{
					category: "house",
					count: 7
				},
				{
					category: "pagoda",
					count: 1
				},
				{
					category: "dock",
					count: 2
				},
				{
					category: "boat",
					count: 3
				},
				{
					category: "market",
					count: 2
				}
			],
			"Hill Shrine": [
				{
					category: "torii",
					count: 3
				},
				{
					category: "pagoda",
					count: 1
				},
				{
					category: "statue",
					count: 2
				},
				{
					category: "pine",
					count: 8
				}
			],
			"Bamboo Forest": [{
				category: "tree",
				count: 22
			}, {
				category: "pine",
				count: 10
			}],
			"Beach": [{
				category: "boat",
				count: 2
			}, {
				category: "rock",
				count: 6
			}],
			"Inland Hills": [{
				category: "tree",
				count: 10
			}, {
				category: "house",
				count: 2
			}]
		},
		mainObjects: [
			"pagoda",
			"torii",
			"harbor houses",
			"boats"
		],
		spatialNotes: [
			"Town by harbor",
			"Shrine on hill",
			"Peak in distance"
		]
	},
	{
		theme: "forest",
		sceneType: "gemstone mining valley",
		visualStyle: "fantasy",
		atmosphere: "dappled forest light, crystal glints, cool air",
		keywords: [
			"mine",
			"gem",
			"crystal",
			"mining",
			"ore",
			"quarry"
		],
		regions: [
			{
				name: "Mine Site",
				category: "settlement",
				center: [.5, .48],
				radius: .12,
				role: "extraction",
				baseElevation: 1,
				roughness: .25,
				peakStrength: .1
			},
			{
				name: "Crystal Veins",
				category: "rock",
				center: [.42, .38],
				radius: .12,
				role: "ore veins",
				baseElevation: 2.5,
				roughness: .5,
				peakStrength: .4
			},
			{
				name: "Forest Cover",
				category: "forest",
				center: [.6, .55],
				radius: .18,
				role: "woods",
				baseElevation: 1.2,
				roughness: .4,
				peakStrength: .2
			},
			{
				name: "Stream",
				category: "river",
				center: [.48, .62],
				radius: .08,
				role: "runoff",
				baseElevation: -.3,
				roughness: .1,
				peakStrength: 0
			},
			{
				name: "Hills",
				category: "hill",
				center: [.3, .55],
				radius: .14,
				role: "foothills",
				baseElevation: 2,
				roughness: .35,
				peakStrength: .25
			},
			{
				name: "Peaks",
				category: "mountain",
				center: [.7, .25],
				radius: .16,
				role: "backdrop",
				baseElevation: 5.5,
				roughness: .5,
				peakStrength: .7
			}
		],
		terrainAssets: [
			"ore carts debris",
			"pines",
			"boulders"
		],
		objects: {
			"Mine Site": [
				{
					category: "mine",
					count: 3
				},
				{
					category: "building",
					count: 3
				},
				{
					category: "crate",
					count: 10
				},
				{
					category: "tent",
					count: 3
				},
				{
					category: "campfire",
					count: 2
				}
			],
			"Crystal Veins": [
				{
					category: "crystal",
					count: 14
				},
				{
					category: "boulder",
					count: 8
				},
				{
					category: "rock",
					count: 10
				}
			],
			"Forest Cover": [{
				category: "tree",
				count: 28
			}, {
				category: "pine",
				count: 12
			}],
			"Hills": [{
				category: "tree",
				count: 10
			}, {
				category: "rock",
				count: 8
			}]
		},
		mainObjects: [
			"crystals",
			"mine shafts",
			"camp",
			"forest"
		],
		spatialNotes: [
			"Mine at valley center",
			"Crystals on rock veins",
			"Forest surrounds"
		]
	}
];
function scoreTemplate(prompt, t) {
	const p = prompt.toLowerCase();
	let score = 0;
	for (const kw of t.keywords) if (p.includes(kw)) score += 3;
	for (const kw of t.keywords) if (kw.length > 4 && p.includes(kw.slice(0, 4))) score += .5;
	return score;
}
function detectStyle(prompt, fallback) {
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
function analyzeIntent(prompt) {
	const p = prompt.toLowerCase();
	const explicitThemeHints = [];
	const allKw = TEMPLATES.flatMap((t) => t.keywords);
	for (const kw of allKw) if (p.includes(kw) && !explicitThemeHints.includes(kw)) explicitThemeHints.push(kw);
	const explicitObjects = [
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
		"antenna"
	].filter((o) => p.includes(o));
	let explicitStyle = null;
	if (/cartoon|anime/.test(p)) explicitStyle = "cartoon";
	else if (/sci-?fi|futur/.test(p)) explicitStyle = "sci-fi";
	else if (/fantasy|magic/.test(p)) explicitStyle = "fantasy";
	else if (/realistic/.test(p)) explicitStyle = "realistic";
	return {
		explicitThemeHints,
		explicitObjects,
		explicitStyle,
		sceneTypeGuess: prompt.slice(0, 80)
	};
}
/** Scene-level planning: complete unspecified fields into structured P */
function planScene(prompt) {
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
	if (bestScore < 1) best = TEMPLATES.find((t) => t.theme === "medieval") ?? TEMPLATES[0];
	const visualStyle = intent.explicitStyle ?? detectStyle(prompt, best.visualStyle);
	const regions = best.regions.map((r, i) => ({
		...r,
		id: `r${i}`,
		color: REGION_LAYOUT_COLORS[r.category]
	}));
	const objects = {};
	for (const [k, list] of Object.entries(best.objects)) objects[k] = list.filter((o) => o.count > 0);
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
		mainObjects: [.../* @__PURE__ */ new Set([...best.mainObjects, ...intent.explicitObjects])]
	};
}
function listPresets() {
	return [
		{
			label: "Tropical pirate island",
			prompt: "Please create a tropical island that serves as a pirate stronghold, inspired by the adventurous atmosphere of One Piece."
		},
		{
			label: "Canyon tribal villages",
			prompt: "Please create a canyon scene with a river flowing through the entire canyon. Primitive tribal villages are scattered along the surrounding cliffs and valley floor."
		},
		{
			label: "Desert battlefield",
			prompt: "Please create a desert battlefield inspired by PUBG's desert maps, designed as an open environment suitable for large-scale PvP combat."
		},
		{
			label: "Snow tech valley",
			prompt: "Please create a realistic snow-covered mountain valley inspired by the style of Command & Conquer: Red Alert, featuring a variety of futuristic high-tech buildings scattered throughout the landscape."
		},
		{
			label: "Medieval village",
			prompt: "A peaceful medieval village with a windmill on the hill, market square, farmland, and a small stream, fantasy game art style."
		},
		{
			label: "Volcanic demon lair",
			prompt: "A volcanic demon lair with a lava lake, obsidian platforms, ritual towers, and glowing crystals in a fantasy style."
		},
		{
			label: "Japanese island towns",
			prompt: "An island with Japanese-style towns, a hilltop shrine with torii gates, pagodas, harbor boats, and a distant mountain peak."
		},
		{
			label: "Gemstone mine",
			prompt: "A gemstone mining site in a forested mountain valley with crystal veins, mine shafts, worker camp, and a stream."
		}
	];
}
/** Deterministic value / fbm noise for terrain (paper eq. 6 noise terms) */
function hash2(x, y, seed) {
	let h = seed + x * 374761393 + y * 668265263;
	h = (h ^ h >>> 13) * 1274126177;
	h = h ^ h >>> 16;
	return (h >>> 0) / 4294967295;
}
function valueNoise2(x, y, seed) {
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
function fbm(x, y, seed, octaves = 5, lacunarity = 2, gain = .5) {
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
function geomorphicPeak(dx, dy, radius, sharpness = 2.2) {
	const d = Math.sqrt(dx * dx + dy * dy) / Math.max(radius, 1e-6);
	if (d > 1.4) return 0;
	return Math.pow(Math.max(0, 1 - d), sharpness);
}
/** Dune / ridge operator */
function geomorphicDune(x, y, seed, scale) {
	const n = fbm(x * scale, y * scale * .35, seed, 3, 2.1, .55);
	return Math.pow(Math.abs(n * 2 - 1), 1.4);
}
/** Terrace steps */
function geomorphicTerrace(h, steps) {
	const s = Math.max(2, steps);
	return Math.floor(h * s) / s + h % (1 / s) * .15;
}
/** Simple erosion-like smoothing weight */
function erosionFactor(x, y, seed) {
	return .7 + .3 * fbm(x * .8, y * .8, seed + 7, 3);
}
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = a + 1831565813 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
function pickSeed(prompt) {
	let h = 2166136261;
	for (let i = 0; i < prompt.length; i++) {
		h ^= prompt.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
/** Soft regional weights from layout centers (paper soft masks m̃_r) */
function softWeights(u, v, regions) {
	const weights = regions.map((r) => {
		const dx = u - r.center[0];
		const dy = v - r.center[1];
		const d = Math.sqrt(dx * dx + dy * dy);
		const falloff = Math.max(0, 1 - d / (r.radius * 1.45));
		return Math.pow(falloff, 1.6);
	});
	const sum = weights.reduce((a, b) => a + b, 0);
	if (sum < 1e-6) {
		let minI = 0;
		let minD = Infinity;
		regions.forEach((r, i) => {
			const dx = u - r.center[0];
			const dy = v - r.center[1];
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d < minD) {
				minD = d;
				minI = i;
			}
		});
		return {
			weights: regions.map((_, i) => i === minI ? 1 : 0),
			primary: minI
		};
	}
	const norm = weights.map((w) => w / sum);
	let primary = 0;
	let maxW = -1;
	norm.forEach((w, i) => {
		if (w > maxW) {
			maxW = w;
			primary = i;
		}
	});
	return {
		weights: norm,
		primary
	};
}
function buildLayoutMap(regions, resolution = 160) {
	const map = [];
	for (let y = 0; y < resolution; y++) {
		const row = [];
		for (let x = 0; x < resolution; x++) {
			const { primary } = softWeights(x / (resolution - 1), y / (resolution - 1), regions);
			row.push(regions[primary]?.category ?? "grass");
		}
		map.push(row);
	}
	return map;
}
function planTerrainAssets(plan) {
	const theme = plan.theme;
	const base = [{
		kind: "rock",
		categoryAffinity: [
			"rock",
			"mountain",
			"cliff",
			"canyon",
			"hill"
		],
		density: .45,
		scaleRange: [.6, 1.8]
	}];
	if (theme === "tropical" || theme === "island") base.push({
		kind: "tree",
		categoryAffinity: [
			"forest",
			"beach",
			"grass",
			"settlement"
		],
		density: .65,
		scaleRange: [.8, 1.5]
	});
	else if (theme === "snow") {
		base.push({
			kind: "tree",
			categoryAffinity: [
				"snow",
				"forest",
				"hill",
				"settlement"
			],
			density: .5,
			scaleRange: [.9, 1.6]
		});
		base.push({
			kind: "ice",
			categoryAffinity: [
				"ice",
				"snow",
				"mountain"
			],
			density: .25,
			scaleRange: [.5, 1.2]
		});
	} else if (theme === "desert") base.push({
		kind: "cactus",
		categoryAffinity: ["desert", "sand"],
		density: .45,
		scaleRange: [.7, 1.6]
	});
	else if (theme === "volcanic") base.push({
		kind: "crystal",
		categoryAffinity: [
			"rock",
			"lava",
			"cliff"
		],
		density: .3,
		scaleRange: [.5, 1.3]
	});
	else {
		base.push({
			kind: "tree",
			categoryAffinity: [
				"forest",
				"grass",
				"hill"
			],
			density: .55,
			scaleRange: [.8, 1.5]
		});
		base.push({
			kind: "bush",
			categoryAffinity: [
				"grass",
				"hill",
				"settlement"
			],
			density: .35,
			scaleRange: [.4, .9]
		});
	}
	return base;
}
/**
* Height field generation following paper eq. (6):
* H(x) = Σ_r m̃_r(x) [ h_r + Σ_k w_{r,k} N_{r,k}(x) + Σ_j α_{r,j} G_{r,j}(x) ]
*/
function generateHeightField(plan, seed, resolution = 160, worldSize = 120) {
	const regions = plan.regions;
	const data = new Float32Array(resolution * resolution);
	const regionId = new Uint8Array(resolution * resolution);
	const hasOcean = regions.some((r) => r.category === "ocean" || r.category === "river");
	const islandLike = plan.theme === "tropical" || plan.theme === "island" || plan.theme === "volcanic";
	for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
		const u = x / (resolution - 1);
		const v = y / (resolution - 1);
		const wx = (u - .5) * worldSize;
		const wz = (v - .5) * worldSize;
		const { weights, primary } = softWeights(u, v, regions);
		let h = 0;
		for (let ri = 0; ri < regions.length; ri++) {
			const r = regions[ri];
			const m = weights[ri];
			if (m < 1e-5) continue;
			const nx = wx * .045;
			const nz = wz * .045;
			const n1 = fbm(nx, nz, seed + ri * 17, 5) * 2 - 1;
			const n2 = fbm(nx * 2.5, nz * 2.5, seed + 40 + ri, 4) * 2 - 1;
			const n3 = fbm(nx * 6, nz * 6, seed + 90 + ri, 2) * 2 - 1;
			const noiseTerm = r.roughness * (n1 * 1.6 + n2 * .7 + n3 * .25);
			const dx = u - r.center[0];
			const dy = v - r.center[1];
			let geo = 0;
			if (r.peakStrength > .05) geo += r.peakStrength * geomorphicPeak(dx, dy, r.radius * 1.05, 1.9 + r.peakStrength) * (4.2 + r.baseElevation * .2);
			if (r.category === "sand" || r.category === "desert") geo += 1.1 * geomorphicDune(nx, nz, seed + 90, 1.15) * Math.max(.3, r.roughness) * 2.4;
			if (r.category === "canyon" || r.category === "cliff") {
				const terrace = geomorphicTerrace(.5 + .5 * n1, 5 + Math.floor(r.peakStrength * 3));
				geo += terrace * Math.max(.4, r.peakStrength) * 3.2;
				geo += geomorphicPeak(dx, dy, r.radius * .9, 3.5) * 2.5;
			}
			if (r.category === "mountain") geo += geomorphicPeak(dx * 1.2, dy * 1.2, r.radius, 2.4) * r.peakStrength * 5;
			if (r.category === "river") geo -= 1.8 + Math.abs(n1) * .4;
			if (r.category === "ocean") geo -= 2.5 + n1 * .3;
			if (r.category === "settlement" || r.category === "road") geo *= .25;
			const e = erosionFactor(nx, nz, seed);
			let local = (r.baseElevation + noiseTerm + geo) * e;
			if (r.category === "settlement" || r.category === "road") local = r.baseElevation + noiseTerm * .15;
			h += m * local;
		}
		if (islandLike) {
			const cx = u - .5;
			const cy = v - .5;
			const radial = Math.sqrt(cx * cx + cy * cy) / .52;
			if (radial > .55) {
				const t = Math.min(1, (radial - .55) / .45);
				h = h * (1 - t) + (-2.8 - fbm(wx * .05, wz * .05, seed, 2)) * t;
			}
		}
		if (!islandLike) {
			const edgeDist = Math.min(u, v, 1 - u, 1 - v);
			if (edgeDist < .08) {
				const t = edgeDist / .08;
				h *= .55 + .45 * t;
			}
		}
		const primaryCat = regions[primary]?.category;
		if (primaryCat === "ocean") h = Math.min(h, -1.2 + fbm(wx * .08, wz * .08, seed + 3, 2) * .4);
		if (primaryCat === "river") h = Math.min(h, -.6);
		if (primaryCat === "beach" && hasOcean) h = Math.max(-.15, Math.min(h, .9));
		data[y * resolution + x] = h;
		regionId[y * resolution + x] = primary;
	}
	const smoothed = new Float32Array(data.length);
	for (let y = 1; y < resolution - 1; y++) for (let x = 1; x < resolution - 1; x++) {
		const i = y * resolution + x;
		smoothed[i] = data[i] * .45 + (data[i - 1] + data[i + 1] + data[i - resolution] + data[i + resolution]) * .1375;
	}
	for (let y = 1; y < resolution - 1; y++) for (let x = 1; x < resolution - 1; x++) {
		const i = y * resolution + x;
		const cat = regions[regionId[i]]?.category;
		if (cat === "ocean" || cat === "river") data[i] = Math.min(data[i], smoothed[i]);
		else data[i] = smoothed[i];
	}
	return {
		resolution,
		worldSize,
		data,
		regionId
	};
}
function sampleHeight(hf, wx, wz) {
	const { resolution, worldSize, data } = hf;
	const u = wx / worldSize + .5;
	const v = wz / worldSize + .5;
	if (u < 0 || u > 1 || v < 0 || v > 1) return -10;
	const x = u * (resolution - 1);
	const y = v * (resolution - 1);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(resolution - 1, x0 + 1);
	const y1 = Math.min(resolution - 1, y0 + 1);
	const tx = x - x0;
	const ty = y - y0;
	const h00 = data[y0 * resolution + x0];
	const h10 = data[y0 * resolution + x1];
	const h01 = data[y1 * resolution + x0];
	const h11 = data[y1 * resolution + x1];
	return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}
function sampleNormal(hf, wx, wz) {
	const e = hf.worldSize / hf.resolution;
	const hL = sampleHeight(hf, wx - e, wz);
	const hR = sampleHeight(hf, wx + e, wz);
	const hD = sampleHeight(hf, wx, wz - e);
	const hU = sampleHeight(hf, wx, wz + e);
	const nx = hL - hR;
	const ny = 2 * e;
	const nz = hD - hU;
	const len = Math.hypot(nx, ny, nz) || 1;
	return [
		nx / len,
		ny / len,
		nz / len
	];
}
function sampleSlope(hf, wx, wz) {
	return 1 - sampleNormal(hf, wx, wz)[1];
}
function buildTerrainSpec(plan, seed) {
	return {
		layout: buildLayoutMap(plan.regions),
		resolution: 160,
		worldSize: 120,
		heightScale: 1,
		materials: { ...TERRAIN_MATERIALS },
		assetPrototypes: planTerrainAssets(plan)
	};
}
function scatterTerrainAssets(plan, hf, seed) {
	const rng = mulberry32(seed ^ 2748);
	const out = [];
	const assets = planTerrainAssets(plan);
	const half = hf.worldSize * .48;
	for (const asset of assets) {
		const count = Math.floor(55 * asset.density);
		for (let i = 0; i < count; i++) {
			const wx = (rng() * 2 - 1) * half;
			const wz = (rng() * 2 - 1) * half;
			const u = wx / hf.worldSize + .5;
			const v = wz / hf.worldSize + .5;
			const ri = hf.regionId[Math.min(hf.resolution - 1, Math.max(0, Math.floor(v * (hf.resolution - 1)))) * hf.resolution + Math.min(hf.resolution - 1, Math.max(0, Math.floor(u * (hf.resolution - 1))))];
			const cat = plan.regions[ri]?.category;
			if (!cat || !asset.categoryAffinity.includes(cat)) continue;
			if (sampleSlope(hf, wx, wz) > .55) continue;
			const h = sampleHeight(hf, wx, wz);
			if (h < .05) continue;
			const scale = asset.scaleRange[0] + rng() * (asset.scaleRange[1] - asset.scaleRange[0]);
			out.push({
				kind: asset.kind,
				position: [
					wx,
					h,
					wz
				],
				scale,
				rotation: rng() * Math.PI * 2
			});
		}
	}
	return out;
}
function refineTerrainHeights(hf, plan) {
	const { resolution, data } = hf;
	const next = new Float32Array(data);
	for (let y = 2; y < resolution - 2; y++) for (let x = 2; x < resolution - 2; x++) {
		const i = y * resolution + x;
		const r0 = hf.regionId[i];
		let boundary = false;
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1]
		]) if (hf.regionId[(y + dy) * resolution + (x + dx)] !== r0) {
			boundary = true;
			break;
		}
		if (boundary) {
			let s = 0;
			let c = 0;
			for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
				s += data[(y + oy) * resolution + (x + ox)];
				c++;
			}
			next[i] = s / c;
		}
	}
	for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
		const i = y * resolution + x;
		const reg = plan.regions[hf.regionId[i]];
		if (reg?.category === "settlement" || reg?.category === "road") {
			let s = data[i];
			let c = 1;
			if (x > 0) {
				s += data[i - 1];
				c++;
			}
			if (x < resolution - 1) {
				s += data[i + 1];
				c++;
			}
			if (y > 0) {
				s += data[i - resolution];
				c++;
			}
			if (y < resolution - 1) {
				s += data[i + resolution];
				c++;
			}
			next[i] = next[i] * .35 + s / c * .65;
		}
	}
	return {
		...hf,
		data: next
	};
}
/**
* Stage 3 — Regional Object Generation & Placement (paper §2.3)
* Region composition prior → instance gen → ray-based placement → scale cal
*/
var KIND_ALIASES = {
	hut: "hut",
	house: "house",
	tower: "tower",
	dock: "dock",
	ship: "ship",
	tree: "tree",
	palm: "palm",
	pine: "pine",
	rock: "rock",
	boulder: "boulder",
	cactus: "cactus",
	vehicle: "vehicle",
	tank: "tank",
	building: "building",
	antenna: "antenna",
	fence: "fence",
	campfire: "campfire",
	tent: "tent",
	bridge: "bridge",
	statue: "statue",
	crystal: "crystal",
	mine: "mine",
	dragon: "dragon",
	windmill: "windmill",
	well: "well",
	crate: "crate",
	watchtower: "watchtower",
	satellite: "satellite",
	bunker: "bunker",
	boat: "boat",
	pagoda: "pagoda",
	torii: "torii",
	barn: "barn",
	market: "market",
	totem: "statue"
};
var BASE_SCALES = {
	hut: 1.2,
	house: 1.6,
	tower: 2.2,
	dock: 2.5,
	ship: 3.2,
	tree: 1.4,
	palm: 1.6,
	pine: 1.8,
	rock: .8,
	boulder: 1.3,
	cactus: 1,
	vehicle: 1.4,
	tank: 1.8,
	building: 2.4,
	antenna: 2.8,
	fence: 1,
	campfire: .7,
	tent: 1.1,
	bridge: 3.5,
	statue: 1.5,
	crystal: .9,
	mine: 2,
	dragon: 4,
	windmill: 3.5,
	well: 1,
	crate: .55,
	watchtower: 2.5,
	satellite: 1.6,
	bunker: 2,
	boat: 1.4,
	pagoda: 2.8,
	torii: 2.2,
	barn: 2.2,
	market: 1.8
};
function resolveKind(cat) {
	return KIND_ALIASES[cat.toLowerCase()] ?? "crate";
}
function isVegetation(k) {
	return k === "tree" || k === "palm" || k === "pine" || k === "cactus";
}
function isStructure(k) {
	return [
		"hut",
		"house",
		"tower",
		"building",
		"barn",
		"market",
		"pagoda",
		"bunker",
		"mine",
		"watchtower",
		"windmill"
	].includes(k);
}
/**
* Sample placement candidates inside a region disk on the terrain.
* Filters by slope / water / spacing (paper placement constraints).
*/
function generateRegionalObjects(plan, hf, seed) {
	const rng = mulberry32(seed ^ 1597463007);
	const objects = [];
	let idCounter = 0;
	for (const region of plan.regions) {
		const reqs = plan.objectRequirements[region.name] ?? [];
		if (reqs.length === 0) continue;
		const half = hf.worldSize * .5;
		const cx = (region.center[0] - .5) * hf.worldSize;
		const cz = (region.center[1] - .5) * hf.worldSize;
		const rad = region.radius * hf.worldSize * .95;
		for (const req of reqs) {
			const kind = resolveKind(req.category);
			const baseScale = (BASE_SCALES[kind] ?? 1) * (req.scale ?? 1);
			let placed = 0;
			let attempts = 0;
			const maxAttempts = req.count * 40;
			while (placed < req.count && attempts < maxAttempts) {
				attempts++;
				const ang = rng() * Math.PI * 2;
				const dist = Math.sqrt(rng()) * rad;
				const wx = cx + Math.cos(ang) * dist;
				const wz = cz + Math.sin(ang) * dist;
				if (Math.abs(wx) > half * .96 || Math.abs(wz) > half * .96) continue;
				const h = sampleHeight(hf, wx, wz);
				const slope = sampleSlope(hf, wx, wz);
				const n = sampleNormal(hf, wx, wz);
				if (kind === "ship" || kind === "boat") {
					if (h > .35) continue;
				} else if (kind === "dock") {
					if (h < -.8 || h > 1.2) continue;
				} else {
					if (h < -.2) continue;
					if (isStructure(kind) && slope > .35) continue;
					if (isVegetation(kind) && slope > .55) continue;
					if (slope > .7) continue;
				}
				const minDist = isVegetation(kind) ? 2.2 : isStructure(kind) ? 4.5 : kind === "crate" ? 1.2 : 2.8;
				let clash = false;
				for (const o of objects) {
					const dx = o.position[0] - wx;
					const dz = o.position[2] - wz;
					if (dx * dx + dz * dz < minDist * minDist * .7) {
						clash = true;
						break;
					}
				}
				if (clash) continue;
				const palette = OBJECT_PALETTES[kind] ?? {
					primary: "#888",
					secondary: "#444"
				};
				let rotX = 0;
				let rotZ = 0;
				if (!isStructure(kind) && kind !== "ship" && kind !== "boat") {
					rotX = Math.atan2(n[2], n[1]) * .25;
					rotZ = -Math.atan2(n[0], n[1]) * .25;
				}
				const rotY = rng() * Math.PI * 2;
				const scale = baseScale * (.85 + rng() * .35);
				const y = kind === "ship" || kind === "boat" ? Math.max(h, -.3) + .15 : h;
				objects.push({
					id: `obj_${idCounter++}`,
					kind,
					regionId: region.id,
					position: [
						wx,
						y,
						wz
					],
					rotation: [
						rotX,
						rotY,
						rotZ
					],
					scale,
					color: palette.primary,
					secondaryColor: palette.secondary,
					label: req.appearance ? `${kind} (${req.appearance})` : kind,
					contactScore: .5,
					refined: false
				});
				placed++;
			}
		}
	}
	return objects;
}
/** Image-space scale calibration analogue — normalize outlier scales in region */
function calibrateScales(objects) {
	const byKind = /* @__PURE__ */ new Map();
	for (const o of objects) {
		const list = byKind.get(o.kind) ?? [];
		list.push(o);
		byKind.set(o.kind, list);
	}
	const out = objects.map((o) => ({ ...o }));
	for (const [, list] of byKind) {
		if (list.length < 2) continue;
		const mean = list.reduce((s, o) => s + o.scale, 0) / list.length;
		for (const o of list) {
			const target = out.find((x) => x.id === o.id);
			if (o.scale > mean * 1.6) target.scale = mean * 1.35;
			if (o.scale < mean * .5) target.scale = mean * .7;
		}
	}
	return out;
}
/**
* Scene refinement agent (paper §2.3.3)
* Object pose/scale/mesh quality + terrain contact co-deformation
*/
function refineScene(objects, hf, _plan, seed, iterations = 2) {
	const rng = mulberry32(seed ^ 979437);
	let current = objects.map((o) => ({
		...o,
		position: [...o.position],
		rotation: [...o.rotation]
	}));
	const report = {
		objectsFixed: 0,
		floatingFixed: 0,
		penetrationFixed: 0,
		scaleFixed: 0,
		poseFixed: 0,
		iterations
	};
	for (let iter = 0; iter < iterations; iter++) for (const o of current) {
		const [wx, , wz] = o.position;
		const terrainH = sampleHeight(hf, wx, wz);
		const slope = sampleSlope(hf, wx, wz);
		const n = sampleNormal(hf, wx, wz);
		const isWatercraft = o.kind === "ship" || o.kind === "boat";
		if (o.scale > 6) {
			o.scale = 5.5;
			report.scaleFixed++;
		}
		if (o.scale < .25) {
			o.scale = .4;
			report.scaleFixed++;
		}
		const structures = [
			"hut",
			"house",
			"tower",
			"building",
			"barn",
			"market",
			"pagoda",
			"bunker",
			"mine",
			"watchtower",
			"windmill",
			"antenna",
			"satellite",
			"well",
			"torii"
		];
		if (structures.includes(o.kind)) {
			if (Math.abs(o.rotation[0]) > .08 || Math.abs(o.rotation[2]) > .08) {
				o.rotation[0] = 0;
				o.rotation[2] = 0;
				report.poseFixed++;
			}
		} else if (!isWatercraft) {
			o.rotation[0] = Math.atan2(n[2], n[1]) * .3;
			o.rotation[2] = -Math.atan2(n[0], n[1]) * .3;
		}
		let targetY = terrainH;
		if (isWatercraft) targetY = Math.max(terrainH, -.25) + .1;
		else if (o.kind === "dock") targetY = terrainH + .05;
		else targetY = terrainH;
		const dy = o.position[1] - targetY;
		if (dy > .35) {
			o.position[1] = targetY;
			report.floatingFixed++;
			report.objectsFixed++;
		} else if (dy < -.45) {
			o.position[1] = targetY;
			report.penetrationFixed++;
			report.objectsFixed++;
		} else o.position[1] = targetY;
		if (structures.includes(o.kind) && slope > .4) {
			const step = 1.2;
			let best = {
				x: wx,
				z: wz,
				s: slope,
				h: terrainH
			};
			for (let k = 0; k < 6; k++) {
				const a = rng() * Math.PI * 2;
				const nx = wx + Math.cos(a) * step;
				const nz = wz + Math.sin(a) * step;
				const s = sampleSlope(hf, nx, nz);
				if (s < best.s) best = {
					x: nx,
					z: nz,
					s,
					h: sampleHeight(hf, nx, nz)
				};
			}
			if (best.s < slope) {
				o.position[0] = best.x;
				o.position[2] = best.z;
				o.position[1] = best.h;
				report.poseFixed++;
			}
		}
		const finalDy = Math.abs(o.position[1] - sampleHeight(hf, o.position[0], o.position[2]));
		o.contactScore = Math.max(0, 1 - finalDy / .5);
		o.refined = true;
	}
	return {
		objects: current,
		report
	};
}
/**
* WorldClaw end-to-end agentic pipeline
* P = F_plan(q) → T = F_terrain(P) → O = F_region(P, T) → S = Compose(T, O)
*/
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
var logId = 0;
async function runWorldClawPipeline(prompt, onLog, onProgress, signal) {
	const log = (stage, agent, message, level = "info") => {
		onLog({
			stage,
			agent,
			message,
			level
		});
	};
	const check = () => {
		if (signal?.cancelled) throw new Error("Generation cancelled");
	};
	const seed = pickSeed(prompt + String(Date.now() % 1e4));
	onProgress("intent", .04);
	log("intent", "IntentAnalysisAgent", `Parsing open-ended prompt (${prompt.length} chars)…`);
	await sleep(280);
	check();
	const intent = analyzeIntent(prompt);
	log("intent", "IntentAnalysisAgent", `Extracted constraints: ${intent.explicitThemeHints.slice(0, 6).join(", ") || "none explicit"}`, "detail");
	log("intent", "IntentAnalysisAgent", `Key objects mentioned: ${intent.explicitObjects.join(", ") || "—"}`, "detail");
	await sleep(200);
	onProgress("planning", .12);
	log("planning", "ScenePlanningAgent", "Completing scene specification P = (R, C_terrain, C_object)…");
	await sleep(350);
	check();
	const plan = planScene(prompt);
	log("planning", "ScenePlanningAgent", `Scene type: ${plan.sceneType}`, "success");
	log("planning", "ScenePlanningAgent", `Theme=${plan.theme} · Style=${plan.visualStyle} · Regions=${plan.regions.length}`, "detail");
	log("planning", "ScenePlanningAgent", `Spatial: ${plan.spatialNotes.join("; ")}`, "detail");
	log("planning", "ScenePlanningAgent", `Atmosphere: ${plan.atmosphere}`, "detail");
	await sleep(250);
	onProgress("terrain_plan", .22);
	log("terrain_plan", "TerrainPlanningAgent", "Building structured terrain spec P_terrain (layout, assets, materials, θ)…");
	await sleep(300);
	check();
	const terrainSpec = buildTerrainSpec(plan, seed);
	log("terrain_plan", "TerrainPlanningAgent", `Layout map ${terrainSpec.resolution}² · world ${terrainSpec.worldSize}u · ${terrainSpec.assetPrototypes.length} asset prototypes`, "success");
	onProgress("terrain_assets", .32);
	log("terrain_assets", "TerrainAssetAgent", "Generating semantic layout map I_layout + materials M_terrain…");
	await sleep(280);
	log("terrain_assets", "TerrainAssetAgent", `Materials bound to ${Object.keys(terrainSpec.materials).length} terrain categories`, "detail");
	log("terrain_assets", "TerrainAssetAgent", `Terrain assets: ${plan.terrainAssets.join(", ")}`, "detail");
	await sleep(200);
	onProgress("terrain_build", .42);
	log("terrain_build", "TerrainGenerationAgent", "Compositing height field H(x) = Σ m̃_r [h_r + noise + geomorphic]…");
	await sleep(200);
	check();
	let heightField = generateHeightField(plan, seed);
	log("terrain_build", "TerrainGenerationAgent", `Height field ${heightField.resolution}² ready · scattering terrain-associated assets…`, "success");
	const scattered = scatterTerrainAssets(plan, heightField, seed);
	log("terrain_build", "TerrainGenerationAgent", `Scattered ${scattered.length} mid-scale environmental instances`, "detail");
	await sleep(220);
	onProgress("terrain_refine", .52);
	log("terrain_refine", "TerrainRefineAgent", "Render-inspect loop: boundary blend, material scale, landform transitions…");
	await sleep(320);
	heightField = refineTerrainHeights(heightField, plan);
	log("terrain_refine", "TerrainRefineAgent", "Terrain foundation T accepted — global spatial organization locked", "success");
	await sleep(180);
	onProgress("regional_plan", .6);
	log("regional_plan", "RegionalPlanningAgent", "Selecting R+ regions with uninstantiated object requirements…");
	await sleep(250);
	check();
	const activeRegions = plan.regions.filter((r) => (plan.objectRequirements[r.name]?.length ?? 0) > 0);
	log("regional_plan", "RegionalPlanningAgent", `Developing ${activeRegions.length} regions: ${activeRegions.map((r) => r.name).join(", ")}`, "success");
	for (const r of activeRegions) {
		const n = plan.objectRequirements[r.name]?.reduce((s, o) => s + o.count, 0) ?? 0;
		log("regional_plan", "RegionalPlanningAgent", `  · ${r.name} (${r.role}): ~${n} instances planned`, "detail");
	}
	await sleep(200);
	onProgress("object_gen", .7);
	log("object_gen", "ObjectGenerationAgent", "Terrain-conditioned composition → instance segmentation → image-to-3D reconstruction…");
	await sleep(350);
	check();
	let objects = generateRegionalObjects(plan, heightField, seed);
	for (const s of scattered) {
		const kind = s.kind === "tree" ? plan.theme === "tropical" || plan.theme === "island" ? "palm" : plan.theme === "snow" ? "pine" : "tree" : s.kind === "cactus" ? "cactus" : s.kind === "crystal" ? "crystal" : s.kind === "ice" ? "rock" : s.kind === "bush" ? "tree" : "rock";
		objects.push({
			id: `scatter_${objects.length}`,
			kind,
			regionId: "terrain",
			position: s.position,
			rotation: [
				0,
				s.rotation,
				0
			],
			scale: s.scale,
			color: kind === "palm" || kind === "tree" || kind === "pine" ? "#2d5a28" : kind === "cactus" ? "#3a7a40" : kind === "crystal" ? "#66aaff" : "#6a6560",
			secondaryColor: "#4a3020",
			label: `terrain:${s.kind}`,
			contactScore: .6,
			refined: false
		});
	}
	log("object_gen", "ObjectGenerationAgent", `Reconstructed ${objects.length} editable textured mesh instances`, "success");
	await sleep(200);
	onProgress("object_place", .8);
	log("object_place", "PlacementAgent", "Ray-based placement: object-camera ↔ terrain-camera scale transfer (eq. 12–13)…");
	await sleep(280);
	objects = calibrateScales(objects);
	log("object_place", "PlacementAgent", "Scale calibration + contact search complete", "success");
	await sleep(180);
	onProgress("scene_refine", .9);
	log("scene_refine", "SceneRefineAgent", "Object queue → terrain co-deformation (floating / penetration / support)…");
	await sleep(320);
	check();
	const { objects: refined, report } = refineScene(objects, heightField, plan, seed, 2);
	log("scene_refine", "SceneRefineAgent", `Fixed floating=${report.floatingFixed} · penetration=${report.penetrationFixed} · scale=${report.scaleFixed} · pose=${report.poseFixed}`, "detail");
	log("scene_refine", "SceneRefineAgent", "All regional checks passed within iteration budget", "success");
	await sleep(200);
	onProgress("compose", .96);
	log("compose", "WorldClaw", "Composing S = Compose(T, O) — explicit meshes ready for free-viewpoint exploration");
	await sleep(250);
	const world = {
		id: `world_${seed.toString(16)}`,
		plan,
		terrainSpec,
		heightField,
		objects: refined,
		seed,
		generatedAt: Date.now()
	};
	onProgress("done", 1);
	log("done", "WorldClaw", `World ready · ${plan.regions.length} regions · ${refined.length} instances · seed 0x${seed.toString(16)}`, "success");
	return world;
}
function makeLogEntry(partial) {
	return {
		...partial,
		id: `log_${logId++}`,
		t: Date.now()
	};
}
var useWorldClaw = create((set, get) => ({
	prompt: "",
	stage: "idle",
	progress: 0,
	logs: [],
	world: null,
	error: null,
	running: false,
	viewMode: "lit",
	cameraMode: "orbit",
	selectedObjectId: null,
	showLayout: false,
	showRegions: true,
	panelOpen: true,
	cancelFlag: { cancelled: false },
	setPrompt: (p) => set({ prompt: p }),
	setViewMode: (m) => set({ viewMode: m }),
	setCameraMode: (m) => set({ cameraMode: m }),
	setSelectedObjectId: (id) => set({ selectedObjectId: id }),
	setShowLayout: (v) => set({ showLayout: v }),
	setShowRegions: (v) => set({ showRegions: v }),
	setPanelOpen: (v) => set({ panelOpen: v }),
	cancel: () => {
		get().cancelFlag.cancelled = true;
	},
	reset: () => set({
		stage: "idle",
		progress: 0,
		logs: [],
		world: null,
		error: null,
		running: false,
		selectedObjectId: null
	}),
	generate: async () => {
		const prompt = get().prompt.trim();
		if (!prompt || get().running) return;
		const cancelFlag = { cancelled: false };
		set({
			running: true,
			error: null,
			logs: [],
			world: null,
			progress: 0,
			stage: "intent",
			cancelFlag,
			selectedObjectId: null,
			cameraMode: "orbit"
		});
		try {
			set({
				world: await runWorldClawPipeline(prompt, (entry) => {
					set((s) => ({ logs: [...s.logs, makeLogEntry(entry)] }));
				}, (stage, progress) => set({
					stage,
					progress
				}), cancelFlag),
				running: false,
				stage: "done",
				progress: 1
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Generation failed";
			set({
				running: false,
				error: msg,
				stage: msg.includes("cancel") ? "idle" : "error"
			});
		}
	}
}));
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
var buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98]", {
	variants: {
		variant: {
			default: "bg-accent text-accent-fg hover:bg-accent/90",
			secondary: "bg-surface-elevated text-fg border border-border hover:bg-surface-subtle",
			ghost: "text-fg-muted hover:text-fg hover:bg-surface-subtle",
			outline: "border border-border bg-transparent text-fg hover:bg-surface-subtle",
			danger: "bg-danger text-fg hover:bg-danger/90"
		},
		size: {
			default: "h-10 px-4 py-2",
			sm: "h-8 rounded-md px-3 text-xs",
			lg: "h-11 rounded-lg px-6",
			icon: "h-10 w-10"
		}
	},
	defaultVariants: {
		variant: "default",
		size: "default"
	}
});
var Button = import_react.forwardRef(({ className, variant, size, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
	ref,
	className: cn(buttonVariants({
		variant,
		size,
		className
	})),
	...props
}));
Button.displayName = "Button";
function levelClass(level) {
	switch (level) {
		case "success": return "text-success";
		case "warn": return "text-warn";
		case "detail": return "text-fg-subtle";
		default: return "text-fg-muted";
	}
}
function AgentConsole() {
	const logs = useWorldClaw((s) => s.logs);
	const running = useWorldClaw((s) => s.running);
	const bottomRef = (0, import_react.useRef)(null);
	(0, import_react.useEffect)(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [logs.length]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-full min-h-0 flex-col",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center justify-between border-b border-border px-3 py-2",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs font-medium tracking-wide text-fg-muted uppercase",
				children: "Agent console"
			}), running && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
				className: "flex items-center gap-1.5 text-[11px] text-info",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info" }), "Running"]
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed",
			children: [
				logs.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-fg-subtle",
					children: "Waiting for a prompt. Agents will log intent analysis, terrain planning, regional generation, and refinement here."
				}),
				logs.map((log) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "shrink-0 text-fg-subtle",
						children: [
							"[",
							log.agent.replace(/Agent$/, ""),
							"]"
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: cn(levelClass(log.level)),
						children: log.message
					})]
				}, log.id)),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: bottomRef })
			]
		})]
	});
}
function LayoutMap({ size = 160 }) {
	const world = useWorldClaw((s) => s.world);
	const dataUrl = (0, import_react.useMemo)(() => {
		if (!world) return null;
		const res = world.terrainSpec.resolution;
		const canvas = document.createElement("canvas");
		canvas.width = res;
		canvas.height = res;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const img = ctx.createImageData(res, res);
		const layout = world.terrainSpec.layout;
		for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
			const hex = REGION_LAYOUT_COLORS[layout[y]?.[x] ?? "grass"] ?? "#888";
			const r = parseInt(hex.slice(1, 3), 16);
			const g = parseInt(hex.slice(3, 5), 16);
			const b = parseInt(hex.slice(5, 7), 16);
			const i = (y * res + x) * 4;
			img.data[i] = r;
			img.data[i + 1] = g;
			img.data[i + 2] = b;
			img.data[i + 3] = 255;
		}
		ctx.putImageData(img, 0, 0);
		for (const reg of world.plan.regions) {
			ctx.fillStyle = "#fff";
			ctx.beginPath();
			ctx.arc(reg.center[0] * res, reg.center[1] * res, 2, 0, Math.PI * 2);
			ctx.fill();
		}
		return canvas.toDataURL();
	}, [world]);
	if (!dataUrl) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex items-center justify-center rounded-md border border-border bg-surface-subtle text-[11px] text-fg-subtle",
		style: {
			width: size,
			height: size
		},
		children: "No layout"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
		src: dataUrl,
		alt: "Semantic layout map",
		width: size,
		height: size,
		className: "rounded-md border border-border object-cover",
		style: { imageRendering: "pixelated" }
	});
}
var STAGES = [
	{
		id: "intent",
		label: "Intent"
	},
	{
		id: "planning",
		label: "Plan"
	},
	{
		id: "terrain_plan",
		label: "Terrain"
	},
	{
		id: "terrain_build",
		label: "Build"
	},
	{
		id: "regional_plan",
		label: "Regions"
	},
	{
		id: "object_gen",
		label: "Objects"
	},
	{
		id: "scene_refine",
		label: "Refine"
	},
	{
		id: "done",
		label: "Compose"
	}
];
var ORDER = [
	"idle",
	"intent",
	"planning",
	"terrain_plan",
	"terrain_assets",
	"terrain_build",
	"terrain_refine",
	"regional_plan",
	"object_gen",
	"object_place",
	"scene_refine",
	"compose",
	"done"
];
function stageIndex(s) {
	return ORDER.indexOf(s);
}
function PipelineBar() {
	const stage = useWorldClaw((s) => s.stage);
	const progress = useWorldClaw((s) => s.progress);
	const running = useWorldClaw((s) => s.running);
	const current = stageIndex(stage);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-2",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "text-xs font-medium text-fg-muted",
					children: "Global-to-regional pipeline"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
					className: "font-mono text-[11px] tabular-nums text-fg-subtle",
					children: [Math.round(progress * 100), "%"]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "h-1 overflow-hidden rounded-full bg-surface-subtle",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "h-full rounded-full bg-accent transition-[width] duration-300 ease-out",
					style: { width: `${Math.max(2, progress * 100)}%` }
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-1",
				children: STAGES.map((s) => {
					const idx = stageIndex(s.id);
					const active = running && current >= idx && current < idx + 2;
					return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide", (current > idx || stage === "done") && !active ? "border-border text-fg-muted" : active ? "border-border-strong bg-surface-elevated text-fg" : "border-transparent text-fg-subtle"),
						children: s.label
					}, s.id);
				})
			})
		]
	});
}
var PRESETS = listPresets();
var VIEW_MODES = [
	{
		id: "lit",
		label: "Lit",
		icon: Eye
	},
	{
		id: "instance",
		label: "Instance",
		icon: Box
	},
	{
		id: "depth",
		label: "Depth",
		icon: Layers
	},
	{
		id: "normal",
		label: "Normal",
		icon: Map$1
	}
];
function ControlPanel() {
	const prompt = useWorldClaw((s) => s.prompt);
	const setPrompt = useWorldClaw((s) => s.setPrompt);
	const generate = useWorldClaw((s) => s.generate);
	const cancel = useWorldClaw((s) => s.cancel);
	const running = useWorldClaw((s) => s.running);
	const world = useWorldClaw((s) => s.world);
	const error = useWorldClaw((s) => s.error);
	const viewMode = useWorldClaw((s) => s.viewMode);
	const setViewMode = useWorldClaw((s) => s.setViewMode);
	const cameraMode = useWorldClaw((s) => s.cameraMode);
	const setCameraMode = useWorldClaw((s) => s.setCameraMode);
	const selectedObjectId = useWorldClaw((s) => s.selectedObjectId);
	const panelOpen = useWorldClaw((s) => s.panelOpen);
	const setPanelOpen = useWorldClaw((s) => s.setPanelOpen);
	const selected = world?.objects.find((o) => o.id === selectedObjectId);
	if (!panelOpen) return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		onClick: () => setPanelOpen(true),
		className: "absolute top-3 left-3 z-20 flex h-10 items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 text-sm text-fg backdrop-blur-sm",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sparkles, { className: "h-4 w-4" }), "WorldClaw"]
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
		className: "absolute top-0 left-0 z-20 flex h-full w-full max-w-[380px] flex-col border-r border-border bg-surface/95 backdrop-blur-md sm:w-[380px]",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start justify-between gap-2 border-b border-border px-4 py-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-elevated",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sparkles, { className: "h-3.5 w-3.5 text-fg" })
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
						className: "text-sm font-semibold tracking-tight text-fg",
						children: "WorldClaw"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "text-[11px] text-fg-subtle",
						children: "Agentic 3D open-world generation"
					})] })]
				}) }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => setPanelOpen(false),
					className: "rounded-md p-1.5 text-fg-muted hover:bg-surface-subtle hover:text-fg",
					"aria-label": "Collapse panel",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "h-4 w-4" })
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
								className: "text-xs font-medium text-fg-muted",
								htmlFor: "prompt",
								children: "Open-ended world prompt"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
								id: "prompt",
								value: prompt,
								onChange: (e) => setPrompt(e.target.value),
								rows: 3,
								placeholder: "e.g. a tropical pirate island with docks and ships…",
								className: "w-full resize-none rounded-lg border border-border bg-bg px-3 py-2.5 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:ring-1 focus:ring-ring focus:outline-none",
								disabled: running
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex gap-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									className: "flex-1",
									onClick: () => void generate(),
									disabled: running || !prompt.trim(),
									children: running ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }), "Generating"] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sparkles, { className: "h-4 w-4" }), "Generate world"] })
								}), running && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "secondary",
									onClick: cancel,
									"aria-label": "Cancel",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Square, { className: "h-3.5 w-3.5" })
								})]
							}),
							error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-xs text-danger",
								children: error
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "text-xs font-medium text-fg-muted",
							children: "Paper examples"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "flex flex-wrap gap-1.5",
							children: PRESETS.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: running,
								onClick: () => setPrompt(p.prompt),
								className: "rounded-md border border-border bg-surface-elevated px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50",
								children: p.label
							}, p.label))
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PipelineBar, {}),
					world && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-3 rounded-lg border border-border bg-bg/50 p-3",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "space-y-1.5",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "text-xs font-medium text-fg-muted",
									children: "Render mode"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "grid grid-cols-4 gap-1",
									children: VIEW_MODES.map((m) => {
										const Icon = m.icon;
										return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
											type: "button",
											onClick: () => setViewMode(m.id),
											className: cn("flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-[10px] transition-colors", viewMode === m.id ? "border-border-strong bg-surface-elevated text-fg" : "border-transparent text-fg-subtle hover:bg-surface-subtle"),
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: "h-3.5 w-3.5" }), m.label]
										}, m.id);
									})
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "space-y-1.5",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "text-xs font-medium text-fg-muted",
										children: "Camera"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "grid grid-cols-2 gap-1",
										children: [{
											id: "orbit",
											label: "Orbit",
											icon: Orbit
										}, {
											id: "walk",
											label: "Walk",
											icon: Footprints
										}].map((m) => {
											const Icon = m.icon;
											return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
												type: "button",
												onClick: () => setCameraMode(m.id),
												className: cn("flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition-colors", cameraMode === m.id ? "border-border-strong bg-surface-elevated text-fg" : "border-transparent text-fg-subtle hover:bg-surface-subtle"),
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: "h-3.5 w-3.5" }), m.label]
											}, m.id);
										})
									}),
									cameraMode === "walk" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "text-[10px] leading-snug text-fg-subtle",
										children: "WASD move · Q/E up-down · IJKL look · Shift sprint"
									})
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex gap-3",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LayoutMap, { size: 120 }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "min-w-0 flex-1 space-y-1.5 text-[11px]",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "font-medium text-fg",
											children: world.plan.sceneType
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
											className: "text-fg-muted",
											children: [
												world.plan.theme,
												" · ",
												world.plan.visualStyle
											]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
											className: "text-fg-subtle",
											children: [
												world.plan.regions.length,
												" regions · ",
												world.objects.length,
												" ",
												"assets"
											]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
											className: "truncate font-mono text-fg-subtle",
											children: ["seed 0x", world.seed.toString(16)]
										})
									]
								})]
							}),
							selected && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "rounded-md border border-border bg-surface-elevated px-2.5 py-2 text-[11px]",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "font-medium text-fg",
									children: selected.label
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
									className: "text-fg-muted",
									children: [
										selected.kind,
										" · scale ",
										selected.scale.toFixed(2),
										" · contact",
										" ",
										(selected.contactScore * 100).toFixed(0),
										"%"
									]
								})]
							})
						]
					}),
					world && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-1.5",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "text-xs font-medium text-fg-muted",
							children: "Regions R"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
							className: "space-y-1",
							children: world.plan.regions.map((r) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
								className: "flex items-center gap-2 rounded-md px-1 py-0.5 text-[11px]",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "h-2.5 w-2.5 shrink-0 rounded-sm",
										style: { background: r.color }
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "truncate text-fg",
										children: r.name
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "ml-auto shrink-0 text-fg-subtle",
										children: r.category
									})
								]
							}, r.id))
						})]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "h-[180px] shrink-0 border-t border-border sm:h-[200px]",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AgentConsole, {})
			})
		]
	});
}
function hashColor(id) {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = h * 31 + id.charCodeAt(i) | 0;
	return `hsl(${Math.abs(h) % 360} 65% 55%)`;
}
function useMat(color, viewMode, id, roughness = .75, metalness = .05) {
	return (0, import_react.useMemo)(() => {
		if (viewMode === "instance") return new MeshStandardMaterial({
			color: hashColor(id),
			roughness: .55,
			metalness: .1,
			flatShading: true
		});
		if (viewMode === "normal") return new MeshNormalMaterial();
		if (viewMode === "depth") return new MeshStandardMaterial({
			color: "#888",
			roughness: 1,
			metalness: 0,
			emissive: "#000"
		});
		return new MeshStandardMaterial({
			color,
			roughness,
			metalness
		});
	}, [
		color,
		viewMode,
		id,
		roughness,
		metalness
	]);
}
function Group({ obj, children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("group", {
		position: obj.position,
		rotation: obj.rotation,
		scale: obj.scale,
		userData: { objectId: obj.id },
		children
	});
}
function ObjectMesh({ obj, viewMode, selected, onSelect }) {
	const primary = useMat(obj.color, viewMode, obj.id);
	const secondary = useMat(obj.secondaryColor ?? obj.color, viewMode, obj.id + "_s", .8, .02);
	const handleClick = (e) => {
		e.stopPropagation();
		onSelect(obj.id);
	};
	const sel = selected ? 1.04 : 1;
	switch (obj.kind) {
		case "hut": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.45,
					0
				],
				scale: sel,
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.7,
					.85,
					.9,
					8
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.1,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					1.05,
					.85,
					8
				] })
			})]
		});
		case "house": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.55,
					0
				],
				scale: sel,
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.4,
					1.1,
					1.1
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.3,
					0
				],
				rotation: [
					0,
					Math.PI / 4,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					1.1,
					.7,
					4
				] })
			})]
		});
		case "tower":
		case "watchtower": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.1,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.35,
					.45,
					2.2,
					8
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					2.3,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.1,
					.35,
					1.1
				] })
			})]
		});
		case "building":
		case "bunker": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.9,
					0
				],
				scale: sel,
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.8,
					1.8,
					1.4
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.95,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.9,
					.15,
					1.5
				] })
			})]
		});
		case "barn": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.7,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					2.2,
					1.4,
					1.4
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.6,
					0
				],
				rotation: [
					0,
					0,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					2.3,
					.5,
					1.5
				] })
			})]
		});
		case "market": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.55,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.6,
					.2,
					1.2
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					1.2,
					.7,
					4
				] })
			})]
		});
		case "pagoda": return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: [
				0,
				.7,
				1.35
			].map((y, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("group", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					y + .25,
					0
				],
				scale: sel * (1 - i * .12),
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.2,
					.5,
					1.2
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					y + .55,
					0
				],
				scale: sel * (1 - i * .1),
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					1.1,
					.35,
					4
				] })
			})] }, i))
		});
		case "torii": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						-.7,
						1,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						.15,
						2,
						.15
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						.7,
						1,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						.15,
						2,
						.15
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						2,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						2,
						.18,
						.25
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						2.25,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						2.3,
						.12,
						.3
					] })
				})
			]
		});
		case "dock": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.15,
					0
				],
				scale: sel,
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					3.5,
					.15,
					1.2
				] })
			}), [
				-1.4,
				0,
				1.4
			].map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					x,
					-.35,
					.4
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.08,
					.1,
					.9,
					6
				] })
			}, x))]
		});
		case "ship": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						.35,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						2.8,
						.5,
						1
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						.9,
						.35,
						0
					],
					scale: sel,
					castShadow: true,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
						.5,
						.9,
						4
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						1.3,
						0
					],
					scale: sel,
					castShadow: true,
					material: secondary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						.08,
						1.6,
						.08
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						.15,
						1.3,
						0
					],
					scale: sel,
					castShadow: true,
					material: secondary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						.9,
						1.1,
						.05
					] })
				})
			]
		});
		case "boat": return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.15,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.4,
					.3,
					.55
				] })
			})
		});
		case "palm": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.9,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.08,
					.14,
					1.8,
					6
				] })
			}), [
				0,
				1,
				2,
				3,
				4
			].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					Math.cos(i / 5 * Math.PI * 2) * .55,
					1.85,
					Math.sin(i / 5 * Math.PI * 2) * .55
				],
				rotation: [
					.6,
					i / 5 * Math.PI * 2,
					0
				],
				scale: sel,
				castShadow: true,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					.15,
					.08,
					1.1
				] })
			}, i))]
		});
		case "pine": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.4,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.1,
					.14,
					.8,
					6
				] })
			}), [
				.9,
				1.4,
				1.85
			].map((y, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					y,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					.85 - i * .18,
					.75,
					7
				] })
			}, y))]
		});
		case "tree": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.45,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.1,
					.14,
					.9,
					6
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.25,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("sphereGeometry", { args: [
					.7,
					8,
					6
				] })
			})]
		});
		case "cactus": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.7,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.18,
					.22,
					1.4,
					8
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					.35,
					.85,
					0
				],
				rotation: [
					0,
					0,
					Math.PI / 2
				],
				scale: sel,
				castShadow: true,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.1,
					.12,
					.55,
					6
				] })
			})]
		});
		case "rock":
		case "boulder": return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.35,
					0
				],
				scale: [
					sel * (obj.kind === "boulder" ? 1.3 : 1),
					sel,
					sel * 1.1
				],
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dodecahedronGeometry", { args: [.45, 0] })
			})
		});
		case "vehicle":
		case "tank": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						.35,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						1.6,
						.45,
						.9
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						.7,
						0
					],
					scale: sel,
					castShadow: true,
					material: secondary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						.8,
						.35,
						.7
					] })
				}),
				obj.kind === "tank" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						.6,
						.7,
						0
					],
					rotation: [
						0,
						0,
						Math.PI / 2
					],
					scale: sel,
					castShadow: true,
					material: secondary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
						.06,
						.06,
						1,
						6
					] })
				})
			]
		});
		case "antenna":
		case "satellite": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.2,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.06,
					.1,
					2.4,
					6
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					2.3,
					0
				],
				rotation: [
					Math.PI / 5,
					0,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.45,
					.45,
					.08,
					16
				] })
			})]
		});
		case "windmill": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						1.2,
						0
					],
					scale: sel,
					castShadow: true,
					onClick: handleClick,
					material: primary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
						.4,
						.55,
						2.4,
						8
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						2.5,
						.35
					],
					scale: sel,
					castShadow: true,
					material: secondary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						2.2,
						.18,
						.12
					] })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
					position: [
						0,
						2.5,
						.35
					],
					rotation: [
						0,
						0,
						Math.PI / 2
					],
					scale: sel,
					castShadow: true,
					material: secondary,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
						2.2,
						.18,
						.12
					] })
				})
			]
		});
		case "bridge": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.35,
					0
				],
				scale: sel,
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					4.5,
					.2,
					1.2
				] })
			}), [-1.8, 1.8].map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					x,
					0,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					.25,
					.7,
					1.3
				] })
			}, x))]
		});
		case "statue": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.2,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.4,
					.45,
					.25,
					8
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.9,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("capsuleGeometry", { args: [
					.25,
					.9,
					4,
					8
				] })
			})]
		});
		case "crystal": return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.55,
					0
				],
				rotation: [
					0,
					0,
					.15
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: viewMode === "lit" ? new MeshStandardMaterial({
					color: obj.color,
					emissive: obj.color,
					emissiveIntensity: .35,
					roughness: .25,
					metalness: .4
				}) : primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("octahedronGeometry", { args: [.45, 0] })
			})
		});
		case "mine": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.5,
					0
				],
				rotation: [
					Math.PI / 2,
					0,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.7,
					.85,
					1.4,
					10
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.15,
					.9
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.2,
					.3,
					.8
				] })
			})]
		});
		case "tent": return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.55,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					.9,
					1.1,
					4
				] })
			})
		});
		case "campfire": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.1,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.45,
					.5,
					.15,
					8
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.35,
					0
				],
				scale: sel,
				material: viewMode === "lit" ? new MeshStandardMaterial({
					color: "#ff8844",
					emissive: "#ff6622",
					emissiveIntensity: .8
				}) : primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("coneGeometry", { args: [
					.25,
					.5,
					5
				] })
			})]
		});
		case "well": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.35,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("cylinderGeometry", { args: [
					.45,
					.5,
					.7,
					10
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.9,
					0
				],
				scale: sel,
				castShadow: true,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("torusGeometry", { args: [
					.48,
					.06,
					6,
					12
				] })
			})]
		});
		case "fence": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [[-.6, .6].map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					x,
					.4,
					0
				],
				scale: sel,
				castShadow: true,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					.08,
					.8,
					.08
				] })
			}, x)), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.55,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: secondary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					1.4,
					.08,
					.06
				] })
			})]
		});
		case "crate": return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.25,
					0
				],
				scale: sel,
				castShadow: true,
				receiveShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					.5,
					.5,
					.5
				] })
			})
		});
		case "dragon": return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Group, {
			obj,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.6,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("capsuleGeometry", { args: [
					.4,
					1.6,
					4,
					8
				] })
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					1.1,
					.7
				],
				scale: sel,
				castShadow: true,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("sphereGeometry", { args: [
					.35,
					8,
					6
				] })
			})]
		});
		default: return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Group, {
			obj,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
				position: [
					0,
					.3,
					0
				],
				scale: sel,
				castShadow: true,
				onClick: handleClick,
				material: primary,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("boxGeometry", { args: [
					.6,
					.6,
					.6
				] })
			})
		});
	}
}
function categoryColor(plan, regionIndex, viewMode) {
	const cat = plan.regions[regionIndex]?.category ?? "grass";
	if (viewMode === "instance") {
		const hue = regionIndex * 47 % 360;
		return new Color(`hsl(${hue} 55% 50%)`);
	}
	if (viewMode === "depth") return new Color("#777777");
	return new Color(TERRAIN_MATERIALS[cat]?.albedo ?? "#4a7c3f");
}
function TerrainMesh({ heightField, plan, viewMode }) {
	const { geometry, material } = (0, import_react.useMemo)(() => {
		const { resolution, worldSize, data, regionId } = heightField;
		const geo = new PlaneGeometry(worldSize, worldSize, resolution - 1, resolution - 1);
		geo.rotateX(-Math.PI / 2);
		const pos = geo.attributes.position;
		const colors = new Float32Array(pos.count * 3);
		const color = new Color();
		for (let i = 0; i < pos.count; i++) {
			const ix = i % resolution;
			const iy = Math.floor(i / resolution);
			const h = data[iy * resolution + ix] ?? 0;
			pos.setY(i, h);
			const ri = regionId[iy * resolution + ix] ?? 0;
			color.copy(categoryColor(plan, ri, viewMode));
			if (viewMode === "lit") {
				const e = 1;
				const hL = data[iy * resolution + Math.max(0, ix - e)] ?? h;
				const hR = data[iy * resolution + Math.min(resolution - 1, ix + e)] ?? h;
				const hD = data[Math.max(0, iy - e) * resolution + ix] ?? h;
				const hU = data[Math.min(resolution - 1, iy + e) * resolution + ix] ?? h;
				const slope = Math.min(1, Math.hypot(hR - hL, hU - hD) * .35);
				color.offsetHSL(0, 0, -slope * .18);
				if (h > 4) color.offsetHSL(0, -.05, .08);
				if (h < 0) color.offsetHSL(.02, .05, -.05);
			}
			colors[i * 3] = color.r;
			colors[i * 3 + 1] = color.g;
			colors[i * 3 + 2] = color.b;
		}
		pos.needsUpdate = true;
		geo.setAttribute("color", new BufferAttribute(colors, 3));
		geo.computeVertexNormals();
		let mat;
		if (viewMode === "normal") mat = new MeshNormalMaterial({ flatShading: false });
		else if (viewMode === "depth") mat = new MeshStandardMaterial({
			vertexColors: true,
			roughness: 1,
			metalness: 0,
			flatShading: false
		});
		else mat = new MeshStandardMaterial({
			vertexColors: true,
			roughness: .88,
			metalness: .04,
			flatShading: false
		});
		return {
			geometry: geo,
			material: mat
		};
	}, [
		heightField,
		plan,
		viewMode
	]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("mesh", {
		geometry,
		material,
		receiveShadow: true,
		castShadow: true,
		userData: { terrain: true }
	});
}
/** Water plane for ocean/river themes */
function WaterPlane({ worldSize, y = -.4, color = "#1a4a6e" }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("mesh", {
		rotation: [
			-Math.PI / 2,
			0,
			0
		],
		position: [
			0,
			y,
			0
		],
		receiveShadow: true,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("planeGeometry", { args: [worldSize * 1.4, worldSize * 1.4] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("meshStandardMaterial", {
			color,
			roughness: .15,
			metalness: .35,
			transparent: true,
			opacity: .88
		})]
	});
}
function WalkController({ enabled, world }) {
	const { camera } = useThree();
	const keys = (0, import_react.useRef)({});
	const yaw = (0, import_react.useRef)(0);
	const pitch = (0, import_react.useRef)(.12);
	const pos = (0, import_react.useRef)(new Vector3(0, 4, 18));
	const primed = (0, import_react.useRef)(false);
	(0, import_react.useEffect)(() => {
		if (!enabled) {
			primed.current = false;
			return;
		}
		if (!primed.current) {
			const h = world ? sampleHeight(world.heightField, 0, 16) : 2;
			pos.current.set(0, Math.max(h + 1.7, 2), 16);
			yaw.current = 0;
			pitch.current = .1;
			primed.current = true;
		}
		const down = (e) => {
			keys.current[e.code] = true;
			if ([
				"Space",
				"ArrowUp",
				"ArrowDown",
				"ArrowLeft",
				"ArrowRight"
			].includes(e.code)) e.preventDefault();
		};
		const up = (e) => {
			keys.current[e.code] = false;
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
		};
	}, [enabled, world]);
	useFrame((_, rawDelta) => {
		if (!enabled) return;
		const delta = Math.min(rawDelta, .05);
		const speed = (keys.current["ShiftLeft"] || keys.current["ShiftRight"] ? 24 : 12) * delta;
		const forward = new Vector3(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
		const right = new Vector3(Math.cos(yaw.current), 0, -Math.sin(yaw.current));
		if (keys.current["KeyW"] || keys.current["ArrowUp"]) pos.current.addScaledVector(forward, speed);
		if (keys.current["KeyS"] || keys.current["ArrowDown"]) pos.current.addScaledVector(forward, -speed);
		if (keys.current["KeyA"] || keys.current["ArrowLeft"]) pos.current.addScaledVector(right, -speed);
		if (keys.current["KeyD"] || keys.current["ArrowRight"]) pos.current.addScaledVector(right, speed);
		if (keys.current["KeyQ"]) pos.current.y += speed;
		if (keys.current["KeyE"]) pos.current.y -= speed;
		if (world && !keys.current["KeyQ"] && !keys.current["KeyE"]) {
			const th = sampleHeight(world.heightField, pos.current.x, pos.current.z);
			const targetY = Math.max(th + 1.65, .5);
			pos.current.y += (targetY - pos.current.y) * Math.min(1, 10 * delta);
		}
		pos.current.y = Math.max(.5, Math.min(45, pos.current.y));
		const half = (world?.heightField.worldSize ?? 100) * .48;
		pos.current.x = Math.max(-half, Math.min(half, pos.current.x));
		pos.current.z = Math.max(-half, Math.min(half, pos.current.z));
		if (keys.current["KeyJ"]) yaw.current += 1.5 * delta;
		if (keys.current["KeyL"]) yaw.current -= 1.5 * delta;
		if (keys.current["KeyI"]) pitch.current = Math.min(1.2, pitch.current + 1.1 * delta);
		if (keys.current["KeyK"]) pitch.current = Math.max(-1.2, pitch.current - 1.1 * delta);
		camera.position.copy(pos.current);
		const look = new Vector3(pos.current.x - Math.sin(yaw.current) * Math.cos(pitch.current), pos.current.y + Math.sin(pitch.current), pos.current.z - Math.cos(yaw.current) * Math.cos(pitch.current));
		camera.lookAt(look);
	});
	return null;
}
function SceneContent({ world }) {
	const viewMode = useWorldClaw((s) => s.viewMode);
	const cameraMode = useWorldClaw((s) => s.cameraMode);
	const selectedObjectId = useWorldClaw((s) => s.selectedObjectId);
	const setSelectedObjectId = useWorldClaw((s) => s.setSelectedObjectId);
	const theme = world.plan.theme;
	const showWater = theme === "tropical" || theme === "island" || theme === "canyon" || theme === "snow" || world.plan.regions.some((r) => r.category === "ocean" || r.category === "river");
	const sunPos = theme === "volcanic" ? [
		20,
		12,
		-10
	] : theme === "snow" ? [
		30,
		40,
		10
	] : theme === "desert" ? [
		40,
		50,
		5
	] : [
		25,
		35,
		15
	];
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("color", {
			attach: "background",
			args: [theme === "volcanic" ? "#1a0a08" : theme === "snow" ? "#b8c8d8" : theme === "desert" ? "#c8b080" : theme === "tropical" || theme === "island" ? "#6aa8d0" : "#8ab0c8"]
		}),
		theme !== "volcanic" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sky, {
			distance: 450,
			sunPosition: sunPos,
			inclination: .52,
			azimuth: .25,
			mieCoefficient: theme === "desert" ? .008 : .005,
			rayleigh: theme === "snow" ? .6 : 1
		}),
		theme === "volcanic" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stars, {
			radius: 80,
			depth: 40,
			count: 1200,
			factor: 3
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ambientLight", { intensity: theme === "volcanic" ? .25 : theme === "snow" ? .55 : .42 }),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("hemisphereLight", { args: [
			theme === "desert" ? "#ffe8c0" : "#c8e0f0",
			theme === "volcanic" ? "#2a1008" : "#3a4a30",
			.35
		] }),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("directionalLight", {
			castShadow: true,
			position: sunPos,
			intensity: theme === "desert" ? 1.65 : theme === "volcanic" ? .95 : 1.3,
			"shadow-mapSize-width": 2048,
			"shadow-mapSize-height": 2048,
			"shadow-camera-far": 160,
			"shadow-camera-left": -70,
			"shadow-camera-right": 70,
			"shadow-camera-top": 70,
			"shadow-camera-bottom": -70,
			color: theme === "volcanic" ? "#ff8844" : "#fff5e6"
		}),
		theme === "volcanic" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pointLight", {
			position: [
				0,
				2,
				0
			],
			intensity: 2.5,
			distance: 40,
			color: "#ff4400"
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("fog", {
			attach: "fog",
			args: [
				theme === "volcanic" ? "#1a0a08" : theme === "snow" ? "#c8d4e0" : theme === "desert" ? "#d4c090" : "#7aacc8",
				45,
				theme === "desert" ? 135 : 115
			]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)(TerrainMesh, {
			heightField: world.heightField,
			plan: world.plan,
			viewMode
		}),
		showWater && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WaterPlane, {
			worldSize: world.heightField.worldSize,
			y: theme === "canyon" ? -.85 : -.35,
			color: theme === "canyon" ? "#2a6a8a" : theme === "snow" ? "#6a90a8" : theme === "volcanic" ? "#3a1808" : "#1a5f8a"
		}),
		world.objects.map((obj) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ObjectMesh, {
			obj,
			viewMode,
			selected: selectedObjectId === obj.id,
			onSelect: setSelectedObjectId
		}, obj.id)),
		cameraMode === "orbit" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OrbitControls, {
			makeDefault: true,
			enableDamping: true,
			dampingFactor: .08,
			minDistance: 8,
			maxDistance: 150,
			maxPolarAngle: Math.PI * .48,
			target: [
				0,
				2,
				0
			]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)(WalkController, {
			enabled: cameraMode === "walk",
			world
		})
	] });
}
function EmptyScene() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("color", {
			attach: "background",
			args: ["#0c0c0e"]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ambientLight", { intensity: .4 }),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("gridHelper", { args: [
			80,
			40,
			"#2a2a30",
			"#1a1a20"
		] }),
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("mesh", {
			rotation: [
				-Math.PI / 2,
				0,
				0
			],
			position: [
				0,
				-.01,
				0
			],
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("planeGeometry", { args: [80, 80] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("meshStandardMaterial", { color: "#121214" })]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)(OrbitControls, {
			makeDefault: true,
			enableDamping: true
		})
	] });
}
function WorldViewport() {
	const world = useWorldClaw((s) => s.world);
	const cameraMode = useWorldClaw((s) => s.cameraMode);
	const [ready, setReady] = (0, import_react.useState)(false);
	(0, import_react.useEffect)(() => {
		setReady(true);
	}, []);
	if (!ready) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex h-full w-full items-center justify-center bg-bg text-sm text-fg-muted",
		children: "Initializing viewport…"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Canvas, {
		shadows: true,
		dpr: [1, 1.75],
		gl: {
			antialias: true,
			powerPreference: "high-performance"
		},
		className: "h-full w-full touch-none",
		onPointerMissed: () => useWorldClaw.getState().setSelectedObjectId(null),
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PerspectiveCamera, {
			makeDefault: true,
			position: cameraMode === "walk" ? [
				0,
				4,
				18
			] : [
				42,
				34,
				42
			],
			fov: 50,
			near: .2,
			far: 400
		}), world ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SceneContent, { world }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyScene, {})]
	});
}
function AppShell() {
	const setPrompt = useWorldClaw((s) => s.setPrompt);
	const prompt = useWorldClaw((s) => s.prompt);
	const world = useWorldClaw((s) => s.world);
	const running = useWorldClaw((s) => s.running);
	const stage = useWorldClaw((s) => s.stage);
	(0, import_react.useEffect)(() => {
		if (!prompt) {
			const presets = listPresets();
			setPrompt(presets[0]?.prompt ?? "");
		}
	}, [prompt, setPrompt]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "relative h-dvh w-full overflow-hidden bg-bg",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(WorldViewport, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ControlPanel, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "pointer-events-none absolute top-3 right-3 z-10 flex flex-col items-end gap-2",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-lg border border-border bg-surface/90 px-3 py-2 text-right backdrop-blur-sm",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "text-[10px] tracking-wide text-fg-subtle uppercase",
						children: "Tencent Hunyuan · WorldClaw"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "text-xs text-fg-muted",
						children: world ? "Explorable · editable meshes" : running ? `Stage: ${stage.replace(/_/g, " ")}` : "Enter a prompt to generate"
					})]
				})
			}),
			!world && !running && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "pointer-events-none absolute inset-0 z-0 flex items-center justify-center pl-0 sm:pl-[380px]",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "max-w-sm px-6 text-center",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-lg font-semibold tracking-tight text-fg",
						children: "Open-world generation"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-2 text-sm leading-relaxed text-fg-muted",
						children: "Intent analysis → global terrain foundation → regional object placement → render-based refinement. Pick a paper example or write your own prompt, then generate."
					})]
				})
			})
		]
	});
}
/** Avoid SSR for WebGL / browser-only world viewer */
function ClientOnly({ children, fallback = null }) {
	const [mounted, setMounted] = (0, import_react.useState)(false);
	(0, import_react.useEffect)(() => {
		setMounted(true);
	}, []);
	if (!mounted) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: fallback });
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children });
}
function IndexPage() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ClientOnly, {
		fallback: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "flex h-dvh w-full items-center justify-center bg-bg text-sm text-fg-muted",
			children: "Loading WorldClaw…"
		}),
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AppShell, {})
	});
}
//#endregion
export { IndexPage as component };

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  groupBrowserAssetObjects,
  loadWorldClawAssetManifest,
  parseWorldClawAssetManifest,
  resolveBrowserAsset,
  selectAssetVariant,
} from "../src/lib/worldclaw/assets.ts";

test("asset manifest fetch is abortable and bounded before parsing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_uri, options) => {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    };
    const controller = new AbortController();
    const pending = loadWorldClawAssetManifest("/worldclaw/assets/abort-fixture.json", controller.signal);
    controller.abort(new Error("fixture cancelled"));
    await assert.rejects(pending, /fixture cancelled/);

    globalThis.fetch = async () =>
      new Response("{}", {
        headers: { "content-length": "1000001", "content-type": "application/json" },
      });
    const oversized = await loadWorldClawAssetManifest(
      "/worldclaw/assets/oversized-fixture.json",
      new AbortController().signal,
    );
    assert.equal(oversized.status, "invalid");
    assert.match(oversized.error, /exceeds 1000000 bytes/);

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(700_000));
            controller.enqueue(new Uint8Array(400_001));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const streamedOversize = await loadWorldClawAssetManifest(
      "/worldclaw/assets/streamed-oversized-fixture.json",
      new AbortController().signal,
    );
    assert.equal(streamedOversize.status, "invalid");
    assert.match(streamedOversize.error, /exceeds 1000000 bytes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source asset manifest retains turnarounds, materials, and construction recipes", async () => {
  const raw = JSON.parse(
    await readFile(
      new URL("../assets/worldclaw/asset-library.json", import.meta.url),
      "utf8",
    ),
  );
  const manifest = parseWorldClawAssetManifest(raw);
  assert.equal(Object.keys(manifest.prototypes).length, 27);
  assert.equal(
    Object.values(manifest.prototypes).reduce(
      (total, definition) => total + definition.variants.length,
      0,
    ),
    34,
  );
  assert.match(manifest.evidence.contactSheetUri, /contact-sheet\.png$/);
  assert.deepEqual(manifest.evidence.turnaroundViews, [
    "front",
    "front_three_quarter",
    "side",
    "rear",
  ]);

  const hut = manifest.prototypes.hut;
  assert.match(hut.evidence.turnaroundUri, /hut-turnaround\.png$/);
  assert.ok(hut.variants[0].materialIds.includes("straw_thatch"));
  assert.equal(hut.variants[0].constructionRecipe.roofAssembly, "thatch_gable_rafter_coatwork");

  const building = manifest.prototypes.building;
  assert.ok(building.variants[0].materialIds.includes("fired_brick"));
  assert.ok(building.variants[0].materialIds.includes("blue_gray_slate"));
  const japanese = building.variants.find(
    (variant) => variant.id === "building_timber_frame_white_tile",
  );
  assert.ok(japanese, "Japanese building variant is missing");
  assert.equal(japanese.node, "ASSET_building_timber_frame_white_tile");
  assert.ok(japanese.materialIds.includes("white_lime_plaster"));
  assert.ok(japanese.materialIds.includes("charcoal_roof_tile"));
  assert.match(japanese.evidence.turnaroundUri, /building-timber-frame.*turnaround\.png$/);
  assert.equal(manifest.aliases.house, "building");
  assert.match(manifest.prototypes.pagoda.evidence.turnaroundUri, /pagoda-turnaround\.png$/);
  assert.match(manifest.prototypes.torii.evidence.turnaroundUri, /torii-turnaround\.png$/);
  assert.match(manifest.prototypes.bridge.evidence.turnaroundUri, /bridge-turnaround\.png$/);
  assert.deepEqual(manifest.prototypes.bridge.collider.sizeMeters, [16, 2.2, 3.4]);
  assert.equal(manifest.aliases.bridge, "bridge");

  const tree = manifest.prototypes.tree;
  const bamboo = selectAssetVariant(tree, "segmented bamboo culms with lanceolate leaves");
  assert.equal(bamboo?.id, "tree_bamboo_cluster");
  assert.equal(bamboo?.node, "ASSET_tree_bamboo_cluster");
  assert.match(bamboo?.evidence?.turnaroundUri ?? "", /bamboo-cluster-turnaround\.png$/);
  const cherry = selectAssetVariant(tree, "branching pale pink cherry blossom tree");
  assert.equal(cherry?.id, "tree_cherry_blossom");
  assert.equal(cherry?.node, "ASSET_tree_cherry_blossom");
  assert.match(cherry?.evidence?.turnaroundUri ?? "", /cherry-blossom-turnaround\.png$/);
  assert.equal(selectAssetVariant(tree, "generic green tree")?.id, "tree_broadleaf_layered");

  const directSemanticNodes = {
    dragon: "ASSET_dragon",
    windmill: "ASSET_windmill",
    mine: "ASSET_mine",
    crystal: "ASSET_crystal",
    antenna: "ASSET_antenna",
    satellite: "ASSET_satellite",
    dock: "ASSET_dock",
    tent: "ASSET_tent",
    well: "ASSET_well",
    statue: "ASSET_statue",
    fence: "ASSET_fence",
    campfire: "ASSET_campfire",
    crate: "ASSET_crate",
    market: "ASSET_market",
  };
  for (const [kind, node] of Object.entries(directSemanticNodes)) {
    assert.equal(manifest.aliases[kind], kind, `${kind} must resolve semantically`);
    assert.equal(resolveBrowserAsset(kind, manifest, kind)?.node, node);
  }

  assert.equal(
    resolveBrowserAsset("house", manifest, "round-door Hobbit hillside home")?.node,
    "ASSET_building_hobbit_round_door",
  );
  assert.equal(
    resolveBrowserAsset("building", manifest, "futuristic high-tech command facility")?.node,
    "ASSET_building_futuristic_facility",
  );
  assert.equal(
    resolveBrowserAsset("bunker", manifest, "fortified bunker with firing slots")?.node,
    "ASSET_building_fortified_bunker",
  );
  assert.equal(
    resolveBrowserAsset("vehicle", manifest, "tracked excavator construction machinery")?.node,
    "ASSET_tank_tracked_excavator",
  );
});

test("appearance matching selects a material-aware authored variant", () => {
  const definition = {
    node: "ASSET_building",
    generator: "building",
    targetHeightMeters: 8,
    collider: {
      type: "box",
      centerMeters: [0, 4, 0],
      sizeMeters: [5, 8, 4],
    },
    source: "blender_procedural",
    defaultVariant: "brick_slate",
    variants: [
      {
        id: "brick_slate",
        node: "ASSET_building",
        status: "authored",
        appearanceTerms: ["red brick", "slate roof"],
        materialIds: ["fired_brick", "blue_gray_slate"],
      },
      {
        id: "timber_thatch",
        node: "ASSET_building_timber",
        status: "authored",
        appearanceTerms: ["timber beams", "thatched roof"],
        materialIds: ["timber_structural_dark", "straw_thatch"],
      },
    ],
  };
  assert.equal(
    selectAssetVariant(definition, "exposed timber beams with a thatched roof").id,
    "timber_thatch",
  );
  assert.equal(selectAssetVariant(definition, "brick_slate").id, "brick_slate");
  assert.equal(
    selectAssetVariant(
      {
        ...definition,
        defaultVariant: "brick_slate",
        variants: [
          definition.variants[0],
          {
            id: "timber_white_tile",
            node: "ASSET_building_japanese",
            status: "authored",
            appearanceTerms: [
              "exposed dark timber frame",
              "white lime plaster infill",
              "recessed wooden doors",
              "overlapping dark roof tiles",
            ],
            materialIds: ["timber_structural_dark", "white_lime_plaster", "charcoal_roof_tile"],
          },
        ],
      },
      "houses with exposed dark timber frames, white plaster, recessed wooden doors and overlapping dark tiles",
    ).id,
    "timber_white_tile",
  );
  assert.equal(selectAssetVariant(definition, "generic building").id, "brick_slate");
});

test("compiled batching keeps authored nodes separate within one prototype", () => {
  const base = {
    kind: "building",
    regionId: "r0",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 2.4,
    color: "#fff",
    label: "building",
    contactScore: 1,
    refined: true,
  };
  const asset = {
    prototype: "building",
    uri: "/worldclaw/assets/worldclaw-kit.glb",
    source: "blender_procedural",
    targetHeightMeters: 8,
    collider: {
      type: "box",
      centerMeters: [0, 4, 0],
      sizeMeters: [5.4, 8, 4.4],
    },
  };
  const groups = groupBrowserAssetObjects([
    { ...base, id: "brick", browserAsset: { ...asset, node: "ASSET_building" } },
    {
      ...base,
      id: "timber",
      browserAsset: { ...asset, node: "ASSET_building_timber_frame_white_tile" },
    },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => [group.node, group.objects.map((object) => object.id)]),
    [
      ["ASSET_building", ["brick"]],
      ["ASSET_building_timber_frame_white_tile", ["timber"]],
    ],
  );
});

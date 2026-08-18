import assert from "node:assert/strict";
import { test } from "node:test";
import {
  constructionAudit,
  constructionRequirementAuthority,
} from "../src/lib/worldclaw/construction-audit.ts";

const japanesePrompt =
  "A Japanese archipelago with two coastal towns, one pagoda, and a fishing harbor. Buildings use exposed dark timber frames, white plaster infill, recessed wooden doors and windows, and overlapping dark slate tile roofs.";

function pagodaAsset() {
  return {
    prototype: "pagoda",
    uri: "/worldclaw/assets/worldclaw-kit.glb",
    node: "ASSET_pagoda",
    source: "blender_procedural",
    targetHeightMeters: 14,
    collider: {
      type: "box",
      centerMeters: [0, 7, 0],
      sizeMeters: [7.9, 14, 7.9],
    },
    variantId: "pagoda_three_tier_dark_tile",
    appearanceTerms: [
      "pagoda",
      "dark timber",
      "white lime plaster",
      "natural blue gray slate roof",
      "overlapping natural slate courses",
    ],
    materialIds: ["timber_structural_dark", "white_lime_plaster", "blue_gray_slate"],
    constructionRecipe: {
      wallAssembly: "japanese_post_beam_white_lime_infill",
      roofAssembly: "pagoda_tiered_natural_slate_eaves",
      weatheringProfile: "japanese_exposed_timber",
      systems: ["overlapping natural slate roof courses", "three separate deep hip roofs"],
    },
  };
}

function baseWorld(prompt = japanesePrompt) {
  return {
    plan: {
      prompt,
      objectRequirements: {
        NorthCoastTown: [
          {
            category: "pagoda",
            count: 1,
            // Replays the leaked house vocabulary from strict run
            // 2026-08-12T01-35-19-704Z.
            appearance:
              "three-tier pagoda; exposed timber frame, plaster infill, doors, windows, overlapping roof tiles",
          },
        ],
        IslandGrasslands: [
          {
            category: "fence",
            count: 3,
            appearance: "fence; exposed timber frame construction inherited from town buildings",
          },
        ],
      },
      regions: [
        { id: "north", name: "NorthCoastTown" },
        { id: "grass", name: "IslandGrasslands" },
      ],
    },
    objects: [
      {
        id: "pagoda-1",
        kind: "pagoda",
        regionId: "north",
        browserAsset: pagodaAsset(),
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `fence-${index}`,
        kind: "fence",
        regionId: "grass",
      })),
    ],
  };
}

test("house construction prose cannot become pagoda or fence authority", () => {
  assert.equal(
    constructionRequirementAuthority({
      prompt: japanesePrompt,
      requestedKind: "pagoda",
      appearance: "exposed timber frame and plaster infill",
      ruleLabel: "exposed timber frame",
    }),
    "selected_manifest_variant",
  );
  assert.equal(
    constructionRequirementAuthority({
      prompt: japanesePrompt,
      requestedKind: "fence",
      appearance: "exposed timber frame",
      ruleLabel: "exposed timber frame",
    }),
    "selected_manifest_variant",
  );
  assert.equal(
    constructionRequirementAuthority({
      prompt: japanesePrompt,
      requestedKind: "building",
      appearance: "exposed timber frame",
      ruleLabel: "exposed timber frame",
    }),
    "user_subject_scoped",
  );
});

test("latest-run pagoda and fence leakage produces no false deterministic conflict", () => {
  const audit = constructionAudit(baseWorld());
  assert.deepEqual(audit.conflicts, []);
  assert.equal(audit.materialFamilyMacroF1, 1);
});

test("selected pagoda manifest vocabulary remains its construction authority", () => {
  const world = baseWorld();
  world.plan.objectRequirements.NorthCoastTown[0].appearance = "generic pagoda";
  const audit = constructionAudit(world);
  assert.deepEqual(audit.conflicts, []);
  assert.equal(audit.materialFamilyMacroF1, 1);
});

test("explicit subject-scoped fence construction remains a hard gate", () => {
  const world = baseWorld("A Japanese island where three fences use exposed timber frames.");
  const audit = constructionAudit(world);
  assert.deepEqual(audit.conflicts, [
    "IslandGrasslands fence: 0/3 resolve required exposed timber frame construction",
  ]);
  assert.ok(audit.materialFamilyMacroF1 < 0.9);
});

test("explicit unsupported pagoda material remains a hard gate", () => {
  const world = baseWorld("A Japanese island with a pagoda built from red brick walls.");
  world.plan.objectRequirements.NorthCoastTown[0].appearance = "red brick pagoda";
  const audit = constructionAudit(world);
  assert.ok(
    audit.conflicts.includes("NorthCoastTown pagoda: 0/1 resolve required brick construction"),
  );
});

test("construction wording before a subject is scoped to that nearest subject", () => {
  const world = baseWorld("A Japanese island with a red brick pagoda and timber town buildings.");
  world.plan.objectRequirements.NorthCoastTown[0].appearance = "red brick pagoda";
  const audit = constructionAudit(world);
  assert.ok(
    audit.conflicts.includes("NorthCoastTown pagoda: 0/1 resolve required brick construction"),
  );
});

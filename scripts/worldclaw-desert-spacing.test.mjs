import assert from "node:assert/strict";
import { test } from "node:test";
import { planScene } from "../src/lib/worldclaw/planning.ts";
import { ensureObjectRequirements } from "../src/lib/worldclaw/pipeline.ts";
import {
  generateHeightField,
  hasCombatOpenWorldIntent,
  planTerrainAssets,
  scatterTerrainAssets,
} from "../src/lib/worldclaw/terrain.ts";

const BATTLEFIELD_PROMPT =
  "Please create a desert battlefield inspired by PUBG's desert maps, designed as an open environment suitable for large-scale PvP combat.";

function requirementTotal(plan, category) {
  return Object.values(plan.objectRequirements)
    .flat()
    .filter((requirement) => requirement.category === category)
    .reduce((sum, requirement) => sum + requirement.count, 0);
}

test("desert battlefield language is treated as an open-combat world", () => {
  assert.equal(hasCombatOpenWorldIntent(BATTLEFIELD_PROMPT), true);
  assert.equal(hasCombatOpenWorldIntent(planScene(BATTLEFIELD_PROMPT)), true);
  assert.equal(
    hasCombatOpenWorldIntent("Japanese archipelago with fishing towns and bamboo terraces"),
    false,
  );
});

test("the desert battlefield template keeps compounds apart and the dunes sparse", () => {
  const plan = planScene(BATTLEFIELD_PROMPT);
  assert.equal(plan.theme, "desert");
  assert.match(plan.sceneType, /battlefield/i);

  const west = plan.regions.find((region) => /west/i.test(region.name));
  const east = plan.regions.find((region) => /east/i.test(region.name));
  const dunes = plan.regions.find((region) => /dune|combat/i.test(`${region.name} ${region.role}`));
  assert.ok(west && east && dunes);
  assert.ok(west.center[0] < 0.35, "west compound stays on the west side");
  assert.ok(east.center[0] > 0.65, "east compound stays on the east side");
  assert.ok(dunes.radius >= 0.3, "open combat flats need a large reserved radius");

  const duneCactus = (plan.objectRequirements[dunes.name] ?? []).find(
    (requirement) => requirement.category === "cactus",
  );
  assert.ok((duneCactus?.count ?? 0) <= 6, "open dunes must not be a cactus thicket");
  assert.ok(requirementTotal(plan, "cactus") <= 8);
  assert.ok(requirementTotal(plan, "crate") <= 12, "crate clutter must stay inside compounds");
  assert.equal(
    (plan.objectRequirements[dunes.name] ?? []).some(
      (requirement) => requirement.category === "vehicle" || requirement.category === "tank",
    ),
    false,
    "vehicles stage at compounds, not on the open flats",
  );
});

test("empty combat desert and sand stay empty instead of receiving oasis defaults", () => {
  const plan = planScene(BATTLEFIELD_PROMPT);
  const mesa = plan.regions.find((region) => /mesa|plateau/i.test(`${region.name} ${region.role}`));
  assert.ok(mesa);
  plan.objectRequirements[mesa.name] = [];
  ensureObjectRequirements(plan);
  assert.deepEqual(plan.objectRequirements[mesa.name], []);
  assert.ok(requirementTotal(plan, "cactus") <= 8);
});

test("desert battlefield cactus scatter is sparse and skips open combat sand", () => {
  const plan = planScene(BATTLEFIELD_PROMPT);
  const cactus = planTerrainAssets(plan).find((asset) => asset.kind === "cactus");
  assert.ok(cactus);
  assert.ok(cactus.density <= 0.16);
  assert.equal(cactus.categoryAffinity.includes("sand"), false);

  const heightField = generateHeightField(plan, 0x9d014d95);
  const scattered = scatterTerrainAssets(plan, heightField, 0x9d014d95, 1);
  const dunes = plan.regions.find((region) => /combat flats/i.test(region.role));
  assert.ok(dunes);
  const duneIndex = plan.regions.indexOf(dunes);
  const cactusOnDunes = scattered.filter((asset) => {
    if (asset.kind !== "cactus") return false;
    const u = asset.position[0] / heightField.worldSize + 0.5;
    const v = asset.position[2] / heightField.worldSize + 0.5;
    const ix = Math.min(
      heightField.resolution - 1,
      Math.max(0, Math.round(u * (heightField.resolution - 1))),
    );
    const iy = Math.min(
      heightField.resolution - 1,
      Math.max(0, Math.round(v * (heightField.resolution - 1))),
    );
    return heightField.regionId[iy * heightField.resolution + ix] === duneIndex;
  });
  assert.equal(cactusOnDunes.length, 0, "combat flats must stay clear of cactus scatter");

  const cacti = scattered.filter((asset) => asset.kind === "cactus");
  for (let index = 0; index < cacti.length; index++) {
    for (let other = index + 1; other < cacti.length; other++) {
      const dx = cacti[index].position[0] - cacti[other].position[0];
      const dz = cacti[index].position[2] - cacti[other].position[2];
      assert.ok(Math.hypot(dx, dz) >= 3.9, "scattered cacti must keep combat-readable spacing");
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appearanceContractConflicts,
  exactHeroLedgerFromSceneSummary,
  heightFromLayout,
  needsAdaptiveRepair,
  shouldRunAdaptiveImageRepair,
  normalizeCommitteeJudgement,
  normalizeConstructionEvidenceStatement,
  normalizeFinalRenderJudgement,
  normalizeVisualContract,
  WORLD_PROMPT_MAX_CHARS,
  WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS,
  normalizePlan,
  validatePromptInput,
} from "../src/lib/worldclaw/inference.ts";
import {
  objectCoveragePipelineDecision,
  objectCoverageCertificationFailures,
  remapObjectRequirements,
  sceneReferenceSummary,
  shouldRunFinalModelReview,
  visualReferenceCertificationFailures,
  visualReferenceFailureIsFatal,
} from "../src/lib/worldclaw/pipeline.ts";
import { planScene } from "../src/lib/worldclaw/planning.ts";

test("prompt validation enforces a bounded non-empty model fragment", () => {
  assert.deepEqual(validatePromptInput({ prompt: "  island village  " }), {
    prompt: "island village",
  });
  assert.throws(() => validatePromptInput({ prompt: "   " }), /Empty prompt/);
  assert.throws(
    () => validatePromptInput({ prompt: "x".repeat(WORLD_PROMPT_MAX_CHARS + 1) }),
    /characters or fewer/,
  );
});

test("adaptive repair is score-triggered instead of conflict-triggered", () => {
  assert.equal(needsAdaptiveRepair(0.81, WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS.planning), true);
  assert.equal(needsAdaptiveRepair(0.82, WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS.planning), false);
  assert.equal(needsAdaptiveRepair(0.78, WORLDCLAW_ADAPTIVE_REPAIR_THRESHOLDS.layout), false);
  assert.equal(needsAdaptiveRepair(Number.NaN, 0.5), true);
});

test("interactive generation keeps reviewed image candidates while the paper benchmark may repair", () => {
  assert.equal(shouldRunAdaptiveImageRepair(false, 0.1, 0.78), false);
  assert.equal(shouldRunAdaptiveImageRepair(true, 0.1, 0.78), true);
  assert.equal(shouldRunAdaptiveImageRepair(true, 0.9, 0.78), false);
  assert.equal(visualReferenceFailureIsFatal({}), false);
  assert.equal(
    visualReferenceFailureIsFatal({
      benchmarkContract: {
        caseId: "case",
        promptSha256: "0".repeat(64),
        regionalReadability: ["north", "south", "east", "west"],
        terrainRelationships: ["river divides towns"],
        objectFamilies: ["bridge"],
      },
    }),
    false,
  );
  assert.deepEqual(
    visualReferenceCertificationFailures({
      visualContract: {
        judgement: { passed: false },
      },
    }),
    [
      "Pre-build appearance contract was retained with review warnings; this world is viewable but not certification-eligible",
    ],
  );
  assert.equal(shouldRunFinalModelReview([]), true);
  assert.equal(shouldRunFinalModelReview(["pre-build concept warning"]), false);
});

test("quantity shortfalls remain inspectable while missing required heroes still block", () => {
  const quantityShortfall = {
    satisfactionRatio: 0.878,
    missingKinds: [],
    missingHeroKinds: [],
  };
  assert.equal(objectCoveragePipelineDecision(quantityShortfall), "retain-warning");
  assert.deepEqual(objectCoverageCertificationFailures(quantityShortfall), [
    "Requested-object satisfaction is 88%; requires 95%",
  ]);
  assert.equal(
    objectCoveragePipelineDecision({
      satisfactionRatio: 0.878,
      missingKinds: ["crate"],
      missingHeroKinds: [],
    }),
    "retain-warning",
  );
  assert.equal(
    objectCoveragePipelineDecision({
      satisfactionRatio: 0.99,
      missingKinds: ["bridge"],
      missingHeroKinds: ["bridge"],
    }),
    "block",
  );
  assert.equal(
    objectCoveragePipelineDecision({
      satisfactionRatio: 0.97,
      missingKinds: [],
      missingHeroKinds: [],
    }),
    "pass",
  );
});

test("appearance contract blocks only contract-judge conflicts", () => {
  const candidateSelectionConcern = "concept shoreline differs from the canonical map";
  const blocking = appearanceContractConflicts(
    ["one configured appearance judge timed out"],
    [["wrong roof material"], []],
  );
  assert.deepEqual(blocking, ["one configured appearance judge timed out", "wrong roof material"]);
  assert.equal(blocking.includes(candidateSelectionConcern), false);
});

test("committee judgements score the exact candidate roster once and select within it", () => {
  const complete = normalizeCommitteeJudgement(
    {
      candidates: [
        { candidateId: "map-a", score: 0.9, passed: true },
        { candidateId: "map-b", score: 0.7, passed: false },
      ],
      preferredCandidateId: "map-a",
    },
    ["map-a", "map-b"],
  );
  assert.deepEqual([...complete.scores.keys()], ["map-a", "map-b"]);
  assert.equal(complete.preferredCandidateId, "map-a");
  assert.throws(
    () =>
      normalizeCommitteeJudgement(
        {
          candidates: [{ candidateId: "map-a", score: 0.9, passed: true }],
          preferredCandidateId: "map-a",
        },
        ["map-a", "map-b"],
      ),
    /omitted candidate scores: map-b/,
  );
  assert.throws(
    () =>
      normalizeCommitteeJudgement(
        {
          candidates: [
            { candidateId: "map-a", score: 0.9, passed: true },
            { candidateId: "map-a", score: 0.8, passed: true },
          ],
          preferredCandidateId: "map-a",
        },
        ["map-a", "map-b"],
      ),
    /more than once/,
  );
  assert.throws(
    () =>
      normalizeCommitteeJudgement(
        {
          candidates: [
            { candidateId: "map-a", score: 0.9, passed: true },
            { candidateId: "map-b", score: 0.8, passed: true },
          ],
          preferredCandidateId: "map-c",
        },
        ["map-a", "map-b"],
      ),
    /preferred candidate is missing or outside/,
  );
});

test("visual reference prompts recover only authoritative exact hero counts", () => {
  assert.deepEqual(
    exactHeroLedgerFromSceneSummary(
      [
        "scene=Japanese archipelago",
        "hero subject=boat x4; count authority=user prompt exact",
        "hero subject=pagoda x1; count authority=user prompt exact",
        "hero subject=nine decorative lanterns",
        "hero subject=torii x1; count authority=user prompt exact",
      ].join("\n"),
    ),
    ["boat x4", "pagoda x1", "torii x1"],
  );
});

test("short provider plans receive unique fallback region ids", () => {
  for (const count of [0, 1, 2]) {
    const regions = Array.from({ length: count }, (_, index) => ({
      name: `Provider ${index}`,
      category: "grass",
      center: [0.25 + index * 0.1, 0.5],
      radius: 0.2,
    }));
    const plan = normalizePlan({ regions }, "test world");
    assert.ok(plan.regions.length >= 3);
    assert.equal(new Set(plan.regions.map((region) => region.id)).size, plan.regions.length);
    assert.deepEqual(
      plan.regions.map((region) => region.id),
      plan.regions.map((_, index) => `r${index}`),
    );
  }
});

test("provider plan normalization bounds malformed numeric and text fields", () => {
  const plan = normalizePlan(
    {
      theme: "not-a-theme",
      visualStyle: "not-a-style",
      regions: [
        {
          name: "n".repeat(200),
          category: "not-a-category",
          center: [Number.NaN, Number.POSITIVE_INFINITY],
          radius: Number.NEGATIVE_INFINITY,
          baseElevation: Number.NaN,
          roughness: 50,
          peakStrength: -50,
        },
      ],
      objectRequirements: {
        ["n".repeat(200)]: [{ category: "tree", count: 9999, scale: 9999 }],
      },
    },
    "test world",
  );

  assert.equal(plan.theme, "custom");
  assert.equal(plan.visualStyle, "stylized");
  for (const region of plan.regions) {
    assert.ok(region.name.length <= 80);
    assert.ok(region.center.every(Number.isFinite));
    assert.ok(region.center.every((value) => value >= 0 && value <= 1));
    assert.ok(Number.isFinite(region.radius));
    assert.ok(region.roughness >= 0 && region.roughness <= 1);
    assert.ok(region.peakStrength >= 0 && region.peakStrength <= 1);
  }
});

test("planning keeps realistic rendering only when the user explicitly requests it", () => {
  const inferredRealism = normalizePlan(
    { visualStyle: "realistic", regions: [] },
    "A Japanese archipelago with a bamboo forest",
  );
  const requestedRealism = normalizePlan(
    { visualStyle: "realistic", regions: [] },
    "A photorealistic Japanese archipelago with a bamboo forest",
  );

  assert.equal(inferredRealism.visualStyle, "stylized");
  assert.equal(requestedRealism.visualStyle, "realistic");
});

test("named Japanese vegetation regions cannot normalize to tropical palms", () => {
  const plan = normalizePlan(
    {
      regions: [
        { name: "Terraced Bamboo Forest", category: "forest", role: "bamboo terraces" },
        { name: "Sakura Grove", category: "forest", role: "cherry blossom grove" },
        { name: "Sea", category: "ocean" },
      ],
      objectRequirements: {
        "Terraced Bamboo Forest": [{ category: "palm", count: 12 }],
        "Sakura Grove": [{ category: "pine", count: 8 }],
      },
    },
    "A Japanese archipelago with a terraced bamboo forest and cherry blossom grove",
  );

  const bamboo = plan.objectRequirements["Terraced Bamboo Forest"][0];
  const cherry = plan.objectRequirements["Sakura Grove"][0];
  assert.equal(bamboo.category, "tree");
  assert.match(bamboo.appearance, /segmented green culms/i);
  assert.equal(cherry.category, "tree");
  assert.match(cherry.appearance, /pale pink blossom canopy/i);
});

test("image-guided terrain keeps border-connected painted ocean below water", () => {
  const size = 40;
  const rgba = new Uint8Array(size * size * 4);
  const paint = (x, y, r, g, b) => {
    const index = (y * size + x) * 4;
    rgba[index] = r;
    rgba[index + 1] = g;
    rgba[index + 2] = b;
    rgba[index + 3] = 255;
  };

  // Dark illustrated sea, including almost-black wave strokes.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) paint(x, y, 8, 34, 66);
  }
  for (let x = 2; x < size - 2; x++) paint(x, 5, 5, 12, 20);

  // A large green island and a neutral inland rock patch. The rock must not
  // become water simply because the broad ocean test accepts dark blues.
  for (let y = 9; y < 33; y++) {
    for (let x = 8; x < 32; x++) paint(x, y, 48, 112, 54);
  }
  for (let y = 17; y < 23; y++) {
    for (let x = 12; x < 18; x++) paint(x, y, 88, 84, 80);
  }

  const result = heightFromLayout(rgba, size, size, "island", size, []);
  const categoryAt = (x, y) => result.categories[result.regionId[y * size + x]];
  const heightAt = (x, y) => result.height[y * size + x];

  for (let x = 0; x < size; x++) {
    assert.equal(categoryAt(x, 0), "ocean");
    assert.equal(categoryAt(x, size - 1), "ocean");
    assert.ok(heightAt(x, 0) <= -0.73);
    assert.ok(heightAt(x, size - 1) <= -0.73);
  }
  assert.equal(categoryAt(20, 5), "ocean", "wave ink is closed into ocean");
  assert.ok(heightAt(20, 5) <= -0.73, "wave ink cannot become a terrain spike");
  assert.notEqual(categoryAt(15, 20), "ocean", "inland rock remains land");
  assert.ok(heightAt(15, 20) > -0.73);
  assert.equal(result.layoutMaskProvenance.passed, true);
  assert.ok(result.layoutMaskProvenance.landWaterIoU >= 0.95);
});

test("dark volcanic rock touching border-connected sea remains authoritative land", () => {
  const size = 64;
  const rgba = new Uint8Array(size * size * 4);
  const paint = (x, y, r, g, b) => {
    const index = (y * size + x) * 4;
    rgba[index] = r;
    rgba[index + 1] = g;
    rgba[index + 2] = b;
    rgba[index + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) paint(x, y, 30, 76, 110);
  }
  for (let y = 8; y < 56; y++) {
    for (let x = 8; x < 54; x++) paint(x, y, 58, 118, 58);
  }
  // Blue-gray basalt touches the island's eastern shoreline. The old broad
  // deep-navy rule joined this patch to the surrounding ocean flood-fill.
  for (let y = 18; y < 46; y++) {
    for (let x = 42; x < 54; x++) paint(x, y, 21, 24, 31);
  }

  const plan = normalizePlan(
    {
      theme: "island",
      regions: [
        { name: "Sea", category: "ocean", center: [0.05, 0.5], role: "surrounding sea" },
        { name: "Meadow", category: "grass", center: [0.4, 0.5], role: "inland meadow" },
        {
          name: "Volcanic Ridge",
          category: "rock",
          center: [0.75, 0.5],
          role: "dark basalt shoreline ridge",
        },
      ],
    },
    "An island with a dark volcanic ridge touching the eastern sea",
  );
  const result = heightFromLayout(rgba, size, size, "island", size, plan.regions);
  const categoryAt = (x, y) => result.categories[result.regionId[y * size + x]];

  assert.equal(categoryAt(63, 32), "ocean");
  assert.notEqual(categoryAt(48, 32), "ocean");
  assert.ok(result.height[32 * size + 48] > -0.73);
  assert.equal(result.layoutMaskProvenance.passed, true);
});

test("disjoint settlement masks keep distinct named regions and object requirements", () => {
  const size = 64;
  const rgba = new Uint8Array(size * size * 4);
  const paint = (x, y, r, g, b) => {
    const index = (y * size + x) * 4;
    rgba[index] = r;
    rgba[index + 1] = g;
    rgba[index + 2] = b;
    rgba[index + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) paint(x, y, 48, 112, 54);
  }
  for (let y = 22; y < 42; y++) {
    for (let x = 5; x < 25; x++) paint(x, y, 112, 62, 42);
    for (let x = 39; x < 59; x++) paint(x, y, 112, 62, 42);
  }

  const plan = normalizePlan(
    {
      theme: "island",
      regions: [
        { name: "Woodland", category: "forest", center: [0.5, 0.5], role: "green buffer" },
        { name: "West Hamlet", category: "settlement", center: [0.23, 0.5], role: "western town" },
        { name: "East Hamlet", category: "settlement", center: [0.77, 0.5], role: "eastern town" },
      ],
      objectRequirements: {
        "West Hamlet": [{ category: "watchtower", count: 1 }],
        "East Hamlet": [{ category: "market", count: 2 }],
      },
    },
    "two separated island settlements",
  );

  const result = heightFromLayout(rgba, size, size, "island", size, plan.regions);
  const settlements = result.regions.filter((region) => region.category === "settlement");
  const byName = Object.fromEntries(settlements.map((region) => [region.name, region]));
  const leftRegion = result.regions[result.regionId[32 * size + 15]];
  const rightRegion = result.regions[result.regionId[32 * size + 49]];

  assert.equal(settlements.length, 2);
  assert.equal(leftRegion.name, "West Hamlet");
  assert.equal(rightRegion.name, "East Hamlet");
  assert.notEqual(leftRegion.id, rightRegion.id);
  assert.ok(byName["West Hamlet"].center[0] < 0.4);
  assert.ok(byName["East Hamlet"].center[0] > 0.6);
  assert.equal(byName["West Hamlet"].role, "western town");
  assert.equal(byName["East Hamlet"].role, "eastern town");
  assert.ok(settlements.every((region) => Math.abs(region.center[0] - 0.5) > 0.1));

  const remapped = remapObjectRequirements(plan, result.regions);
  assert.deepEqual(
    remapped["West Hamlet"].map(({ category, count }) => [category, count]),
    [["watchtower", 1]],
  );
  assert.deepEqual(
    remapped["East Hamlet"].map(({ category, count }) => [category, count]),
    [["market", 2]],
  );
});

test("many disconnected semantic patches saturate the bounded region graph without Uint8 wrap", () => {
  const size = 128;
  const rgba = new Uint8Array(size * size * 4);
  const paint = (x, y, r, g, b) => {
    const index = (y * size + x) * 4;
    rgba[index] = r;
    rgba[index + 1] = g;
    rgba[index + 2] = b;
    rgba[index + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) paint(x, y, 48, 112, 54);
  }
  for (let gridY = 0; gridY < 4; gridY++) {
    for (let gridX = 0; gridX < 4; gridX++) {
      const startX = 5 + gridX * 31;
      const startY = 5 + gridY * 31;
      for (let y = startY; y < startY + 18; y++) {
        for (let x = startX; x < startX + 18; x++) paint(x, y, 112, 62, 42);
      }
    }
  }

  const result = heightFromLayout(rgba, size, size, "island", size, []);
  const usedRegionIds = new Set(result.regionId);

  assert.equal(result.regions.length, 12);
  assert.equal(result.categories.length, result.regions.length);
  assert.equal(usedRegionIds.size, result.regions.length);
  assert.ok(Math.max(...usedRegionIds) < result.regions.length);
  assert.deepEqual(
    result.regions.map((region) => region.id),
    result.regions.map((_, index) => `r${index}`),
  );
});

test("image-guided semantic partitioning validates raster shape and resolution bounds", () => {
  const rgba = new Uint8Array(2 * 2 * 4);

  assert.throws(() => heightFromLayout(rgba, 2, 2, "island", 1, []), /resolution.*2 through/i);
  assert.throws(() => heightFromLayout(rgba, 2, 2, "island", 1_025, []), /resolution.*1024/i);
  assert.throws(
    () => heightFromLayout(new Uint8Array(15), 2, 2, "island", 2, []),
    /RGBA length must equal/,
  );
});

test("layout region renaming preserves every authoritative object requirement", () => {
  const original = normalizePlan(
    {
      theme: "island",
      regions: [
        { name: "Battlefield", category: "grass", center: [0.3, 0.4] },
        { name: "Military Harbor", category: "ocean", center: [0.8, 0.7] },
        { name: "Fort", category: "settlement", center: [0.55, 0.5] },
      ],
      objectRequirements: {
        Battlefield: [{ category: "tank", count: 4, appearance: "wrecked" }],
        "Military Harbor": [{ category: "ship", count: 3 }],
        Fort: [{ category: "bunker", count: 2 }],
      },
    },
    "battlefield island",
  );
  const renamed = original.regions.map((region, index) => ({
    ...region,
    id: `r${index}`,
    name: ["Inland Hills", "Sea", "Harbor Town"][index],
  }));

  const remapped = remapObjectRequirements(original, renamed);
  const totals = Object.fromEntries(
    Object.values(remapped)
      .flat()
      .map((requirement) => [requirement.category, requirement.count]),
  );
  assert.deepEqual(totals, { tank: 4, ship: 3, bunker: 2 });
  assert.deepEqual(
    Object.keys(remapped),
    renamed.map((region) => region.name),
  );
});

test("Japanese fallback planning requests construction-aware compiled landmarks", () => {
  const plan = planScene("Japanese island towns with a hilltop shrine and harbor");
  const requirements = Object.values(plan.objectRequirements).flat();
  const buildings = requirements.filter((requirement) => requirement.category === "building");
  assert.ok(buildings.length >= 2);
  assert.ok(
    buildings.every((requirement) =>
      /timber.*plaster.*(?:tile|roof)/i.test(requirement.appearance ?? ""),
    ),
  );
  assert.equal(requirements.filter((requirement) => requirement.category === "pagoda").length, 2);
  assert.equal(requirements.find((requirement) => requirement.category === "torii")?.count, 3);
});

test("visual reference summary stays bounded without dropping hero subjects", () => {
  const plan = normalizePlan(
    {
      sceneType: "Dense reference stress test",
      theme: "island",
      mainObjects: [
        "Five-tiered Pagoda",
        "Vermilion Shinto Torii Gate",
        "Four Japanese Fishing Boats",
        "Northern Coastal Town",
      ],
      regions: Array.from({ length: 12 }, (_, index) => ({
        name: `Region ${index}`,
        category: index === 0 ? "ocean" : "settlement",
        center: [0.1 + index * 0.05, 0.5],
        radius: 0.2,
        role: "r".repeat(500),
      })),
      objectRequirements: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `Region ${index}`,
          [
            {
              category: index === 0 ? "ship" : "building",
              count: index + 1,
              appearance: "hand-constructed material detail ".repeat(100),
            },
          ],
        ]),
      ),
    },
    "stress test",
  );
  const summary = sceneReferenceSummary(plan);
  assert.ok(summary.length <= 3_000);
  for (const subject of plan.mainObjects) {
    assert.match(summary, new RegExp(subject));
  }
  assert.match(summary, /objects Region 0: ship x1/);
});

test("visual reference judgement is bounded and cannot pass with conflicts", () => {
  const contract = normalizeVisualContract(
    {
      terrainReliefScale: 99,
      terrainMicroDetailScale: -4,
      vegetationDensityScale: 99,
      objectDensityScale: 0,
      waterLevelMeters: 99,
      palette: ["#123456", "not-a-color"],
      cameras: [
        {
          view: "isometric",
          azimuthDegrees: -45,
          elevationDegrees: 120,
          target: [-2, 4],
          distanceScale: 99,
        },
      ],
      judgement: {
        passed: true,
        agreementScore: 0.95,
        missingSubjects: [],
        conflicts: ["the harbor moved"],
      },
    },
    "island",
  );

  assert.equal(contract.source, "gemini-3.6-flash");
  assert.equal(contract.terrainReliefScale, 1);
  assert.equal(contract.terrainMicroDetailScale, 0);
  assert.equal(contract.vegetationDensityScale, 1.5);
  assert.equal(contract.objectDensityScale, 0.1);
  assert.equal(contract.waterLevelMeters, 0.5);
  assert.deepEqual(contract.palette, ["#123456"]);
  assert.equal(contract.cameras.length, 3);
  assert.equal(contract.cameras[0].azimuthDegrees, 315);
  assert.equal(contract.cameras[0].elevationDegrees, 90);
  assert.deepEqual(contract.cameras[0].target, [0, 1]);
  assert.equal(contract.judgement.passed, false);
});

test("final render judgement fails hard defects despite a high aggregate score", () => {
  const judgement = normalizeFinalRenderJudgement({
    passed: true,
    agreementScore: 0.97,
    metrics: {
      mapRegistration: 0.96,
      referenceAgreement: 0.92,
      heroObjectCoverage: 0.94,
      constructionFidelity: 0.91,
      waterIntegrity: 0.42,
    },
    missingSubjects: [],
    conflicts: ["Water forms vertical spikes along the southern coast"],
  });
  assert.equal(judgement.passed, false);
  assert.equal(judgement.metrics.waterIntegrity, 0.42);
});

test("final render judgement requires every registered metric and no conflicts", () => {
  const judgement = normalizeFinalRenderJudgement({
    passed: true,
    agreementScore: 0.9,
    metrics: {
      mapRegistration: 0.92,
      referenceAgreement: 0.84,
      heroObjectCoverage: 0.94,
      constructionFidelity: 0.82,
      waterIntegrity: 0.94,
    },
    missingSubjects: [],
    conflicts: [],
    observations: ["Lighting is cooler than the concept sheet"],
  });
  assert.equal(judgement.passed, true);
});

test("deterministic construction and camera failures cannot be overridden by the VLM", () => {
  const judgement = normalizeFinalRenderJudgement(
    {
      passed: true,
      agreementScore: 0.99,
      metrics: {
        mapRegistration: 0.99,
        referenceAgreement: 0.99,
        heroObjectCoverage: 0.99,
        constructionFidelity: 0.99,
        waterIntegrity: 0.99,
      },
      missingSubjects: [],
      conflicts: [],
    },
    {
      objectSatisfactionRatio: 1,
      missingHeroKinds: [],
      heroCountFailures: [],
      constructionConflicts: ["building lacks required slate construction"],
      waterMaxMeters: -0.8,
      landMinMeters: 0.1,
      waterLevelMeters: -0.35,
      mapNorthUp: false,
    },
  );
  assert.equal(judgement.passed, false);
  assert.match(judgement.conflicts.join(" "), /slate construction/);
  assert.match(judgement.conflicts.join(" "), /north-up/);
});

test("deterministic map and water evidence overrides contradictory VLM impressions", () => {
  const judgement = normalizeFinalRenderJudgement(
    {
      passed: false,
      agreementScore: 0.2,
      metrics: {
        mapRegistration: 0.2,
        referenceAgreement: 0.9,
        heroObjectCoverage: 0.95,
        constructionFidelity: 0.9,
        waterIntegrity: 0.3,
      },
      missingSubjects: [],
      conflicts: [
        "The map is mirrored and its shoreline does not match the canonical map",
        "Water climbs land and forms disconnected jagged walls",
      ],
      observations: [],
    },
    {
      objectSatisfactionRatio: 1,
      heroRequiredByKind: { torii: 1, pagoda: 1, boat: 4 },
      missingHeroKinds: [],
      heroCountFailures: [],
      heroVisibilityFailures: [],
      constructionConflicts: [],
      materialFamilyMacroF1: 0.96,
      waterMaxMeters: -0.4,
      landMinMeters: 0,
      waterLevelMeters: -0.1,
      mapNorthUp: true,
      cameraMatricesPassed: true,
      compiledSlotsMatched: true,
      depthPassesFinite: true,
      landWaterIoU: 0.989,
      landIoU: 0.987,
      waterIoU: 0.991,
      shorelineBoundaryF1: 0.999,
      shorelineP95DistancePixels: 1,
      maskSize: 512,
      orientationSuspicious: false,
      bestAlternateOrientation: "flipY",
      alternateOrientationImprovement: -0.3,
      leakageBoundaryTolerancePixels: 2,
      rawFalseWaterOnLandRatio: 0.013,
      falseWaterOnLandRatio: 0,
      rawMissingCanonicalWaterRatio: 0.001,
      missingCanonicalWaterRatio: 0,
      referenceWaterComponents: 1,
      renderedWaterComponents: 1,
      failures: [],
    },
  );

  assert.equal(judgement.metrics.mapRegistration, 0.989);
  assert.equal(judgement.metrics.waterIntegrity, 0.991);
  assert.ok(judgement.agreementScore > 0.9);
  assert.deepEqual(judgement.conflicts, []);
  assert.equal(judgement.passed, true);
  assert.equal(judgement.observations.length, 2);
  assert.match(judgement.observations[0], /superseded by registered deterministic evidence/);
});

test("semantic composition disagreements remain blocking when shoreline registration passes", () => {
  const judgement = normalizeFinalRenderJudgement(
    {
      passed: false,
      agreementScore: 0.2,
      metrics: {
        mapRegistration: 0.2,
        referenceAgreement: 0.9,
        heroObjectCoverage: 0.95,
        constructionFidelity: 0.9,
        waterIntegrity: 0.3,
      },
      missingSubjects: [],
      conflicts: [
        "The shoreline is wrong and the northern town is displaced from its mapped region",
      ],
      observations: [],
    },
    {
      objectSatisfactionRatio: 1,
      heroRequiredByKind: { torii: 1 },
      missingHeroKinds: [],
      heroCountFailures: [],
      heroVisibilityFailures: [],
      constructionConflicts: [],
      materialFamilyMacroF1: 0.96,
      waterMaxMeters: -0.4,
      landMinMeters: 0,
      waterLevelMeters: -0.1,
      mapNorthUp: true,
      cameraMatricesPassed: true,
      compiledSlotsMatched: true,
      depthPassesFinite: true,
      landWaterIoU: 0.989,
      landIoU: 0.987,
      waterIoU: 0.991,
      shorelineBoundaryF1: 0.999,
      shorelineP95DistancePixels: 1,
      maskSize: 512,
      orientationSuspicious: false,
      bestAlternateOrientation: "flipY",
      alternateOrientationImprovement: -0.3,
      leakageBoundaryTolerancePixels: 2,
      rawFalseWaterOnLandRatio: 0.013,
      falseWaterOnLandRatio: 0,
      rawMissingCanonicalWaterRatio: 0.001,
      missingCanonicalWaterRatio: 0,
      referenceWaterComponents: 1,
      renderedWaterComponents: 1,
      failures: [],
    },
  );

  assert.equal(judgement.metrics.mapRegistration, 0.989);
  assert.equal(judgement.passed, false);
  assert.equal(judgement.conflicts.length, 1);
  assert.match(judgement.conflicts[0], /semantic region\/composition disagreement/);
});

test("construction resolve fractions are normalized to explicit failing and passing counts", () => {
  assert.equal(
    normalizeConstructionEvidenceStatement(
      "NorthCoastTown building: 6/7 resolve required exposed timber frame construction",
    ),
    "NorthCoastTown building: 1 of 7 fail required exposed timber frame construction; 6 pass",
  );
  assert.equal(
    normalizeConstructionEvidenceStatement(
      "Settlement 2 hut: 0/9 resolve required overlapping roof tile construction",
    ),
    "Settlement 2 hut: 9 of 9 fail required overlapping roof tile construction; 0 pass",
  );
  const bounded = normalizeConstructionEvidenceStatement(
    `NorthCoastTown building: 6/7 resolve required ${"detailed material ".repeat(30)}`,
  );
  assert.ok(bounded.length <= 240);
  assert.match(bounded, /; 6 pass$/);
});

test("a VLM cannot invert six of seven construction passes into six failures", () => {
  const judgement = normalizeFinalRenderJudgement(
    {
      passed: false,
      agreementScore: 0.8,
      metrics: {
        mapRegistration: 0.99,
        referenceAgreement: 0.9,
        heroObjectCoverage: 0.95,
        constructionFidelity: 0.82,
        waterIntegrity: 0.99,
      },
      missingSubjects: [],
      conflicts: [
        "NorthCoastTown buildings: 6/7 fail required doors, windows, timber frames, roof tiles, and plaster infill",
      ],
      observations: [],
    },
    {
      objectSatisfactionRatio: 1,
      heroRequiredByKind: { torii: 1 },
      missingHeroKinds: [],
      heroCountFailures: [],
      heroVisibilityFailures: [],
      constructionConflicts: [
        "NorthCoastTown building: 6/7 resolve required exposed timber frame construction",
      ],
      materialFamilyMacroF1: 0.96,
      waterMaxMeters: -0.4,
      landMinMeters: 0,
      waterLevelMeters: -0.1,
      mapNorthUp: true,
      cameraMatricesPassed: true,
      compiledSlotsMatched: true,
      depthPassesFinite: true,
      landWaterIoU: 0.989,
      landIoU: 0.987,
      waterIoU: 0.991,
      shorelineBoundaryF1: 0.999,
      shorelineP95DistancePixels: 1,
      maskSize: 512,
      orientationSuspicious: false,
      bestAlternateOrientation: "flipY",
      alternateOrientationImprovement: -0.3,
      leakageBoundaryTolerancePixels: 2,
      rawFalseWaterOnLandRatio: 0.013,
      falseWaterOnLandRatio: 0,
      rawMissingCanonicalWaterRatio: 0.001,
      missingCanonicalWaterRatio: 0,
      referenceWaterComponents: 1,
      renderedWaterComponents: 1,
      failures: ["NorthCoastTown building: 6/7 resolve required exposed timber frame construction"],
    },
  );

  assert.equal(judgement.passed, false, "the one deterministic failure remains a hard gate");
  assert.ok(
    judgement.conflicts.includes(
      "NorthCoastTown building: 1 of 7 fail required exposed timber frame construction; 6 pass",
    ),
  );
  assert.doesNotMatch(judgement.conflicts.join("\n"), /6\s*\/\s*7 fail/i);
  assert.match(judgement.observations.join("\n"), /construction-count inversion superseded/i);
});

test("weak semantic evidence is not duplicated as an absent subject", () => {
  const judgement = normalizeFinalRenderJudgement({
    passed: false,
    agreementScore: 0.7,
    metrics: {
      mapRegistration: 0.95,
      referenceAgreement: 0.6,
      heroObjectCoverage: 0.9,
      constructionFidelity: 0.8,
      waterIntegrity: 0.95,
    },
    missingSubjects: ["Terraced bamboo forest with clearly formed terrain terraces"],
    conflicts: [
      "The terraced bamboo forest is present but sparse and its terraces are poorly legible",
    ],
    observations: [],
  });

  assert.deepEqual(judgement.missingSubjects, []);
  assert.equal(judgement.conflicts.length, 1);
  assert.match(judgement.conflicts[0], /present but sparse/i);
  assert.match(
    judgement.observations.join("\n"),
    /consolidated into its semantic quality conflict/i,
  );
});

test("a genuinely absent subject remains in the missing-subject gate", () => {
  const judgement = normalizeFinalRenderJudgement({
    passed: false,
    agreementScore: 0.7,
    metrics: {},
    missingSubjects: ["pagoda"],
    conflicts: [],
    observations: [],
  });
  assert.deepEqual(judgement.missingSubjects, ["pagoda"]);
});

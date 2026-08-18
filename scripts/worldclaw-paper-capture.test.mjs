import assert from "node:assert/strict";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { chromium } from "playwright";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedViews = [
  "global",
  "region-1",
  "region-2",
  "region-3",
  "region-4",
  "walk-1",
  "walk-2",
  "walk-3",
  "walk-4",
];

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function startVite(t) {
  const port = await reservePort();
  const output = [];
  const viteProcess = spawn(
    process.execPath,
    [
      resolve(workspaceRoot, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [viteProcess.stdout, viteProcess.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => output.push(chunk));
  }
  t.after(() => {
    if (viteProcess.exitCode === null) viteProcess.kill("SIGTERM");
  });

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (viteProcess.exitCode !== null) {
      throw new Error(`Vite exited ${viteProcess.exitCode}: ${output.join("").slice(-4_000)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return url;
    } catch {
      // Expected while Vite starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Vite did not start: ${output.join("").slice(-4_000)}`);
}

test(
  "paper capture runs a provider-free literal-mesh fixture and restores live state",
  { timeout: 120_000 },
  async (t) => {
    const url = await startVite(t);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const browserErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const result = await page.evaluate(async (viewNames) => {
      const appModule = await (await fetch("/src/components/worldclaw/AppShell.tsx")).text();
      const storeUrl = appModule.match(/from "([^"]*\/src\/lib\/worldclaw\/store\.ts[^"]*)"/)?.[1];
      const sceneUrl = appModule.match(
        /from "([^"]*\/src\/components\/worldclaw\/WorldScene\.tsx[^"]*)"/,
      )?.[1];
      if (!storeUrl || !sceneUrl) throw new Error("Could not resolve transformed runtime modules");
      const [{ useWorldClaw }, sceneHelpers] = await Promise.all([
        import(storeUrl),
        import(sceneUrl),
      ]);

      const validFloatDepth = new Float32Array([5, 1, 1, 1, 15, 1, 1, 1, 0, 0, 0, 0]);
      const validDepth = sceneHelpers.summarizePaperDepthPixels(validFloatDepth, 1, 20);
      let nonFiniteFailure = "";
      try {
        sceneHelpers.summarizePaperDepthPixels(new Float32Array([Number.NaN, 1, 0, 1]), 1, 20);
      } catch (error) {
        nonFiniteFailure = error instanceof Error ? error.message : String(error);
      }
      let deadlineFailure = "";
      try {
        sceneHelpers.assertPaperCaptureDeadlineAt(10, 10, "unit seam");
      } catch (error) {
        deadlineFailure = error instanceof Error ? error.message : String(error);
      }
      const subset = sceneHelpers.resolvePaperCaptureViewNames({
        views: ["walk-4", "global", "walk-4", "region-2"],
      });

      const manifest = await (await fetch("/worldclaw/assets/asset-library.json")).json();
      const regionDefinitions = [
        ["nw", "Northwest", "grass", [0.25, 0.25]],
        ["ne", "Northeast", "hill", [0.75, 0.25]],
        ["sw", "Southwest", "forest", [0.25, 0.75]],
        ["se", "Southeast", "settlement", [0.75, 0.75]],
      ];
      const regions = regionDefinitions.map(([id, name, category, center], index) => ({
        id,
        name,
        category,
        center,
        radius: 0.2,
        role: "fixture quadrant",
        baseElevation: 1.5,
        roughness: 0.2,
        peakStrength: 0.1,
        color: ["#5b8d48", "#788f52", "#35643b", "#8b7655"][index],
      }));
      const resolution = 33;
      const worldSize = 96;
      const data = new Float32Array(resolution * resolution);
      data.fill(1.5);
      const regionId = new Uint8Array(resolution * resolution);
      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          regionId[y * resolution + x] =
            (x < resolution / 2 ? 0 : 1) + (y < resolution / 2 ? 0 : 2);
        }
      }

      const compiledKinds = ["pagoda", "torii", "bridge", "building"];
      const centers = [
        [-24, -24],
        [24, -24],
        [-24, 24],
        [24, 24],
      ];
      const baseScales = { pagoda: 2.8, torii: 2.2, bridge: 3.5, building: 2.4 };
      const objects = [];
      for (let index = 0; index < compiledKinds.length; index++) {
        const kind = compiledKinds[index];
        const definition = manifest.prototypes[kind];
        const variant =
          definition.variants.find((candidate) => candidate.id === definition.defaultVariant) ??
          definition.variants[0];
        const center = centers[index];
        objects.push({
          id: `compiled-${index}`,
          kind,
          regionId: regions[index].id,
          position: [center[0], 1.5, center[1]],
          rotation: [0, (index * Math.PI) / 7, 0],
          scale: baseScales[kind],
          color: "#a46f45",
          label: `fixture ${kind}`,
          contactScore: 1,
          refined: true,
          browserAsset: {
            prototype: kind,
            uri: manifest.library.uri,
            node: variant?.node ?? definition.node,
            source: "blender_procedural",
            targetHeightMeters: variant?.targetHeightMeters ?? definition.targetHeightMeters,
            collider: variant?.collider ?? definition.collider,
            variantId: variant?.id,
            appearanceTerms: variant?.appearanceTerms,
            materialIds: variant?.materialIds,
            constructionRecipe: variant?.constructionRecipe,
          },
        });
        objects.push({
          id: `primitive-${index}`,
          kind: "rock",
          regionId: regions[index].id,
          position: [center[0] + 6, 1.5, center[1] + 3],
          rotation: [0, 0, 0],
          scale: 1.2,
          color: "#777068",
          label: "fixture rock",
          contactScore: 1,
          refined: true,
        });
      }
      const world = {
        id: "paper-runtime-fixture",
        seed: 424242,
        generatedAt: 1,
        plan: {
          prompt: "provider-free paper capture fixture",
          sceneType: "fixture",
          theme: "custom",
          visualStyle: "stylized",
          atmosphere: "clear",
          regions,
          terrainAssets: [],
          objectRequirements: {},
          spatialNotes: [],
          mainObjects: compiledKinds,
          visualContract: {
            source: "local-defaults",
            terrainReliefScale: 1,
            terrainMicroDetailScale: 0,
            vegetationDensityScale: 1,
            objectDensityScale: 1,
            waterLevelMeters: -0.35,
            palette: ["#5b8d48"],
            dominantSilhouettes: ["pagoda"],
            compositionNotes: ["fixture"],
            cameras: [],
          },
        },
        terrainSpec: {
          layout: Array.from({ length: 4 }, (_, y) =>
            Array.from(
              { length: 4 },
              (_, x) => regions[(x < 2 ? 0 : 1) + (y < 2 ? 0 : 2)].category,
            ),
          ),
          resolution: 4,
          worldSize,
          heightScale: 1,
          materials: {},
          assetPrototypes: [],
          source: "procedural",
        },
        heightField: { resolution, worldSize, data, regionId, source: "procedural" },
        objects,
      };
      useWorldClaw.setState({
        world,
        stage: "done",
        running: false,
        viewMode: "instance",
        cameraMode: "orbit",
        selectedObjectId: "compiled-0",
        showRegions: false,
      });

      const readyDeadline = performance.now() + 45_000;
      while (
        typeof window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__ !== "function" ||
        window.__WORLDCLAW_QA__?.world.id !== world.id
      ) {
        if (performance.now() >= readyDeadline) throw new Error("Paper fixture bridge timed out");
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const registeredBefore = window.__WORLDCLAW_CAPTURE_REGISTERED__;
      const before = {
        viewMode: useWorldClaw.getState().viewMode,
        selectedObjectId: useWorldClaw.getState().selectedObjectId,
      };
      const promptHash = [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(world.plan.prompt)),
        ),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const binding = {
        suiteId: "2026-08-12T08-00-00-000Z",
        caseId: "figure-12-provider-free-fixture",
        caseToken: "a".repeat(48),
        promptSha256: promptHash,
        regionalReadability: [
          "northwest grass",
          "northeast hill",
          "southwest forest",
          "southeast settlement",
        ],
      };
      let wrongPromptFailure = "";
      try {
        await window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__({
          views: ["global"],
          binding: { ...binding, promptSha256: "b".repeat(64) },
          regionalRoles: binding.regionalReadability,
        });
      } catch (error) {
        wrongPromptFailure = error instanceof Error ? error.message : String(error);
      }
      let weakSemanticRoleFailure = "";
      const weakRegionalRoles = [
        "northwest grass",
        "northeast hill",
        "southwest forest",
        "vehicle staging area",
      ];
      try {
        await window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__({
          views: ["global"],
          binding: { ...binding, regionalReadability: weakRegionalRoles },
          regionalRoles: weakRegionalRoles,
        });
      } catch (error) {
        weakSemanticRoleFailure = error instanceof Error ? error.message : String(error);
      }
      const startedAt = performance.now();
      const matrix = await window.__WORLDCLAW_CAPTURE_PAPER_MATRIX__({
        views: ["global", "region-1", "walk-1"],
        binding,
        regionalRoles: binding.regionalReadability,
      });
      const elapsedMs = performance.now() - startedAt;
      const after = {
        viewMode: useWorldClaw.getState().viewMode,
        selectedObjectId: useWorldClaw.getState().selectedObjectId,
      };
      const view = matrix.views.global;
      return {
        subset,
        validDepth: validDepth.summary,
        nonFiniteFailure,
        deadlineFailure,
        elapsedMs,
        before,
        after,
        registeredApiPreserved:
          typeof registeredBefore === "function" &&
          window.__WORLDCLAW_CAPTURE_REGISTERED__ === registeredBefore,
        viewNames,
        matrix: {
          capturedViews: matrix.capturePolicy.capturedViews,
          width: view.width,
          height: view.height,
          pngPasses: [view.beauty, view.instance, view.depth, view.normal].map((pass) =>
            pass.dataUrl.startsWith("data:image/png;base64,"),
          ),
          beauty: {
            renderPipeline: view.beauty.renderPipeline,
            postprocessingBypassed: view.beauty.postprocessingBypassed,
            visiblePostprocessingEquivalent: view.beauty.visiblePostprocessingEquivalent,
          },
          depth: {
            measurementEncoding: view.depth.measurementEncoding,
            finiteValidation: view.depth.finiteValidation,
            finiteDepthPixelCount: view.depth.finiteDepthPixelCount,
            nonFiniteDepthPixelCount: view.depth.nonFiniteDepthPixelCount,
            outOfRangeDepthPixelCount: view.depth.outOfRangeDepthPixelCount,
          },
          inventory: matrix.geometryInventory,
          mapping: matrix.logicalIds.mapping,
          visibility: view.instance.visibility,
          materialAudit: matrix.materialAudit,
          stateAudit: matrix.stateAudit,
          isolation: matrix.isolation,
          cameraMatrixPassed: view.camera.matrixSanity.passed,
          binding: matrix.binding,
          worldPromptSha256: matrix.worldPromptSha256,
          worldFingerprint: matrix.worldFingerprint,
          worldFingerprintAlgorithm: matrix.worldFingerprintAlgorithm,
          capturedAt: matrix.capturedAt,
          wrongPromptFailure,
          weakSemanticRoleFailure,
          regionOne: matrix.views["region-1"].camera.region,
          walkOne: matrix.views["walk-1"].camera.region,
        },
        qaWorld: window.__WORLDCLAW_QA__?.world,
      };
    }, expectedViews);

    assert.deepEqual(result.subset, ["global", "region-2", "walk-4"]);
    assert.equal(result.validDepth.finiteDepthPixelCount, 2);
    assert.equal(result.validDepth.backgroundPixelCount, 1);
    assert.match(result.nonFiniteFailure, /nonFinite=1/);
    assert.match(result.deadlineFailure, /Paper capture timed out while unit seam/);
    assert.ok(result.elapsedMs < 90_000, `fixture capture took ${result.elapsedMs}ms`);
    assert.deepEqual(result.before, result.after);
    assert.equal(result.registeredApiPreserved, true);
    assert.deepEqual(result.matrix.capturedViews, ["global", "region-1", "walk-1"]);
    assert.equal(result.matrix.width, 640);
    assert.equal(result.matrix.height, 360);
    assert.deepEqual(result.matrix.pngPasses, [true, true, true, true]);
    assert.equal(result.matrix.binding.caseId, "figure-12-provider-free-fixture");
    assert.equal(result.matrix.worldPromptSha256, result.matrix.binding.promptSha256);
    assert.match(result.matrix.worldFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(result.matrix.worldFingerprintAlgorithm, "fnv1a-dual32-canonical-world");
    assert.equal(new Date(result.matrix.capturedAt).toISOString(), result.matrix.capturedAt);
    assert.match(result.matrix.wrongPromptFailure, /prompt hash does not match/);
    assert.match(
      result.matrix.weakSemanticRoleFailure,
      /could not evidence four distinct semantic region-role matches/,
    );
    assert.equal(result.matrix.regionOne.requestedSemanticRole, "northwest grass");
    assert.equal(result.matrix.regionOne.selectionSource, "preregistered-semantic-role-match");
    assert.ok(result.matrix.regionOne.semanticMatch.matchedTerms.includes("grass"));
    assert.equal(result.matrix.regionOne.id, result.matrix.walkOne.id);
    assert.deepEqual(result.matrix.beauty, {
      renderPipeline: "direct-lit-structural-beauty",
      postprocessingBypassed: true,
      visiblePostprocessingEquivalent: false,
    });
    assert.equal(
      result.matrix.depth.measurementEncoding,
      "rgba32f-r-depth-meters-g-coverage-b-finite-sentinel",
    );
    assert.equal(
      result.matrix.depth.finiteValidation,
      "geometry-preflight-plus-shader-sentinel-plus-float32-readback",
    );
    assert.ok(result.matrix.depth.finiteDepthPixelCount > 0);
    assert.equal(result.matrix.depth.nonFiniteDepthPixelCount, 0);
    assert.equal(result.matrix.depth.outOfRangeDepthPixelCount, 0);
    assert.equal(result.matrix.inventory.terrainMeshCount, 1);
    assert.ok(result.matrix.inventory.compiledBatchCount > 1);
    assert.equal(result.matrix.inventory.renderedLogicalObjectCount, 8);
    assert.equal(result.matrix.inventory.expectedLogicalObjectCount, 8);
    assert.equal(result.matrix.inventory.geometryFinitePreflightPassed, true);
    assert.equal(result.matrix.inventory.nonFiniteGeometryValueCount, 0);
    assert.equal(result.matrix.inventory.diagnosticsUseColliderProxies, false);
    assert.equal(result.matrix.mapping.length, 9);
    assert.equal(result.matrix.visibility.invalidIdPixelCount, 0);
    assert.equal(result.matrix.visibility.visibleObjectCount, 8);
    assert.equal(
      result.matrix.materialAudit.liveMaterialReferencesUnchangedDuringDiagnostics,
      true,
    );
    assert.equal(
      result.matrix.materialAudit.liveMaterialPropertiesUnchangedDuringDiagnostics,
      true,
    );
    assert.equal(result.matrix.materialAudit.originalMaterialPropertiesRestored, true);
    assert.deepEqual(result.matrix.stateAudit, {
      directLitBeautyReportedAsVisiblePostprocessingEquivalent: false,
      liveMaterialStateVerified: true,
      liveCameraStateVerified: true,
      worldFingerprintVerified: true,
    });
    assert.deepEqual(result.matrix.isolation, {
      worldDataMutated: false,
      liveCameraMutated: false,
      liveMaterialsUsedForDiagnostics: false,
      diagnosticPostprocessingBypassed: true,
      rendererStateRestored: true,
      uiViewModeRestored: true,
      uiSelectionRestored: true,
    });
    assert.equal(result.matrix.cameraMatrixPassed, true);
    assert.deepEqual(result.qaWorld, {
      id: "paper-runtime-fixture",
      seed: 424242,
      prompt: "provider-free paper capture fixture",
      viewMode: "instance",
      cameraMode: "orbit",
    });
    assert.deepEqual(browserErrors, []);
  },
);

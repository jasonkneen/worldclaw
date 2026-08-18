#!/usr/bin/env node

import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { chromium } from "playwright";
import {
  defaultPrototypeRoot,
  discoverPrototypes,
  repoRoot,
} from "./lib.mjs";

const threeBuild = join(repoRoot, "node_modules/three/build");
const threeModule = join(threeBuild, "three.module.js");
const threeCore = join(threeBuild, "three.core.js");

function optionValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberOption(name, fallback) {
  const raw = optionValue(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function transpileModel(modulePath) {
  const source = readFileSync(modulePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    fileName: modulePath,
  });
  return outputText.replaceAll(/from\s+["']three["']/g, 'from "/three.module.js"');
}

function previewHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; background: #141418; overflow: hidden; }
      canvas { display: block; }
    </style>
  </head>
  <body>
    <canvas id="c"></canvas>
    <script type="module">
      import * as THREE from "/three.module.js";
      import * as modelModule from "/model.js";

      try {
        const params = new URLSearchParams(location.search);
        const width = Number(params.get("width") || 1024);
        const height = Number(params.get("height") || 1024);
        const yaw = Number(params.get("yaw") || 0.7);
        const pitch = Number(params.get("pitch") || 0.35);
        const canvas = document.getElementById("c");
        canvas.width = width;
        canvas.height = height;

        const createModel = modelModule.createModel ?? modelModule.default;
        if (typeof createModel !== "function") {
          throw new Error("createModel export is missing");
        }
        const created = createModel();
        const root = created?.isObject3D ? created : created?.root;
        if (!root?.isObject3D) throw new Error("createModel did not return a root");

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1c20);
        scene.add(new THREE.AmbientLight(0xffffff, 0.45));
        const key = new THREE.DirectionalLight(0xfff5e6, 1.35);
        key.position.set(4, 7, 5);
        scene.add(key);
        scene.add(new THREE.HemisphereLight(0xc8e0f0, 0x3a4a30, 0.35));
        scene.add(root);

        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.length() * 0.5, 0.4);
        const camera = new THREE.PerspectiveCamera(35, width / height, 0.05, Math.max(40, radius * 20));
        const distance = radius * 2.6;
        camera.position.set(
          center.x + Math.sin(yaw) * Math.cos(pitch) * distance,
          center.y + Math.sin(pitch) * distance,
          center.z + Math.cos(yaw) * Math.cos(pitch) * distance,
        );
        camera.lookAt(center);

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        renderer.setSize(width, height, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.render(scene, camera);
        window.__VIBE_PREVIEW_READY__ = true;
      } catch (error) {
        window.__VIBE_PREVIEW_ERROR__ = error instanceof Error ? error.stack || error.message : String(error);
        throw error;
      }
    </script>
  </body>
</html>`;
}

function startServer(files) {
  const missing = [];
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const body = files[url.pathname];
      if (!body) {
        missing.push(url.pathname);
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const type = url.pathname.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : url.pathname === "/" || url.pathname.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "application/octet-stream";
      response.writeHead(200, { "content-type": type });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({ server, port: address.port, missing });
    });
  });
}

const id = optionValue("--id");
const moduleOption = optionValue("--module");
const entries = discoverPrototypes(defaultPrototypeRoot);
const selected = moduleOption
  ? {
      modulePath: resolve(moduleOption),
      catalogue: {
        id: optionValue("--asset", "model"),
        yaw: numberOption("--yaw", 0.7),
        pitch: numberOption("--pitch", 0.35),
      },
      directory: dirname(resolve(moduleOption)),
    }
  : entries.find((entry) => entry.catalogue.id === id);

if (!selected) {
  throw new Error(id ? `Unknown vibe prototype: ${id}` : "Pass --id <model-id> or --module <model.ts>");
}

const width = numberOption("--width", 1024);
const height = numberOption("--height", 1024);
const yaw = numberOption("--yaw", selected.catalogue.yaw);
const pitch = numberOption("--pitch", selected.catalogue.pitch);
const previewDir = join(selected.directory, "preview");
mkdirSync(previewDir, { recursive: true });
const iteration = Date.now();
const output = resolve(
  optionValue("--output", join(previewDir, `${selected.catalogue.id}-${iteration}.png`)),
);
const latest = join(previewDir, "latest.png");

if (!existsSync(threeModule) || !existsSync(threeCore)) {
  throw new Error("three build files are missing from node_modules/three/build");
}

const reference = optionValue("--reference");
if (reference) {
  const referencePath = resolve(reference);
  if (!existsSync(referencePath)) {
    throw new Error(`reference image not found: ${referencePath}`);
  }
  const extension = extname(referencePath) || ".png";
  copyFileSync(referencePath, join(previewDir, `reference${extension}`));
}

const { server, port, missing } = await startServer({
  "/": previewHtml(),
  "/three.module.js": readFileSync(threeModule),
  "/three.core.js": readFileSync(threeCore),
  "/model.js": transpileModel(selected.modulePath),
});

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("favicon.ico")) return;
    pageErrors.push(text);
  });
  const url = `http://127.0.0.1:${port}/?width=${width}&height=${height}&yaw=${yaw}&pitch=${pitch}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  try {
    await page.waitForFunction(
      () => window.__VIBE_PREVIEW_READY__ === true || Boolean(window.__VIBE_PREVIEW_ERROR__),
      null,
      { timeout: 15000 },
    );
    const runtimeError = await page.evaluate(() => window.__VIBE_PREVIEW_ERROR__ ?? null);
    if (runtimeError) throw new Error(runtimeError);
    const ready = await page.evaluate(() => window.__VIBE_PREVIEW_READY__ === true);
    if (!ready) throw new Error("preview page loaded without becoming ready");
  } catch (error) {
    const missingHint = missing.length > 0 ? ` missing=${missing.join(",")}` : "";
    throw new Error(
      `vibe preview failed:${missingHint} ${pageErrors.join(" | ") || error}`.trim(),
    );
  }
  await page.locator("canvas").screenshot({ path: output });
  writeFileSync(latest, readFileSync(output));
  const report = {
    schemaVersion: 1,
    mode: "fast-preview",
    asset: selected.catalogue.id,
    module: relative(repoRoot, selected.modulePath),
    output: relative(repoRoot, output),
    latest: relative(repoRoot, latest),
    size: [width, height],
    camera: { yaw, pitch },
  };
  writeFileSync(join(previewDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}

#!/usr/bin/env node

import "./node-filereader.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Box3, Vector3 } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import {
  defaultPrototypeRoot,
  defaultVibePublicDir,
  discoverPrototypes,
  repoRoot,
  resolveCreateModel,
  unwrapModel,
} from "./lib.mjs";

function optionValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const root = optionValue("--root", defaultPrototypeRoot);
const outDir = optionValue("--out", defaultVibePublicDir);
const onlyId = optionValue("--id");
const entries = discoverPrototypes(root).filter((entry) =>
  onlyId ? entry.catalogue.id === onlyId : true,
);
const accepted = entries.filter((entry) => entry.catalogue.status === "accepted");
for (const entry of accepted) {
  if (!entry.catalogue.collider) {
    throw new Error(`${entry.catalogue.id}: accepted models require catalogue.collider`);
  }
}

mkdirSync(outDir, { recursive: true });

const published = [];
for (const entry of accepted) {
  const moduleUrl = pathToFileURL(entry.modulePath).href;
  const exported = await import(moduleUrl);
  const created = resolveCreateModel(exported)();
  const { root: modelRoot, dispose } = unwrapModel(created);
  modelRoot.name = entry.catalogue.node;
  modelRoot.userData = {
    ...modelRoot.userData,
    source: "vibe_model",
    prototype: entry.catalogue.prototype,
    modelId: entry.catalogue.id,
  };
  modelRoot.traverse((child) => {
    if (child.userData?.excludeFromExport) child.parent?.remove(child);
  });

  const box = new Box3().setFromObject(modelRoot);
  const size = box.getSize(new Vector3());
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(modelRoot, { binary: true });
  const fileName = `${entry.catalogue.id}.glb`;
  const outputPath = join(outDir, fileName);
  writeFileSync(outputPath, Buffer.from(glb));
  dispose?.();
  published.push({
    id: entry.catalogue.id,
    prototype: entry.catalogue.prototype,
    node: entry.catalogue.node,
    uri: `/worldclaw/assets/vibe/${fileName}`,
    targetHeightMeters: entry.catalogue.targetHeightMeters,
    collider: entry.catalogue.collider,
    appearanceTerms: entry.catalogue.appearanceTerms,
    materialIds: entry.catalogue.materialIds,
    bytes: Buffer.byteLength(glb),
    boundsMeters: [size.x, size.y, size.z],
  });
}

const library = {
  version: 1,
  source: "vibe_model",
  prototypes: Object.fromEntries(
    published.map((entry) => [
      entry.prototype,
      {
        node: entry.node,
        generator: entry.prototype,
        targetHeightMeters: entry.targetHeightMeters,
        collider: entry.collider,
        source: "vibe_model",
        libraryUri: entry.uri,
        defaultVariant: entry.id,
        variants: [
          {
            id: entry.id,
            node: entry.node,
            status: "authored",
            appearanceTerms: entry.appearanceTerms,
            materialIds: entry.materialIds,
          },
        ],
      },
    ]),
  ),
};

writeFileSync(join(outDir, "library.json"), `${JSON.stringify(library, null, 2)}\n`);
if (published.length > 0) {
  writeFileSync(
    join(outDir, "inventory.json"),
    `${JSON.stringify(
      {
        scanned: entries.length,
        accepted: accepted.length,
        published: published.length,
        models: published,
      },
      null,
      2,
    )}\n`,
  );
}
console.log(
  `WORLDCLAW_VIBE_COMPILE_OK scanned=${entries.length} accepted=${accepted.length} out=${relative(repoRoot, outDir)}`,
);

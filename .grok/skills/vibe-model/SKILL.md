---
name: vibe-model
description: >
  Preview-first reconstruction of reference-driven hard-surface props, machinery,
  signage, modular architecture, and hero assemblies as direct Three.js source
  for the WorldClaw asset kit. Use when building, revising, visually matching,
  previewing, or compiling a procedural hard-surface model into the WorldClaw
  published GLB overlay. Triggers on "vibe-model", "createModel", "hard-surface
  prop", "asset prototype", "reference-driven model". Do not use for generic
  Three.js application code, bitmap editing, characters, organic assets,
  foliage, terrain, or particle effects.
metadata:
  short-description: "WorldClaw hard-surface Three.js props: preview, critique, GLB overlay"
---

# Vibe Model

Build direct Three.js models with one short visual loop:

```text
model source -> deterministic preview -> independent visual critique
      ^                                      |
      `----------- highest-impact fix -------'
```

Before authoring, read both references completely:

- [fast-loop.md](references/fast-loop.md) for capture, critique, and publish
- [modeling-rules.md](references/modeling-rules.md) for hard-surface geometry

WorldClaw's Blender kit stays the offline compiler for existing families.
Vibe models are additional TypeScript sources. Accepted ones compile to their
own GLB and overlay the runtime kit by prototype key. Do not rewrite
`assets/worldclaw/asset-library.json` to `vibe_model` — the Blender validator
requires that file to stay `blender_procedural`.

## Author

Work in `assets/worldclaw/prototypes/<model-id>/`:

- `model.ts` — export `createModel`
- `catalogue.json` — id, prototype family, node, status, height, collider

`createModel` may return a Three.js `Group` or a controller with a stable
`root`, optional `update`, semantic parts and actions, and idempotent
`dispose`. Keep preview-only scene setup in `createPreview`.

Name the installed root `ASSET_<prototype>`. Metres, Y-up. Use shared
primitives when they preserve the intended shape. Keep the model small enough
to change in one focused edit.

`catalogue.json` status is `draft` until a critic accepts the preview.

## Preview

Capture as soon as the primary silhouette and major secondary masses exist:

```sh
npm run assets:vibe:preview -- --id <model-id>
```

Keep the camera deterministic. Change yaw, pitch, width, or height only when
the reference requires it.

## Critique

Give a fresh critic only the brief, reference, and current beauty image. Ask
for a resemblance score, what reads correctly, and no more than three
prioritized fixes.

Score silhouette and proportions first, then major masses and negative space,
distinctive landmarks, material/value/color read, and detail plausibility.
Apply the highest-impact correction and capture again.

Stop at a score of 85 or higher, after two plateauing scores, or after ten
iterations. Treat a plateau as evidence to change the representation or obtain
better reference evidence.

## Deliver

Set `status` to `accepted`. Then compile and rebuild:

```sh
npm run assets:vibe
npm run assets:build
```

`assets:build` runs the vibe compile first, then Blender. Report the model
source, final preview, iteration count, accepted score, and unresolved visual
approximations. Do not commit generated previews unless requested.

Organic families (palm, tree, pine, cactus, dragon) stay on the Blender path.
This skill is hard-surface only.

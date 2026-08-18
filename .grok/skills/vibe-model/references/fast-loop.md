# Visual-first loop

## Source

Each working model lives at `assets/worldclaw/prototypes/<model-id>/` with
`model.ts` and `catalogue.json`.

`createModel` may return a Three.js `Group` or a controller with a stable
`root`, `update`, `dispose`, semantic parts, and actions. Optional
`createPreview` may return `{ scene, camera, root, update, dispose }`.

Name the installed root `ASSET_<prototype>` (for example `ASSET_crate`).
Author in metres, Y-up. Mark preview-only nodes with
`userData.excludeFromExport = true`.

Capture before the model feels complete; detail follows the critic.

## Snapshot

```sh
npm run assets:vibe:preview -- --id <model-id>
npm run assets:vibe:preview -- --id <model-id> --reference <reference-image>
```

The default capture is one 1024×1024 beauty image under
`assets/worldclaw/prototypes/<model-id>/preview/`. Use yaw, pitch, width, or
height only when the reference requires them.

## Critic

Give a fresh critic the brief, reference, and current beauty image. Ask for a
resemblance score, what matches, and no more than three prioritized fixes.
Accept at 85. Otherwise implement the highest-impact correction and capture
again.

Stop at acceptance, two plateauing scores, or ten iterations. A plateau means
the representation or reference evidence needs to change.

## Delivery

Set `catalogue.json` `status` to `accepted`. Then:

```sh
npm run assets:vibe
npm run assets:build
```

`assets:vibe` writes `public/worldclaw/assets/vibe/<id>.glb` and a sidecar
library. `assets:build` runs that compile, then the existing Blender kit.
The Blender source manifest stays blender-only. Runtime overlays accepted
vibe prototypes onto the published kit by prototype key.

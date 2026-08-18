# WorldClaw Status, Progress, and Current Position

**Snapshot:** 2026-08-12  
**Branch:** `main` at `1e6a379`, 7 commits ahead of `origin/main`  
**Product status:** working candidate; not yet paper-superiority certified

## Executive summary

WorldClaw is now a working browser-based, model-guided 3D world generator with:

- current multi-provider planning, layout, visual-reference, critique, and final-review stages;
- deterministic semantic terrain, regional placement, collision/contact refinement, and Three.js exploration;
- a validated, reusable Blender/glTF asset library with saved turnarounds and material/construction metadata;
- retained evidence for successful and failed model stages, including in-app image previews rather than direct base64 links;
- registered map, isometric, oblique, and walk captures plus literal instance, depth, and normal diagnostics;
- an exact, prepaid, hash-bound eleven-case paper comparison harness.

The current position is **candidate**, not “better than the paper.” Core engineering, evidence, assets, and deterministic validation are substantially implemented, but no fresh paid Japanese run has passed all current gates after the latest fixes, and the complete eleven-case qualitative suite has not been executed and certified.

## Current user-visible behavior

### Generation and evidence

- The left process panel is resizable and paged into **Run**, **Models**, **World**, and **Library**.
- Every retained model artifact shows provider, model, stage, iteration, role, status, score, lineage, structured output, and saved image where available.
- Images open in an in-app modal. The UI does not expose unusable direct base64 links.
- Failed runs retain the richest available committee evidence instead of being overwritten by a later empty snapshot.
- Rejected model variants remain inspectable; they do not silently disappear.
- Pre-build appearance rejection is a certification warning, not permission to discard an otherwise buildable interactive world.
- Requested-object quantity coverage below 95% is now retained as an honest warning when all required hero kinds exist. Missing explicit heroes still fail closed.

### Interactive generation speed

- Ordinary preview committees use medium reasoning and finish after two independently usable results.
- Slower committee stragglers are cancelled once quorum is satisfied and displayed as `skipped after quorum`.
- Strict paper-benchmark execution still uses the complete fixed committee.
- Adaptive image repair remains bounded and is reserved for strict/feasibility-critical paths instead of repeatedly repairing ordinary previews.
- No paid run has yet measured the wall-clock improvement from these latest quorum changes; do not claim a percentage speedup yet.

### World inspection

- Orbit and walk cameras are available.
- Render modes include Lit, Instance, Depth, Normal, and Map.
- Instance rendering now preserves per-object colors for compiled assets without requiring geometry color attributes.
- Depth uses readable linear camera-space display rather than nearly-black perspective packing.
- Map framing fits the finite terrain and authored-object envelope.
- Walk spawning requires dry ground, collider clearance, and a usable forward sightline.

## Current model roster

These identifiers are verified in the live code and benchmark contract:

| Role                      | Provider/model                               |
| ------------------------- | -------------------------------------------- |
| xAI text and vision       | `grok-4.6`                                   |
| xAI image                 | `grok-imagine-image-quality`                 |
| Gemini text and vision    | `gemini-3.6-flash`                           |
| Gemini image              | `gemini-3-pro-image`                         |
| OpenAI text and vision    | `gpt-5.6-sol`                                |
| OpenAI image              | `gpt-image-2`                                |
| Anthropic text and vision | `anthropic/claude-opus-5` through AI Gateway |

There is no active Gemini 3.1 image path in the current roster. Gemini 3.6 Flash is treated as text/vision only; it is not mislabeled as an image-output model.

xAI text and vision now default to `grok-4.6` (committee, adapter, paid roster, paper generation/review, live check). Adapter, committee, and roster all honor `XAI_TEXT_MODEL` when set. Imagine remains `grok-imagine-image-quality`. Historical ledgers and older `progress.md` notes may still say 4.5. `aspect_ratio` / `resolution` / map-conditioned Imagine edits and a `grok-imagine-image-2.0` A/B remain follow-up work.

Provider controls include bounded request/response sizes, cancellation, timeouts, response identity checks where the upstream API exposes them, request-only identity where image APIs do not, paid-run attempt ceilings, append-only attempt evidence, and Gemini billing circuits/cooldown to stop repeatedly calling a known-failing direct credential.

Server credentials required by the fixed roster are present in the local `.xai_env`. Their values are not recorded here.

## Asset library

### Published library snapshot

| Metric              |                                                      Current value |
| ------------------- | -----------------------------------------------------------------: |
| Prototype families  |                                                                 27 |
| Authored variants   |                                                                 34 |
| Aliases             |                                                                 34 |
| Material IDs        |                                                                 54 |
| Saved evidence PNGs |                            35: 34 turnarounds plus 1 contact sheet |
| GLB size            |                            1,763,508 bytes, approximately 1.68 MiB |
| Nodes               |                                                                246 |
| Meshes              |                                                                212 |
| Vertices            |                                                             52,371 |
| Triangles           |                                                             45,550 |
| GLB SHA-256         | `17da60761498da76a9b2e2f351fe06d56458c5c50211fcda404f35470a762b9f` |
| Validator status    |                                                             passed |

The source and published manifests are byte-identical. Assets are meter-scale, Y-up at runtime, collider-described, and selected through explicit appearance/material vocabulary. The compact GLB preserves 34 authored roots while avoiding the earlier large mesh/node parse overhead.

### Coverage

- The paper suite names 36 unique object families.
- 35 families have authored, composite, or terrain coverage.
- `animals` remains explicitly unsupported; it is not dishonestly aliased to another asset.

### Asset browser

The `/assets` route provides:

- search and family filters;
- previous/next and keyboard navigation;
- saved four-view turnarounds and the compiled contact sheet;
- material vocabulary, construction recipe, dimensions, bounds, collider, meshes, vertices, and triangle data;
- desktop and mobile layouts;
- **Compare authored variants**, with side-by-side saved imagery and geometry/material/construction differences.

The comparison is correctly labeled as authored-variant comparison, not historical version control. Historical asset revisions are not yet archived as a browsable version timeline.

Representative evidence:

- `screenshots/worldclaw-asset-library.png`
- `screenshots/worldclaw-asset-library-mobile.png`
- `screenshots/worldclaw-asset-library-compare.png`
- `screenshots/worldclaw-asset-library-compare-mobile.png`

## Deterministic world-generation systems completed

- Prompt-count parsing and authority for exact requested heroes.
- Plan normalization, bounded feasibility checks, and benchmark-specific four-role contracts.
- Image-guided semantic region extraction with explicit map authority.
- Water/land classification, shoreline preservation, mirror/orientation metrics, and finite height generation.
- Named terrain shaping for bamboo terraces, basalt ridges, settlements, forests, beaches, rivers, and oceans.
- Authored-footprint placement with collision checks and bounded repair.
- Capacity-aware town streets, harbor berths, landmark reservation, and region ownership.
- Four exact boats in compact water-only, non-overlapping harbor berths.
- Bridges across real water channels with dry supports.
- Terrain contact, structure support sampling, bounded lot flattening, and penetration/floating repair.
- Safe walking spawn and collider-aware movement.
- GLB prototype/variant selection, batching, compiled-slot accounting, and explicit primitive-fallback evidence.

## Evidence and evaluation position

### Implemented

- Fixed registered map, isometric, oblique, and walk views.
- A nine-view paper matrix: global, four regional, and four walk views.
- Beauty, literal object ID, float camera-depth, and geometry-normal evidence.
- Camera matrices, reflection checks, world fingerprints, material-state isolation, and restoration checks.
- Hash-bound case, prompt, role, run, world, seed, ledger, structured-output, and image inventories.
- Four-model qualitative review with conservative aggregation: losses remain losses and split panels cannot become synthetic wins.
- Exact model/attempt budgets and a provider-free dry-run.
- Honest failure retention and token-redacted paid-attempt evidence.

### Not yet proven

- No current successful retained run exists after the latest fixes to visual-reference retention, regional capacity, requested-object coverage, and interactive quorum.
- The latest reported failures were stopped at internal quality gates; those gates now preserve viewable worlds when heroes exist, but a new paid run is required to prove the end-to-end result.
- The full eleven-case selected-figure suite has not produced a certified result bundle.
- Therefore WorldClaw must not yet claim scientific, whole-paper, or selected-figure superiority.
- Editing individual instances, independent object export/re-import, and model-free whole-world manifest replay remain roadmap items rather than completed product behavior.

See `docs/paper-superiority-scorecard.md` for the exact claim boundary and deterministic/qualitative gates. `progress.md` is a historical run ledger and contains earlier metrics and obsolete model-policy notes; this file is the current position snapshot.

## Latest verification

Verified against the live checkout on 2026-08-12:

| Gate                                   | Result                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `npm test`                             | passed, 284/284                                                               |
| `npm run typecheck`                    | passed                                                                        |
| `npm run lint`                         | passed with 0 errors and 3 existing Fast Refresh warnings in `WorldScene.tsx` |
| `git diff --check`                     | passed                                                                        |
| `npm run build:dev`                    | passed                                                                        |
| Asset validator                        | passed; exact GLB metrics and SHA listed above                                |
| Asset Library desktop browser QA       | passed; no console errors or provider requests                                |
| Asset Library mobile browser QA        | passed; comparison matrix remains accessible                                  |
| Live renderer QA on frozen compact GLB | passed after Instance, Depth, Map, and Walk repairs                           |
| Paper-suite single-case dry-run        | passed with zero paid calls                                                   |

The build reports an existing large client chunk warning for `AppShell` at roughly 1.58 MB minified. This is not a build failure, but code splitting is a performance follow-up.

## Repository/worktree position

- Branch: `main`, 7 local commits ahead of `origin/main`.
- Current HEAD: `1e6a379` (`Add ordinary Gemini billing cooldown`).
- The worktree is substantially dirty: 54 tracked status entries and 96 untracked entries at this snapshot.
- The tracked diff includes approximately 22,196 insertions and 10,522 deletions across 54 files.
- Generated `.vercel/output/**`, screenshots, QA evidence, Blender scripts/assets, new WorldClaw modules, and source changes coexist in the same checkout.
- Do not run destructive cleanup, reset, broad checkout, or blanket commit operations. Reconcile source, generated output, and evidence deliberately.
- The published asset tree is validated and should remain frozen unless a coordinated asset rebuild is explicitly intended.

The startup contract is `startup.sh`, which loads server-only credentials and starts the Vite preview on port 8080. A manual startup probe reached ready, but the detached process did not remain alive after the invoking shell ended in this host session. Treat persistent preview liveness as a current operational watch item; rerun and verify the startup lifecycle before claiming the preview is continuously available.

## Current risks and watchlist

1. **No post-fix paid proof:** deterministic tests are strong, but the newest retention and speed policies need one fresh real-provider generation.
2. **Benchmark not certified:** one Japanese pass cannot establish the eleven-case claim.
3. **Dirty worktree:** source, generated build artifacts, and evidence are not yet cleanly packaged for review or merge.
4. **Preview lifecycle:** startup reaches Vite ready but did not remain listening in this host invocation.
5. **Bundle size:** `AppShell` remains a large client chunk and should be split after behavior stabilizes.
6. **Asset ontology:** animals are the sole explicitly unsupported paper family.
7. **Version history:** authored variants are browsable and comparable, but historical asset revisions are not retained as a first-class timeline.
8. **Coverage semantics:** sub-95% model-density quantity is now a visible warning, while explicit hero absence remains a hard failure; certification can still reject the final result.
9. **xAI Imagine is request-incomplete:** no `aspect_ratio`, `resolution`, or reference-image edits, so Grok cannot lock to the canonical map the way Gemini/OpenAI can.
10. **Unauthenticated inference:** committee `createServerFn`s have no `authMiddleware`; interactive generate has no per-user spend cap. Paid ceilings are process-local and do not bind Vercel isolates.
11. **Empty-beach harbor invention:** unclassified extra beaches still receive dock×2 / boat×4 / ship×2 defaults.

## Recommended next execution order

1. Wire xAI Imagine `aspect_ratio` / `resolution` / map-conditioned edits (parity with Gemini and OpenAI). Keep `grok-imagine-image-quality` until a gated 2.0 A/B wins.
2. Stabilize and re-verify `startup.sh` persistence without changing the application contract.
3. Run one user-approved, paid Japanese case **on grok-4.6** and inspect the retained Run/Models/World evidence rather than only the terminal outcome.
4. Confirm that pre-build visual warnings and sub-95% non-hero quantity warnings retain an interactive world, while explicit missing heroes still stop.
5. Compare selected map/reference images against registered map/isometric/oblique/walk captures and inspect authored variants in `/assets`.
6. Fix only evidence-backed visual defects from that run; do not restart broad speculative refactors.
7. Freeze source/assets, rerun tests, typecheck, lint, build, asset validator, desktop/mobile/cancel QA, and capture checks.
8. Package the large dirty worktree into reviewable commits or a deliberate patch series.
9. Only after the Japanese case passes, run the eleven-case paid suite and four-model review under the existing call caps.

Separate from the 4.6 cutover, before any public deploy: gate the four inference server functions (they are currently unauthenticated), remount `AuthProvider` and the Grok banner in `__root.tsx`, and stop `ensureObjectRequirements` from inventing docks/boats/ships on empty beaches.

## Useful commands

```sh
# Start or revive preview
sh ./startup.sh

# Local deterministic gates
npm test
npm run typecheck
npm run lint
npm run build:dev
node scripts/blender/validate-worldclaw-kit.mjs

# Inspect the immutable paper case without spending quota
node scripts/worldclaw-paper-suite.mjs --dry-run --case figure-12-japanese-island-towns

# Provider/model availability check; this can call provider listing endpoints
node scripts/check-worldclaw-inference.mjs

# Paid suite is intentionally explicit; do not run without user authorization
npm run qa:worldclaw:paper -- --allow-paid-model-calls --case figure-12-japanese-island-towns
```

## Suggested skills for the next session

- `diagnosing-bugs` for any next failed stage; reproduce the exact retained artifact before editing.
- `reference-analysis-validator` and `orthographic-registration` for map/reference/camera fidelity.
- `multiview-constraint-solver` and `multiview-fit-loop` for concept-to-registered-view alignment.
- `threejs-qa-release` and `threejs-debug-profiler` for renderer/runtime and bundle follow-up.
- `blender-pro-workflow`, `blender-modeling`, `blender-materials`, and `blender-export` only for a coordinated asset rebuild.
- `code-review-change-size` before packaging the current large dirty worktree.

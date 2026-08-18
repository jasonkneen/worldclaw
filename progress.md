Original prompt: Build and iteratively improve WorldClaw into an agentic 3D open-world generator that exceeds the paper: use real current 2026 models collaboratively, expose every image/model/variant/critique stage, preserve reference-map fidelity across registered map/isometric/oblique/walk views, produce authored Blender assets and materials, and fail closed on measurable quality defects.

## Current quality loop

- Baseline preserved in the existing reference-validation screenshots and JSON artifacts.
- Current focus: stream the four-provider committee ledger while generation is running, retain partial/failing outputs, then run the strict Japanese archipelago reference-to-world gate.
- Provider contract: Grok 4.5 + Imagine Quality, Gemini 3.6 Flash + Gemini 3 Pro Image + visible Gemini 3.1 Flash Image variant, GPT-5.6-sol + GPT Image 2, Claude Opus 5 through the configured gateway.
- Current multiview optimization: one triptych per image provider, deterministic panel split, then independent repairs from only the selected provider.
- Do not overwrite or remove existing user/agent artifacts in the dirty worktree.

## QA ledger

- Three.js QA references loaded: browser, interaction, visual, mobile, performance, and release gates.
- Pending: progressive evidence wiring, full tests/typecheck/lint, strict live-provider generation, screenshot inspection, build and production/runtime verification.

## 2026-08-11 progressive evidence gate

- Added bounded `ensembleProgress` state and a pipeline evidence callback after planning, layout, and multiview stages.
- The model committee ledger now renders before final world composition and remains available after cancel/error.
- QA timeout/failure capture now persists the partial committee ledger and every retained image artifact.
- Multiview rejection paths now return their failed candidates and critiques before the pipeline fails closed; rejected output is no longer lost in an exception.
- Verification: TypeScript, targeted ESLint, Prettier, diff check, and full deterministic suite pass (113/113).
- Next: strict real-provider Japanese archipelago generation with the optimized four-triptych flow.

## 2026-08-12 retained failure and authority repair

- Strict real-provider run failed honestly after two iterations: concept sheets moved shorelines/landmarks, omitted torii/pagoda cues, and drifted boat visibility. All four providers/models authenticated; 4 layout/concept variants, critiques, and 3 flawed repair montages were retained.
- Visual inspection proved that provider outputs do not reliably obey a fixed strip layout or camera registration. A requested single-view repair can itself become a collage.
- Authority firewall now separates: canonical map/plan/manifest/colliders for structure; full unmodified image-model boards for construction/material/species/atmosphere; registered WebGL map/isometric/oblique/walk captures for final structural proof.
- Full provider outputs are retained without blind equal-width splitting. Repair is one complete selected concept board rather than three sheet-of-sheet calls.
- Runtime reference cameras now come from the fixed WorldClaw camera contract, never inferred from generated montage crops.
- Committee preference and candidate pass/fail are distinct; QA exports explicit selection and rationale.
- QA evidence is namespaced per run and `latest_run.json` identifies the current dossier.
- Verification after repair: 113/113 tests, TypeScript, ESLint, Prettier, and diff check pass.
- Adaptive repair is now score-triggered with bounded provider deadlines; ordinary free-text dissent no longer forces a costly second pass. Appearance-judge conflicts cannot contaminate the structural contract.
- A complete real-provider build reached `World ready`: 151/151 requested objects, 125 Blender GLB instances, and 26 honest primitive fallbacks. The process screenshot visibly confirms Japanese timber/plaster buildings, pagoda, torii, bamboo, sakura, and harbor assets.
- The first post-build evidence pass failed honestly while encoding the registered map. The unchanged high-resolution capture contract now has a 45-second render/encode deadline and the QA harness persists any post-ready failure instead of leaving a stale `running` dossier.
- Exact user counts now govern the visible watercraft synonym family: a noun-adjacent `four boats` removes model-added `ship` requirements unless the prompt explicitly counts ships too. Focused tests prove four boats and zero extra ships.
- Verification after these repairs: 115/115 deterministic tests, TypeScript, targeted ESLint, Prettier, and diff check pass.
- The next strict run completed end to end. Registered capture is now stable and emitted map/isometric/oblique/walk plus canonical/rendered/difference masks. Deterministic geometry passed: 98.9% land-water IoU, 99.9% shoreline F1, north-up identity orientation, finite cameras/depth, one water component, zero interior false water, and all compiled slots matched.
- It failed the correct visible-quality gates: 11 docks instead of 1, four boats on the wrong coast, sparse town organization, weak ridge/terrace expression, 5/6 southern buildings resolving the wrong construction contract, pagoda slate vocabulary mismatch, material-family F1 0.722, distant isometric/oblique framing, and a bamboo-obscured walk view.
- The final VLM also contradicted the deterministic shoreline evidence. Judge authority is being repaired so qualitative region/composition criticism remains visible but cannot rewrite proven map/water/orientation facts.
- Current repair streams: harbor/town/terrain composition; authored material vocabulary; registered camera framing; deterministic-vs-qualitative final-judge authority.
- Integrated and verified the first repair set: 124/124 tests, full lint/typecheck, frozen Blender asset validation, and production build all passed. Public GLB is reproducible at SHA `a59b4375…4515354`, 1,685,108 bytes and 29,240 triangles.
- Second strict live-provider run completed with the same prompt. Compared with the prior run: overall agreement 28→70, map 20→99, hero coverage 35→72, water 55→99; exact torii=1/pagoda=1/boat=4 now pass and boats occupy the eastern harbor. Construction improved 18→35 but remains below certification.
- Remaining run-two failures: model-invented huts/watchtowers inherited incompatible house construction requirements, construction evidence wording let judges invert `6/7 resolve` into `6/7 fail`, terrace/ridge silhouettes remained weak, and registered perspectives still had excessive empty ocean / a wall-blocked walk view.
- Third repair set now canonicalizes unrequested Japanese huts/watchtowers to authored buildings, scopes house construction terms away from pagoda/landmarks, emits explicit deterministic pass/fail counts, consolidates weak-vs-missing subjects, strengthens six terrace levels and dark basalt ridge geometry, and is tightening measured NDC camera fill/walk occlusion rejection.
- Run three completed at 68 and proved camera framing fixed, but exposed region ownership loss: model totals passed globally while northern/southern building counts moved between towns. The canonical map itself had excellent two-town/terrace/ridge composition; downstream repair collapsed it.
- Run four then failed earlier and honestly: 9/8 proposed buildings could fit the two semantic towns structurally, but retained vegetation/crates blocked all but 1/3 placements. No misleading final world was produced.
- Structure-first capacity policy now removes/re-packs town structures before dressing, probes real street-block capacity, reinserts props only collision-free, preserves explicit user counts, and reconciles only non-explicit model density with a shared balanced scale and four-building town minimum. Every region logs requested/capacity/chosen/placed/minimum/authority.
- Run-three raster replay now restores exact northern/southern ownership, suppresses the false ridge settlement, reconnects split basalt components on their principal axis, and expands bamboo into broad connected terrace bands.
- Current verification: 139/139 tests, TypeScript, full lint, asset validation, and diff checks pass.
- Next: one final strict live-provider build, visual comparison, then production/release handoff without weakening the gate.
- Strict run `2026-08-12T01-35-19-704Z` completed with every final capture and failed honestly at 60. Deterministic structure remains strong: 98.0% land-water IoU, 99.9% shoreline F1, north-up identity, one intact water component, exact torii/pagoda/four-boat counts, all 132 compiled slots, and material-family F1 0.904.
- Visual review confirms the remaining defects are real: one town remains under-composed, the pagoda is assigned to the bamboo island rather than its planned north-town site, the torii is too small to read as a hero, terrace/ridge massing is weak in perspective, and the walk capture is blocked by blossom trunks and a shoreline lip.
- The run also exposed four false construction conflicts caused by house-envelope prose leaking onto pagodas and fences. Construction authority now scopes prose to its nearest named subject and audits specialty objects against their selected manifest variants; explicit subject requirements remain hard gates.
- OpenAI/Claude planning and GPT Image layout calls were retained as timeout errors despite valid credentials. Bounded committee deadlines are now 150 seconds for text/vision and 180 seconds for image generation, with provider hard caps raised to 180/240 seconds while preserving cancellation and error evidence.
- Current verification after these fixes: 145/145 deterministic tests plus TypeScript and focused lint pass. Placement/terrain and inspection-camera repairs are in progress before the next paid strict run.
- Strict run `2026-08-12T02-09-16-481Z` proved all four text providers now complete under the widened deadlines and retained every layout/concept output. It failed before WebGL because its tiny image-derived FishingHarbor could not fit the prior 17.7m four-hull arc inside the authored harbor envelope.
- Exact four-boat placement now uses a compact deterministic 2x2 berth formation with real 9.4x3.6m hull footprints, water-only corners, non-overlap, bounded retries, and the original region lock. The selected-plan-shaped tiny-harbor regression passes.
- GPT Image layout generation was the only provider-stage timeout at 180 seconds; image calls now receive the adapter's full bounded 240-second window. Current verification: 148/148 tests, TypeScript, and lint pass.

## 2026-08-12 exact paper-suite and retained-failure gate

- Strict run `2026-08-12T03-19-30-127Z` retained all eight first-iteration layout/multiview image files but failed before WebGL: East Coastal Town reached only 3/4 buildings and Fishing Harbor incorrectly inherited a 4-building town program and reached 1/4.
- The regional fix keeps the quality gate intact: an exact two-town prompt removes only the surplus bare-harbor building program, retains boats/docks, reclaims adjacent dry generic roof fragments into their named town, defers optional dressing, and permits only bounded readable structure scales (`0.90/0.82/0.74`). Generic `Settlement N` masks no longer create competing town envelopes. Impossible layouts still fail closed.
- The same failure exposed a QA persistence race. The alert path first saved a rich 4-provider/8-artifact dossier, then the outer catch saved a sparse remounted DOM and erased the ledger. Committee persistence is now monotonic: stable provider/artifact IDs merge, richer fields and image-file references survive, later failure metadata is added, and failed runs remain explicitly `failed-retained` without reconstructing unknown selections.
- The exact paper PDF is fixed at SHA-256 `8369dfddc7fa5658fb589bb2723f11057c3dffc35f14b081cec0463980758a03`. Missing reference pages 33, 34, 36, and 38 were rendered from that PDF, completing immutable evidence for Figures 4–7 and 9–15.
- `assets/worldclaw/reference-validation/paper_prompt_suite.json` now versions all eleven exact paper prompts, page hashes, terrain relationships, object families, four regional roles, view requirements, and the three-reviewer median claim policy. `npm run qa:worldclaw:paper -- --dry-run` inspects it; a single case can run with `--case`, while the full paid run is deliberately explicit.
- The completion audit remains honest: the reusable Blender/GLB kit and browser runtime are proven, but the eleven-case suite, literal-mesh four-region/four-walk diagnostics, unsupported showcase asset families, and three-reviewer median are not yet complete. One Japanese run cannot establish paper-level parity.
- Current integrated verification: 163/163 deterministic tests, TypeScript, full ESLint, frozen public GLB validation (1,685,108 bytes, 29,240 triangles, SHA `a59b4375…4515354`), and diff checks pass. Next gates are literal-mesh capture integration, authored paper-family asset expansion, the repaired Japanese paid run, then the full eleven-case certification matrix.

# WorldClaw Selected-Figure Qualitative Scorecard

## Target

The goal is not architectural resemblance to _WorldClaw: Agentic 3D Open-World
Generation at Scale_. This scorecard compares the browser output against eleven
selected illustrated figures on six preregistered qualitative axes. Even a full
pass is not a scientific or whole-paper superiority result.

The paper reports qualitative figures rather than numerical scene-quality,
latency, memory, or prompt-success benchmarks (paper pp. 12–19). The thresholds
below are therefore project acceptance criteria, not claims made by the paper.

## Shared visual gates

Run the eleven illustrated prompt families from paper pp. 13–16 and 32–38. The
exact prompts, immutable page references, hashes, and evidence requirements are
versioned in `assets/worldclaw/reference-validation/paper_prompt_suite.json`.
For each world, capture a fixed global orbit, four regional views, four
ground-level walk views, and literal-mesh instance, linear camera-depth, and
geometry-normal diagnostics.

Four fixed-model reviewers compare hash-locked, role-matched captures. All four
must complete without blockers or uncertainty. Three wins and zero losses are
required for an axis win; any loss makes that case-axis a loss. A two-two split
is a tie, never a synthetic win. The result must satisfy all of the following:

| Axis                          | Pass condition                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global terrain organization   | Requested regions, paths/waterways, elevation hierarchy, and open-space composition read as clearly as the corresponding paper figure.                               |
| Regional content richness     | Required object categories are recognizable without labels and have comparable or greater density and silhouette variety.                                            |
| Material and lighting quality | PBR response, surface separation, value hierarchy, and atmosphere are at least as coherent; six of eleven scenes must be a strict visual win.                        |
| Ground-level stability        | No exposed terrain edges, floating assets, severe penetration, broken scale, blank distance fields, or camera-dependent geometry failures in any accepted walk view. |
| Prompt alignment              | Every named region, main object family, and stated relationship is present or an explicit failure is reported; silent substitution fails.                            |
| Diagnostic correctness        | One logical object has one instance ID across submeshes; depth is camera-space depth; normals are geometry normals; diagnostic passes bypass beauty postprocessing.  |

No case-axis may lose. At least four of six axes must win in at least six of the
eleven cases before this selected-figure model-panel result is claim-eligible.

## Beyond-paper engineering gates

These requirements cover evidence the paper does not demonstrate and are the
main route to a result that is better as a usable production system.

### Reproducibility

- A prompt plus explicit seed produces the same scene plan, placements, asset
  references, and statistical Blender build report on repeated runs.
- Published assets are content-addressed and include their SHA-256, tool version,
  coordinate convention, scale, origin/anchor, bounds, collider, materials, and
  triangle count.
- Generated code is allowlisted and declarative; a prompt cannot inject Python.

### Blender and glTF contract

- Blender is an offline compiler, never a browser or request-time dependency.
- Every supported showcase object resolves to an independent GLB prototype or a
  provenance-recorded imported/generated asset. Primitive fallback is visible in
  telemetry and is forbidden in accepted showcase captures.
- The GLB validator proves glTF 2, required named roots, finite transforms,
  nonempty meshes, supported PBR materials, correct ground/waterline anchors,
  collider metadata, file budgets, and manifest alias integrity.
- Exported assets load back into both Blender and Three.js without scale,
  orientation, pivot, material, or node-identity drift.

### Editing and reuse

- A user can select, transform, hide, delete, duplicate, and replace an instance
  without rebuilding terrain.
- A selected object can be exported independently and re-imported with the same
  identity, scale, material assignment, and ground contact.
- A complete world manifest can be exported and replayed without model calls.

### Browser runtime

- Initial nearby/low-LOD 3D payload is at most 8 MB.
- Orbit view stays at or below 200 draw calls and 1.5 million visible triangles
  on desktop; mobile stays at or below 120 draw calls and 500,000 triangles.
- Repeated vegetation, rocks, and buildings are instanced. Higher LODs stream
  with hysteresis instead of creating one `THREE.LOD` controller per object.
- Desktop and 390x844 mobile QA have no page/console errors, horizontal overflow,
  black canvas, context loss, or missing controls.
- Walk controls prove player-visible `A = left` and `D = right`, terrain following,
  bounds, fly controls, and listener cleanup over repeated mode switches.

### Honest failure behavior

- Provider, Blender, asset-validation, and GLB-load failures are surfaced with the
  failing stage and provenance. Telemetry never labels procedural placement as
  camera-ray recovery or blockout primitives as reconstructed textured meshes.
- Cancellation returns the UI promptly, ignores late results, and aborts or
  times out provider work so quota is bounded.
- Model-visible input fragments, outputs, asset counts, texture dimensions, and
  retries have hard caps.

## Evidence bundle

Every scored run must retain:

- normalized plan and seed;
- semantic layout and height/contact data;
- Blender version, command, manifest, report, GLB hashes, and validator output;
- renderer calls, triangles, geometries, textures, payload bytes, and load time;
- global/regional/walk/diagnostic captures at fixed cameras;
- contact and fallback counts;
- typecheck, unit/integration test, lint, production build, desktop QA, and mobile
  QA results.

## Reference-to-world validation contract

The three inputs have different authority and must not be averaged together:

1. The canonical semantic map owns coastline, land/water topology, X/Z region
   layout, landmark handedness, hero counts, and map anchors.
2. The approved map-conditioned multiview sheet owns silhouettes, construction
   systems, material families, palette, density, and camera intent. It remains a
   semantic/look reference until panel landmarks support pixel registration.
3. The structured plan owns named regions, relationships, exact requested
   counts, and failure semantics.

Final certification is the logical AND of deterministic gates and a vision
review. A high model score cannot compensate for a mirror, missing object,
wrong roof, water on land, or absent evidence. The machine-readable thresholds
are in `assets/worldclaw/reference-validation/reference_manifest.json`.

| Deterministic gate     | Required result                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map orientation        | Square orthographic north-up capture, finite matrices, positive handedness; fail when a mirror/180° alternative improves IoU by at least 0.02.          |
| Land/water topology    | IoU at least 0.95, boundary F1 at least 0.95 within 4 px at 1024², and P95 shoreline distance at most 6 px.                                             |
| Water integrity        | False water on land at most 0.5%, missing canonical water at most 1%, matching significant connected components, and at least 0.02 m terrain clearance. |
| Hero visibility        | Exact requested count and at least 64 stable ID-pass pixels for every hero in one matched final view.                                                   |
| Construction/materials | Every requested construction tag is present in the resolved GLB variant and material-family macro-F1 is at least 0.90.                                  |
| Capture completeness   | Map, isometric, oblique, and 1.65 m eye-height walk beauty/ID/depth evidence; zero non-finite depth pixels.                                             |

## Research-to-implementation ledger

| Source                                                                                                                                                                                                                                             | Adopted constraint                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MVD-Fusion](https://openaccess.thecvf.com/content/CVPR2024/html/Hu_MVD-Fusion_Single-view_3D_via_Depth-consistent_Multi-view_Generation_CVPR_2024_paper.html)                                                                                     | Generate multiple map-conditioned views before geometry and keep camera roles explicit rather than asking one attractive image to stand in for 3D consistency.        |
| [MVGBench](https://www.openaccess.thecvf.com/content/ICCV2025/papers/Xie_MVGBench_a_Comprehensive_Benchmark_for_Multi-view_Generation_Models_ICCV_2025_paper.pdf)                                                                                  | Judge view consistency and semantic preservation separately; retain all views and camera metadata.                                                                    |
| [SAM 3D Objects](https://ai.meta.com/blog/sam-3d/) and [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)                                                                                                                           | Treat per-object images/turnarounds and independent asset identity as the route to future image-to-3D replacement, not as decorative gallery output.                  |
| [CGA shape grammars](https://emeritus.icu.ee.ethz.ch/research/demos/procedural-modeling.html)                                                                                                                                                      | Model walls, openings, doors, roof assemblies, trim, and weathering as named construction systems rather than stretched boxes.                                        |
| [buildingSMART opening relationships](https://standards.buildingsmart.org/IFC/RELEASE/IFC2x3/TC1/HTML/ifcproductextension/lexical/ifcrelfillselement.htm)                                                                                          | Openings are explicit host/fill relationships: wall void, reveal, frame, door/window leaf, and glazing are separately evidenced.                                      |
| [buildingSMART roof types](https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcRoofTypeEnum.htm)                                                                                                                     | Roof type is a semantic choice with pitch, eaves, ridge/cap, and course construction, not merely a cone or prism.                                                     |
| Official [Grok 4.6](https://docs.x.ai/developers/grok-4-6), [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), and [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation) documentation | Use Grok 4.6 and Gemini 3.6 Flash for current planning/vision; use the current image-generation model family for pixels. Do not relabel an image model as Gemini 3.6. |

## Current milestone (2026-08-12)

Implemented and locally verified so far:

- Real-provider planning and visual analysis use the fixed committee Grok 4.6,
  Gemini 3.6 Flash, GPT-5.6 Sol, and Claude Opus 5. Image candidates use separate
  current image-model identities and are never mislabeled as text models.
- The map-conditioned pre-build sheet contains isometric, oblique, and walk
  concepts; the final renderer captures square map, isometric, oblique, and walk
  views without mutating the user's camera or diagnostic mode.
- The process panel is horizontally resizable and exposes a stage ledger,
  provider identity, retained map/sheet, final comparison, requested-to-placed
  counts, GLB provenance, contact sheet, and per-variant turnaround dossiers.
- The deterministic Blender compiler publishes 27 meter-scale GLB prototypes,
  34 variants, 54 materials, collider contracts, hashes, budgets, 34 four-view
  dossiers, and a contact sheet. The frozen 2,556,844-byte GLB contains 45,550
  triangles and was byte-identical across two fresh Blender processes.
- Placement uses authored footprints, organized settlement/harbor layouts,
  exact hero rescue, terrain contact refinement, safe walk spawn, and collision
  proxies. Global water is emitted only for scenes with an ocean region.
- A final Gemini 3.6 comparison is wired after actual renderer capture and is
  unable to override current deterministic count, construction, orientation,
  and height/water failures.

Still required before any selected-figure qualitative claim:

- Land/water mask, shoreline boundary, mirror/rotation, ID-pixel visibility,
  material-family, and depth-finiteness metrics must be integrated into the
  final hard gate and displayed with overlay/difference artifacts.
- A fresh exact-prompt Japanese paid generation and four-reviewer result must
  pass the new prompt/run/world/seed binding and conservative comparison gate.
- Desktop, mobile, cancellation, production-build, and matched-view visual QA
  must all pass after the asset tree is frozen.
- The eleven paper prompt families and fixed four-model review remain the final
  selected-figure suite. Until they pass, the honest status is **candidate**.

## Completion audit (2026-08-12)

The exact local PDF was re-audited at SHA-256
`8369dfddc7fa5658fb589bb2723f11057c3dffc35f14b081cec0463980758a03`.
The paper's comparison discussion explicitly uses three broad axes—terrain and
region organization, content richness and prompt alignment, and free-viewpoint
appearance/scene representation (pp. 17–19). The six axes above are this
project's stricter decomposition; they are not numerical claims made by the
paper.

The reusable Blender/GLB kit, Three.js batching, committee ledger, and strict
map/shoreline metrics are implemented, but paper-level completion is not yet
proven. In particular:

- no eleven-case retained result bundle or four-model panel result exists yet;
- the current Japanese stress case has not produced a passing final visual
  verdict;
- the nine-view paper capture is implemented and executable, but paid results
  have not yet been produced with the hardened binding contract;
- literal-mesh instance, float camera-depth, and geometry-normal diagnostics now
  pass provider-free browser regression, but must also pass each paid world;
- 35 of 36 paper object families now have authored/composite/terrain coverage;
  animals remain explicitly unsupported because no animal runtime ontology exists; and
- instance transform/hide/delete/duplicate/replace, independent export/reimport,
  and model-free world-manifest replay remain engineering goals rather than
  completed capabilities.

Use `npm run qa:worldclaw:paper -- --dry-run` to inspect the immutable suite and
paid-call cap. Paid execution additionally requires `--allow-paid-model-calls`.
Use `--continue-on-failure` only when intentionally spending quota on all eleven
cases. A single-case pass with `--case <case-id>` never upgrades the suite claim.

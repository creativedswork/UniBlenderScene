# Validation

## Pre-submission checks — 2026-11-13

The local submission check passed `npm run check`, `npm run build` and all
30 unit tests. `npm run test:blender` passed on Blender 5.1.1 with 16 MCP tools,
70 bounded-revision guard cases, gray work/confirmation previews, explicit
approval and downstream appearance export. Its synthetic 2.7-million-triangle
fixture took about 47 seconds for each guard snapshot, within the default
300-second bridge timeout. These timings describe this fixture, not a production
performance guarantee. Evidence is under
`.canova/runs/blender-integration-j1yIpp/`.

`npm run test:viewer -- .canova/runs/blender-integration-j1yIpp` also passed,
covering the work-draft and confirmation views, approval controls and existing
interactive viewer checks, with no page errors.

Both native Claude manifests passed `claude plugin validate`; the plugin retains
the documented root `CLAUDE.md` warning. The user confirmed Claude Code workflow
validation before submission; this check did not repeat a paid model run.
`npm run pack:plugin` produced a 0.3.3 archive with both harness entries and the
built viewer. Archive inspection excluded runtime scenes, `canova_output/`,
dependencies and environment files other than `.env.example`. Staged paths,
credential-pattern scanning and local Markdown links were also checked.

## 0.3.3 phase-driven work, confirmation and delivery — 2026-11-09

SceneStore now derives one `workflowState` from each scene's persisted plan,
workflow index and operation state. Every scene response exposes production
phase, operation status, approval flag, and presentation mode/purpose/source/
iteration. There is no parallel writable phase field. Geometry and composition
edits render gray automatically; material, lighting and final work render
appearance; delivery selects the reviewed best version.

`scene_preview` and `scene_review_views` now support incomplete geometry or
composition work, using the current `.blend` rather than an older best version.
Work previews cannot approve structure or enable final export. Confirmation
previews still use the preserved checkpoint. Five-view evidence and GLB caches
bind to their actual source and iteration; profile/manifest metadata also binds
purpose and phase. Old images and caches are hidden when those bindings do not
match. Phase transitions invalidate prior presentation, and image requests
while jobs run return state without image bytes.

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript, viewer build, unit tests | Passed; 24 tests | `npm run check`, `npm run build`, `npm test` |
| Blender work-preview / approval / final delivery | Passed | `npm run test:blender`; `.canova/runs/blender-integration-KNdaBn/` |
| Browser draft and confirmation states | Passed | `npm run test:viewer -- .canova/runs/blender-integration-KNdaBn` |
| Actual revision-17 geometry work | Passed in an isolated copy | `.canova/runs/workflow-room-x2oBGd/result.json` |

Regression tests reproduce revision 17 with stale revision-16 views and an older
best checkpoint. Only current-17 gray work evidence becomes available; preview
preserves phase, status, counters, budget and approval. A subsequent revision
invalidates the old preview. Restart tests reconstruct the same state and cache
bindings. Blender checks cover automatic gray geometry rendering, work previews
before any best checkpoint exists, forbidden premature approval/export, normal
confirmation and downstream appearance delivery. Browser checks show a work-draft
label and hide approval controls until confirmation, alongside the existing
interactive viewer checks.

The reported room was copied into its own SceneStore and dedicated bridge. Its
state remained geometry/edit, current iteration 17, structural work, not approved.
The generated GLB was 211,375,068 bytes with no texture images; current `.blend`
hashes, counters and stage budget were unchanged. Reloading that copy reproduced
the same workflow state. No live scene was altered or approved, and the running
user service was not restarted. The service can validate tool state and artifact
identity; it cannot guarantee every free-form sentence written by an agent.

## 0.3.2 structural gray review — 2026-11-09

Composition confirmation now presents the neutral gray checkpoint image through
`scene_get`, snapshot render URLs, image aliases, and the viewer main image. All
five Workbench views use single-color shading, a neutral background and grayscale
PNG output. Review GLBs receive opaque gray materials and neutral studio lighting
on an export copy; textures, vertex colors, lighting bakes and HDR environments
are excluded from that copy. Source `.blend` files keep their original appearance.

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript, viewer build and unit tests | Passed; 22 tests | `npm run check`, `npm run build`, `npm test` |
| Real Blender preview and restoration | Passed | `npm run test:blender`; `.canova/runs/blender-integration-yW5hCL/` |
| Browser main image and structural 3D | Passed | `npm run test:viewer -- .canova/runs/blender-integration-yW5hCL`; `viewer-structural-3d.png` |
| Reported room checkpoint | Passed in an isolated copy | `.canova/runs/structural-room-GaT1k5/result.json` |

Tests check texture-free gray GLB materials, neutral light colors, disabled camera
depth of field, stable graph mappings, correct gray PNG delivery through MCP and
HTTP aliases, and unchanged source/checkpoint bytes. Legacy colored previews are
hidden and regenerated even when the iteration has not changed. Regenerating the
five views invalidates the preview cache and manifest. Approval stays pending
until an explicit decision; the downstream stages and final export retain the
original red material and procedural textures in the integration fixture.

The browser checks grayscale pixels in the main review image and loads the
structural GLB into the path tracer, alongside the existing selection, orbit,
reference-gallery and approve/revise checks. The reported room's checkpoint 16
was copied into an isolated SceneStore with a dedicated bridge: all five views
were regenerated, the new 211,375,076-byte GLB had no texture images and used gray
materials, and the source `.blend` hash and pending approval were preserved.
The browser interaction check used the small integration fixture, not that large
room GLB. No running user service was restarted and no original scene was
approved or rewritten. Existing installations need the updated service/plugin
and a new `scene_preview` call to replace their old review assets.

## 0.3.1 image history reduction — 2026-11-09

`scene_get.images` now selects `none`, `render`, `references`, or `all`. Omitted
selection preserves the legacy all-images response. Reference/object selectors
reject conflicting image modes. The shared Skill, MCP prompt, tool descriptions,
and optional Codex agent templates now request metadata without images, inspect
references once, and retrieve each new render without repeating every reference.

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript and viewer build | Passed | `npm run check`, `npm run build` |
| Unit tests | 22 passed | `npm test`; six-reference selector regression and invalid combinations included |
| Blender output selection | Passed | `npm run test:blender`; `.canova/runs/blender-integration-8c2klA/` |
| Browser viewer | Passed | `npm run test:viewer -- .canova/runs/blender-integration-8c2klA` |
| TTADK Claude Code / `gpt-6.1-sol` | Passed | `npm run test:claude`; `.canova/runs/claude-integration-Hw1cjI/result.json` |
| Native Claude manifests | Passed | Plugin validator retains the documented repository `CLAUDE.md` warning; marketplace validation passed |

The unit fixture contains six references and one render: legacy/all returns
seven image blocks, render-only returns one, references-only returns six, and
none returns zero while preserving metadata. Two repeated render inspections
return two image blocks instead of fourteen; each inspection still sends its
render, and no client-history deletion or server-side deduplication is implied.
Selection leaves scene state and budgets unchanged. Real Blender checks verify
that selected render/reference bytes match the PNG assets.

The Claude smoke run used low effort, loaded the shared Skill, explicitly
selected `none` for initial state and `render` for finished visual evidence,
completed review and GLB export, and emitted one image block in its tool-result
messages. It produced a 269,928-byte PNG and 115,376-byte GLB. This small supplied-
script run validates tool selection and delivery, not model quality or automatic
recovery of a conversation already over its image limit. The separate browser
check verifies the existing interactive viewer.

Image counting and the conservative checkpoint around 35 images are host
instructions, not an enforced conversation quota. They include Read, screenshots,
Provider results and MCP images, preserve mandatory visual review and user
approval, and provide handoff/recovery instructions. The MCP service cannot prune
historical host messages. No live user session was cleared or rewritten; plugin
installation, service deployment and public publication were not performed.

## 0.3.0 multi-harness packaging — 2026-11-08

Checked locally with Node.js 22.20.0, Blender 5.1.1, Claude Code 2.1.187,
and TTADK 1.0.28. The project and plugin identity is now UniBlenderScene /
`uni-blender-scene`. The existing GitHub repository has not been renamed or
published by these checks.

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript and viewer build | Passed | `npm run check`, `npm run build` |
| Unit tests | 21 passed | `npm test`; includes shared manifest identity and configuring both MCP transports |
| Native Claude manifests | Passed | `claude plugin validate .claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` |
| Real Blender workflow | Passed | `npm run test:blender`; `.canova/runs/blender-integration-Nin6FT/` |
| MCP Apps browser viewer | Passed | `npm run test:viewer -- .canova/runs/blender-integration-Nin6FT` |
| TTADK Claude Code, GPT-6.1 Sol | Passed | `npm run test:claude`; `.canova/runs/claude-integration-5cfxCp/result.json` |
| Dual-harness ZIP | Passed | `npm run pack:plugin`; required entries present and runtime/secret exclusions checked |

The native manifest validator warns that root `CLAUDE.md` is not installed
plugin context. That file imports repository contributor instructions;
`skills/` owns installed plugin behavior. Claude discovers the shared 17 Skills
at the root and uses its native `http` MCP configuration. Codex retains the
portable root manifest and `streamable-http` configuration. Both connect to the
same service. Configuration tests verify that endpoint changes reach both
harnesses and invalid remote HTTP URLs leave both configurations unchanged.

The Blender run exercised all 15 tools, PNG rendering, reviewed GLB export,
Provider provenance checks with a local fixture, five composition views,
explicit approval, scope rollback, and failed-edit recovery. It produced a
269,935-byte PNG and 115,376-byte GLB. The browser integration exercised the
bundled viewer with these artifacts, including selection bounds and world axes,
orbit, render/3D switching, review controls, and artifact transfers.

The Claude run used `ttadk claude -m gpt-6.1-sol` with session-local plugin
loading, low reasoning effort, and Read/Skill plus this plugin's MCP tools.
Initialization and result model usage both identified `gpt-6.1-sol`; the MCP
connection was connected and all 17 shared Skills were discovered. The model
loaded `blender-scene`, read the supplied `tests/scene.py` fixture, then called
create, plan, graph verification, edit, image retrieval, review, export, and
progress tools. The test checked the stored completed state and actual output
bytes: 269,928-byte PNG and 115,376-byte GLB. It verifies harness integration
with a supplied script, not autonomous scene-code quality or reconstruction
fidelity. No paid asset provider or subagent was used.

The model attempted an optional `scene_graph` status update during review, which
the service rejected because graph mutation requires editing state. It reported
the rejection and completed review/export. The generated mesh still carries
`scene_node_id`, and export derives the renderable graph mapping from GLB data.
Early attempts encountered an empty TTADK model list, a test prompt that triggered
the image-request guard, and a model-run timeout; these are not counted as passed
end-to-end runs. The final run above completed with exit status 0.

GitHub publication, service deployment, persistent client installation, and
public plugin-directory approval were not performed. The CLI smoke test does
not verify an embedded viewer; that check belongs to the browser integration.

## Composition checkpoint preview — 2026-11-08

Type checking, viewer build, and all 20 unit tests passed. Blender 5.1.1
integration also passed: `scene_preview` prepares a pending checkpoint's GLB,
render profile, Scene Graph, and manifest while retaining `awaiting_review`,
`compositionApproved=false`, and unchanged checkpoint bytes. Final export stays
blocked. Unit tests cover pending-state persistence and preview invalidation
after the composition decision. Built organizational groups map through their
descendant meshes rather than requiring a direct mesh.

Chrome loaded the room's approximately 205 MiB GLB in a local MCP Apps host.
Manual checks covered tree selection of the chair, visible bounds and XYZ
arrows, orbit alignment, cancellation, and re-selection. The bundled viewer's
chunk loader accepts files up to 256 MiB; this single room check does not
establish a general performance target. The host was a session helper, not a
packaged browser server. The room remains at composition review, with material
and lighting work pending. The [README](../README.md) includes the checked
viewer screenshot; generated scenes and runtime evidence remain outside Git.

## 0.2.1 preview selection — 2026-11-08

Type checking, viewer build and all 19 unit tests passed. Chromium 156 browser
integration passed against the real Blender export fixture, including 12-edge
world-space selection bounds, XYZ arrows, child/group selection, tree/viewport
sync, clear/Escape/empty-space deselection, orbit and render-mode visibility.
The browser waits for path-tracer warmup before the selection sequence and uses
actual mouse input for immediate re-selection after cancellation.

The arrows are direction indicators, without drag editing or Blender writeback.
The selection helpers do not enter the traced scene. Blender execution/export
was unchanged from the 0.2.0 checks below, so that integration was not repeated
for this UI change. Local evidence is retained under
`.canova/runs/acceptance-0.2.1/`; see the [manual checklist](acceptance-0.2.1.md).

## 0.2.0 workflow enforcement — 2026-11-08

Type checking, viewer build and all 19 unit tests passed. Blender 5.1.1 integration
passed through the HTTP MCP interface, including Provider discovery blocking,
local GLB provenance/import checks, graph verification, iteration-bound scene
inspection, all-reference evidence, mandatory composition approval, five Workbench
review views, stage scope violation rollback, failed-edit retry and final export.
The Provider test uses a local GLB fixture and does not call or charge Meshy.

Browser integration passed for the five actual structural images, approval and
return-to-geometry controls, reference gallery, GLB loading, orbit, reset and
render/3D switching. Reports and screenshots are retained locally under
`.canova/runs/acceptance-0.2.0/`. The local plugin cache and running MCP service
were updated to 0.2.0; a live empty-scene smoke check reached the dedicated
Blender 5.1.1 bridge. GitHub publication and public-directory approval were not
performed.

The service validates workflow records and basic factor signatures. Host
capability discovery, semantic object classification, reference resemblance and
claims about external Provider tasks still require host/user judgment. These
checks do not measure 1:1 reconstruction accuracy. See the
[acceptance checklist](acceptance-0.2.0.md) for manual checks and coverage limits.

## Scene Graph and staged preview — 2026-11-08

The first implementation adds ordered stage budgets and structured reviews,
composition approval with five neutral Blender renders, stable Scene Graph IDs,
GLB mapping checks, a matching export manifest, and a selectable hierarchy in
the Three.js viewer. The service blocks edits and export while awaiting the
explicit composition decision. Unit tests cover graph cycles, duplicate names,
unknown relations, stage transitions, restart persistence, and missing built
mesh mappings. Blender 5.1.1 integration confirms all five review images,
approval gating, and a real exported object ID. Browser integration confirms
child and group selection with a visible overlay, orbit, camera reset, and
render/3D switching.

`npm run check`, `npm run build`, `npm test`, `npm run test:blender`, and
`npm run test:viewer -- <evidenceDirectory>` passed. The viewer screenshot was
also inspected and the graph layout corrected. Automated Blender state
fingerprints for stage edit restrictions were outside that first pass and were
added with limited coverage in 0.2.0. Local color measurements and broader
orthographic and hidden-object browser fixtures remain unverified.

## Multi-view reference input — 2026-11-05

The input convention matches Canova: one primary view for camera/composition
and up to five auxiliary views of the same scene for spatial reasoning. The
plugin retains the single-image API, persists ordered views with labels, returns
every image to the host, and accepts additional views on scene continuation.
Primary image-space anchors remain separate from auxiliary spatial criteria.

Type checking, build, unit tests, Blender integration, and viewer integration
passed. The HTTPS integration exercised both input forms, every reference image
in `scene_get`, auxiliary asset chunks, MIME types, and artifact access tokens.
Unit tests checked restart persistence, six-image limits, primary preservation,
and failed-download rollback. Browser tests used a simulated upload host to
check primary selection, reference switching/enlargement, and appending views.
These checks cover input delivery and UI behavior; they do not measure the host
model's reconstruction accuracy from multiple views.

Local Codex attachments also accept `local_path` within configured
`LOCAL_REFERENCE_ROOTS`. All 10 unit tests passed, including disabled-by-default
local access, symlink boundary rejection, invalid image rejection, and MCP input
validation. The Blender integration initialized a scene with two local image
paths and returned both images through `scene_get`; viewer integration passed.
The local marketplace cache was refreshed, and the running service read the
user-supplied room photo through a dedicated Blender 5.1.1 bridge. This does not
establish a fresh native Codex conversation's automatic tool selection or UI.

## 0.1.2 path-traced preview alignment — 2026-11-05

Compared the local Canova commit `4f36073` with this plugin's GLB exporter and
viewer. The preview now traces every exported light using its Blender energy,
including area-light occlusion and indirect bounces. It uses a sampled Blender
display transform instead of image-wide CSS color calibration, and exports the
camera projection matrix and depth-of-field settings. The old three-light shadow
limit, spot-light shadow proxy, and GTAO pass were removed.

`npm run check`, `npm run build`, `npm test`, `npm run test:blender`, and
`npm run test:viewer -- <evidenceDirectory>` passed. The Blender test used a
dedicated Blender 5.1.1 bridge and confirmed the light energy, display LUT, and
projection matrix in `render-profile.json`. The iframe test reached 32 path
tracing samples with 8 bounces, loaded the Blender LUT, and exercised orbit,
reset, mode switching, refinement, and downloads. The test scene included a
diffuse floor patch to inspect its contact shadow; the browser screenshot was
visually inspected. The exporter also bakes procedural base color, roughness,
metallic, normal, and emission color inputs into PBR textures. The Blender test
confirmed a procedural color texture in the GLB. The gamer-bedroom scene was
re-exported with three material textures and checked in the bundled viewer with
four scene lights, the Blender LUT, and orbit interaction. These checks do not
establish pixel-level Cycles equivalence or full parity with Canova's exporter.
`npm run check:scenario-skills` reported a newer upstream Scenario revision
(`b8544b9`); the inspected Canova commit still pins `e24bc7d`, so this renderer
update kept the packaged Scenario revision.

## 0.1.1 local alignment check — 2026-11-05

The workspace passed `npm run check`, `npm run build`, and `npm test` (9 tests).
`npm run test:blender` passed using an isolated Blender 5.1.1 process and
temporary run directory. `npm run pack:plugin` produced a ZIP containing the
production adapter and Scenario knowledge. The 15 copied Scenario Skills and
97 files matched the pinned source checksums.

The local marketplace installed version 0.1.1 into the Codex plugin cache;
the installed scene Skill, adapter, and service source matched the workspace.
The running local service at `127.0.0.1:4312` exposed the updated tool
descriptions and rejected an image-reference request without a reference file.
These checks do not measure scene fidelity or verify that a future host forwards
an attached image. The 0.1.0 viewer and packaging checks below were not repeated
for that skill change.

## 0.1.0 release checks

Checked on 2026-11-04 with Node.js 22.20.0, Blender 5.1.1, and Chromium
148.0.7778.96 on macOS. The service used a separate Blender process, HTTP port,
and temporary `.canova/runs` directory.

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript | Passed | `npm run check` |
| Self-contained viewer build | Passed | `npm run build` |
| Workflow checks | 5 passed | `npm test` |
| Portable manifests | Passed | Draft 2020-12 validation against the canonical `plugin.json` and `mcp.json` schemas |
| Dependency advisories | 0 reported | `npm audit --registry=https://registry.npmjs.org` |
| Real Blender workflow | Passed | `npm run test:blender` |
| MCP Apps iframe viewer | Passed | `npm run test:viewer -- <evidenceDirectory>` |
| Clean ZIP extraction | Passed | Fresh `npm ci`, type check, build, and all 5 workflow checks in a separate directory |
| Archive exclusions | Passed | 35 entries; no `.git`, `.canova`, `node_modules`, or `.env` included |

The Blender check exercised HTTP MCP initialization, all eight tool
registrations, resource reading, scene creation, frozen planning, Python edits,
PNG rendering, review recording, best-checkpoint GLB export, and scene viewing.
It polled jobs through image-free `scene_view` responses and queried one named
Blender object for its rotation mode, world matrix, materials, and polygon count.
It rejected stale reviews and unauthorized artifact reads, transferred a PNG
through an explicitly approved HTTPS reference host, continued a scene with a
new request, and recovered from an intentionally failed edit. A subsequent
Blender edit asserted that the original object existed and the failed mutation
had been removed.

The example generated a 266,997-byte PNG and a 16,300-byte GLB. Its render showed
a red beveled cube on a lit floor. The integration script supplied review values
to test the protocol; it did not run an autonomous model or measure visual
similarity. The rendered image and interactive preview were separately inspected.

The viewer check used the official MCP AppBridge in a sandboxed iframe with
`allow-scripts`, `allow-same-origin`, and `allow-downloads`, without form
submission permission. CSP restricted assets to the test origin. It verified
the handshake, GLB loading, automatic color calibration, orbit dragging, camera
reset, render/3D switching, refinement messages, expansion requests, and GLB
download. It recorded no JavaScript page errors.

![Blender viewer in the integration iframe](viewer-preview.png)

The image shows the bundled viewer with the integration scene. WebGL lighting
approximates Blender; this check does not establish pixel equivalence.

## Scope

The package adapts the scene workflow for a host-supplied model. It does not
include the original ModelHub integration, Codex App Server runtime, evaluation
runner, application session UI, or historical scene data.

These checks do not establish HTTPS deployment, installation in a live ChatGPT
account, ChatGPT-native image upload, automatic Skill selection, subagent
registration, OAuth, public-directory approval, multi-user isolation, or
performance on large production scenes. Read the
[service setup](operations.md) before connecting a client.

The [portable manifest](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
and [MCP configuration](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)
were checked against their canonical schemas.

The plugin's ZIP includes the built viewer and excludes dependencies,
credentials and runtime data. GitHub publication distributes source; it does
not deploy the MCP service or start Blender.

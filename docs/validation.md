# Validation

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

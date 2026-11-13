# UniBlenderScene

A Blender scene creation and review plugin for agent harnesses, with native
plugin entries for **Codex** and **Claude Code**.

Turn reference images or text into editable Blender scenes. Both plugins share
the same Skills, staged workflow and MCP service: plan the scene, build geometry,
confirm composition in gray, then refine materials and lighting. Deliver renders,
`.blend` files and GLBs, with an interactive Three.js viewer in compatible hosts.

| Host | Integration | Visual review |
| --- | --- | --- |
| Codex | Portable plugin manifest and shared Skills | Renders and artifact links; interactive preview in an MCP Apps host |
| Claude Code | Native plugin manifest and shared Skills | Render inspection and `.blend`/GLB links in the terminal |
| Other agent harnesses | Connect to the MCP service and supply the scene workflow instructions | Depends on the host's image and MCP Apps support |

The host supplies the model, planning, code generation and visual judgment. The
service executes scene operations through a dedicated Blender process and enforces
scene state, checkpoints, stage budgets and approval. Additional harnesses need
their own MCP connection and instruction loading; native plugin packaging is
provided for Codex and Claude Code. The embedded viewer requires MCP Apps and
WebGL 2.

## Showcase: gamer bedroom from multiple views

This reconstruction uses three reference views in Blender 5.1.1. The images
below show iteration 15, after composition approval and material and lighting
calibration against the primary reference.

<table>
  <tr>
    <th width="50%">Reference room</th>
    <th width="50%">Refined Blender render</th>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/gameroom-reference.webp" alt="Reference image of a gamer bedroom" width="480" />
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/gameroom-showcase.webp" alt="Blender reconstruction with a lit desk, display shelves, mesh chair, and bed" width="480" />
    </td>
  </tr>
</table>

The reference image is included with the user's permission. The request was to
reconstruct the room as closely as possible, using the primary view for composition
and the other views for equipment details and spatial layout.

Standalone furniture, equipment, and accessories use externally generated GLB
assets assembled in Blender, with procedural room surfaces and fittings. The
monitor uses artwork extracted from the supplied screen image. Golden shelf
lighting, cool gray window fill, wood surfaces, and the transparent speaker dome
were refined while preserving the approved geometry and camera. Local wall
brightness, curtain shadows, shelf shapes, and small generated details still
differ from the reference; this is a best-effort reconstruction. Scene files
remain local artifacts.

![Chrome Three.js preview with the chair selected in the scene tree, an orange 3D bounding box, and XYZ direction arrows](docs/gameroom-viewer.jpg)

The Chrome screenshot shows the updated GLB in the bundled viewer through a local
MCP Apps host. Chair selection, its bounding box and XYZ arrows, and camera reset
were checked after export. The preview uses the Blender display transform and
progressive path tracing. The browser host used for this check is a local session
helper; it is not a packaged standalone preview server.

## What's in the plugin

The five modules are grouped by responsibility:

![Three color-coded layers of UniBlenderScene modules](docs/plugin-modules.svg)

| Part | What it does | Main files |
| --- | --- | --- |
| Plugin metadata | Portable Codex entry and native Claude Code entry, sharing Skills and the service. | [`plugin.json`](plugin.json), [`mcp.json`](mcp.json), [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json), [`harnesses/claude-code/mcp.json`](harnesses/claude-code/mcp.json) |
| Skills | Explain setup and guide scene planning, editing, visual review, required single-object Provider discovery, and bundled Blender production techniques. | [`skills/blender-setup/`](skills/blender-setup/SKILL.md), [`skills/blender-scene/`](skills/blender-scene/SKILL.md), [`skills/scenario-blender-*/`](skills/scenario-blender-expert/SKILL.md) |
| MCP service | Exposes scene tools, tracks jobs and review state, saves checkpoints, and provides artifact URLs. | [`src/service/server.ts`](src/service/server.ts), [`src/service/store.ts`](src/service/store.ts) |
| Blender bridge | Executes scene code in a dedicated Blender process, then renders and exports the result. | [`runtime/blender/bridge.py`](runtime/blender/bridge.py), [`runtime/blender/export.py`](runtime/blender/export.py) |
| Three.js viewer | Shows the render, progressive path-traced GLB preview, selectable scene tree, and composition review controls inside an MCP Apps host. | [`src/viewer/widget.ts`](src/viewer/widget.ts), [`src/viewer/widget.html`](src/viewer/widget.html) |

Standalone objects must use an applicable separately configured 3D API Provider.
Blender modeling is the fallback only when discovery finds no applicable Provider.
Geometry plans record each object strategy and its downloaded GLB provenance;
room surfaces and simple primitives can be procedural.
The plugin does not bundle a 3D asset provider or its credentials.

## Quick start

1. In Codex, install **UniBlenderScene** from the **UniBlenderScene** plugin source.
   In Claude Code, start from a separate scene project outside the plugin checkout
   and pass `--plugin-dir /absolute/path/to/UniBlenderScene`, then invoke
   `/uni-blender-scene:blender-setup` or `/uni-blender-scene:blender-scene`.
   See [client installation](docs/operations.md#install-the-plugin-source).
2. Start the [Blender MCP service](docs/operations.md#run-the-local-service), or
   [connect to a deployed service](docs/operations.md#connect-a-remote-service).
   The bundled connection points to `127.0.0.1`; installing the plugin does not
   start Blender or the service. To start both local processes together, use
   [the local launcher](docs/operations.md#start-the-local-processes-together).
3. Attach an image or describe a scene, then ask for a render and interactive 3D
   preview. For example:

> Create a Blender scene matching this image. Preserve the camera composition,
> lighting and main objects, then show the interactive 3D result.

To use Claude Code through TTADK with the requested model, run
`ttadk claude -m gpt-6.1-sol -- --plugin-dir /absolute/path/to/UniBlenderScene`.
TTADK must make that model available for Claude Code; model access is separate
from plugin installation. Run this command from the scene project. See
[scene project setup](docs/operations.md#claude-code) and
[CLI validation](docs/operations.md#validate-claude-code-with-ttadk).

## Repository layout

```text
plugin.json, mcp.json       Portable plugin entry for Codex
.agents/plugins/           Codex marketplace
.claude-plugin/            Claude Code manifest and marketplace
skills/                    Shared scene workflow and production knowledge
harnesses/                 Client-specific MCP configuration and agent templates
src/service/               MCP tools, scene state, workflow checks, Blender client
src/viewer/                MCP Apps Three.js viewer
runtime/blender/           Dedicated Python bridge and export code
scripts/                   Build, configure, package, upstream checks
tests/                     Workflow, Blender, viewer, and harness validation
docs/                      Setup, design, showcases, validation records
.canova/runs/              Ignored local scenes and validation evidence
```

The project identity is **UniBlenderScene** (`uni-blender-scene`, version 0.3.3).
The canonical repository is
[`creativedswork/UniBlenderScene`](https://github.com/creativedswork/UniBlenderScene).
Existing run directories and Blender `codex_bake_lighting` /
`codex_preview_emissive_tint` properties retain their names for saved-scene compatibility.

## Scene workflow

The [scene Skill](skills/blender-scene/SKILL.md) describes this tool sequence:

| Tool | Result |
| --- | --- |
| `scene_create` | Create a scene with an optional reference image |
| `scene_plan` | Set criteria, required Scene Graph and assets, and stage budgets |
| `scene_plan_review` | Verify graph coverage and spatial relationships against every view |
| `scene_asset_strategy` | Record Provider discovery and local GLB, or no-Provider Blender fallback |
| `scene_graph` | Update graph names and completion states during editing |
| `scene_edit` | Run Blender code, save and render |
| `scene_get` | Inspect the scene and latest render |
| `scene_review` | Review the render and select the best checkpoint |
| `scene_review_decision` | Approve or revise the geometry and composition checkpoint |
| `scene_review_views` | Retry generation of the five confirmation views |
| `scene_preview` | Prepare current geometry/composition work or a pending checkpoint as a gray 3D preview without approving it |
| `scene_export` | Export the best reviewed `.blend` and GLB after completion |
| `scene_view` | Check progress and open the interactive viewer |
| `scene_continue` | Refine an existing scene |

The service saves a checkpoint before each edit, supplies an iteration-bound inspection, and exports the best reviewed scene. See the [0.2.0 acceptance checklist](docs/acceptance-0.2.0.md) for Provider, multi-view and approval checks.
For full reconstructions, the plan runs ordered geometry, composition,
materials, lighting, and final stages with one budget per stage. Composition
approval is mandatory before materials; five neutral Blender views are
available in the widget. The explicit decision tool resumes from the saved
checkpoint or returns to geometry or composition with feedback.

An image-based request must pass its image through `scene_create.reference`; the
service rejects a text-only create when the request refers to an image. The
scene Skill directs the first edit to build a complete scene blockout, then later edits refine bounded
parts. The scene Skill supplies the same pinned Scenario Blender production
knowledge revision as Canova, adapted to this plugin's host-driven tools.
For reference images, the host records major regions in normalized image
coordinates and measures them in each render. The service checks those submitted
measurements and keeps composition open when a region edge differs by more than
8% of the frame; it does not detect objects in images on its own.

## Authoritative workflow state

Every scene response includes `workflowState`. `phase` identifies the production
stage; `status` identifies the operation state, such as `edit`, `review` or
`awaiting_review`. `presentation` fixes the image mode, purpose, source and
iteration. It is derived from the scene's persisted plan, workflow index and
status; there is no second independently writable phase variable. Each scene
has its own state, including after a service restart or a new agent conversation.

| Production/state | Presentation | Source and purpose |
| --- | --- | --- |
| Geometry or composition, editing/reviewing | Gray main image; current five-view/GLB preview on request | Current working iteration; work draft |
| Awaiting composition approval | Gray main image, five views and GLB | Preserved checkpoint; confirmation |
| Materials, lighting or final work | Appearance render | Current working iteration; work draft |
| Completed or best-effort delivery | Reviewed appearance | Selected best checkpoint; delivery |

Geometry/composition edits automatically render gray images. `scene_review_views`
and `scene_preview` can inspect incomplete work without advancing its phase,
spending an edit round or approving it. Views, profiles and manifests identify
their source and iteration; stale or wrong-mode artifacts are not offered as
the current result. Work drafts never expose an approval button. Final export
and explicit composition approval retain their existing state checks.

## Interactive 3D preview

During geometry/composition work or at its confirmation checkpoint, call
`scene_preview` with the scene ID, then poll `scene_view` until the job finishes.
The service generates missing five-view evidence and chooses the source from
`workflowState`: current work during editing/review, preserved best checkpoint
while `awaiting_review`. The viewer loads that iteration's GLB, render profile
and Scene Graph. Preparing this preview
preserves the checkpoint, pending approval, and stage budget. Final
`scene_export` remains blocked until the workflow reaches `completed` or
`best_effort`; only `scene_review_decision` records the user's decision.

During structural confirmation, the main image and five review views use neutral
gray shading. The review GLB replaces textures and material effects with opaque
gray surfaces and neutral studio lighting on an export copy. Original materials,
lights and `.blend` checkpoints are retained for downstream work and final export.
Previously cached textured review GLBs are hidden until `scene_preview` regenerates
them. Original `.blend` files keep their materials; work drafts expose previews,
while checkpoint/final downloads may include the original `.blend`.

The Scene Graph uses stable `scene_node_id` properties on Blender objects.
Export includes `scene-graph.json` and `manifest.json`, and checks that built
objects map to GLB meshes. Organizational groups can use their descendants'
meshes. The viewer supports:

- Select a tree node to frame the object or group and show its orange 3D bounds
  with red X, green Y, and blue Z direction arrows.
- Click a mesh to select its tree entry while preserving the camera view.
- Orbit, zoom, pan, and reset the camera. Bounds stay aligned with the selection.
- Click empty space, press Escape, or use **Clear selection** to deselect.
- Switch between the Blender render and 3D preview; review the five neutral views
  before approving or requesting changes to composition.

The arrows show world-axis directions and do not edit transforms. Blender renders
remain the visual review source. The viewer requires an MCP Apps host and WebGL 2;
the MCP endpoint itself is not a Chrome preview page. See the
[viewer checklist](docs/acceptance-0.2.1.md) and
[service setup](docs/operations.md#open-the-interactive-preview).

## Multiple reference views

Supply up to 6 images of the same scene in `scene_create.references`. The first
image defines the primary camera and composition; auxiliary images clarify
depth, occlusion, and relative object positions. Each file can include a short
`label`, such as "right side". The original single-image `reference` input is
still supported. Use `scene_continue.references` to append views to a delivered
scene while preserving its primary image, with at most 6 references in total.

Select image content explicitly when using `scene_get`:

| `images` | Returned image content |
| --- | --- |
| `render` | Latest render only; use once after each edit |
| `references` | Reference views only; inspect once before planning |
| `none` | No images; scene state and reference metadata remain available |
| `all` | References and latest render; also the legacy behavior when omitted |

`referenceName` selects one reference view, alone or with `images: "references"`.
`objectName` returns object data without images, alone or with `images: "none"`.
Do not combine these selectors with incompatible image modes. Poll with
`scene_view`, then retrieve each finished render once with `images: "render"`.
Avoid reading that same PNG again through the host's image-reading tool.

Image limits apply to the conversation sent to the model, including repeated
tool results. The shared Skill asks the host to count images from all sources and checkpoint
around 35 images on the observed 50-image TTADK route. This is host guidance,
not a server-enforced conversation quota. The service cannot remove historical
images from Claude Code; see [image-history recovery](docs/operations.md#image-history-and-recovery).

The embedded viewer lets users select and enlarge any reference. In clients
that expose file upload, select multiple images, choose the primary view, then
create a scene or add views to the current scene. The host model reconciles the
views during planning and spatial review; image-space alignment uses the primary
view. This input support does not automatically estimate calibrated cameras or
triangulate geometry.

In local Codex or Claude Code, attach the images to the conversation and ask to use the Blender
scene plugin. Each reference can use `local_path` instead of `download_url` and
`file_id`. The local service must enable the image directories with
`LOCAL_REFERENCE_ROOTS` (platform path separator). Local files are disabled by
default; approved files are copied into the scene and checked for PNG/JPEG/WebP
content and the 20 MB limit. Reinstall an updated local plugin, then restart
the host and use a new conversation to load its tools and instructions.

## Related research

- [VIGA: Vision-as-Inverse-Graphics Agent via Interleaved Multimodal Reasoning](https://arxiv.org/abs/2601.11109)
  (Yin et al., 2026) describes a code, render, inspect, and revise loop for
  reconstructing editable scenes from images. Its visual feedback approach is
  relevant to this plugin's scene review workflow.
- [SceneCraft: An LLM Agent for Synthesizing 3D Scene as Blender Code](https://arxiv.org/abs/2403.01248)
  (Hu et al., 2024) uses scene planning, Blender Python generation, and rendered
  visual feedback to refine 3D scenes.

## Documentation

- [Service setup and deployment](docs/operations.md): local runtime, plugin
  source, remote connection, configuration, and packaging.
- [Scene Skill](skills/blender-scene/SKILL.md): scene workflow and tool use.
- [Validation results](docs/validation.md): checks performed for this release.

## Credits and upstream updates

The [scene Skill](skills/blender-scene/SKILL.md) is installed alongside the
[Scenario Blender Skills](skills/scenario-blender-expert/SKILL.md). Each domain
has a directly loadable `SKILL.md` and retains its pinned upstream source as
`UPSTREAM.md`. The original files and [MIT license](skills/scenario/LICENSE)
are credited to Scenario Labs and its contributors. Scene edits still run only
through this plugin's dedicated bridge. See [upstream tracking](docs/scenario-skills.md)
for the pinned revision and `npm run check:scenario-skills` update check.

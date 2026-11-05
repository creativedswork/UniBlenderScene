# CodexBlenderPlugin

Create and refine Blender scenes from reference images or text, then inspect the
render and orbitable 3D preview.

## Showcase: gamer bedroom from multiple views

The latest reconstruction used three reference views in Blender 5.1.1.

| Reference room | Reviewed Blender render |
| --- | --- |
| ![Reference image of a gamer bedroom](docs/gameroom-reference.webp) | ![Blender reconstruction with a lit desk, display shelves, mesh chair, and bed](docs/gameroom-showcase.webp) |

The reference image is included with the user's permission. The request was to
reconstruct the room as closely as possible, using the primary view for composition
and the other views for equipment details and spatial layout.

Furniture, equipment, and accessories were modeled in Blender. The monitor uses
artwork extracted from the supplied screen image. The result was reviewed across
five rendered iterations and saved as `.blend` and GLB files. GLB loading, orbit
interaction, and camera reset were checked in the bundled Three.js viewer.
Small figures, fabric, and some materials remain simplified. The scene files
remain local artifacts; this showcase includes only the render.

## What's in the plugin

The five modules are grouped by responsibility:

![Three color-coded layers of CodexBlenderPlugin modules](docs/plugin-modules.svg)

| Part | What it does | Main files |
| --- | --- | --- |
| Plugin metadata | Describes the plugin, its onboarding Skill, and the MCP connection. | [`plugin.json`](plugin.json), [`mcp.json`](mcp.json) |
| Skills | Explain setup and guide scene planning, editing, visual review, and optional 3D asset discovery. | [`skills/blender-setup/`](skills/blender-setup/SKILL.md), [`skills/blender-scene/`](skills/blender-scene/SKILL.md) |
| MCP service | Exposes scene tools, tracks jobs and review state, saves checkpoints, and provides artifact URLs. | [`src/server.ts`](src/server.ts), [`src/store.ts`](src/store.ts) |
| Blender bridge | Executes scene code in a dedicated Blender process, then renders and exports the result. | [`blender/bridge.py`](blender/bridge.py), [`blender/export.py`](blender/export.py) |
| Three.js viewer | Shows the render and a progressive path-traced GLB preview inside the chat, with scene downloads. | [`web/widget.ts`](web/widget.ts), [`web/widget.html`](web/widget.html) |

A separately configured 3D generation tool can supply a detailed GLB for import.
The plugin does not bundle a 3D asset provider or its credentials.

## Quick start

1. Install **CodexBlenderPlugin** from the **Codex Blender** plugin source.
   [Add the source](docs/operations.md#install-the-plugin-source) if it is not listed.
2. Start the [Blender MCP service](docs/operations.md#run-the-local-service), or
   [connect to a deployed service](docs/operations.md#connect-a-remote-service).
   The bundled connection points to `127.0.0.1`; installing the plugin does not
   start Blender or the service.
3. Attach an image or describe a scene, then ask for a render and interactive 3D
   preview. For example:

> Create a Blender scene matching this image. Preserve the camera composition,
> lighting and main objects, then show the interactive 3D result.

For complex image-to-scene work, we recommend a paid ChatGPT plan with plugin
access and GPT-6.1 Sol or GPT-6 Astra ([model guidance](https://learn.chatgpt.com/docs/models)).

## Scene workflow

The [scene Skill](skills/blender-scene/SKILL.md) describes this tool sequence:

| Tool | Result |
| --- | --- |
| `scene_create` | Create a scene with an optional reference image |
| `scene_plan` | Set the scene plan and review criteria |
| `scene_edit` | Run Blender code, save and render |
| `scene_get` | Inspect the scene and latest render |
| `scene_review` | Review the render and select the best checkpoint |
| `scene_export` | Export `.blend` and GLB files |
| `scene_view` | Check progress and open the interactive viewer |
| `scene_continue` | Refine an existing scene |

The service saves a checkpoint before each edit and exports the best reviewed scene.

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

The [scene craft guidance](skills/blender-scene/references/scene-craft.md) adapts
methods from [Scenario Labs' Blender Expert Skills](https://github.com/scenario-labs/skills/tree/main/skills/dcc/blender)
(MIT). Thanks to Scenario Labs and its contributors. The plugin does not bundle
their scripts or MCP service. See [upstream tracking](docs/scenario-skills.md)
for the reviewed version and `npm run check:scenario-skills` update check.

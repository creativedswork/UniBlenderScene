# CodexBlenderPlugin

Create and refine Blender scenes from reference images or text, then inspect the
render and orbitable 3D preview.

## What's in the plugin

The plugin packages the instructions, scene tools, Blender integration, and
interactive preview needed to build and inspect a scene. This diagram shows the
packaged parts and their connections:

```mermaid
flowchart LR
  subgraph plugin["CodexBlenderPlugin"]
    P["Plugin metadata<br/>Install and connect"]
    S["Skills<br/>Setup and scene workflow"]
    M["MCP service<br/>Scene tools, jobs, checkpoints"]
    B["Blender bridge<br/>Run, render, export"]
    V["Three.js viewer<br/>Inspect, orbit, download"]
    P -.->|"declares"| S
    P -.->|"declares endpoint"| M
    S -.->|"guides use of"| M
    M <-->|"commands and results"| B
    M -->|"serves scene and render"| V
  end
```

| Part | What it does | Main files |
| --- | --- | --- |
| Plugin metadata | Describes the plugin, its onboarding Skill, and the MCP connection. | [`plugin.json`](plugin.json), [`mcp.json`](mcp.json) |
| Skills | Explain setup and guide scene planning, editing, visual review, and optional 3D asset discovery. | [`skills/blender-setup/`](skills/blender-setup/SKILL.md), [`skills/blender-scene/`](skills/blender-scene/SKILL.md) |
| MCP service | Exposes scene tools, tracks jobs and review state, saves checkpoints, and provides artifact URLs. | [`src/server.ts`](src/server.ts), [`src/store.ts`](src/store.ts) |
| Blender bridge | Executes scene code in a dedicated Blender process, then renders and exports the result. | [`blender/bridge.py`](blender/bridge.py), [`blender/export.py`](blender/export.py) |
| Three.js viewer | Shows the render and orbitable GLB inside the chat, with scene downloads. | [`web/widget.ts`](web/widget.ts), [`web/widget.html`](web/widget.html) |

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

## Showcase: gamer bedroom from one photo

This scene was built from one photo in Blender 5.1.1.

| Input reference | Reviewed Blender render |
| --- | --- |
| ![Input photo of a gamer bedroom](docs/gameroom-reference.webp) | ![Rendered gamer bedroom scene with a Meshy-generated chair](docs/gameroom-showcase.webp) |

The input photo is included with the user's permission. The request was:

> Build an orbitable 3D room from this photo. Match the camera composition and
> warm shelf lighting. If a detailed chair would improve the result, check the
> available image-to-3D tools and tell me the credit cost before generating it.
> Show a Blender render and an interactive 3D preview.

The room was modeled in Blender. A separately configured Meshy tool supplied the
chair after the user approved its credit cost. The reviewed scene was exported as
`.blend` and GLB, and the Three.js preview was checked for orbit interaction.
The scene is a reconstruction: the photo does not show the room's hidden sides.
The `.blend` and GLB from this run remain local artifacts.

## Documentation

- [Service setup and deployment](docs/operations.md): local runtime, plugin
  source, remote connection, configuration, and packaging.
- [Scene Skill](skills/blender-scene/SKILL.md): scene workflow and tool use.
- [Validation results](docs/validation.md): checks performed for this release.

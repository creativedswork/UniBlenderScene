# UniBlenderScene

English | [简体中文](README.zh-CN.md)

A Blender scene creation and review plugin for **Codex** and **Claude Code**.

Turn reference images or text into editable Blender scenes. Combine your agent
harness with 3D APIs such as [Tripo](https://developers.tripo3d.ai/en/docs/introduction)
or [Meshy](https://docs.meshy.ai/en/api) to generate individual objects, then
assemble and refine the scene in Blender.

Deliver renders, `.blend` files and GLBs, with interactive 3D preview in
compatible MCP Apps hosts. Completed scenes can also be prepared for rendering
and interactive presentation with [Meshy's ThreeRT](https://github.com/meshy-dev/ThreeRT).

| Host | How to use it |
| --- | --- |
| Codex | Install the plugin; review renders and open interactive previews in an MCP Apps host |
| Claude Code | Load the plugin; inspect renders and access `.blend`/GLB files from the terminal |
| Other agent harnesses | Connect to the MCP service and load the scene workflow instructions; preview support depends on the host |

## Showcases

<table>
  <tr>
    <th colspan="2" scope="colgroup">Forest house at sunset</th>
    <th colspan="2" scope="colgroup">Rainy city circuit</th>
  </tr>
  <tr>
    <th scope="col">Reference</th>
    <th scope="col">Blender</th>
    <th scope="col">Blender · Low</th>
    <th scope="col">Three.js · Low</th>
  </tr>
  <tr>
    <td align="center" valign="middle"><a href="docs/forest-house-reference.webp"><img src="docs/forest-house-reference.webp" alt="Reference of a glass house and pool among pines at sunset" width="180" /></a></td>
    <td align="center" valign="middle"><a href="docs/forest-house-blender.webp"><img src="docs/forest-house-blender.webp" alt="Blender render with warm interiors and sunlight through the pines" width="180" /></a></td>
    <td align="center" valign="middle"><a href="docs/rainy-city-circuit-blender.webp"><img src="docs/rainy-city-circuit-blender.webp" alt="Low-angle Blender render of a white sports car and its wet-road reflection" width="214" /></a></td>
    <td align="center" valign="middle"><a href="docs/rainy-city-circuit-threejs-low.webp"><img src="docs/rainy-city-circuit-threejs-low.webp" alt="Three.js preview of the car and its reflection from the default camera" width="214" /></a></td>
  </tr>
  <tr>
    <th scope="col">Three.js</th>
    <th scope="col">ThreeRT</th>
    <th scope="col">Three.js · Raised</th>
    <th scope="col">ThreeRT · Raised</th>
  </tr>
  <tr>
    <td align="center" valign="middle"><a href="docs/forest-house-threejs.webp"><img src="docs/forest-house-threejs.webp" alt="Three.js preview of the forest house, sunbeams and pool" width="180" /></a></td>
    <td align="center" valign="middle"><a href="docs/forest-house-threert.webp"><img src="docs/forest-house-threert.webp" alt="ThreeRT render of the house and sunbeams with simplified trees" width="180" /></a></td>
    <td align="center" valign="middle"><a href="docs/rainy-city-circuit-threejs.webp"><img src="docs/rainy-city-circuit-threejs.webp" alt="Raised Three.js view of car and storefront reflections on wet asphalt" width="214" /></a></td>
    <td align="center" valign="middle"><a href="docs/rainy-city-circuit-threert.webp"><img src="docs/rainy-city-circuit-threert.webp" alt="ThreeRT render of the same raised view with wet-road reflections and blue haze" width="214" /></a></td>
  </tr>
</table>

The forest house was built from one reference. Three.js uses baked diffuse lighting on selected building surfaces. The ThreeRT image uses simplified tree geometry and is cropped to match the Blender framing.

For the rainy circuit, Blender and Three.js share the default low camera. The raised Three.js and ThreeRT views share a second camera. Three.js uses lightmaps for the road, barriers and storefronts, with real-time reflections and fog lit by local lights.

## What's in the plugin

![Three color-coded layers of UniBlenderScene modules](docs/plugin-modules.svg)

Shared Skills guide planning and visual review, a dedicated Blender service
builds and renders the scene, and the viewer supports interactive inspection.
Codex and Claude Code use the same scene workflow.

Standalone objects use an applicable, separately configured 3D asset provider;
connect Tripo, Meshy or another provider through your agent harness's tools or
Skills. The agent imports the generated assets into Blender for placement and
scene review. Room surfaces and simple primitives can be procedural. If no
applicable provider is available, the workflow can fall back to Blender modeling.
Provider access, API keys and generation costs are configured separately. See the
[asset workflow](skills/blender-scene/references/assets.md).

## Quick start

Ask your agent to read and follow the [quick-start guide](docs/quick-start.md) to set up UniBlenderScene.

## Scene workflow

The [scene Skill](skills/blender-scene/SKILL.md) guides a staged process:

1. **Plan:** identify the main objects, spatial relationships and visual goals.
2. **Build:** establish the full scene, then refine geometry and composition.
3. **Confirm:** review the gray scene from multiple views and approve composition
   before materials and lighting begin.
4. **Refine:** use Leap for structural changes and Tweak for existing parameters.
   Compare material or lighting candidates against the same baseline when several
   directions are plausible, then render and review the selected edit.
5. **Deliver:** export the best reviewed checkpoint as a render, `.blend` and GLB.

The agent supplies planning and visual judgment; the service executes Blender
operations, saves checkpoints and tracks review progress. See the
[workflow design](docs/scene-generation-preview.md) for details.

## Memory: learning across scene tasks

The workflow pairs an inner **edit → render → review → revise** loop with an
outer loop that captures lessons from completed scenes. Verified repairs can
become reusable guidance, Blender functions or checks after validation, and
later tasks can retrieve applicable entries.

Memory stays in the service's local data directory and survives restarts.
Learning runs during agent tasks; it does not change model weights. See the
[Scene Skill Library](skills/blender-skill-library/SKILL.md).

## Interactive 3D preview

Ask the agent to open the preview in a host that supports MCP Apps. You can:

- Orbit, zoom, pan and reset the camera.
- Click the Three.js or ThreeRT view: W/S moves along the viewing direction, including up or down when tilted; A/D moves sideways. Hold Shift to move faster.
- Select objects in the scene tree or 3D view to inspect their bounds.
- Switch between the Blender render and interactive 3D preview.
- Review neutral gray views, then approve composition or request changes in chat.

Use the gray views to check proportions and placement, and the Blender render
to review lighting and materials.

### ThreeRT preview

Explore your completed scene in ThreeRT to inspect its lighting, materials and
spatial depth from different viewpoints. When ThreeRT is available, completed
scenes open in this mode automatically.

Use the preview selector to switch to **Three.js · 网页交互** for quick
navigation and layout checks. Select **Render** to compare with the Blender
image. Appearance can differ between preview modes; use the Blender render
when reviewing the final look.

ThreeRT approximates Blender's HDR environment lighting with a gradient sky.
The native client displays the baked sky panorama when the export includes one.
See the [upstream HDRI request](https://github.com/meshy-dev/ThreeRT/issues/178).

For static scenes, ask the agent to optimize the browser preview for smoother
navigation. If ThreeRT is unavailable, you can explore the scene with Three.js.
See [preview setup](docs/operations.md#threert-setup-and-limits) to enable ThreeRT.

## Related research

- [BlenderAlchemy: Editing 3D Graphics with Vision-Language Models](https://arxiv.org/abs/2404.17672)
  (Huang et al., 2024) inspired the plugin's Leap and Tweak edits and its
  candidate search for materials and lighting.
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

The plugin includes [Scenario Blender Skills](skills/scenario-blender-expert/SKILL.md),
credited to Scenario Labs and its contributors under the
[MIT license](skills/scenario/LICENSE). See [upstream tracking](docs/scenario-skills.md)
for the pinned revision and update process.

Selected [EL4CTEO Blender Skills](https://github.com/EL4CTEO/blender-skills)
contribute time-of-day, weather and surface-texturing techniques under their
[MIT license](skills/blender-effects/LICENSE). See [effects integration](docs/blender-effects.md)
for the pinned sources, scene adapters and delivery limits.

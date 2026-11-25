# Blender production knowledge

The Scenario Blender knowledge is based on the Canova snapshot
(`e24bc7d40be97b428e7b9fd467c415366e1dd974`). The
[source manifest](../../scenario/source.json) records the expert Skill revision
and checksums for the copied references and helper source.
Selected EL4CTEO Blender Skills add environment and surface effects, pinned in
[their source manifest](../../blender-effects/source.json) under the
[MIT license](../../blender-effects/LICENSE).
Each domain is a top-level Skill installed beside `blender-scene`.
Load the smallest relevant domain for the current task; its `SKILL.md` states
the relationship to this plugin and selects the upstream technique references.

| Task or visible gap | Domain |
| --- | --- |
| Complete blockout, proportions, camera coverage | [blockout](../../scenario-blender-blockout/SKILL.md) |
| Furniture, devices, bevels, and mechanical forms | [hard surface](../../scenario-blender-hard-surface/SKILL.md) |
| Fabric, organic silhouettes, and soft forms | [sculpting](../../scenario-blender-sculpting/SKILL.md) |
| PBR surfaces and texture color spaces | [texturing and shading](../../scenario-blender-texturing-shading/SKILL.md) |
| Light direction, contact shadows, exposure, and color | [lighting and rendering](../../scenario-blender-lighting-rendering/SKILL.md) |
| Day/night, sunset, fog, god rays or preset environment moods | [time of day](../../blender-time-of-day/SKILL.md) |
| Rain/snow, wetness, puddles, ripples, snow cover or lightning | [weather effects](../../blender-weather-fx/SKILL.md) |
| Repeatable wear, rust, grime, dust or decals on an existing base material | [surface texturing](../../blender-texturing/SKILL.md) |
| Repeated structures and procedural geometry | [geometry nodes](../../scenario-blender-geometry-nodes/SKILL.md) |
| UV layout and texture baking | [UV and baking](../../scenario-blender-uv-baking/SKILL.md) |
| Imported mesh cleanup or polygon budget | [retopology](../../scenario-blender-retopology/SKILL.md) |
| Asset and GLB compatibility | [export](../../scenario-blender-export/SKILL.md) |
| Hair or fur | [hair](../../scenario-blender-hair/SKILL.md) |
| Armatures, weights, and controls | [rigging](../../scenario-blender-rigging/SKILL.md) |
| Character or object motion | [animation](../../scenario-blender-animation/SKILL.md) |
| Shot lists, storyboards, and animatics | [previs and storyboard](../../scenario-blender-previs-storyboard/SKILL.md) |
| 2D drawing or hybrid 2D/3D scenes | [Grease Pencil](../../scenario-blender-grease-pencil/SKILL.md) |

Start with the shared [expert workflow](../../scenario-blender-expert/SKILL.md).
For Blender code,
read its [reliability checklist](../../scenario-blender-expert/references/bpy-reliability.md)
and check the active Blender version before using version-specific APIs.

## Adapter to this plugin

Scenario and EL4CTEO files are production knowledge, not alternative runtimes. Keep scene
creation, edits, checkpoints, rendering, review, and export inside this plugin's
`scene_*` tools and dedicated Blender bridge. In particular:

| Knowledge operation | Plugin operation |
| --- | --- |
| Scene or object summary | `scene_get` with `images: "none"`, optionally with `objectName` |
| One bounded Blender mutation | `scene_edit` |
| Camera render evidence | `scene_get` with `images: "render"` once after `scene_edit` finishes |
| Global critique and next edit | `scene_review` |
| Historical best and rollback | `SceneStore` review state |
| Deliverable export | `scene_export` |

Do not use upstream MCP tools, stage loops, background Blender
processes, or helper scripts that save, render, or export. Helper source is
included for provenance and technique inspection. If adapting a helper into
`scene_edit`, use only the needed supported `bpy` operations and keep the edit
within the task scene. Upstream Blender 5.2 advice must be checked against the
actual Blender version before use.

For EL4CTEO effects, read the [effects adapter](../../blender-effects/adapter.md)
before construction. It assigns geometry, material and lighting changes to their
stages and describes version checks and GLB limitations. Use Scenario for detailed
lighting critique and custom shading; load the effect Skill only for the requested
environment or surface operation.

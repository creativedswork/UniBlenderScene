# Blender production knowledge

This plugin packages the same Scenario Blender knowledge revision used by the
Canova runtime (`e24bc7d40be97b428e7b9fd467c415366e1dd974`). The original
files, helper source, license, and checksums are in [scenario](../../scenario/source.json).
Each Scenario domain is a top-level Skill installed beside `blender-scene`.
Load the smallest relevant domain for the current task; its `SKILL.md` states
the relationship to this plugin and selects the upstream technique references.

| Task or visible gap | Domain |
| --- | --- |
| Complete blockout, proportions, camera coverage | [blockout](../../scenario-blender-blockout/SKILL.md) |
| Furniture, devices, bevels, and mechanical forms | [hard surface](../../scenario-blender-hard-surface/SKILL.md) |
| Fabric, organic silhouettes, and soft forms | [sculpting](../../scenario-blender-sculpting/SKILL.md) |
| PBR surfaces and texture color spaces | [texturing and shading](../../scenario-blender-texturing-shading/SKILL.md) |
| Light direction, contact shadows, exposure, and color | [lighting and rendering](../../scenario-blender-lighting-rendering/SKILL.md) |
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

Scenario files are production knowledge, not an alternative runtime. Keep scene
creation, edits, checkpoints, rendering, review, and export inside this plugin's
`scene_*` tools and dedicated Blender bridge. In particular:

| Knowledge operation | Plugin operation |
| --- | --- |
| Scene or object summary | `scene_get`, optionally with `objectName` |
| One bounded Blender mutation | `scene_edit` |
| Camera render evidence | `scene_get` after `scene_edit` finishes |
| Global critique and next edit | `scene_review` |
| Historical best and rollback | `SceneStore` review state |
| Deliverable export | `scene_export` |

Do not run Scenario's separate MCP tools, stage loops, background Blender
processes, or helper scripts that save, render, or export. Helper source is
included for provenance and technique inspection. If adapting a helper into
`scene_edit`, use only the needed supported `bpy` operations and keep the edit
within the task scene. Upstream Blender 5.2 advice must be checked against the
actual Blender version before use.

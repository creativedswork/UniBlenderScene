# Environment and surface effects in this plugin

The EL4CTEO sources pinned in [source.json](source.json) provide techniques and
helper source. Co-load [blender-scene](../blender-scene/SKILL.md), which owns
planning, edits, rendering, review, checkpoints and export through `scene_*`.
Upstream `blender-core`, direct MCP calls, CLI commands, saves and render/bake
scripts are upstream context, not additional execution paths. Do not launch
another Blender process or import/run the bundled helpers directly. Read only
the helper functions needed for the effect and adapt their supported `bpy`
operations into one bounded `scene_edit`.

## Plan effects by what they change

| Change | Stage |
| --- | --- |
| Rain/snow emitter geometry, splash meshes, snow thickness, decal planes, fog container | Geometry, before composition confirmation |
| Wear, wetness, snow surface, masks, decal textures, fog material density/scattering | Materials |
| Sun/sky, practical lights, world fog, exposure, compositor | Lighting |

Define visible criteria and graph mappings for effect objects before construction.
Build containers and geometry in their planned stage; tune their existing
materials during materials and their illumination during lighting. Give fog
containers a volume-only material scaffold in geometry so structural review
excludes the container instead of showing an opaque box. Lighting freezes object
material graphs: tune mesh-volume density and anisotropy during materials, not
in a lighting edit. Upstream `run()` functions often combine these
changes, so copying a whole call into a later stage can violate frozen geometry,
materials or lighting. Follow `workflowState` and the existing refinement path
when an effect was not in the plan; do not bypass stage guards.

Inspect existing objects, node groups, shared materials and world/compositor
before editing. Upstream `ENV_*`, `TX_*` and `DC_*` names are conventions, not
proof of ownership: preserve unrelated data with those names. Pass explicit
target names and make shared materials single-user when only selected objects
should change. Preserve existing shader links and values so removing an effect
restores the base surface. Changing topology invalidates curvature attributes.

## Version and delivery checks

The pinned helpers target Blender 5.2+ and describe 5.3 features. Check the active
`bpy.app.version` and RNA interfaces before adapting them. In particular, Geometry
Nodes modifier input access, sky enums, compositor interfaces and volume settings
vary by version. The pinned shader helpers read noise output `Factor`, while
Blender 5.1 uses `Fac`; resolve the actual socket when adapting those functions:

```python
factor = noise_node.outputs.get("Factor")
if factor is None:
    factor = noise_node.outputs["Fac"]
```

Before 5.2, modifier inputs use `mod[identifier]` rather than
`mod.properties.inputs.<identifier>.value`. Use the interface socket identifier,
not a guessed `Socket_2`. Preserve the effect's intended behavior when replacing
an unsupported operation; report a missing capability if no equivalent exists.

After each edit, inspect the latest `scene_get` render and runtime inventory;
use `scene_review` for the current criteria. A script's count or successful
return is not evidence that rain, fog, wear or a decal reads correctly. For an
animated effect, inspect representative frames through scene edits within the
planned budget; the plugin's still preview does not prove a seamless loop or
deliver an animation.

Blender shader nodes, volumes, compositor effects, GN instances and their timing
are not portable GLB behavior. Keep the editable `.blend` and reviewed render.
For GLB, bake supported surface channels or retain a selected static geometry
representation only when the delivery requires it, then use `scene_export` and
verify the bundled viewer. Vertex masks require a consuming runtime shader;
their presence alone does not enable weather in this viewer. `scene_bake`'s
lightmap mode is not a general PBR mask/channel baker. Follow
[UV and baking](../scenario-blender-uv-baking/SKILL.md) and the
[export guidance](../blender-scene/references/blender-code.md) for the selected
delivery. Report effects absent or approximated in the viewer.

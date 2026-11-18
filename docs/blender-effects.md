# Environment and surface effects

This plugin includes three domains from
[EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills/tree/9e7e04a603c125a0d17447ab97112fa70a865067),
pinned to revision `9e7e04a603c125a0d17447ab97112fa70a865067`:

| Skill | Use |
| --- | --- |
| [blender-time-of-day](../skills/blender-time-of-day/SKILL.md) | Day/night, atmosphere, fog, god rays and environment moods |
| [blender-weather-fx](../skills/blender-weather-fx/SKILL.md) | Rain/snow, wetness, puddles, ripples, snow cover and lightning |
| [blender-texturing](../skills/blender-texturing/SKILL.md) | Wear, rust, grime, dust, roughness breakup and decals |

Scenario remains the source for detailed light placement, render critique, base
PBR, skin, eyes and custom shading. The
[production map](../skills/blender-scene/references/production-knowledge.md)
selects the relevant domain. The plugin's existing packaging includes root
`skills/`; these additions need no new MCP service or credentials.

## Execution and delivery

The [effects adapter](../skills/blender-effects/adapter.md) maps techniques to
the plugin's `scene_*` workflow. Agent-generated `bpy` edits execute through
`SceneStore` and the dedicated Blender bridge. The retained upstream scripts are
source material, not automatically invoked commands or additional runtime tools.
Geometry, material and lighting effects must be scheduled in their respective
stages; an upstream one-call recipe can change all three at once.

The upstream targets Blender 5.2+ and describes 5.3 APIs. Check the active version
before adapting code, especially Geometry Nodes modifier inputs, sky and
compositor interfaces. Keeping an upstream script does not establish that it
runs unchanged on an older Blender.

Procedural materials may need surface-channel baking for GLB. Blender volumes,
compositing, particle instances and animation timing do not automatically become
viewer features. Deliver the reviewed render and editable Blender file, verify
the chosen viewer representation and report its differences. Smoke, fire and
fluid simulation are outside these three imported domains.

## Provenance and updates

The [source manifest](../skills/blender-effects/source.json) records each copied
file's SHA-256. Original entrypoints are retained as `UPSTREAM.md`; helper source
and references are copied unchanged. The local `SKILL.md` files and shared
adapter define this plugin's execution instructions. Copyright and permission
notices are retained in the [upstream MIT license](../skills/blender-effects/LICENSE).

For an update, review the selected domain's upstream changes, copy only relevant
files, update the pinned revision and checksums, and review the local adapter
against those changes. The integrity check in `npm test` detects changed or
missing snapshot files; it does not query GitHub or prove rendered quality.
Run `npm run check`, `npm run build` and `npm test` after changing the package.
Validate new execution behavior on the active Blender through the dedicated
bridge before claiming it works.

## Local compatibility check

On 2026-11-18, a fixture executed selected, adapted source functions through
`SceneStore` and a dedicated Blender 5.1.1 bridge. It restored wetness and surface
layers to their original material values, checked fog extinction against
`3.912 / 180`, and evaluated 350 rain instances at frames 1 and 49 for a 48-frame
loop (maximum coordinate difference below `1e-6` m). The saved render was
inspected for the fog and wet surface. Shader noise outputs and GN modifier
input assignment were adapted to 5.1 as described in the shared adapter.

This checks those selected functions, not every preset, ground collision,
lightning, snow thickness, animation delivery or GLB appearance. Runtime evidence
stays under `.canova/runs/blender-skills-adoption-20261118/` and is excluded from
the plugin sources.

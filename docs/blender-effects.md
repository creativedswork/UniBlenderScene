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

### Export to the preview

The export writes atmosphere, weather and animation data to
`render-profile.json`. Both preview adapters read the same data format. The
format uses Y-up world coordinates in metres, linear colors and times in
seconds. Re-export an existing checkpoint to generate the new fields.

| Blender effect | Three.js | ThreeRT |
| --- | --- | --- |
| Fog and light shafts | Marches per-volume density and color with height falloff, approximate noise and local lighting. Samples directional shadows and one spot shadow. | Uses native boxes for constant volumes and native height or local fog for gradients. Local fog approximates the Blender shape and density curve. |
| Mist, Bloom and Fog Glow | Applies depth haze and Bloom. Fog Glow uses a Bloom approximation. | Uses native exponential fog for Mist and Bloom for highlight glow. A world volume takes precedence over Mist. |
| Rain, snow, dust, ash and embers from the weather graph | Plays seeded, world-space particles. Rain can hit configured geometry and show splash rings. | Uses a native camera-relative rain curtain. Other particle effects and ground impacts are available in the Blender render. |
| Wet surfaces, snow, wear and decals | Uses glTF geometry and baked PBR texture channels, including coat weight and roughness. Adds a time-varying coat normal for supported ripple materials. | Uses the same geometry and PBR surface inputs. Ripple animation is available in Three.js and Blender. |
| Lightning and other animation | Plays glTF clips and sampled light, emission and world strength changes. Time-varying effects use the raster preview. | Uses source PBR and light values at the saved frame for these sampled tracks. |

The density translator supports constant shaders, a height ramp, exponential
falloff and the weather Skill's noise modulation. The browser places bounded
volumes in world-aligned boxes and uses a bounded set of volumes, lights and
particles for interactive rendering. The exporter records unsupported graphs
and effect limits in the render profile. The Blender file and reviewed render
retain authored node graphs, grid volumes and simulation data.

Source references for the mappings are the [Blender extractor](../runtime/blender/vfx.py),
[Three.js volume pass](../src/viewer/volumes.ts), [Three.js weather runtime](../src/viewer/weather.ts)
and [ThreeRT adapter](../runtime/threert/scene.ts).

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

---
name: blender-weather-fx
description: Use with blender-scene for rain, snow, dust, embers, wet surfaces, puddles, ripples, snow cover and lightning. Use time-of-day for fog and sky; smoke/fire simulation needs separate techniques.
---

# Weather effects

Read the [plugin adapter](../blender-effects/adapter.md) before planning or editing.
Co-load [time of day](../blender-time-of-day/SKILL.md) when the request also
changes the sky, light direction or atmosphere.

## Select the source

Read the relevant [weather techniques](UPSTREAM.md) and helper source:

| Effect | Source to inspect |
| --- | --- |
| Looping rain, snow, dust, ash or embers; ground hits and splashes | [precipitation.py](scripts/precipitation.py) |
| Wetness, puddles, ripples, wall streaks or snow cover | [surface_weather.py](scripts/surface_weather.py) |
| Flash timing and branching emissive bolts | [lightning.py](scripts/lightning.py) |

Read [weather values](references/weather-values.md) for speed, density and
surface response. Read [real-time delivery](references/realtime-engines.md)
only when preparing meshes, masks or baked effects for an engine; this plugin's
viewer does not automatically consume those engine recipes.

## Apply and verify

Set meters, FPS, frame range, wind, seed and ground targets explicitly. Keep
precipitation world-fixed across the camera path; use evaluated instances to
inspect it because the source mesh can be empty. Render counts can differ from
background evaluation through the GN `Is Viewport` branch.

Make rain visible with side/back light against a darker region. Inspect ground
hits at roofs and awnings, splash placement, near-camera streak size and the
reported particle cap. A render with too little rain may need lighting rather
than more particles. For animation, compare representative frames and the loop
boundary before claiming continuity.

Wetness should darken porous albedo, reduce roughness and add a coat; puddles
also flatten the base normal. Keep ripples inside puddle masks. Snow thickness
changes silhouette and belongs in geometry, not a late material edit. Check
shared-material scope and preserve the original links when layering effects.

For lightning, inspect flash and decay frames and their effect on scene exposure;
a visible bolt alone does not prove the flash timing. Complete `scene_review`
with evidence for the requested effect and follow the adapter's GLB checks.
These sources provide weather effects, not a smoke, fire or fluid simulation
pipeline.

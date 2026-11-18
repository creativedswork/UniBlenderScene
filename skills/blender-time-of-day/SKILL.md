---
name: blender-time-of-day
description: Use with blender-scene for daylight, sunset, night, height fog, god rays and preset environment moods. Use Scenario lighting for detailed subject and product lighting.
---

# Time of day and atmosphere

Read the [plugin adapter](../blender-effects/adapter.md) before planning or editing.
Keep detailed light placement and image critique in
[Scenario lighting](../scenario-blender-lighting-rendering/SKILL.md).

## Select the source

- Read [time and atmosphere techniques](UPSTREAM.md) for sun/sky balance,
  exposure and the desired time or mood.
- For night, neon, horror, underwater or desert looks, read
  [night and moods](references/night-and-moods.md).
- For height fog, volumetric shafts or mist, read
  [fog and volumetrics](references/fog-volumetrics.md).
- For light temperatures and intensity conversions, read
  [light values](references/light-values.md).
- Before implementing a preset, inspect the needed functions in
  [scene_mood.py](scripts/scene_mood.py). Its full `run()` replaces the world,
  creates geometry and lights, and can reset exposure or add grading; adapt only
  the requested changes, preserving the scene's existing color management and
  compositor unless the brief calls for changing them.

## Apply and verify

Choose light direction, time, scene scale and visibility before tuning color.
Use the sun and sky together; check the sky's sun-disc behavior to avoid double
illumination. At night, preserve dark regions and motivated practical lights.
For fog, start from extinction `3.912 / visibility_m`, then inspect the rendered
result; height, scattering, light direction and scene extent also affect it.
God rays need an occluder and a side/back source, not just denser fog.

Compare the same-camera render before and after the change: subject/background
separation, practical-light readability, fog depth and clipping. Check the EXR
when available for linear highlights hidden by display tone mapping. If the
subject disappears, fix lighting and contrast before increasing fog or grading.
Review the selected effect through `scene_review` and disclose differences in
the exported viewer under the adapter's delivery checks.

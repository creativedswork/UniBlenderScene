---
name: blender-texturing
description: Use with blender-scene for repeatable edge wear, rust, grime, dust, roughness breakup and surface decals. Use Scenario shading for base PBR, skin, eyes and custom material design.
---

# Surface wear and decals

Read the [plugin adapter](../blender-effects/adapter.md) before planning or editing.
Use [Scenario shading](../scenario-blender-texturing-shading/SKILL.md) for base
material construction, physical values and character-specific materials, and
[weather effects](../blender-weather-fx/SKILL.md) for wetness or snow.

## Select the source

- Read the relevant [surface layering techniques](UPSTREAM.md) before adding
  wear, rust, grime, dust or roughness breakup. Inspect
  [smart_material.py](scripts/smart_material.py) for curvature masks, layered
  node groups and restoration of original shader links.
- For stickers or signs, inspect [decal.py](scripts/decal.py) for projection,
  surface offset and adaptive subdivision. Plan decal geometry before composition
  confirmation; assign its image and surface response during materials.
- For trim sheets, tiling, vertex-color blends or painting, read
  [trims, tiling and painting](references/trims-tiling-painting.md). Follow
  [Scenario shading](../scenario-blender-texturing-shading/SKILL.md) for the
  selected painting technique and its available execution context.

## Apply and verify

Start from a checked base material. Layer base, edge wear, rust, grime and dust
according to physical causes: wear at exposed convex edges, grime in cavities,
dust on upward-facing surfaces. Break up masks to avoid uniform procedural wear;
choose amounts from the brief rather than applying every layer.

Match curvature radius to real feature size. Coarse meshes need a baked
curvature mask rather than vertex wear smeared across entire faces; read
[UV and baking](../scenario-blender-uv-baking/SKILL.md) when that is needed.
Keep data masks Non-Color and surface colors correctly encoded. Recompute
curvature attributes after topology changes and isolate shared materials when
only selected targets should change.

Inspect masks and the lit render at the intended viewing distance. Check that
wear follows geometry, roughness variation is readable, and decals preserve
image aspect, stay above curved surfaces and avoid z-fighting. Verify that
removing a layer restores original values and connections. Review the result
through `scene_review`; for GLB, follow the adapter's baking and viewer checks
rather than assuming procedural shader groups export.

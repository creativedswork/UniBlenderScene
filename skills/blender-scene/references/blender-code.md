# Blender code guidance

`scene_edit` loads the scene's `current.blend` before executing your code. It
saves, renders, and returns an object summary afterward. `bpy` is already
available. Use imports for other modules you need.

- Use world coordinates in Blender's Z-up convention. The glTF exporter converts
  to Y-up for the viewer.
- Set `bpy.context.scene.camera`. Aim the camera with
  `(target - camera.location).to_track_quat('-Z', 'Y').to_euler()`.
- Start with 512 × 512 pixels and 32 Cycles samples for feedback. Increase only
  when the task needs more detail. Node and Blender must share the same run path.
- Prefer Principled BSDF materials with simple parameters or packed image
  textures. Bake procedural shaders if those details must survive GLB export.
- The viewer exports the active camera, reconstructs lights from a render
  profile, and loads the world EXR when present. Blender compositor effects,
  volumes, and indirect lighting can differ in WebGL. Review the PNG render.
- For a clear interactive preview of static opaque surfaces, use
  `scene_bake` after final review, with `lightingBakes` entries containing
  `objectName`, `resolution` (start at 512), and `samples: 128`. The tool defaults
  to `mode: "lightmap"`. Poll `scene_get`, then call `scene_export` to package
  the prepared result. Prepare source material UVs
  during scene production; the bake needs a free UV channel below 4. This
  preserves PBR materials and source UVs, and selects raster preview without
  progressive sampling. Deliver the render profile and `lightmap-*.png`
  alongside the GLB; a standalone GLB viewer will not apply these lightmaps.
  Each receiver adds bake time and texture storage, so select visible
  surfaces and verify the result in the bundled viewer.
  Baking preserves the reviewed checkpoint and workflow stage. Results are
  reused while source content, bake settings and bake script version match;
  changing only preview appearance does not rebake. Omitted `lightingBakes`
  reuses the active selection; `[]` clears explicit receivers while source
  object bake flags still apply.
- For wet roads, `scene_export.previewAppearance.planarReflection` selects one
  horizontal mesh by name. `reflectionProbe: [x, y, z]` captures the static
  surroundings at a Blender Z-up position for metallic and glossy materials.
  Compare the saved camera and orbit views; these captures approximate
  reflections and require recapture after scene or lighting changes.
- Use legacy appearance baking only when replacing the surface response is
  acceptable: set `obj["codex_bake_lighting"]` to a texture resolution, or omit
  `mode` in a legacy `scene_export.lightingBakes` entry. On `scene_bake`, request
  `mode: "appearance"` explicitly. It replaces the prepared-copy shader with an
  emissive texture. `obj["codex_preview_emissive_tint"] = [r, g, b]` adjusts that
  texture in the viewer without changing the reviewed Blender render. Keep
  reflective surfaces in their PBR materials when their response matters.
- For a fresh scene, clear the default objects if any. For refinements, identify
  objects by their existing names and change only what the request requires.
- Do not write outside the scene workspace, delete checkpoints, start background
  jobs, change bridge networking, or launch external tools from scene code.
- On a Python or render failure, the service restores the pre-edit checkpoint.
  Inspect the error and fix the prerequisite. Do not submit a review for the
  failed iteration.

See `tests/scene.py` at the plugin root for a complete camera, material, and
lighting example used by the real Blender integration check.

## Imported GLB checks

After `bpy.ops.import_scene.gltf(filepath=...)`, inspect the imported object
names, material slots, polygon counts, dimensions, scale, origin, parent, and
rotation mode. Call `scene_get` with `objectName` after the edit to retrieve an
exact object's transforms when the default summary omits it.

Blender applies `rotation_euler` only when `rotation_mode` is an Euler mode.
Imported GLBs may use `QUATERNION`; setting `rotation_euler` in that mode changes
stored values without rotating the object. Set `rotation_mode = 'XYZ'` before
assigning Euler angles, or assign `rotation_quaternion` directly. Render a view
after changing orientation to confirm the result.

Place the asset against the floor using its evaluated bounding box, then compare
its scale and rear, front, or side view with the reference. Preserve the source
texture and material connections when exporting to GLB.

## Export color checks

Use these checks when the exported viewer has unexpected color, brightness or
emission relative to the reviewed Blender render. Inspect the model actually
loaded by the failing backend; a native adapter may prepare a separate copy.

1. Keep the reviewed source unchanged while checking conversion. Record its
   iteration and export version, the backend and engine version, and the input
   model/profile. Confirm the running service uses the code being tested.
2. Trace texture roles through shader connections. Color and emissive PNGs use
   sRGB; normal, roughness, metallic and packed data maps remain Non-Color.
   A linear float emission bake needs sRGB encoding exactly once when written
   to a color PNG. Check a known sample after decoding and preserve HDR energy
   with a normalized texture and a separate strength. Do not gamma-encode data
   maps or an already encoded image again.
3. Check linked emission strength as well as emission color. The portable
   result must retain their product, black regions outside the mask, and peak
   intensity; a constant fallback can make an entire object emit. Check other
   prominent shader features for exporter support. Bake unsupported response
   only on an export copy and disclose any loss of view-dependent shading.
4. Compare linear light RGB, power and full world transforms, then exposure,
   display transform/LUT and backend postprocessing. Matching input RGB does
   not prove matching displayed color. Disable unrequested grading in the
   adapter and identify unsupported display transforms rather than silently
   compensating with the authored lights. Normalize unsupported image formats
   on the backend copy while retaining source precision.
5. Re-export after a conversion fix and inspect the active backend's saved-camera
   image and orbit/reset views. Compare the emitting area, surrounding light,
   shadow readability and prominent materials. Retain before/after images and
   a report linking the output version to the checks. Regression tests prove
   the covered conversion behavior; actual viewer inspection establishes the
   observed appearance. Report unresolved engine differences separately.

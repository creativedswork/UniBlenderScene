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
- For a static opaque surface that needs closer WebGL lighting, set
  `obj["codex_bake_lighting"] = 256` (or 512 for a large wall or floor). Export
  bakes its direct and indirect light into an emissive texture on a copy of the
  scene. Use this selectively because each surface adds export time and GLB
  size. `obj["codex_preview_emissive_tint"] = [r, g, b]` optionally adjusts that
  surface in the viewer without changing the reviewed Blender render.
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

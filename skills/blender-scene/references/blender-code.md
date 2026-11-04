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
- For a fresh scene, clear the default objects if any. For refinements, identify
  objects by their existing names and change only what the request requires.
- Do not write outside the scene workspace, delete checkpoints, start background
  jobs, change bridge networking, or launch external tools from scene code.
- On a Python or render failure, the service restores the pre-edit checkpoint.
  Inspect the error and fix the prerequisite. Do not submit a review for the
  failed iteration.

See `tests/scene.py` at the plugin root for a complete camera, material, and
lighting example used by the real Blender integration check.

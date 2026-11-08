# Reference-guided scene craft

Use these checks for a visually detailed scene, especially one based on a
reference image. They adapt methods from Scenario Labs'
[Blender expert](https://github.com/scenario-labs/skills/tree/e24bc7d40be97b428e7b9fd467c415366e1dd974/skills/dcc/blender/scenario-blender-expert),
[lighting and rendering](https://github.com/scenario-labs/skills/tree/e24bc7d40be97b428e7b9fd467c415366e1dd974/skills/dcc/blender/scenario-blender-lighting-rendering),
and [export](https://github.com/scenario-labs/skills/tree/e24bc7d40be97b428e7b9fd467c415366e1dd974/skills/dcc/blender/scenario-blender-export)
Skills. This reference uses this plugin's `scene_*` workflow; the packaged
Scenario helpers are optional source material and its MCP tools are not used.

## Build from large shapes to detail

- Identify the camera, main objects, and approximate scale anchors. With a
  reference image, note the parts it hides and treat them as a reconstruction.
- Block out the room and large objects first. Render from the target camera and
  check proportions, silhouettes, overlap, and floor contact before adding small
  props or textures. For an attached reference, record 2-8 major object or region
  boxes in image coordinates normalized to 0-1, using the same crop in the render.
  Include any foreground object that substantially occludes the main subject.
  Do not mark composition complete because all objects are present: compare each
  box's left, top, right, and bottom edges with the reference. Inspect another
  angle when a visible silhouette hides a collision or floating object.
- Fix a failed blockout or misplaced object before refining its material. Use
  each `scene_get` render and `scene_review` to record what changed and which
  criterion still fails.

## Match the lighting in the render

- Set the camera and composition before lighting. Identify visible sources such
  as windows, lamps, and emissive screens, then place and color lights to match
  their apparent contribution in the reference.
- When a reference is available, compare it with the Blender render at the same
  crop; otherwise use the lighting goals in the scene plan. Check the large light
  and dark regions first, including a desaturated view when color obscures value
  differences. Adjust one source at a time and inspect the next render; light
  settings alone do not show the final result.
- Separate emissive surfaces from the lights that illuminate nearby geometry.
  Check whether warm practicals and cooler ambient or window light still read
  correctly after Blender color management and in the exported preview.

## Check the deliverable

- Before `scene_export`, inspect prominent and imported objects for floor
  contact, floating parts, overlapping faces, inverted normals, unexpected
  scale or orientation, and missing image textures. Use `scene_get` with
  `objectName` when the abbreviated summary is insufficient.
- After `scene_export`, load the GLB in the Three.js viewer and check its scale,
  orientation, materials, textures, and orbit interaction. The Blender render
  remains the visual evidence when WebGL lighting differs.

Do not run Scenario's separate Blender MCP commands or launch another Blender
process for these checks. Keep scene edits, checkpoints, and export inside this
plugin's dedicated bridge and `SceneStore` workflow.

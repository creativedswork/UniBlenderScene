# Reference-guided scene craft

Use these checks for a visually detailed scene, especially one based on a
reference image. They adapt methods from Scenario Labs'
[Blender expert](https://github.com/scenario-labs/skills/tree/b8544b9c86e0685844cc6effbb27f3885f744d3a/skills/dcc/blender/scenario-blender-expert),
[lighting and rendering](https://github.com/scenario-labs/skills/tree/b8544b9c86e0685844cc6effbb27f3885f744d3a/skills/dcc/blender/scenario-blender-lighting-rendering),
and [export](https://github.com/scenario-labs/skills/tree/b8544b9c86e0685844cc6effbb27f3885f744d3a/skills/dcc/blender/scenario-blender-export)
Skills. This reference uses this plugin's `scene_*` workflow; the Scenario MCP
tools and helper scripts are not prerequisites.

## Build from large shapes to detail

- Identify the camera, main objects, and approximate scale anchors. With a
  reference image, note the parts it hides and treat them as a reconstruction.
- Block out the room and large objects first. Render from the target camera and
  check proportions, silhouettes, overlap, and floor contact before adding small
  props or textures. Inspect another angle when a visible silhouette hides a
  collision or floating object.
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

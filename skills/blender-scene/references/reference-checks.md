# Reference checks

Use these checks for image reconstruction when a point or edge in the reference
can be matched to the same subject in Blender. Read the original images in
attachment order. Draft the checks and inspect the points and edge samples
overlaid on their source view before freezing the plan. Use manual clicks or a
segmentation-assisted contour when the exact positions are hard to locate.

1. In `scene_plan.referenceChecks`, give each check an `id`, stored `reference`
   asset name, Scene Graph `nodeId`, and `tolerance`. Record `target` in
   normalized `[x, y]` coordinates from the top-left of the full reference.
   Choose the tolerance from the visible precision and importance of the feature.
   In the graph review, verify that the landmark or edge is visible and its
   scope identifies the intended subject. Correct the draft in planning if it
   binds the wrong view or subject.
2. For a `point`, supply one target position and a `landmarkId`. Create an Empty
   at that semantic location on the mapped subject and set
   `empty["scene_landmark_id"]` to the ID. Parent it so it follows the part when
   that part moves. Use separate graph nodes for parts that need distinct
   visibility checks. The service projects the Empty and checks for the mapped
   surface in the visibility mask at that pixel. Tolerance is Euclidean
   distance in normalized image coordinates.
3. For an `edge`, supply `side: "left"` or `"right"` and 2–16 target points
   with strictly increasing interior y coordinates. At each y, the service
   takes the extreme visible pixel on that side of the mapped node. Tolerance
   is the maximum horizontal error as a fraction of frame width. For a street
   gap, use separate nodes for the two contributing sides. Measure the right
   edge of the left group and the left edge of the right group on the same rows.

Compose and render each paired camera at the reference aspect ratio, with
square pixels and the render border disabled. Use perspective or orthographic
cameras. Choose visible, opaque surfaces. The diagnostic mask uses solid
Workbench visibility and samples at up to 1024 px on the long side. Leave
transparent surfaces, fog, light beams and reflections to the appearance
review. Use reference observation regions to tell the reviewer where to look.

During composition and final, read `inspection.summary.referenceMeasurements`
before `scene_review`. Each entry has the target and the measured positions
with the contributing Blender object names. For a discrepancy, call
`scene_get` with `images: "alignment"` and `referenceName` if the overlay helps
locate it. The overlay marks targets in cyan and measurements in amber on the
same Blender render. Use the visibility mask and object transforms to choose a
bounded repair. Compare all affected paired views after the edit and retain the
current checkpoint when the candidate fails to improve it.

The service freezes the checks after graph approval, carries them across
`scene_continue`, and measures them again on composition revalidation and final
review. Missing visibility or incompatible framing produces an unmeasurable
result. After budget exhaustion, report failed or unmeasurable checks from
`remainingGaps` when showing the selected checkpoint. The existing composition
approval and best-effort delivery rules still apply.

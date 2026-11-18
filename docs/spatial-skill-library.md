# Spatial Skill Library

Version `0.3.5-relations.2` connects the scene relation graph to a packaged Python
reward library, bounded layout search and the existing versioned experience
library. The host model remains responsible for planning, interpreting rendered
feedback and proposing generalizations. The service executes and records those
steps; it does not contain a background learning model.

The [blender-spatial Skill](../skills/blender-spatial/SKILL.md) owns the operational
workflow and [scorer contract](../skills/blender-spatial/references/scorer-contract.md).
It co-loads with blender-scene, which retains Provider selection, scene state,
budgets, checkpoints, rendering and composition approval.

## Inner loop

1. A plan freezes the bundled Python source and any active learned reward
   versions. Built-in support, alignment and spacing relations automatically
   select active keys named `spatial-support`, `spatial-alignment` and
   `spatial-spacing`. Custom `skill` relations select an explicit active version.
2. Each edit evaluates the pinned rewards on complete evaluated world-space
   geometry. Single-owner object frames are available for learned orientation
   functions. Missing geometry and invalid scores remain unmeasurable.
3. `scene_optimize` searches small translations and optional rotations around
   world Z over explicitly movable nodes. It runs through the existing edit
   transaction, consumes one existing edit allowance and ends in rendered review.
4. The host compares the render and independent measurements with the rewards.
   Candidate scoring changes may be fixture-validated and tried locally without
   replacing the plan's frozen review scores.

The search is deterministic bounded coordinate search, not a global layout
solver. It can stall and does not optimize object scale or arbitrary articulation.
It cannot grant rounds, expand an authorized revision scope, move the camera or
approve composition. Failed edits restore their checkpoint.

## Outer loop

Verified repairs are captured through the existing scene experience flow. A
`spatial_score` candidate contains `score(layouts, relation)` Python code,
applicability, limitations, verified source lesson IDs and positive/counterexample
unittest fixtures. Candidate hashes cover that definition.

Validation executes the new fixtures and inherited fixtures from all earlier
passing versions of the same key. The reports distinguish those two sets. A
candidate cannot drop inherited failures by weakening its own tests. One-scene
validated versions can be tried locally; shared activation additionally requires
reviewed source evidence from at least two distinct scenes.

Activation changes the default for future plans. Current plans retain their
exact versions. A failed revalidation blocks further use of that candidate;
retirement removes it from new plans. Previous passing versions remain available
for explicit rollback.

## Evidence and limits

`inspection.summary.spatialEvaluation` records rewards and scorer provenance.
Optimization reports include trial, frozen-plan and independent bundled results
before and after search. `inspection.spatialReport` identifies the scene-local
JSON evidence file, and reviews retain that path for later lessons.

Runtime cases, candidates, validation history and active versions live under
`RUNS_ROOT/experience-library/`. Scene measurements live inside each scene's
`measurements/` directory. They are not committed or copied into installed Skill
files. Publishing learned functions in a plugin remains a separate source change.

The bundled rewards and independent geometric checks use world AABBs. They do
not establish surface contact, absence of mesh intersections or reference-image
similarity. Learned functions must declare the geometry they need, and every
scene still needs independent visual review. See the
[comparison procedure](scene-relations-comparison.md) before claiming improved
scene quality.

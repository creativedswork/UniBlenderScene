# Compare independent spatial relations

This branch adds independent relation nodes to the existing object hierarchy.
`scene_plan.relations` connects participants by stable graph IDs and binds each
relation to global criteria. `scene_review.relationReviews` records one result
per active relation. Numeric checks use evaluated Blender world-space mesh
bounds. Version `0.3.5-relations.2` also provides explicit bounded layout search
through `scene_optimize`, using pinned Python rewards from `blender-spatial`.
See the
[relation workflow](../skills/blender-scene/references/relations.md) for field
definitions and geometric limitations.

## Run a comparison

Use two new scenes with the same references, request, host model, stage budgets,
asset files, target camera and rendering settings. Reuse identical downloaded
assets when permitted; record any difference in provider output or manual
intervention. Do not change an existing plan to switch conditions midway.

The service accepts both conditions:

| Condition | Planning and review |
| --- | --- |
| A: existing workflow | Explicitly request a control run that omits top-level `scene_plan.relations`. Keep the same spatial requirements in the global criteria and legacy descriptions. |
| B: independent relations | Express those same spatial requirements in `scene_plan.relations`. Bind them to composition criteria, then inspect measurements and submit `relationReviews` during composition and final review. |

To measure the added layout search separately, keep the same relation plan in
both runs and compare host-written corrections with `scene_optimize`. Count each
search as one edit, keep identical edit budgets and starting geometry, and record
the exact scorer IDs/hashes, search steps, candidate overrides and measurement
report paths. A changed shared library must not silently change an existing run.

For example, use the same scene request in both runs: a horizontal table, a vase
resting on it, and three identical chairs in a straight, evenly spaced row beside
it. In B, use support for vase/table, alignment and spacing for the chair row,
and semantic relations for chair orientation or camera-relative visibility.
Freeze the same dimensions and acceptable errors in A's criteria and B's
relation parameters. A numeric tolerance is an absolute Blender-unit distance,
not an image-space percentage.

An explicit control-run instruction takes precedence over the Skill's default
recommendation to use independent relations. Omitting relations exercises the
legacy path in this same service; comparing against the unmodified `main`
version additionally requires switching the service and installed Skill to that
revision. Record which comparison was performed.

## Record results

For each run, save the scene ID, plan, host model/version, asset identities,
per-stage edit counts, remaining gaps and Blender renders. Use the same views
and independent final measurements for both conditions. Compare:

- Support gaps/penetration and visible contact quality.
- Center alignment and adjacent spacing errors in world units.
- Camera-relative occlusion and consistency across the five structural views.
- Successful edit attempts and regressions after a local placement change.
- Total time and host/tool usage, including the added relation reviews.
- Frozen and trial reward changes compared with independent geometric and visual
  outcomes. Reward improvement alone is not a scene-quality measurement.

Repeat across multiple scenes before attributing a quality improvement to this
workflow. Passing implementation tests establishes the measurement and review
mechanics; it does not establish improved scene quality.

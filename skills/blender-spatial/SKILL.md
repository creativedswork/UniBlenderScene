---
name: blender-spatial
description: Use alongside blender-scene for numeric spatial layout optimization or learning reusable Python spatial scoring functions. Does not own asset generation or scene approval.
---

# Spatial scoring and layout learning

This is the spatial module of the
[Scene Skill Library](../blender-skill-library/SKILL.md); it owns spatial rewards
and layout search. General guidance, production functions and checks use the
shared library workflow.

Co-load [blender-scene](../blender-scene/SKILL.md); it owns scene planning,
Providers, edit budgets, checkpoints, visual review and approval. Use only that
Skill's dedicated scene tools. Discover `scene_optimize` and the existing
`scene_skill_propose`, `scene_skill_validate`, `scene_skill_activate` tools
before attempting this workflow. Missing tools require service recovery through
blender-setup, not an alternate Blender connection.

## Plan measurable relations

Inspect assets and establish world units and coordinate frames. Keep one
predicate per relation: separate support, relative placement and orientation.
Read [relation fields](../blender-scene/references/relations.md) when constructing
the plan. Bind spatial criteria to stages that must check them.

The bundled [Python rewards](scripts/scores.py) implement support, center
alignment and adjacent spacing. `scene_plan` freezes their source/hash and
automatically pins active `spatial_score` versions with keys `spatial-support`,
`spatial-alignment`, `spatial-spacing`. A later activation affects new plans;
existing plans keep their pins. Retiring a version removes it from new plans;
a failed revalidation blocks its further execution, including existing plans.

For another validated relationship, use `type: "skill"` with exact `scorer`
ID/hash, `minScore`, numeric `parameters` and explicit participant roles. Retrieve
the scorer's applicability, limitations and code before selecting it. Do not
replace a measurable relation with `semantic` just to avoid a failed check.
Use semantic review when the available geometry/scorers do not represent the
requirement; state the limitation. A whole furniture AABB may not identify its
support surface. Use inspected part nodes when available; do not invent them.

## Inner loop: improve this scene

1. Build the complete blockout through `scene_edit`, then read
   `inspection.summary.spatialEvaluation` and `relationChecks`. Scoring uses all
   mapped mesh bounds, plus `matrixWorld` when a node has one unambiguous owner.
2. Review the render and all relevant references. Fix incorrect object mappings
   or relation definitions before treating the score as an optimization target.
3. During geometry/composition `edit`, call `scene_optimize` with explicit
   `movableNodeIds`, `translationStep` in world units, `passes` (1-8), and optional
   world-Z `rotationStepDegrees`. Choose steps from the observed error and object
   scale. Search makes bounded coordinate moves; it is local and can stall.
   A call uses one existing edit round and ends with a render requiring review.
4. Compare `summary.layoutOptimization.before/after`, `frozenBefore/frozenAfter`,
   and `independentBefore/independentAfter` with the image. A higher score is not
   visual acceptance. Submit normal criterion and relation reviews; do not
   refill budgets or approve composition through optimization.
5. If a scorer misrepresents the relationship, develop a generic correction.
   Read [the scorer contract](references/scorer-contract.md) before changing
   code. First-scene exploratory code can run through `scene_edit` and remain
   task-local script evidence. A candidate with verified source lessons can be
   proposed and fixture-validated, then tried through `scorerOverrides` on
   `scene_optimize`. Such a trial does not change plan pins or review thresholds.
   Inspect trial and frozen results separately; do not claim the candidate's own
   score proves improvement. Search preserves already passing frozen and bundled
   geometric checks, but still requires independent render review.

If no active numeric relations exist, search refuses the request. Continue
bounded host-written editing and semantic review, or correct the plan through
the owning scene workflow. Do not turn failed prerequisites into a passing score.

## Outer loop: update the shared local library

After delivery verification, follow
[Scene Skill Library](../blender-skill-library/SKILL.md) to record the
repair, script/render evidence, applicability and limitations. Keep user-specific
art direction in the case. Consolidate common function improvements under a
stable key using `kind: "spatial_score"`.

Validate the exact candidate with positive and counterexample unittest fixtures
that receive the module as `skill`. Include the newly discovered failure. The
service also runs fixtures from all earlier passing versions of that key against
the new code; weakening the candidate's own tests cannot discard those cases.
Inspect the full validation report, including `regressions`.

One-scene validated candidates are local trials. Shared activation additionally
requires reviewed verified source lessons from at least two distinct scenes.
Activate only a passing exact version. A regression leaves the previous active
version intact. Record unresolved visual failures rather than promoting them.

Completion means the current scene was independently reviewed and any shared
update has its exact validation and activation recorded. The host performs both
loops; there is no background model or guaranteed monotonic improvement.
Learned versions persist in `RUNS_ROOT/experience-library/`, outside Git and the
installed package. Activation does not rewrite `SKILL.md` or publish a plugin.

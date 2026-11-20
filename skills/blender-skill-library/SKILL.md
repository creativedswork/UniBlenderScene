---
name: blender-skill-library
description: Use when reusing, validating or evolving scene guidance, Python functions and checks across modeling, materials, lighting, cameras, rendering or export; co-load blender-scene.
---

# Scene Skill Library

Co-load [blender-scene](../blender-scene/SKILL.md) for scene execution and
approval. This Skill owns retrieval, evidence-backed lessons, shared candidate
versions, validation, activation and retirement across scene-production domains.
The library can store modeling helpers, material/light/camera setup functions,
render/export checks and diagnostic guidance when supported by verified cases.
The bundled numeric rewards currently cover spatial relationships; co-load
[blender-spatial](../blender-spatial/SKILL.md) for their specialized workflow.

The host owns interpretation, visual review and generalization. The service
captures cases, binds evidence, runs tests and controls the active local library.
Keep the user's task and delivery moving; do not invent acceptance, unseen image
reviews or new scene-edit grants to make a lesson pass.

## Before planning

1. Inspect `learning.skills` in scene responses. Call `scene_library_search` with
   scene/task terms to read relevant active instructions and code. Search again
   using domain terms such as lighting, camera, UV or scattering when needed.
2. Check applicability, limitations and validation mode. `host-review` is a host
   judgment; `blender-tests` proves only the executed fixtures. Neither proves
   that a new scene will resemble a reference without its own visual review.
3. Adapt relevant functions/checks through `scene_edit`; retain its plan,
   Provider, scope, checkpoint and review requirements. Never execute learned
   scene code by another bridge, shell Blender or direct file mutation.

## After delivery verification

Final export automatically captures a case and sets `learning.retrospectiveDue`.
Successful edit scripts are retained under the scene's `scripts/` directory.
For older exports, call `scene_experience` with only `sceneId` to prepare a case.

Before the final delivery reply, call `scene_experience` with a retrospective
bound to `learning.case.fingerprint` and a unique `requestId`. Record:

- The failure, supported cause, effective repair and what was actually verified.
- Applicable conditions and known limitations, including unsuccessful methods
  when they explain the repair's scope.
- Scene-local evidence files: actual images, reports and scripts. The service
  copies them into immutable hash-addressed storage; no reference images or
  scenes are committed or sent to a Provider by this operation.
- `acceptedDifferences` only when the user explicitly accepted them. Empty means
  no recorded acceptance. Delivery, `completed` and `best_effort` do not imply it.
- Lesson status: `verified` for a supported repair, `observation` for an unresolved
  diagnosis, or `preference` for a task/user-specific choice. A verified repair
  can come from a best-effort scene; its scope does not include every criterion.

Use the same request ID when retrying identical input. If the fingerprint changed,
reread the current case and its actual evidence before recording again.

## Consolidate across tasks

When `learning.batchDue` is true (unused verified lessons from at least three
distinct scenes), call `scene_library_search` with `includeCandidates: true`.
Group recurring lessons and review their evidence. An important reproducible bug
can be consolidated earlier. Unrelated cases do not require a new shared rule.

For each supported generalization, call `scene_skill_propose`:

- `guidance`: reusable diagnostic or production instructions.
- `blender_function`: reusable production code.
- `check`: an executable validation function.
- `spatial_score`: a pure Python reward used by numeric layout evaluation and
  search. Co-load [blender-spatial](../blender-spatial/SKILL.md) for its
  function contract, version pinning and local candidate trials.

Use a stable descriptive `key`; the service assigns immutable versions. Include
source lesson IDs, tags, conditions, limitations and concise instructions. Keep
scene-specific names, numeric art direction, personal paths, credentials and
user approvals out of generic code. Do not promote preferences or observations.
Avoid duplicate entries; refine an existing key when it owns the same operation.

Executable candidates require Python code and at least one positive and one
counterexample fixture. Each fixture defines ordinary `unittest.TestCase` tests
and receives the candidate module as `skill`. Exercise the supported operation
and the original failure, including relevant parent transforms or invalid inputs.
Tests must assert behavior; empty/skipped/expected-failure suites do not qualify.

## Validate and activate

Call `scene_skill_validate` with a scene ID, candidate ID, exact candidate hash
and `replays` covering every source lesson. Describe the case comparison and
whether the proposed rule applies; failed comparisons stay failed.

- Code runs in disposable Blender scenes on SceneStore's existing queue. Poll
  `scene_get images=none` until the job finishes, then inspect `skillValidation`
  and the full fixture report through `scene_library_search includeCandidates`.
  The task scene is restored; no edit rounds or composition approvals are added.
  This is trusted host code with Blender OS permissions, not a sandbox.
- Guidance requires host review across at least two distinct scenes, with an
  applicable case and a counterexample that establishes the rule's boundary.
  This is saved as `host-review`, not a deterministic or Blender verification.

Activate only the latest passing validation of the exact version using
`scene_skill_activate action=activate`. Failed candidates stay out of normal
retrieval. A proposed version does not replace the active version automatically.
Retire an entry when later evidence disproves it; preserve the case and failure.
An earlier version may be activated with its latest still-passing validation.
Spatial candidates additionally follow the cross-scene activation, inherited
regression and local-trial requirements in
[blender-spatial](../blender-spatial/SKILL.md).

The local library lives under `RUNS_ROOT/experience-library/`, normally
`.canova/runs/experience-library/`. It survives service restarts. Activation
does not rewrite installed `SKILL.md` files, modify source code, publish a plugin
or grant credentials. Repository changes need the normal code/review workflow;
do not treat a learned entry as authorization to change the plugin in a later
scene task. If the service or host cannot perform learning, report the pending
step without claiming that knowledge was consolidated.

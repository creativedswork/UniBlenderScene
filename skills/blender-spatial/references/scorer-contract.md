# Python spatial scorer contract

Define `score(layouts, relation) -> float`, returning a finite value in `[0, 1]`.
Read arguments only. Scorer code is trusted host Python with Blender OS
permissions, not sandboxed code; it must not mutate the scene, use randomness,
read personal paths, call networks or infer success from object names.

`layouts` maps stable node IDs to world-space `min` and `max` triples. A node with
one mapped owning object also has a row-major 4×4 `matrixWorld`; it may be absent
for merged objects or graph groups. Relation participant roles identify operands.
For custom `type: "skill"` relations, put numeric configuration in `parameters`
and declare the passing `minScore` in the frozen plan.

For example, a reusable facing score can select `subject` and `target` by role,
derive their centers from bounds, and compare the subject's world forward axis
from `matrixWorld` with the direction toward the target. Make the local forward
axis and any planar projection explicit parameters. Missing orientation data
should raise an error and become `unmeasurable`, not a fabricated pass.

Built-in replacement keys use a fixed passing threshold of `0.5`; preserve the
meaning of their world-unit tolerances. Their original TS geometric checks also
remain in force. For different geometric semantics, use a separate custom key
and a `skill` relation instead of changing the meaning of an existing key.

Before a candidate can be tried, `scene_skill_validate` checks its callable
signature and runs ordinary `unittest.TestCase` fixtures. Assert expected scores
or independent geometric outcomes on applicable and failing inputs, including
the repaired bug. Do not assert only that a function returns or that scores are
nonnegative. Add parent/axis/scale examples when they define applicability.

Before sharing, review evidence from multiple distinct scenes and inspect
renders/runtime measurements independently of the reward being learned. Prior
passing fixtures provide regression coverage, not proof against every failure.
Keep every candidate/version and test report; use retirement or an earlier
still-passing activation for rollback. The runtime checks output range on each
evaluation; missing geometry, errors and nonfinite outputs cannot pass review.

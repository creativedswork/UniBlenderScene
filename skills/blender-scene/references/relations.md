# Spatial relations

Use `scene_plan.relations` for independent relation nodes. Their participant
edges connect to existing `graph` nodes; `parentId` still describes object and
part hierarchy. Relation IDs are distinct from object IDs and remain frozen for
the request. A failed `scene_plan_review` returns to planning so an incorrect
relation can be corrected before construction. Use `scene_continue` to replan a
delivered scene for a new request. Legacy plans without `relations` still work.

## Plan

Give each relation `id`, `type`, `description`, `participants` and `criterionIds`.
Each participant has a stable `nodeId` and explicit `role`. Bind relations to
observable global criteria used by the stages that should check them. Placement
relations normally bind to composition criteria; final reviews check all.

Numeric relations require explicit `axis` and `tolerance`, in Blender world
coordinates and Blender units, after asset scaling. Blender uses Z-up. Choose
tolerances from the intended scene scale; do not loosen them to conceal errors.

| Type | Participants and measurement |
| --- | --- |
| `support` | Exactly two: `subject` rests on `support`. Requires `axis: "z"`. Checks subject AABB bottom against support AABB top and subject center against its XY footprint. |
| `alignment` | Two or more `member` participants. Checks the spread of their AABB center coordinates along the chosen axis. Two axes require two relations. |
| `spacing` | Two or more `member` participants, plus positive `spacing`. Sorts centers along the chosen axis and checks each adjacent gap against the requested spacing. Use a separate alignment relation to require a straight row. |
| `semantic` | Two or more participants with descriptive roles. Use for camera-relative placement, occlusion, orientation, relative size, curved/sloped support or other constraints without a numeric checker. No numeric parameters; requires render and runtime evidence. |

Example, after planning `vase` and `table` graph nodes and a `table-layout`
criterion:

```json
{
  "id": "vase-on-table",
  "type": "support",
  "description": "The vase rests on the horizontal table top",
  "participants": [
    { "nodeId": "vase", "role": "subject" },
    { "nodeId": "table", "role": "support" }
  ],
  "criterionIds": ["table-layout"],
  "axis": "z",
  "tolerance": 0.01
}
```

Keep legacy node-level `relations` only when continuing a legacy plan. New
independent relations are the authoritative constraints; avoid maintaining a
second copy in free-text edges.

## Inspect and review

After `scene_edit`, read `inspection.summary.relationChecks` from `scene_get`.
Checks use evaluated mesh bounds transformed into world space, including mapped
object descendants and graph groups. Stable `scene_node_id` tags take precedence
over planned names. Measurements include all mapped meshes, independently of
the abbreviated object inventory. Missing visible mapped mesh bounds produce
`unmeasurable`, never a pass. The check is bound to the inspection and iteration
used by `scene_review`; old inspection results cannot validate a later edit.

These checks approximate geometry with axis-aligned bounding boxes. Hollow or
sloped shapes, overhangs and geometry instances can need additional inspection.
They do not establish surface contact, absence of mesh collisions, support
stability or view-dependent visibility. Check visibility in the render; meshes
with object-level `hide_render` are excluded, but collection/view-layer
visibility is not a separate geometric check. Use semantic relations for
constraints these measurements cannot represent accurately.

For each relation whose `criterionIds` intersects the current-stage criteria,
submit exactly one result:

```json
{
  "relationId": "vase-on-table",
  "passed": false,
  "evidence": "Measured bottom gap is 0.12 units; the vase floats in the side view",
  "correction": "Lower the vase 0.12 units, rerender and check contact and silhouette"
}
```

Put results in `scene_review.relationReviews`. Numeric `failed` or
`unmeasurable` results cannot be overridden by a passing host review. A numeric
pass may still fail visual review. A failed relation must also fail its linked
current-stage criteria. Report failures before another bounded edit; the service
does not move objects automatically or refill edit budgets.

During a scoped revision, `affectedRelations` lists relations involving scoped
nodes or their ancestors/descendants. Use it to identify dependencies to recheck.
It does not authorize editing other participants; preserve their transforms or
ask for additional scope when the requested repair requires it.

`scene-graph.json` exports object `nodes` and independent `relations` together.
The viewer continues to use the object hierarchy for selection.

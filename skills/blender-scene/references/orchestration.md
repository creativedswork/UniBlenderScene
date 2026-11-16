# Host orchestration

Use these roles only when the host supports subagents and the user has authorized
their use. Agent definitions do not create a separate model service.

| Role | Responsibility | Allowed scene tools |
| --- | --- | --- |
| Coordinator | Carry the request, freeze the plan, enforce sequencing, and deliver | All |
| Asset worker | Generate and download one assigned asset through its Provider | None; Provider tools only |
| Builder | Write one complete scene edit against the frozen plan | `scene_get`, `scene_edit` |
| Reviewer | Inspect the reference, latest render, and summary; record evidence | `scene_get`, `scene_review`, `scene_view` |

Run builder and reviewer sequentially. The reviewer does not mutate the scene,
and the builder does not review its own work when the roles are split. Only the
coordinator may begin a new user request or export the final result. Pass scene
ID, current iteration, the frozen criteria, and relevant evidence to each role.

## Asset workers

Use asset workers for the [parallel asset workflow](assets.md#parallel-generation)
after graph verification, when the host supports isolated subagent sessions and
the user has authorized them. Keep the coordinator active to collect results and
dispatch the next ready asset within the concurrency limit.

Give each worker one node ID, the frozen object description and relevant
references, dimensions/style, selected Provider Skill, authorized generation
steps and cost scope, and its own scene input directory. A worker must read and
follow that Provider's instructions, including single-asset session scope,
required choices, create-and-wait ordering and recovery. Return an unresolved
required user choice to the coordinator; do not make it on the user's behalf.

Return the node ID, Provider ID, verified task ID, downloaded GLB path and actual
verification status, or the concrete blocker and known task state. Do not return
credentials or signed URLs. Workers must not call `scene_asset_strategy`,
`scene_edit`, `scene_graph`, review or export tools, modify the frozen plan, or
write another worker's files. The coordinator records results and owns assembly
and scene review. Parallel asset generation does not permit concurrent builder
and reviewer work on the shared Blender scene.

Optional Codex agent templates are in `harnesses/codex/agents/`. Copy them into the target
project's `.codex/agents/` to register the roles in Codex. They remain templates
until installed; portable plugin installation does not automatically register
these TOML files. ChatGPT hosts may use different delegation APIs or run the
roles sequentially in one conversation.

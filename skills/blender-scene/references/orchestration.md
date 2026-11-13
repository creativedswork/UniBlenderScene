# Host orchestration

Use these roles only when the host supports subagents and the user has authorized
their use. Agent definitions do not create a separate model service.

| Role | Responsibility | Allowed scene tools |
| --- | --- | --- |
| Coordinator | Carry the request, freeze the plan, enforce sequencing, and deliver | All |
| Builder | Write one complete scene edit against the frozen plan | `scene_get`, `scene_edit` |
| Reviewer | Inspect the reference, latest render, and summary; record evidence | `scene_get`, `scene_review`, `scene_view` |

Run builder and reviewer sequentially. The reviewer does not mutate the scene,
and the builder does not review its own work when the roles are split. Only the
coordinator may begin a new user request or export the final result. Pass scene
ID, current iteration, the frozen criteria, and relevant evidence to each role.

Optional Codex agent templates are in `harnesses/codex/agents/`. Copy them into the target
project's `.codex/agents/` to register the roles in Codex. They remain templates
until installed; portable plugin installation does not automatically register
these TOML files. ChatGPT hosts may use different delegation APIs or run the
roles sequentially in one conversation.

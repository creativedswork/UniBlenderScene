---
name: scenario-blender-grease-pencil
description: "Use with blender-scene for Grease Pencil drawing, 2D animation, and hybrid 2D/3D scenes."
---

# scenario-blender-grease-pencil

Co-load [blender-scene](../blender-scene/SKILL.md) for the scene lifecycle and [scenario-blender-expert](../scenario-blender-expert/SKILL.md) for shared production checks. This Skill contributes production knowledge for its domain. The
`blender-scene` Skill owns scene creation, planning, editing, rendering, review,
and export through this plugin's `scene_*` tools and dedicated Blender bridge.

- Read relevant technique sections of the pinned [Scenario source](UPSTREAM.md)
  before applying them. Its instructions for Scenario MCP, `skill_get`, a user's
  live Blender session, headless Blender, stage backups, and direct helper-script
  execution are upstream context, not this plugin's execution path.
- Read [procedures](references/procedures.md) only for the technique being used.
- Read [critique](references/critique.md) when assessing the resulting render.
- Apply selected techniques as bounded `bpy` changes through `scene_edit`, then
  inspect the completed render with `scene_get` and submit evidence through
  `scene_review`. Use `scene_export` only when the scene workflow reaches export.
- Verify the domain result against the latest `scene_get` render, object
  summary, and the frozen `scene_plan` criteria before judging it complete.
- Treat bundled `scripts/` as source material. Do not run them directly or
  start another Blender process. Check version-specific APIs against the active
  Blender version before using them in `scene_edit`.

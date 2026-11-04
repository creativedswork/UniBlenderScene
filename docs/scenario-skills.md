# Scenario Labs guidance and updates

The [scene craft reference](../skills/blender-scene/references/scene-craft.md)
adapts general production methods from Scenario Labs' Blender Expert Skills.
Thanks to Scenario Labs and the contributors to
[scenario-labs/skills](https://github.com/scenario-labs/skills) (MIT license).
No Scenario MCP tools or `bx_*` scripts are included in this plugin.

The reviewed source folders and their latest commits at review time are pinned
in [`scripts/scenario-skill-sources.json`](../scripts/scenario-skill-sources.json).
The expert skills were tested upstream on Blender 5.2.1; this plugin's recorded
validation used Blender 5.1.1. Adopt version-specific Python only after a local
Blender test.

Run this from the repository root to check for newer commits in the three
selected upstream folders:

```bash
npm run check:scenario-skills
```

Exit code 0 means the selected folders match the reviewed commits. Exit code 2
means at least one folder changed; exit code 1 means the check failed. A new
commit is a review signal, not a safe automatic change to the scene workflow.

When a selected folder changes, compare it with the recorded commit, update the
relevant guidance in `scene-craft.md`, and keep `scene_edit`, `scene_review`, and
the dedicated Blender bridge as the execution path. Run the Skill validator and
the repository checks, then update `lastReviewedCommit` for each folder actually
reviewed. Do not advance a recorded commit without checking its changes.

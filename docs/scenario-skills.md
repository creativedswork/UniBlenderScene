# Scenario Blender knowledge

The top-level `scenario-blender-*` Skills package the Scenario Blender production
knowledge used by the Canova runtime, pinned to revision
`e24bc7d40be97b428e7b9fd467c415366e1dd974`. Each has a directly loadable
`SKILL.md` that co-loads `blender-scene` and maps the domain to this plugin's
`scene_*` workflow. The copied files and checksums are listed in
[source.json](../skills/scenario/source.json), with the
[MIT license](../skills/scenario/LICENSE). The
[production map](../skills/blender-scene/references/production-knowledge.md)
selects the domain Skill needed for each scene task.

The original `SKILL.md` content is retained verbatim as `UPSTREAM.md` in each
domain folder; its `references/` and helper source are also retained. The
checksums in `source.json` refer to these local `UPSTREAM.md` files. Scenario MCP
tools and separate Blender processes are not part of this plugin. Version-specific
Blender APIs require a check against the active Blender version before use.

Run `npm run check:scenario-skills` to compare the tracked upstream folders
with the reviewed revision. A newer commit is a review signal, not an automatic
upgrade. After reviewing changes, update the copied files, source checksums,
production adapter, and the tracking manifest together.

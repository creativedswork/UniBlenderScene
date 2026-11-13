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

## Review on 2026-11-09

The check now compares each folder's latest commit with the reviewed repository
revision by ancestry. A folder that last changed before that revision is current,
not an update. The reviewed repository revision is recorded separately from the
bundled source snapshot in `source.json`.

Two upstream changes since the bundled snapshot were reviewed: the
[expert audit fix](https://github.com/scenario-labs/skills/commit/3590932e327a4dd1f52d606576b5006b313002f9)
refines contact detection in `bx_audit.py`, and the
[export fix](https://github.com/scenario-labs/skills/commit/202c51fcb73075030bf6b8d1a4661a6b37959f01)
skips meshopt compression in `bx_export.py` before Blender 5.2. This plugin's
`scene_*` workflow does not execute either helper script, so neither changes its
scene guidance or runtime export. The bundled source remains at the pinned
revision until the helpers are separately adapted and tested.

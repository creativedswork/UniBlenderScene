---
name: blender-setup
description: Set up the UniBlenderScene Blender bridge, MCP service, and host connection, or diagnose missing service prerequisites.
---

# Set up UniBlenderScene

Read `docs/quick-start.md` for first-time setup and `docs/operations.md` for
commands and client-specific installation.
Check Node.js 22 or later and a dedicated Blender 4.5 or later installation.

On desktop Codex, install the release ZIP as a local marketplace source and
start a local chat. The stdio entry starts or reuses the dedicated Blender
bridge and service. It looks for Node on the desktop process's PATH and in
`/opt/homebrew/bin` and `/usr/local/bin`. If Node is installed only through an
interactive shell, make Node.js 22+ available to the desktop process.
Preserve an existing `RUNS_ROOT` by setting it in
`~/.canova/.env` before reconnecting. Follow the migration instructions in
`docs/operations.md` if a manually started service owns the port.

For a source checkout, run `npm ci` and `npm run build` from the plugin root.
For a manual HTTP deployment, use the launcher below. Verify `/health` for
HTTP availability and a completed `scene_create` job for Blender connectivity.

For local startup after installation and build, run
`node --import tsx scripts/start-local.ts` from the plugin root. It starts or
reuses its own dedicated bridge and MCP service, checks the full tool catalog,
array schema compatibility and agreement with the checkout version, and keeps
logs/PIDs in `RUNS_ROOT/.service/`. When resuming, preserve the existing
`RUNS_ROOT`; set `SCENE_ID` to verify that scene is readable. The launcher uses a
loopback-only unauthenticated service and does not submit scene edit jobs. Read
`docs/operations.md` for configuration and process ownership behavior.

For Codex, use the `.agents/plugins/marketplace.json` source and portable root
manifests. For Claude Code scene production, start in a scene project outside the
plugin checkout and its subdirectories. Load the plugin with
`claude --plugin-dir /absolute/path/to/UniBlenderScene` or install it from
`.claude-plugin/marketplace.json`. Check `/mcp` for the connection and available
scene tools before scene work. For Cursor, copy the extracted release ZIP or
built checkout into `~/.cursor/plugins/local/uni-blender-scene` and reload
Cursor, or pass `--plugin-dir /absolute/path/to/UniBlenderScene` to Cursor CLI
(`agent`). Cursor loads `.cursor-plugin/plugin.json` and its managed `stdio`
MCP entry in `harnesses/cursor/mcp.json` (`${CURSOR_PLUGIN_ROOT}`), sharing the
same managed local service and `skills/` as Codex and Claude Code. The Claude
HTTP connection is in `harnesses/claude-code/mcp.json`. Read `docs/operations.md`
for commands. For ChatGPT web, the service needs a reachable HTTPS endpoint and
a host-supported authentication flow. Set `PUBLIC_BASE_URL` to the deployed
origin and run `npm run configure -- https://YOUR_SERVICE_ORIGIN` to update all
packaged MCP configurations.

For missing tools, first use the host's tool discovery when available. For a
Codex-managed service, check the logs in `RUNS_ROOT/.service/` and reconnect
Codex. For a manually managed service, run the launcher above with the existing
`RUNS_ROOT`. Missing `scene_plan`, `scene_review` and `scene_export` while other
tools remain visible can result from tuple array schemas; the launcher reports
the affected tool and field. Correct the reported service problem before
reconnecting the host. Restart an owned service only when no scene job is queued
or running; preserve `RUNS_ROOT` and scene IDs. If the launcher passes but the
host still omits tools, refresh its MCP connection or start a new chat, then
verify the host tool list again. If recovery fails, report the missing tool,
launcher error and whether the host or server lacks it. Do not write an
alternative HTTP client or modify plugin source during scene production unless
the user requests that work.

Do not place credentials in manifests or Git. Ask the operator to supply secrets
through their connection settings. Stop if the host cannot reach Blender or
cannot display image evidence; report the missing prerequisite.

---
name: blender-setup
description: Set up the UniBlenderScene Blender bridge, MCP service, and host connection, or diagnose missing service prerequisites.
---

# Set up UniBlenderScene

Read `README.md` at the plugin root for commands and client-specific installation.
Check Node.js 22 or later and a dedicated Blender 4.5 or later installation.

Run installation, build and service startup commands from the plugin root;
keep the scene conversation in its separate project. Install dependencies with
`npm ci`, build the viewer with `npm run build`, and
copy `.env.example` to `.env` when custom settings are needed. Start the dedicated
Blender bridge before the Node service. Verify `/health`; this checks HTTP service
availability, not Blender connectivity. The first `scene_create` job tests the
Blender connection.

For local startup after installation and build, run
`node --import tsx scripts/start-local.ts` from the plugin root. It starts or
reuses its own dedicated bridge and MCP service, checks tool discovery, and keeps
logs/PIDs in `RUNS_ROOT/.service/`. When resuming, preserve the existing
`RUNS_ROOT`; set `SCENE_ID` to verify that scene is readable. The launcher uses a
loopback-only unauthenticated service and does not submit scene edit jobs. Read
`docs/operations.md` for configuration and process ownership behavior.

For Codex, use the `.agents/plugins/marketplace.json` source and portable root
manifests. For Claude Code scene production, start in a scene project outside the
plugin checkout and its subdirectories. Load the plugin with
`claude --plugin-dir /absolute/path/to/UniBlenderScene` or install it from
`.claude-plugin/marketplace.json`. Check `/mcp` for the connection and available
scene tools before scene work. If they are missing or fail, report the error;
do not write an alternative HTTP client or modify plugin source unless the user
requests that work. Both clients share `skills/` and the same running service;
the Claude HTTP connection is in
`harnesses/claude-code/mcp.json`. Read `docs/operations.md` for commands.
For ChatGPT web, the service needs a reachable HTTPS endpoint and a host-supported
authentication flow. Set `PUBLIC_BASE_URL` to the deployed origin and run
`npm run configure -- https://YOUR_SERVICE_ORIGIN` to update both MCP configurations.

Do not place credentials in manifests or Git. Ask the operator to supply secrets
through their connection settings. Stop if the host cannot reach Blender or
cannot display image evidence; report the missing prerequisite.

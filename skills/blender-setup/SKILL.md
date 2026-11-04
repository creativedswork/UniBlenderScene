---
name: blender-setup
description: Set up the CodexBlenderPlugin Blender bridge, MCP service, and host connection, or diagnose missing service prerequisites.
---

# Set up CodexBlenderPlugin

Read `README.md` at the plugin root for commands and client-specific installation.
Check Node.js 22 or later and a dedicated Blender 4.5 or later installation.

Install dependencies with `npm ci`, build the viewer with `npm run build`, and
copy `.env.example` to `.env` when custom settings are needed. Start the dedicated
Blender bridge before the Node service. Verify `/health`; this checks HTTP service
availability, not Blender connectivity. The first `scene_create` job tests the
Blender connection.

For local Codex, use the packaged marketplace or add the local MCP connection.
For ChatGPT web, the service needs a reachable HTTPS endpoint and a host-supported
authentication flow. Set `PUBLIC_BASE_URL` to the deployed origin and run
`npm run configure -- https://YOUR_SERVICE_ORIGIN` to update `mcp.json`.

Do not place credentials in manifests or Git. Ask the operator to supply secrets
through their connection settings. Stop if the host cannot reach Blender or
cannot display image evidence; report the missing prerequisite.

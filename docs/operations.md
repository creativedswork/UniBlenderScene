# Service setup and deployment

This page is for people running the Blender MCP service or packaging the plugin.
The [README](../README.md) covers the plugin and its scene workflow.

## Install the plugin source

The repository contains `plugin.json`, `mcp.json`, and a marketplace definition
at `.agents/plugins/marketplace.json`. Add this repository as a plugin source:

```bash
codex plugin marketplace add creativedswork/CodexBlenderPlugin --ref main
```

If you already cloned the repository, you can add its absolute path instead:

```bash
codex plugin marketplace add /absolute/path/to/CodexBlenderPlugin
```

Install **CodexBlenderPlugin** from the **Codex Blender** source in the Plugins
Directory. The bundled `mcp.json` points to `http://127.0.0.1:4312/mcp`; install
does not start the service. A private repository requires GitHub access.

## Run the local service

Requirements: Node.js 22+, Blender 4.5+ with glTF export support, and an HTTP MCP
client. The embedded viewer also requires MCP Apps and WebGL 2. This release was
tested with Blender 5.1.1 on macOS.

From the repository root, install dependencies and build the viewer:

```bash
npm ci
npm run build
cp .env.example .env
```

Start a dedicated Blender process in one terminal. On macOS:

```bash
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --factory-startup --python blender/bridge.py -- --port 9877
```

On Linux, use `blender` in place of the application path. On Windows, use the
path to `blender.exe`. Start the MCP service in a second terminal:

```bash
npm start
```

`http://127.0.0.1:4312/health` checks HTTP availability. A completed
`scene_create` job confirms the Blender connection. The service and Blender must
run on the same machine or share the same absolute run directory. Scene data is
stored under `.canova/runs/<scene-id>/` by default.

## Connect a remote service

A remote plugin connection needs a reachable HTTPS service; the bundled local
`127.0.0.1` endpoint is only for a client on the same machine. Run Node and a
dedicated Blender process with a shared persistent run directory behind an HTTPS
reverse proxy. Set `HOST=0.0.0.0`, `MCP_API_KEY`, and
`PUBLIC_BASE_URL=https://YOUR_SERVICE_ORIGIN`; forward `Host` and
`Authorization` through the proxy. Then update the packaged endpoint:

```bash
npm run configure -- https://YOUR_SERVICE_ORIGIN
```

Keep the key in connection settings, outside `mcp.json`. The service supports
fixed bearer-key authentication for private connections. It does not implement
OAuth or public-directory submission, which needs a supported authentication
method ([submission requirements](https://developers.openai.com/plugins/deploy/submission#authentication-limitations)).
Set `WIDGET_DOMAIN` only when using a separate UI origin.

## Configuration and access

[`.env.example`](../.env.example) lists service and bridge settings.
`FILE_DOWNLOAD_HOSTS` controls which HTTPS hosts may supply reference images;
downloads have a 20 MB limit. The service serializes Blender operations for one
trusted operator. `scene_edit` runs Python with the Blender process's OS
permissions, so use a dedicated account or container when hosting it.

Scene metadata and reviewed checkpoints survive service restarts. An interrupted
edit restores the pre-edit checkpoint when recovery succeeds. If a timed-out
Blender operation continues or recovery fails, restart the dedicated bridge and
service before resuming. This release has no multi-tenant isolation, job
cancellation, or process supervisor.

The optional templates in [`codex/agents/`](../codex/agents/) can be copied into
a Codex project's `.codex/agents/`; plugin installation does not register them.
[`AGENTS.md`](../AGENTS.md) applies only when this repository is the working
directory. The packaged Skills provide the reusable plugin instructions.

## Verify and package

From the repository root:

```bash
npm run check
npm run build
npm test
npm run test:blender
```

The Blender integration test starts its own bridge and service and prints an
`evidenceDirectory`. Set `BLENDER_BIN` if Blender is installed elsewhere. To
check the MCP Apps viewer in a sandboxed iframe:

```bash
npx playwright install chromium
npm run test:viewer -- /path/printed/as/evidenceDirectory
```

To build a distributable archive:

```bash
npm run pack:plugin
```

The ZIP is written to `../CodexBlenderPlugin.zip`. It excludes `.git`,
`node_modules`, `.env`, and `.canova`. See the [validation results](validation.md)
for checks performed on this release.

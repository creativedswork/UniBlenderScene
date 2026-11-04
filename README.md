# CodexBlenderPlugin

Create and refine Blender scenes from reference images or text, inspect rendered
evidence, and preview the best result inside a supporting chat client.

ChatGPT or Codex supplies the model and Agent loop. This package contains Skills,
a Blender MCP service, an embedded Three.js viewer, and optional Codex agent
templates. It does not require a separate LLM API key or Codex App Server.

```mermaid
flowchart LR
  U["User request + image"] --> H["ChatGPT / Codex host"]
  S["Packaged Skills"] --> H
  H -->|"plan · edit · review"| M["Blender MCP service"]
  M --> B["Dedicated Blender process"]
  B --> C["Checkpoint + render + best scene"]
  C --> M
  M -->|"MCP App resource"| V["Three.js chat viewer"]
  V -->|"refinement message"| H
```

## Quick start

Requirements: Node.js 22+, Blender 4.5+ with glTF export support, and a client that
supports HTTP MCP. The chat viewer additionally requires MCP Apps support and
WebGL 2. This release was tested with Blender 5.1.1 on macOS.

From the repository root:

```bash
npm ci
npm run build
cp .env.example .env
```

Start a **dedicated** Blender process in one terminal. On macOS:

```bash
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --factory-startup --python blender/bridge.py -- --port 9877
```

On Linux, use `blender` in place of the application path. On Windows, run the same
arguments with the path to `blender.exe`.

Start the service in a second terminal:

```bash
npm start
```

The default MCP endpoint is `http://127.0.0.1:4312/mcp`.
`http://127.0.0.1:4312/health` checks HTTP availability. A completed
`scene_create` job confirms the Blender connection.

The server and Blender must run on the same machine or share the same absolute
run directory. Runtime files are stored under `.canova/runs/<scene-id>/`.
Installing the plugin does not automatically start either process.

## Install in Codex or ChatGPT desktop

The repository includes a portable root `plugin.json`, `mcp.json`, and a repo
marketplace at `.agents/plugins/marketplace.json`.

In a Codex version that supports plugin marketplaces:

```bash
codex plugin marketplace add creativedswork/CodexBlenderPlugin --ref main
```

Private repositories require GitHub access. Alternatively, add the cloned
repository as a local marketplace:

```bash
codex plugin marketplace add /absolute/path/to/CodexBlenderPlugin
```

Restart the ChatGPT desktop app, open its Plugins Directory, select the
**Codex Blender** source, and install **CodexBlenderPlugin**. Client and workspace
availability can vary; see the
[official plugin packaging guide](https://developers.openai.com/plugins/build/plugins).

For a CLI that supports MCP but not plugin marketplaces:

```bash
codex mcp add codex-blender --url http://127.0.0.1:4312/mcp
```

Run from this repository so `AGENTS.md` applies, or install the
`skills/blender-scene` directory through your host's Skill mechanism. The MCP
server also exposes a `blender-scene` prompt for clients that support MCP prompts.
A client without MCP Apps can still create scenes and download artifacts.

## Connect from ChatGPT web

ChatGPT web needs a reachable HTTPS service; its servers cannot reach your
machine's `127.0.0.1`.

1. Deploy Node and a dedicated Blender process with a shared persistent run
   directory. Put the service behind an HTTPS reverse proxy.
2. Set `HOST=0.0.0.0`, a strong `MCP_API_KEY`, and
   `PUBLIC_BASE_URL=https://YOUR_SERVICE_ORIGIN` in the server environment.
   Forward `Host` and `Authorization` headers through the proxy.
3. Run `npm run configure -- https://YOUR_SERVICE_ORIGIN` to update the packaged
   MCP endpoint.
4. Register the HTTPS MCP connection in the host's custom plugin flow, using an
   authentication method the host supports. Keep the key in connection settings.
5. Test a new chat with an image attachment, then package the configured plugin
   with `npm run pack:plugin`.

The current service provides fixed bearer-key authentication for private
connections. The public submission portal does not accept API-key auth
connections; public-directory submission requires a supported authentication
integration such as OAuth. This release does not implement OAuth, submit to the
public directory, or provision HTTPS hosting. See
[authentication limitations](https://developers.openai.com/plugins/deploy/submission#authentication-limitations).

The viewer declares the service origin in its MCP Apps CSP metadata. Exported
artifacts use scoped URLs and CORS so the sandbox can load GLB, PNG, and EXR files.
Set `WIDGET_DOMAIN` only when your deployment has a dedicated UI origin.

## Use the plugin

Example request:

> Create a Blender scene matching this image. Preserve the camera composition,
> lighting and main objects, then show the interactive 3D result.

The bundled Skill guides the host through:

| Tool | Result |
| --- | --- |
| `scene_create` | Empty scene, optional reference image, asynchronous job ID |
| `scene_plan` | Frozen criteria, implementation steps and visual threshold |
| `scene_edit` | Checkpoint, execute Python, save and render |
| `scene_get` | Job status, reference image, latest render and object summary |
| `scene_review` | Evidence record, best checkpoint and convergence decision |
| `scene_export` | Best `.blend`, GLB, render profile and optional world EXR |
| `scene_view` | Embedded viewer with progress, orbit controls and downloads |
| `scene_continue` | New user-requested refinement on the same scene |

Long Blender operations return immediately. The host polls `scene_get`; the
widget polls `scene_view` for displayed jobs. The host must inspect the render
before reviewing it. The service does not judge images or generate Python.

The service enforces planning → editing → review, saves checkpoints before
edits, and restores failed edits. It allows 5 regular edit attempts, extending to
8 if the fifth review improves the best result and identifies repairable gaps.
Two consecutive non-improvements stop the request. Best-checkpoint ranking
uses unmet blockers, unmet major criteria, regressions, then the host's visual
score. Scores are judgments, not measured image-similarity metrics.

The viewer preserves the exported camera and aspect ratio, reconstructs lights,
loads EXR environments, applies AgX where configured, adds contact shadows, and
calibrates channel color statistics against the reviewed render at the initial
camera. This adjustment does not reproduce Blender's full lighting algorithm.
WebGL lighting, procedural shaders, volumes and compositing can differ from
Blender's renderer. The PNG remains the visual review evidence.

## Instructions and optional agents

`skills/blender-scene/SKILL.md` is the reusable host workflow.
`skills/blender-setup/SKILL.md` provides onboarding.
`AGENTS.md` applies when this repository is the agent's working directory; it is
not installed as global ChatGPT instructions.

Optional role templates are in `codex/agents/`. To register them in a Codex
project, copy them into that project's `.codex/agents/`. The coordinator can then
delegate sequentially to a builder and reviewer when the host supports subagents
and the user authorizes them. These prompts do not impose tool ACLs or create a
separate orchestrator. Portable plugin installation does not automatically load
the agent TOML files. See
[host orchestration](skills/blender-scene/references/orchestration.md).

## Configuration and access

See [.env.example](.env.example) for service, bridge and origin settings.
`FILE_DOWNLOAD_HOSTS` lists approved HTTPS reference-download domains. Default
entries allow those domains and their subdomains on port 443; an explicit
`hostname:port` entry permits only that exact host and port. Downloads revalidate
redirects, reject unsupported image signatures, and enforce a 20 MB limit.

This release serves one trusted operator and serializes all Blender operations.
`scene_edit` intentionally executes Python with Blender's OS permissions. Use a
dedicated account or container for hosted execution. The bridge listens on
localhost only. A bearer key is required when binding the HTTP service remotely.
Artifact links grant access to the files they expose; share them with intended
recipients only. The package excludes credentials and runtime files.

Scene metadata and reviewed checkpoints survive service restarts. Interrupted
edits restore the saved pre-edit checkpoint; interrupted jobs are reported as
failed. A disconnected or timed-out Blender operation may still be executing.
If recovery fails, stop and restart the dedicated bridge and service before
continuing. There is no multi-tenant isolation, job cancellation or process
supervisor in this release.

## Verify and package

```bash
npm run check
npm run build
npm test
npm run test:blender
```

The Blender integration check starts and stops its own bridge and HTTP service
on separate ports. It saves evidence outside the repository and prints
`evidenceDirectory`. Set `BLENDER_BIN` when Blender is installed elsewhere.

To verify the viewer with a sandboxed iframe and the official MCP AppBridge:

```bash
npx playwright install chromium
npm run test:viewer -- /path/printed/as/evidenceDirectory
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects an existing Chromium binary.
The iframe check uses the integration scene and a local test host; it does not
prove installation inside a user's ChatGPT account.

Create a distributable ZIP after building:

```bash
npm run pack:plugin
```

The archive is written to `../CodexBlenderPlugin.zip`. It contains the built
viewer and plugin source, excluding `.git`, `node_modules`, `.env` and `.canova`.
The source repository builds the viewer during setup.

See [validation results](docs/validation.md) for release checks and untested
deployment steps.

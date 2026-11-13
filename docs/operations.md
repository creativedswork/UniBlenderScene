# Service setup and deployment

This page is for people running the Blender MCP service or packaging the plugin.
The [README](../README.md) covers the plugin and its scene workflow.

## Install the plugin source

### Codex

The repository contains `plugin.json`, `mcp.json`, and a marketplace definition
at `.agents/plugins/marketplace.json`. Add this repository as a plugin source:

```bash
codex plugin marketplace add creativedswork/CodexBlenderPlugin --ref main
```

If you already cloned the repository, you can add its absolute path instead:

```bash
codex plugin marketplace add /absolute/path/to/UniBlenderScene
```

Install **UniBlenderScene** from the **UniBlenderScene** source in the Plugins
Directory. The bundled `mcp.json` points to `http://127.0.0.1:4312/mcp`; install
does not start the service. A private repository requires GitHub access.

### Claude Code

For scene production, use a work directory outside the plugin checkout and its
subdirectories. Keep the checkout as the service and plugin source. This avoids
loading its contributor instructions into the scene project; using the same
directory is supported, but is useful primarily when developing the plugin.

Start the dedicated bridge and service using [the service setup](#run-the-local-service),
then open a scene project in another terminal. For a session-local plugin, pass
the plugin's absolute root path, not `.claude-plugin/`:

```bash
mkdir -p ../SceneProjects/bedroom
cd ../SceneProjects/bedroom
claude --plugin-dir /absolute/path/to/UniBlenderScene
```

The `mkdir` and `cd` commands above assume the shell starts at the plugin
checkout. For persistent installation, run these commands inside Claude Code in
the scene project:

```text
/plugin marketplace add /absolute/path/to/UniBlenderScene
/plugin install uni-blender-scene@uni-blender-scene
```

Invoke `/uni-blender-scene:blender-setup` for setup or
`/uni-blender-scene:blender-scene` to create a scene. The native manifest uses
`harnesses/claude-code/mcp.json` with Claude's `http` transport; root `mcp.json`
uses the portable `streamable-http` transport. Both connect to the same service
and load the shared root `skills/`. No model is pinned in the plugin.
See the official [Claude plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
and [portable plugin packaging](https://developers.openai.com/plugins/build/plugins).

Claude loads `CLAUDE.md` from the working directory and its parent directories.
The checkout's `CLAUDE.md` imports contributor rules from `AGENTS.md`; running in
a checkout subdirectory also inherits them. Loading this directory as a plugin
loads its Skills and MCP configuration separately from project instructions.

Add a `CLAUDE.md` to the scene project with its production scope:

```markdown
# Scene production

Use UniBlenderScene's Skills and native scene_* MCP tools for scene operations.
Before scene work, confirm the MCP connection and available scene tools. If they
are missing or fail, report the failing tool and error; do not substitute an ad
hoc HTTP client or modify plugin source unless the user requests that work.
For an existing scene, read scene_view and preserve its state, budget and paths.
Keep local notes under .canova/runs/; use the service's scene input directory for
assets. Follow the scene Skill's review and approval requirements.
```

Use `/mcp` to check the service connection before requesting a scene. Loading the
plugin does not start the HTTP service or Blender. A healthy connection does not
prove that a scene job will succeed; scene tool failures still need diagnosis.

## Validate Claude Code with TTADK

From the repository root, validate both native manifests:

```bash
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
```

Start the service as described below, then launch an interactive session from
the separate scene project:

```bash
ttadk claude -m gpt-6.1-sol -- --plugin-dir /absolute/path/to/UniBlenderScene
```

`-m` selects the TTADK model; arguments after `--` go to Claude Code. For the
isolated render/export smoke test, return to the plugin checkout and run:

```bash
npm run test:claude
```

The test starts its own Blender bridge and service, loads a temporary copy of
the native plugin, and runs TTADK with `gpt-6.1-sol`. It retains logs and scene
artifacts under `.canova/runs/` and stops its child processes afterward. It
checks plugin/Skill discovery, MCP tool calls, rendered output, and GLB export.
It is an integration test run from the checkout, not the production workspace
layout described above.
This requires a working TTADK login and access to `gpt-6.1-sol` for Claude Code.

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
  --background --factory-startup --python runtime/blender/bridge.py -- --port 9877
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

### Start the local processes together

After installing dependencies and building the viewer, run this from the plugin
checkout to start a dedicated Blender bridge and the local MCP service:

```bash
node --import tsx scripts/start-local.ts
```

This launcher requires `lsof` and `ps`. It binds the service to `127.0.0.1` with
the unauthenticated connection used by the bundled local plugin manifest. It
uses `RUNS_ROOT` when supplied; set it to the existing scene's parent directory
when resuming a scene. Optionally set `SCENE_ID` to require that scene to be
readable before startup reports success. It checks HTTP health and MCP tool
discovery without submitting scene creation or edit jobs.

Logs and PID files are stored in `RUNS_ROOT/.service/`. Repeated launches reuse
only processes recorded there whose listener PID and command match. An occupied
port belonging to another process is reported without stopping that process.
Startup failures stop only the processes created by that launch. Successful
processes remain running after the launcher or Claude exits. This launcher is
for local use; use the separate authenticated deployment procedure for a remote
service.

## Open the interactive preview

Use `scene_view` in a client that supports MCP Apps and WebGL 2. The tool's
embedded viewer includes the Scene Graph, orbit controls, render/3D switching,
and composition review controls. For geometry/composition work or a scene in `awaiting_review`, first call
`scene_preview` with its `sceneId` and poll `scene_view` until the job finishes.
This prepares review assets without approving composition or enabling final
export. Completed scenes use `scene_export` before opening the viewer.

Version 0.3.3 selects presentation from the per-scene `workflowState`. `phase`
names the production stage and `status` names the operation state. During
geometry/composition, edits automatically produce gray work images and
`scene_preview` can generate the current iteration's five views and GLB even
when geometry checks have not passed. These remain work drafts: no approval or
final export is allowed. During `awaiting_review`, the source becomes the
preserved composition checkpoint. This state is reconstructed from persisted
scene fields on restart, independently for every scene.

The service displays neutral gray structural evidence during those phases:
`scene_get`, the main image, five review views and the interactive review GLB.
Only the preview copy receives material and studio-light overrides. Original
materials, lights and source `.blend` files remain available for later stages;
final exports retain the reviewed appearance. Checkpoint/final `.blend` downloads
therefore still contain their materials; work drafts expose only preview assets.
Preview manifests name the gray review
image rather than the colored render.

After updating the service and plugin, call `scene_preview` again for an existing
working or pending scene. Old, wrong-source or wrong-iteration preview caches are not advertised and are rebuilt
with structural shading. If the five review views are missing, run
`scene_review_views` first. Approval and stage budgets are preserved.

Chrome can display the viewer when a browser MCP Apps host connects it to the
service. The service URL `http://127.0.0.1:4312/mcp` is a protocol endpoint, not
a preview page. This package does not start a standalone browser host or assign
a browser preview URL. The README screenshot was checked in a local session
host; that temporary address is not a deployment endpoint.

In a terminal harness without MCP Apps, use `scene_get` with `images: "render"` for new render evidence and
return the signed render, `.blend`, and GLB artifact URLs. Composition decisions
still go through `scene_review_decision` after the user's explicit approval.
Do not report interactive viewer checks as passed from a CLI export alone.

Review assets are stored under `previews/<iteration>/` inside the scene run;
final exports use `artifacts/<iteration>/`. Both include the GLB, render profile,
Scene Graph, and manifest. Keep these runtime files outside Git.

## Image history and recovery

Version 0.3.1 adds image selection to `scene_get`. Use `images: "references"`
once before planning, `images: "render"` once per new render, and `images: "none"`
for state-only reads. Existing calls that omit `images` still return all
references and the render. Image selection does not change review requirements,
scene state, checkpoints, or iteration budgets. The MCP Apps viewer and artifact
URLs continue to expose the stored images independently of these tool responses.

The observed TTADK GPT route rejects requests containing more than 50 images.
Repeated `Read`, screenshot, Provider and MCP image results can accumulate in
conversation history. The shared Skill asks the host to count all of them and
write a text handoff around 35 images. These instructions reduce unnecessary
images but cannot guarantee that every harness prunes its history.

Before clearing a long conversation, keep the scene ID and save a handoff under
`.canova/runs/<scene-id>/handoff.md` with the stage/iteration, frozen plan,
reference labels, local image paths, observed differences, approval state and
next action. Exclude credentials and signed URLs. If compaction does not remove
old image blocks, use `/clear` or a fresh Claude Code conversation, read the
handoff and `scene_view`, and load only the evidence needed for the next step.
Keep the same scene ID and pending approval. `scene_continue` begins a new user
refinement; it is not required to resume an unfinished scene in a new chat.

Restarting the CLI with the same history or resizing the images does not reduce
their count. Updating the plugin does not remove images already in a conversation.

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

This updates both root `mcp.json` and `harnesses/claude-code/mcp.json`.
Keep the key in connection settings, outside manifests. The service supports
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

The optional templates in [`harnesses/codex/agents/`](../harnesses/codex/agents/) can be copied into
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

The ZIP is written to `../UniBlenderScene.zip`. It excludes `.git`,
`node_modules`, `.env`, and `.canova`. See the [validation results](validation.md)
for checks performed on this release.

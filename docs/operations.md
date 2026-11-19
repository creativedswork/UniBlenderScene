# Service setup and deployment

This page is for people running the Blender MCP service or packaging the plugin.
The [README](../README.md) covers the plugin and its scene workflow.

## Install the plugin source

### Codex

Extract the release ZIP and add the extracted directory as a plugin source.
The ZIP includes the built viewer and Node dependencies for macOS and Linux
on arm64 and x64. Install Node.js 22+ and Blender 4.5+ on the machine running Codex.
For a source checkout, run `npm ci` and `npm run build` before adding it as a
local marketplace.

```bash
codex plugin marketplace add /absolute/path/to/UniBlenderScene
codex plugin add uni-blender-scene@uni-blender-scene
```

Open a local Codex chat. Codex launches the plugin's stdio entry when it
connects to MCP, and the entry starts or reuses one local HTTP service and its
dedicated Blender bridge. Connected clients share the task queue. Closing a
chat leaves submitted jobs running. After ten minutes without requests or
queued Blender work, the service exits and stops its bridge. The next Codex
tool call can start them again.

The launcher keeps scene data in `~/.canova/runs` by default. Set `RUNS_ROOT`
in `~/.canova/.env` to use an existing absolute run directory. That file also
supports `BLENDER_BIN`, `LOCAL_REFERENCE_ROOTS`, `THREERT_BIN`, `PORT` (default
4312) and `BLENDER_MCP_PORT` (default 9877). The launcher uses loopback port
4311 to serialize startup. It keeps logs and a versioned runtime copy under
`RUNS_ROOT/.service/` so a Codex update can remove the old plugin files while
the old service finishes its work.

When upgrading from a manually started release, first let its jobs finish and
stop the old MCP service and dedicated bridge. Then reconnect Codex with the
original `RUNS_ROOT`. Later plugin-managed upgrades wait for work accepted
by the older service to finish before the new version opens the same scene
directory. If Codex times out while waiting, reconnect after the old service
stops.

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
`harnesses/claude-code/mcp.json` with Claude's `http` transport. It can reach
the same running service as Codex. Start the service manually for a
Claude-only workflow. Both clients load the shared root `skills/`.
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
For an existing scene, read scene_get with images=none and preserve its state, budget and paths.
Keep local notes under .canova/runs/; use the service's scene input directory for
assets. Follow the scene Skill's review and approval requirements.
```

Use `/mcp` to check the service connection before requesting a scene. Loading the
plugin does not start the HTTP service or Blender. A healthy connection does not
prove that a scene job will succeed; scene tool failures still need diagnosis.

## Validate Claude Code

From the repository root, validate both native manifests:

```bash
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
```

Start the service as described below, then launch an interactive session from
the separate scene project:

```bash
claude --plugin-dir /absolute/path/to/UniBlenderScene
```

Install and authenticate the official Claude Code CLI using its
[setup instructions](https://code.claude.com/docs/en/setup).
Use the configured model or select an available Claude model with `--model sonnet`
or `/model`; see the official [model configuration](https://code.claude.com/docs/en/model-config)
and [CLI reference](https://code.claude.com/docs/en/cli-reference).
For the isolated render/export smoke test, return to the plugin checkout and run:

```bash
npm run test:claude
```

The test starts its own Blender bridge and service, loads a temporary copy of
the native plugin, and directly runs `claude --model sonnet` in print mode.
Set `CLAUDE_BIN` to use another Claude Code executable or `CLAUDE_MODEL` to select
an available Claude model alias or full model ID. It retains logs and scene
artifacts under `.canova/runs/` and stops its child processes afterward. It
checks plugin/Skill discovery, MCP tool calls, rendered output, and GLB export.
It is an integration test run from the checkout, not the production workspace
layout described above.
This requires a working Claude Code login or supported API authentication and
access to the selected model. The smoke test makes model requests and uses
`--max-budget-usd 3` to cap estimated API spend.

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
readable before startup reports success. It checks HTTP health, the full MCP
tool catalog, homogeneous array schemas, and agreement between the checkout,
MCP initialization and health versions without submitting scene creation or edit jobs.
Startup fails with the affected tool/field or version mismatch instead of reporting
ready for an incompatible service. Reused processes undergo the same checks.

Logs and PID files are stored in `RUNS_ROOT/.service/`. Repeated launches reuse
only processes recorded there whose listener PID and command match. An occupied
port belonging to another process is reported without stopping that process.
Startup failures stop only the processes created by that launch. Successful
processes remain running after the launcher or Claude exits. This launcher is
for local use; use the separate authenticated deployment procedure for a remote
service.

The host must also expose the workflow tools before scene creation. If
`scene_plan`, `scene_review` and `scene_export` are absent while other tools are
available, run the launcher against the service checkout: older tuple-style
array schemas can prevent those three tools from loading in the host. After
fixing the reported problem, restart the owned MCP service when it has no active
scene jobs, preserve `RUNS_ROOT`, and refresh the host's MCP connection or start
a new chat. Verify the host tool list before resuming the saved scene with
`scene_get` and `images: "none"`. A passing server check alone does not prove the
host has loaded the tools.

## Open the interactive preview

Poll progress with `scene_get` and `images: "none"`. Only call `scene_view`
when its snapshot has a non-null `renderUrl`, in a client that supports MCP Apps.
Three.js structural review requires WebGL 2. Creation, edits and polling return data without opening a viewer. The `scene_view`
embedded viewer includes the Scene Graph, orbit controls, render/3D switching,
composition review images, downloads, and GLB preview statistics. The statistics
count mesh instances, vertices, triangles, and unique materials in the loaded GLB.
Send approval or requested changes in the conversation; the host records the
user's decision through `scene_review_decision`. Completed, exported scenes default to native
ThreeRT when its client is available; structural review uses Three.js. A manual
backend choice is retained during scene updates. See the
[ThreeRT setup and limits](#threert-setup-and-limits).
For geometry/composition work or a scene in `awaiting_review`, first call
`scene_preview` with its `sceneId` and poll `scene_get` with `images: "none"` until the job finishes.
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

### ThreeRT setup and limits

To enable native interaction, install the [ThreeRT native client](https://threert.dev/download/),
set `THREERT_BIN` to its `threert` executable in the service environment, and
restart the service. No native engine is bundled. ThreeRT runs on the service
host and may differ visually from Blender; delivered frame rate is shown in
the viewer. The standalone `threert-render` executable supports static rendering
only.

### Static lighting bakes and browser rendering

After final scene review, call `scene_bake` with `lightingBakes` entries naming
each receiver (`objectName`), `samples` (16–1024, default 128), and `resolution`
(64–4096, default 512). The new tool defaults to `mode: "lightmap"`. Poll
`scene_get` until the job completes, then call `scene_export` to package the result.
These bakes preserve PBR materials and source UVs, add a separate UV channel,
and export `lightmap-*.png` files alongside the GLB and render profile. The
bundled viewer uses raster rendering for these exports, so camera movement
does not restart progressive sampling. Keep the profile and lightmaps with the
GLB; a standalone GLB viewer will not apply these lightmaps.

Baking prepares a separate scene copy without changing the reviewed checkpoint
or its workflow stage. Results are cached by source file content, bake settings
and bake script version under `.canova/runs/<scene>/postprocess/bakes/<id>/`.
Changing only preview appearance reuses the prepared copy. The existing
`scene_export.lightingBakes` argument remains supported and prepares missing
results automatically; its omitted `mode` retains legacy appearance baking.
On `scene_bake`, omitted `lightingBakes` reuses the active selection; `[]`
clears explicit receivers (source object bake flags still apply).

The implementation follows the existing service/runtime/viewer boundaries:

```text
src/service/postprocess.ts             # bake settings, provenance and cache
src/service/store.ts                   # scene_bake job and scene lifecycle
runtime/blender/postprocess/bake.py     # prepare UVs, textures and scene copy
runtime/blender/export.py              # package the prepared scene
src/viewer/lighting.ts                 # apply lightmaps and reflection captures
```

Offline baking belongs to asset preparation. Bloom, exposure and real-time
reflections remain viewer operations; they do not rerun the bake.

Set `previewAppearance.planarReflection` to the name of a horizontal receiver
mesh to add one real-time planar reflection, such as a wet road. Reflection is
an approximation: the receiver retains its PBR material, while other reflective
objects use the environment map. Set `previewAppearance.reflectionProbe` to a
Blender Z-up `[x, y, z]` position to capture the static surroundings once for
those materials. The capture uses the full light rig; subsequent raster passes
retain the 12 local lights with the largest estimated contribution at the
initial camera, plus directional lights. Bloom and atmospheric preview effects remain
active. `previewAppearance.renderMode: "raster"` also enables this rendering
mode without lightmaps. Existing appearance bakes and unbaked path-traced
exports remain supported. ThreeRT exports use the source materials.

## Image history and recovery

Version 0.3.1 adds image selection to `scene_get`. Use `images: "references"`
once before planning, `images: "render"` once per new render, and `images: "none"`
for state-only reads. Existing calls that omit `images` still return all
references and the render. Image selection does not change review requirements,
scene state, checkpoints, or iteration budgets. The MCP Apps viewer and artifact
URLs continue to expose the stored images independently of these tool responses.

Repeated `Read`, screenshot, Provider and MCP image results can accumulate in
conversation history. Limits depend on the active model and provider. The shared
Skill asks the host to count all images and leave room for the next review batch.
When the limit is unknown, write a text handoff around 35 images as a conservative
workflow checkpoint; this is not a stated Claude Code limit. These instructions
reduce unnecessary images but cannot guarantee that every harness prunes its history.

Before clearing a long conversation, keep the scene ID and save a handoff under
`.canova/runs/<scene-id>/handoff.md` with the stage/iteration, frozen plan,
reference labels, local image paths, observed differences, approval state and
next action. Exclude credentials and signed URLs. If compaction does not remove
old image blocks, use `/clear` or a fresh Claude Code conversation, read the
handoff and `scene_get` with `images: "none"`, and load only the evidence needed for the next step.
Keep the same scene ID and pending approval. `scene_continue` begins a new user
refinement; it is not required to resume an unfinished scene in a new chat.

Restarting the CLI with the same history or resizing the images does not reduce
their count. Updating the plugin does not remove images already in a conversation.

## Connect a remote service

A remote plugin connection needs a reachable HTTPS service. The desktop
launcher runs its backend on loopback for clients on the same machine. Run Node and a
dedicated Blender process with a shared persistent run directory behind an HTTPS
reverse proxy. Set `HOST=0.0.0.0`, `MCP_API_KEY`, and
`PUBLIC_BASE_URL=https://YOUR_SERVICE_ORIGIN`; forward `Host` and
`Authorization` through the proxy. Then update the packaged endpoint:

```bash
npm run configure -- https://YOUR_SERVICE_ORIGIN
```

This switches root `mcp.json` to the remote HTTP transport and updates
`harnesses/claude-code/mcp.json` to the same endpoint.
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
service before resuming. Run each deployment for a single trusted operator.

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

The ZIP is written to `../UniBlenderScene.zip`. It includes the built viewer and
production Node dependencies. The packaging step excludes `.git`, local
environment files, and `.canova`.

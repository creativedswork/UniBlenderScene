# Quick start for agents

Set up UniBlenderScene locally on macOS or Linux for the user's current agent
host, then prepare a separate scene project. Execute the setup steps below;
ask the user to act only when login, installation UI, or a new chat requires it.
Respond in the user's language.

## 1. Locate the plugin and check dependencies

For desktop Codex, extract the release ZIP into a local directory. For a
source installation, reuse an existing UniBlenderScene checkout or clone it:

```bash
git clone https://github.com/creativedswork/UniBlenderScene.git
cd UniBlenderScene
```

The plugin root contains `plugin.json`, `mcp.json`, `skills/`, and
`.agents/plugins/marketplace.json`. Read the
[setup Skill](../skills/blender-setup/SKILL.md) before continuing. Run installation,
build, and startup commands from this root.

Check the following dependencies. Install missing dependencies using the linked
platform instructions when the host permits; if user action is needed, report
the missing dependency and the exact next step.

| Dependency | Check and installation reference |
| --- | --- |
| Node.js 22+ and npm | `node --version` and `npm --version`; [Node.js downloads](https://nodejs.org/en/download). |
| Blender 4.5+ | On macOS, run `"/Applications/Blender.app/Contents/MacOS/Blender" --version`; see [macOS installation](https://docs.blender.org/manual/en/latest/getting_started/installing/macos.html). On Linux, run `blender --version` or the extracted executable's absolute path; see [Linux installation](https://docs.blender.org/manual/en/latest/getting_started/installing/linux.html). |
| Git | `git --version`. |
| Agent host | Check `codex --version` or `claude --version` for the current host and confirm the user is signed in. |
| `lsof` and `ps` | `command -v lsof` and `command -v ps`; install missing commands with the system package manager. |

On Codex Desktop, the MCP process can inherit a shorter PATH than the terminal.
If plugin startup reports `No such file or directory (os error 2)` on macOS, run
this command from the plugin root. It tests the launcher with a minimal desktop PATH.

```bash
env PATH=/usr/bin:/bin:/usr/sbin:/sbin ./scripts/codex-mcp.sh --version
```

The launcher should print Node.js 22 or later. If it cannot find Node, make
Node available to the desktop process using the search paths in the
[setup Skill](../skills/blender-setup/SKILL.md).

## 2. Prepare the local service

For desktop Codex, prefer the release ZIP with its built viewer and runtime
dependencies. Codex starts the service and dedicated Blender bridge when
connecting to MCP. See [Codex setup](operations.md#codex) for existing scene
directories and optional Blender paths.

For a source checkout, install and build from the plugin root.

```bash
npm ci
npm run build
```

For a Claude-only session or another host using the local HTTP URL, start the
service with `node --import tsx scripts/start-local.ts` and wait for the
`Ready` message. See [launcher behavior and logs](operations.md#start-the-local-processes-together)
for manual startup and configuration.

## 3. Connect the current host

Create a scene project outside the plugin checkout and its subdirectories,
reusing an existing scene project when appropriate:

```bash
mkdir -p ../UniBlenderScenes
```

- **Codex:** from the plugin root, run `codex plugin marketplace add "$PWD"`.
  Install it with `codex plugin add uni-blender-scene@uni-blender-scene`.
  Open the separate scene directory as a project and start a new local chat.
  Use the chat's MCP tool discovery to verify that UniBlenderScene exposes
  `scene_get` and `scene_view` before starting production.
- **Claude Code:** from the scene project, launch
  `claude --plugin-dir /absolute/path/to/UniBlenderScene`, using the actual plugin
  root. Check `/mcp` for the connection and available `scene_*` tools. For
  persistent installation, follow [Claude Code setup](operations.md#claude-code).
- **Other hosts or remote services:** follow
  [service setup and deployment](operations.md) for the host's connection and
  authentication requirements.

Report the plugin root, scene project, service URL, and connection checks actually
performed. The launcher's health and tool discovery checks do not prove Blender
scene execution; the first completed `scene_create` job verifies that connection.
If scene tools are missing or fail, report the error and diagnose the setup using
the setup Skill rather than substituting an ad hoc HTTP client.

## 4. Hand off the first scene

Once the plugin is loaded in the scene project, use the user's scene request.
If they only asked for setup, provide this starter prompt:

> Use UniBlenderScene to create a simple room with a floor, two walls, a cube
> pedestal and a sphere on top. Use procedural primitives and warm lighting.
> Pause for my composition approval, then deliver a render, an editable .blend
> file and a GLB. Open the interactive preview if this host supports it.

Follow the [scene Skill](../skills/blender-scene/SKILL.md) for scene work, including
the user's composition approval before materials and lighting. Interactive
preview requires an MCP Apps host. Once export completes and `scene_get` returns
a non-null `renderUrl`, call `scene_view` through the chat's MCP connection and
verify that the interactive 3D preview appears in the chat.

For optional asset providers, reference images, ThreeRT, or remote deployment,
read the relevant sections of [service setup and deployment](operations.md) and
the [asset workflow](../skills/blender-scene/references/assets.md) as needed.

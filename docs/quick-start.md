# Quick start for agents

Set up UniBlenderScene locally on macOS or Linux for the user's current agent
host, then prepare a separate scene project. Execute the setup steps below;
ask the user to act only when login, installation UI, or a new chat requires it.
Respond in the user's language.

## 1. Locate the plugin and check dependencies

Reuse an existing UniBlenderScene checkout when available. Otherwise, clone it
into a suitable local directory:

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

## 2. Build and start the local service

```bash
npm ci
npm run build
node --import tsx scripts/start-local.ts
```

The launcher starts an installed Blender and the MCP service; it does not install
dependencies. For a non-default Blender location, use
`BLENDER_BIN="/absolute/path/to/blender" node --import tsx scripts/start-local.ts`.
Wait for `Ready: http://127.0.0.1:4312/mcp (...)`. The processes remain running
after the launcher exits. On later runs, reuse the launcher; it reuses its own
running processes. See [launcher behavior and logs](operations.md#start-the-local-processes-together)
if startup fails. Do not attach to the user's working Blender process.

## 3. Connect the current host

Create a scene project outside the plugin checkout and its subdirectories,
reusing an existing scene project when appropriate:

```bash
mkdir -p ../UniBlenderScenes
```

- **Codex:** from the plugin root, run `codex plugin marketplace add "$PWD"`.
  Install **UniBlenderScene** from the **UniBlenderScene** source in the Plugins
  Directory. Complete the UI step if tools permit; otherwise ask the user to
  install it. Open the separate scene directory as a project and start a new
  chat to load the plugin.
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
preview requires an MCP Apps host.

For optional asset providers, reference images, ThreeRT, or remote deployment,
read the relevant sections of [service setup and deployment](operations.md) and
the [asset workflow](../skills/blender-scene/references/assets.md) as needed.

# CodexBlenderPlugin

This repository packages a host-driven Blender workflow. ChatGPT or Codex supplies
the language model, planning, Python generation, visual review, and any authorized
subagent coordination. The MCP service executes Blender operations and enforces
scene state.

- Read `skills/blender-scene/SKILL.md` when creating or refining scenes.
- Keep runtime data under `.canova/runs/`. Never commit generated scenes, secrets,
  environment files, logs, or personal connection settings. Commit a reference
  image only when the user explicitly authorizes it for a named public docs
  showcase; keep other references out of Git.
- Use a dedicated Blender bridge process for this service. Do not attach to a
  user's working scene or bypass `SceneStore` when executing scene code.
- Run `npm run check`, `npm run build`, and `npm test` after code changes.
  Run `npm run test:blender` for changes to Blender execution or export.
- Keep portable plugin metadata in root `plugin.json`, skills in `skills/`, and
  MCP connection declarations in `mcp.json`.
- Keep external 3D asset provider selection in the scene Skill. The service does
  not bundle a provider or its credentials; do not describe optional providers
  as built-in generation capabilities.
- Describe GitHub publication, service deployment, client installation, and plugin
  directory approval as separate states. Report only checks actually performed.

This file applies when the repository is the agent's working directory. The
portable plugin's reusable instructions are the packaged Skills; installing the
plugin does not turn this file into global host instructions.

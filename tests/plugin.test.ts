import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("Codex launches the local package and configure switches both hosts to HTTP", async () => {
  const portable = await json("plugin.json");
  const claude = await json(".claude-plugin/plugin.json");
  const pkg = await json("package.json");
  assert.equal(portable.name, "uni-blender-scene");
  for (const manifest of [claude, pkg]) {
    assert.equal(manifest.name, portable.name);
    assert.equal(manifest.version, portable.version);
  }
  assert.equal((await json(".agents/plugins/marketplace.json")).plugins[0].name, portable.name);
  assert.equal((await json(".claude-plugin/marketplace.json")).plugins[0].name, portable.name);
  assert.equal(claude.skills, undefined, "Claude discovers the shared root skills/ by convention");
  const nativePath = claude.mcpServers.replace(/^\.\//, "");
  const root = await mkdtemp(join(tmpdir(), "uni-blender-plugin-"));
  try {
    for (const path of ["mcp.json", "harnesses"]) await cp(path, join(root, path), { recursive: true });
    const connections = async () => [
      (await json(join(root, "mcp.json"))).mcpServers[portable.name],
      (await json(join(root, nativePath))).mcpServers[portable.name],
    ];
    const before = await connections();
    assert.deepEqual(before.map((server) => server.type), ["stdio", "http"]);
    assert.equal(before[0].command, "node");
    assert.equal(before[0].args.at(-1), "${PLUGIN_ROOT}/scripts/codex-mcp.ts");
    assert.equal(before[1].url, "http://127.0.0.1:4312/mcp");
    const script = resolve("scripts/configure.ts");
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "https://blender.example.test"], { cwd: root });
    const after = await connections();
    assert.deepEqual(after, [
      { type: "streamable-http", url: "https://blender.example.test/mcp" },
      { type: "http", url: "https://blender.example.test/mcp" },
    ]);
    const invalid = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "http://remote.example.test"], { cwd: root });
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(await connections(), after, "Invalid URLs must not alter either harness connection");
  } finally { await rm(root, { recursive: true, force: true }); }
});

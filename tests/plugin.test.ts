import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

function assertRelativePluginPath(value: unknown, field: string): string {
  assert.equal(typeof value, "string", `${field} must be a relative path string`);
  const path = value as string;
  assert.ok(!isAbsolute(path), `${field} must not be an absolute path`);
  assert.ok(!path.split("/").includes(".."), `${field} must not contain parent traversal`);
  return path.replace(/^\.\//, "");
}

test("Codex and Cursor launch the local package and configure switches all harnesses to HTTP", async () => {
  const portable = await json("plugin.json");
  const claude = await json(".claude-plugin/plugin.json");
  const cursor = await json(".cursor-plugin/plugin.json");
  const pkg = await json("package.json");
  assert.equal(portable.name, "uni-blender-scene");
  for (const manifest of [claude, cursor, pkg]) {
    assert.equal(manifest.name, portable.name);
    assert.equal(manifest.version, portable.version);
  }
  assert.equal((await json(".agents/plugins/marketplace.json")).plugins[0].name, portable.name);
  assert.equal((await json(".claude-plugin/marketplace.json")).plugins[0].name, portable.name);
  assert.equal(claude.skills, undefined, "Claude discovers the shared root skills/ by convention");
  assert.equal(cursor.skills, undefined, "Cursor discovers the shared root skills/ by convention");

  const claudeMcpPath = assertRelativePluginPath(claude.mcpServers, "claude.mcpServers");
  const cursorMcpPath = assertRelativePluginPath(cursor.mcpServers, "cursor.mcpServers");
  const cursorRulesPath = assertRelativePluginPath(cursor.rules, "cursor.rules");
  const cursorAgentsPath = assertRelativePluginPath(cursor.agents, "cursor.agents");
  assert.ok((await stat(cursorRulesPath)).isDirectory());
  assert.ok((await stat(cursorAgentsPath)).isDirectory());

  const ruleFiles = (await readdir(cursorRulesPath)).filter((name) => /\.(md|mdc|markdown)$/.test(name));
  assert.ok(ruleFiles.length >= 1, "Cursor rules directory must contain at least one rule file");
  for (const file of ruleFiles) {
    const content = await readFile(join(cursorRulesPath, file), "utf8");
    assert.match(content, /^---\n[\s\S]*?alwaysApply:\s*false[\s\S]*?\n---/,
      `Cursor plugin rule ${file} should set alwaysApply: false to avoid polluting unrelated workspaces`);
  }

  const agentFiles = (await readdir(cursorAgentsPath)).filter((name) => /\.(md|mdc|markdown)$/.test(name)).sort();
  assert.deepEqual(agentFiles, ["blender-builder.md", "blender-reviewer.md"]);
  for (const file of agentFiles) {
    const content = await readFile(join(cursorAgentsPath, file), "utf8");
    const expectedName = file.replace(/\.md$/, "");
    assert.match(content, new RegExp(`^---\\n[\\s\\S]*?name:\\s*${expectedName}\\b[\\s\\S]*?description:\\s*.+[\\s\\S]*?\\n---`));
  }
  assert.match(await readFile(join(cursorAgentsPath, "blender-reviewer.md"), "utf8"), /readonly:\s*true/);

  const root = await mkdtemp(join(tmpdir(), "uni-blender-plugin-"));
  try {
    for (const path of ["mcp.json", "harnesses"]) await cp(path, join(root, path), { recursive: true });
    const connections = async () => [
      (await json(join(root, "mcp.json"))).mcpServers[portable.name],
      (await json(join(root, claudeMcpPath))).mcpServers[portable.name],
      (await json(join(root, cursorMcpPath))).mcpServers[portable.name],
    ];
    const before = await connections();
    assert.deepEqual(before.map((server) => server.type), ["stdio", "http", "stdio"]);
    assert.equal(before[0].command, "./scripts/codex-mcp.sh");
    assert.equal(before[0].args.at(-1), "${PLUGIN_ROOT}/scripts/codex-mcp.ts");
    assert.equal(execFileSync(resolve(before[0].command), ["--version"], {
      encoding: "utf8", env: { PATH: dirname(process.execPath) },
    }).trim(), process.version);
    assert.equal(before[1].url, "http://127.0.0.1:4312/mcp");

    assert.equal(before[2].command, "${CURSOR_PLUGIN_ROOT}/scripts/codex-mcp.sh");
    assert.equal(before[2].cwd, "${CURSOR_PLUGIN_ROOT}");
    assert.deepEqual(before[2].args, [
      "--import",
      "${CURSOR_PLUGIN_ROOT}/node_modules/tsx/dist/loader.mjs",
      "${CURSOR_PLUGIN_ROOT}/scripts/codex-mcp.ts",
    ]);
    assert.ok(!JSON.stringify(before[2]).includes("${PLUGIN_ROOT}"),
      "Cursor does not expand ${PLUGIN_ROOT}; use ${CURSOR_PLUGIN_ROOT}");
    const resolvedCursorCommand = before[2].command.replace("${CURSOR_PLUGIN_ROOT}", resolve("."));
    assert.equal(execFileSync(resolvedCursorCommand, ["--version"], {
      encoding: "utf8", env: { PATH: dirname(process.execPath) },
    }).trim(), process.version);

    const script = resolve("scripts/configure.ts");
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "https://blender.example.test"], { cwd: root });
    const after = await connections();
    assert.deepEqual(after, [
      { type: "streamable-http", url: "https://blender.example.test/mcp" },
      { type: "http", url: "https://blender.example.test/mcp" },
      { url: "https://blender.example.test/mcp" },
    ]);
    const invalid = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "http://remote.example.test"], { cwd: root });
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(await connections(), after, "Invalid URLs must not alter any harness connection");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared root skills satisfy Cursor and Agent Skills frontmatter rules", async () => {
  const entries = await readdir("skills", { withFileTypes: true });
  let skillCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join("skills", entry.name, "SKILL.md");
    const content = await readFile(skillPath, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    skillCount++;
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, `${skillPath} must start with YAML frontmatter`);
    const nameMatch = frontmatter[1]!.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
    const descMatch = frontmatter[1]!.match(/^description:\s*["']?([^"'\n]+?)["']?\s*$/m);
    assert.equal(nameMatch?.[1], entry.name, `${skillPath} frontmatter name must match directory name`);
    assert.match(entry.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(entry.name.length <= 64, `${skillPath} name must be <= 64 chars`);
    assert.ok(descMatch?.[1] && descMatch[1].length <= 1024, `${skillPath} description must be present and <= 1024 chars`);
  }
  assert.ok(skillCount >= 20, `Expected packaged skills in skills/, found ${skillCount}`);
});

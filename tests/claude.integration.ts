import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const project = resolve(".");
await mkdir(".canova/runs", { recursive: true });
const root = await mkdtemp(resolve(".canova/runs/claude-integration-"));
const plugin = join(root, "plugin");
const runs = join(root, "scenes");
const children: ChildProcess[] = [];
const logs = new Map<string, string>();
async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
function launch(name: string, command: string, args: string[], options = {}) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", ...options });
  children.push(child); logs.set(name, "");
  child.on("error", (error) => { logs.set(name, logs.get(name)! + error.message); });
  for (const stream of [child.stdout, child.stderr]) stream!.on("data", (chunk) => {
    logs.set(name, logs.get(name)! + chunk.toString());
    appendFileSync(join(root, `${name}.log`), chunk);
  });
  return child;
}
function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function ready(name: string, child: ChildProcess, marker: string) {
  const deadline = Date.now() + 60000;
  while (!logs.get(name)!.includes(marker)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`${name} failed to start. See ${root}/${name}.log`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
const timeout = setTimeout(() => {
  for (const child of children) terminate(child, "SIGTERM");
}, 15 * 60 * 1000);
try {
  for (const path of [".claude-plugin", "harnesses/claude-code", "skills"])
    await cp(path, join(plugin, path), { recursive: true });
  await cp("tests/scene.py", join(root, "scene.py"));
  const blenderPort = await freePort(), port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const nativePath = join(plugin, "harnesses/claude-code/mcp.json");
  const connection = JSON.parse(await readFile(nativePath, "utf8"));
  connection.mcpServers["uni-blender-scene"].url = `${origin}/mcp`;
  await writeFile(nativePath, JSON.stringify(connection));
  const binary = process.env.BLENDER_BIN ?? (process.platform === "darwin" ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender");
  const blender = launch("blender", binary, ["--background", "--factory-startup", "--python", resolve("runtime/blender/bridge.py"), "--", "--port", String(blenderPort)]);
  const server = launch("service", process.execPath, ["--import", "tsx", "src/service/server.ts"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_BASE_URL: origin,
      MCP_API_KEY: "", BLENDER_MCP_PORT: String(blenderPort), RUNS_ROOT: runs },
  });
  await ready("blender", blender, "bridge ready");
  await ready("service", server, "MCP listening");
  const prompt = `Use /uni-blender-scene:blender-scene for a small primitive smoke test: a red cube on a lit floor. This is not a full reconstruction and has no reference images. For scene_create, set prompt to exactly "A red cube on a warm floor under studio lighting." Keep test instructions out of that scene prompt. Use a simple non-staged plan, one criterion for a visible red cube, visualThreshold 70, and graph node cube mapped to RedCube. Classify cube as structure because it is a simple geometric primitive. Read ${join(root, "scene.py")} and submit that complete code through scene_edit. Use only the plugin's scene_* tools for scene operations, never execute Blender directly. Pass all four graph verification checks before editing. Poll scene_view for asynchronous jobs, use scene_get with images=none for metadata and images=render once to inspect the actual PNG before scene_review; always select images explicitly and do not reread the render through Read, bind inspection.id, record honest evidence, then export if completed/best_effort. Return render and artifact links and state that the CLI does not verify the interactive MCP Apps viewer. Do not use subagents, external asset providers, edit repository files, or approve a composition checkpoint. If image inspection or any required tool fails, report the failure instead of claiming success.`;
  await writeFile(join(root, "prompt.txt"), prompt);
  const claude = launch("claude", process.env.TTADK_BIN ?? "ttadk", [
    "claude", "-m", "gpt-6.1-sol", "--", "-p", "--plugin-dir", plugin,
    "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--effort", "low",
    "--permission-mode", "dontAsk", "--tools", "Read,Skill",
    "--allowedTools", "Read,Skill,mcp__plugin_uni-blender-scene_uni-blender-scene__*",
    "--setting-sources", "", "--max-budget-usd", "3",
  ], { cwd: root, env: { ...process.env, TTADK_MODEL_FETCH_TIMEOUT: process.env.TTADK_MODEL_FETCH_TIMEOUT ?? "15000" } });
  const code = await new Promise<number | null>((done, fail) => {
    claude.once("exit", done); claude.once("error", fail);
    claude.stdin!.end(prompt);
  });
  assert.equal(code, 0, `TTADK Claude failed; see ${root}/claude.log`);
  const events = logs.get("claude")!.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  assert.equal(init?.model, "gpt-6.1-sol");
  assert.ok(init.plugins?.some((entry: { name: string }) => entry.name === "uni-blender-scene"));
  assert.ok(init.skills?.some((name: string) => name.includes("blender-scene")));
  const calls = events.flatMap((event) => event.message?.content ?? []).filter((block) => block.type === "tool_use");
  for (const tool of ["scene_create", "scene_plan", "scene_plan_review", "scene_edit", "scene_get", "scene_review", "scene_export", "scene_view"])
    assert.ok(calls.some((call) => call.name.endsWith(`__${tool}`)), `Missing model tool call: ${tool}`);
  assert.ok(calls.some((call) => call.name === "Skill" && call.input?.skill?.includes("blender-scene")));
  const inspections = calls.filter((call) => call.name.endsWith("__scene_get"));
  assert.ok(inspections.some((call) => call.input?.images === "render"));
  assert.ok(inspections.every((call) => call.input?.images || call.input?.referenceName || call.input?.objectName),
    "Model inspections should explicitly select image content");
  const imageBlocks = events.filter((event) => event.type === "user").flatMap((event) => event.message?.content ?? [])
    .flatMap((block) => Array.isArray(block.content) ? block.content : []).filter((block) => block.type === "image").length;
  assert.ok(imageBlocks >= 1 && imageBlocks <= 10, `Unexpected smoke-test image count: ${imageBlocks}`);
  const result = events.findLast((event) => event.type === "result");
  assert.equal(result?.is_error, false);
  const names = (await readdir(runs)).filter((name) => name.startsWith("scene_"));
  assert.equal(names.length, 1);
  const sceneRoot = join(runs, names[0]!);
  const scene = JSON.parse(await readFile(join(sceneRoot, "run.json"), "utf8"));
  assert.ok(["completed", "best_effort"].includes(scene.stage));
  assert.ok(scene.exportedIteration >= 1);
  const artifacts = join(sceneRoot, "artifacts", String(scene.exportedIteration));
  const glb = await readFile(join(artifacts, "final.glb"));
  assert.equal(glb.toString("ascii", 0, 4), "glTF");
  const render = await readFile(join(sceneRoot, scene.render));
  assert.ok(render.length > 10000);
  const evidence = { status: "passed", model: init.model, sceneId: scene.id, renderBytes: render.length,
    glbBytes: glb.length, imageBlocks, toolCalls: calls.map((call) => call.name), evidenceDirectory: root,
    interactiveViewerVerified: false };
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  clearTimeout(timeout);
  for (const [name, log] of logs) await writeFile(join(root, `${name}.log`), log);
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const exited = once(child, "exit");
    terminate(child, "SIGTERM");
    const force = setTimeout(() => terminate(child, "SIGKILL"), 5000);
    await exited; clearTimeout(force);
  }));
  console.log(`Evidence: ${root} (project: ${project})`);
}

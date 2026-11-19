import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkSceneTools } from "../scripts/check-mcp-tools.js";
import { listeners } from "../scripts/local-listeners.js";

async function freePort() {
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  return port;
}

async function until(predicate: () => boolean | Promise<boolean>, detail: string) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await pause(100);
  }
  assert.fail(detail);
}

test("Codex clients share one service, upgrades drain jobs, and idle services restart on demand", { timeout: 60000 }, async () => {
  const cwd = resolve(".");
  const version: string = JSON.parse(await readFile("package.json", "utf8")).version;
  await mkdir(".canova/runs", { recursive: true });
  const root = await mkdtemp(resolve(".canova/runs/managed-test-"));
  const previous = join(root, "previous");
  const blender = join(root, "fake-blender.mjs");
  const gate = join(root, "finish-job");
  const stateFile = join(root, ".service/managed.json");
  const port = await freePort();
  let bridgePort = await freePort();
  while (bridgePort === port) bridgePort = await freePort();
  const clients: Client[] = [];
  async function connect(source: string, idleMs: number) {
    const client = new Client({ name: "managed-startup-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", join(source, "scripts/codex-mcp.ts")], cwd: source,
      env: {
        RUNS_ROOT: root, PORT: String(port), BLENDER_MCP_PORT: String(bridgePort),
        BLENDER_BIN: blender, UNIBLENDER_IDLE_MS: String(idleMs),
      },
    }));
    return client;
  }
  const readManaged = async (): Promise<{ pid: number; source: string }> => JSON.parse(await readFile(stateFile, "utf8"));
  try {
    await mkdir(previous);
    for (const directory of ["src", "scripts"]) await cp(directory, join(previous, directory), { recursive: true });
    for (const directory of ["dist", "node_modules", "runtime", "skills"]) {
      await symlink(join(cwd, directory), join(previous, directory), "dir");
    }
    await writeFile(join(previous, "package.json"), JSON.stringify({ type: "module", version: "0.0.1" }));
    await writeFile(blender, `#!${process.execPath}
import { createServer } from "node:net";
import { existsSync } from "node:fs";
createServer(socket => socket.once("data", () => {
  const wait = setInterval(() => {
    if (!existsSync(${JSON.stringify(gate)})) return;
    clearInterval(wait);
    socket.end(JSON.stringify({status:"ok",result:{}}) + "\\0");
  }, 25);
})).listen(Number(process.argv.at(-1)), "127.0.0.1");
`, { mode: 0o700 });

    const [first, second] = await Promise.all([connect(previous, 10000), connect(previous, 10000)]);
    assert.equal(first.getServerVersion()?.version, "0.0.1");
    const old = await readManaged();
    const oldPid = old.pid;
    assert.deepEqual(listeners(port), [oldPid]);
    checkSceneTools((await second.listTools()).tools);
    assert.equal((await readManaged()).pid, oldPid);

    const created = await first.callTool({ name: "scene_create", arguments: { prompt: "Startup fixture" } });
    const sceneId = (created.structuredContent as { id?: string } | undefined)?.id;
    assert.equal(typeof sceneId, "string");
    await rm(previous, { recursive: true, force: true });
    assert.equal(JSON.parse(await readFile(join(old.source, "package.json"), "utf8")).version, "0.0.1");
    const upgrading = connect(cwd, 1200);
    await until(() => !listeners(port).length, "The older service did not start draining");
    assert.equal((await readManaged()).pid, oldPid, "The older service must retain the scene directory while its job runs");
    assert.equal(listeners(bridgePort).length, 1);
    await writeFile(gate, "");
    const upgraded = await upgrading;
    assert.equal(upgraded.getServerVersion()?.version, version);
    await assert.rejects(() => first.listTools(), /differs from plugin version|matching or newer plugin/);

    const state = await upgraded.callTool({ name: "scene_get", arguments: { sceneId, images: "none" } });
    const snapshot = state.structuredContent as { job?: { status: string } } | undefined;
    assert.equal(snapshot?.job?.status, "done");
    const newPid = (await readManaged()).pid;
    assert.notEqual(newPid, oldPid);
    await until(() => !listeners(port).length && !listeners(bridgePort).length, "The service or bridge stayed up after going idle");

    checkSceneTools((await upgraded.listTools()).tools);
    assert.notEqual((await readManaged()).pid, newPid);
  } catch (error) {
    for (const name of ["mcp", "blender"]) {
      const output = await readFile(join(root, ".service", `${name}.log`), "utf8").catch(() => "");
      if (output) console.error(output);
    }
    throw error;
  } finally {
    await writeFile(gate, "");
    await Promise.allSettled(clients.map(client => client.close()));
    const pid = (await readManaged().catch(() => undefined))?.pid;
    if (pid && listeners(port).includes(pid)) process.kill(pid, "SIGTERM");
    await until(() => !listeners(port).length && !listeners(bridgePort).length, "The test service did not stop");
    await rm(root, { recursive: true, force: true });
  }
});

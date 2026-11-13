import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const runs = resolve(process.env.RUNS_ROOT ?? join(plugin, ".canova/runs"));
const logs = join(runs, ".service");
const port = Number(process.env.PORT ?? 4312), bridgePort = Number(process.env.BLENDER_MCP_PORT ?? 9877);
const origin = `http://127.0.0.1:${port}`;
const started: { pid: number; file: string }[] = [];
const pause = () => new Promise((done) => setTimeout(done, 200));

function listeners(port: number): number[] {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

async function ensureProcess(name: string, command: string, args: string[], listenPort: number) {
  const pidFile = join(logs, `${name}.pid`), logFile = join(logs, `${name}.log`);
  const occupied = listeners(listenPort);
  if (occupied.length) {
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    const commandLine = pid && occupied.includes(pid) ? execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }) : "";
    if (!pid || !commandLine.includes(args.find((arg) => arg.startsWith(plugin)) ?? "\0")) {
      throw new Error(`Port ${listenPort} is already in use by an unrecognized process; it was not reused or stopped.`);
    }
    console.log(`Reusing ${name} on port ${listenPort}.`);
    return;
  }
  const output = openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd: plugin, detached: true, stdio: ["ignore", output, output],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port),
      PUBLIC_BASE_URL: origin, BLENDER_MCP_HOST: "127.0.0.1", BLENDER_MCP_PORT: String(bridgePort), RUNS_ROOT: runs,
      LOCAL_REFERENCE_ROOTS: process.env.LOCAL_REFERENCE_ROOTS ?? runs, MCP_API_KEY: "" },
  });
  closeSync(output);
  await once(child, "spawn");
  child.unref();
  started.push({ pid: child.pid!, file: pidFile });
  writeFileSync(pidFile, String(child.pid));
  const deadline = Date.now() + 60000;
  while (!listeners(listenPort).includes(child.pid!)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`${name} did not start. See ${logFile}`);
    }
    await pause();
  }
  console.log(`Started ${name} on port ${listenPort}. Log: ${logFile}`);
}

try {
  if (!existsSync(join(plugin, "dist/widget.html"))) throw new Error("Build the viewer first: npm run build (in the plugin checkout).");
  mkdirSync(logs, { recursive: true });
  const bridge = join(plugin, "runtime/blender/bridge.py");
  await ensureProcess("blender", process.env.BLENDER_BIN ?? (process.platform === "darwin" ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender"),
    ["--background", "--factory-startup", "--python", bridge, "--", "--port", String(bridgePort)], bridgePort);
  await ensureProcess("mcp", process.execPath,
    ["--import", "tsx", join(plugin, "src/service/server.ts")], port);
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10000) });
  if (!health.ok || (await health.json()).service !== "UniBlenderScene") throw new Error("Local MCP health check failed.");
  const client = new Client({ name: "local-startup-check", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { signal: AbortSignal.timeout(15000) },
    }));
    const { tools } = await client.listTools();
    for (const name of ["scene_view", "scene_get", "scene_edit"]) {
      if (!tools.some((tool) => tool.name === name)) throw new Error(`MCP tool unavailable: ${name}`);
    }
    if (process.env.SCENE_ID) {
      const state = await client.callTool({ name: "scene_view", arguments: { sceneId: process.env.SCENE_ID } });
      if (state.isError) throw new Error("The existing scene is unavailable in RUNS_ROOT. Check the saved scene directory.");
      console.log(`Existing scene is readable: ${process.env.SCENE_ID}`);
    }
    console.log(`Ready: ${origin}/mcp (${tools.length} tools).`);
  } finally { await client.close(); }
} catch (error) {
  for (const child of started.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    try { unlinkSync(child.file); } catch {}
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

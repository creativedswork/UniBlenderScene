import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listeners } from "./local-listeners.js";

const localConfig = join(homedir(), ".canova/.env");
if (existsSync(localConfig)) process.loadEnvFile(localConfig);
const source = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(import.meta.url);
const runs = resolve(process.env.RUNS_ROOT ?? join(homedir(), ".canova/runs"));
const logs = join(runs, ".service");
const port = Number(process.env.PORT ?? 4312);
const bridgePort = Number(process.env.BLENDER_MCP_PORT ?? 9877);
const startupPort = 4311;
const version: string = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
const managedFile = join(logs, "managed.json");
const idleMs = Number(process.env.UNIBLENDER_IDLE_MS ?? 600000);
const numericVersions = new Intl.Collator("en", { numeric: true });
export const localOrigin = `http://127.0.0.1:${port}`;
export const pluginVersion = version;

type Managed = { pid: number; source: string; port: number; bridgePort: number; version: string };

function readManaged(): Managed | undefined {
  return existsSync(managedFile) ? JSON.parse(readFileSync(managedFile, "utf8")) as Managed : undefined;
}

function owned(record: Managed): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(record.pid), "-o", "command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return cmd.endsWith(`${join(record.source, "scripts/managed-local.ts")}\n`);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function compareVersions(a: string, b: string): number {
  const [aCore, ...aPrerelease] = a.split("-");
  const [bCore, ...bPrerelease] = b.split("-");
  return numericVersions.compare(aCore!, bCore!) ||
    Number(!aPrerelease.length) - Number(!bPrerelease.length) ||
    numericVersions.compare(aPrerelease.join("-"), bPrerelease.join("-"));
}

async function withStartupLock(work: () => Promise<void>) {
  // The OS releases the loopback lock even if Codex kills a launcher.
  const lock = createServer(socket => socket.destroy());
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      lock.listen(startupPort, "127.0.0.1");
      await once(lock, "listening");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() >= deadline) {
        throw new Error(`Could not acquire the local startup lock on port ${startupPort}.`, { cause: error });
      }
      await pause(200);
    }
  }
  try { await work(); }
  finally { lock.close(); }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, deadline: number, message: string) {
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause(200);
  }
}

async function health(expected: string): Promise<boolean> {
  try {
    const response = await fetch(`${localOrigin}/health`, { signal: AbortSignal.timeout(2000) });
    const result = await response.json() as { service?: string; version?: string };
    return response.ok && result.service === "UniBlenderScene" && result.version === expected;
  } catch {
    return false;
  }
}

function logOutput(name: string) {
  return openSync(join(logs, `${name}.log`), "a", 0o600);
}

function runtimePath(releaseVersion: string) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) throw new Error("Invalid local service version.");
  return join(logs, `runtime-${releaseVersion}`);
}

async function prepareRuntime() {
  const runtime = runtimePath(version);
  if (existsSync(runtime)) return runtime;
  const staging = await mkdtemp(join(logs, "runtime-setup-"));
  try {
    // Codex removes the previous installed plugin directory when it updates. Keep
    // the files a queued job can still read until its service finishes draining.
    for (const path of ["dist", "node_modules", "package.json", "runtime", "scripts", "skills", "src"]) {
      await cp(join(source, path), join(staging, path), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
    }
    renameSync(staging, runtime);
    return runtime;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function checkSettings() {
  const ports = [port, bridgePort, startupPort];
  if (new Set(ports).size !== ports.length || ports.some(value => !Number.isInteger(value) || value < 1 || value > 65535)) {
    throw new Error(`Choose distinct local ports for MCP and Blender. Port ${startupPort} is reserved for startup.`);
  }
  if (!Number.isSafeInteger(idleMs) || idleMs < 1000) throw new Error("UNIBLENDER_IDLE_MS must be at least 1000.");
}

export async function ensureManagedService() {
  checkSettings();
  await withStartupLock(async () => {
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const old = readManaged();
    const active = old && owned(old);
    const occupied = listeners(port);
    if (occupied.length && !(active && occupied.length === 1 && occupied[0] === old.pid)) {
      throw new Error(`Port ${port} is occupied by a service outside this plugin's management. Use the existing HTTP configuration or stop the service you own before reconnecting.`);
    }
    if (old && compareVersions(old.version, version) > 0) {
      throw new Error(`This project last ran UniBlenderScene ${old.version}. Reload the matching or newer plugin.`);
    }
    if (active) {
      if (old.port !== port || old.bridgePort !== bridgePort) {
        throw new Error("The running service uses different ports. Restore its settings or wait for it to stop.");
      }
      if (old.version === version && await health(version)) return;
    }
    const runtime = await prepareRuntime();
    if (active && owned(old)) {
      if (old.version !== version) {
        try { process.kill(old.pid, "SIGTERM"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await waitFor(() => !owned(old), Date.now() + 65000, "The previous service is finishing work. Reconnect after it stops.");
    }
    if (listeners(bridgePort).length) throw new Error(`Port ${bridgePort} is already in use. Stop the dedicated bridge you own or choose another port.`);

    const output = logOutput("mcp");
    const child = spawn(process.execPath, ["--import", "tsx", join(runtime, "scripts/managed-local.ts")], {
      cwd: runtime, detached: true, stdio: ["ignore", output, output],
      env: {
        ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_BASE_URL: localOrigin, MCP_API_KEY: "",
        RUNS_ROOT: runs, LOCAL_REFERENCE_ROOTS: process.env.LOCAL_REFERENCE_ROOTS ?? runs,
        BLENDER_MCP_HOST: "127.0.0.1", BLENDER_MCP_PORT: String(bridgePort),
      },
    });
    closeSync(output);
    await once(child, "spawn");
    child.unref();
    const record = { pid: child.pid!, source: runtime, port, bridgePort, version };
    const temporary = `${managedFile}.${child.pid}`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, managedFile);
      await waitFor(async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`UniBlenderScene exited during startup. Check ${join(logs, "mcp.log")}.`);
        }
        return listeners(port).includes(record.pid) && await health(version);
      }, Date.now() + 65000, `UniBlenderScene did not become ready. Check ${join(logs, "mcp.log")}.`);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    }
    if (old && old.version !== version) {
      await rm(runtimePath(old.version), { recursive: true, force: true })
        .catch(error => console.error(`Could not remove the previous local runtime: ${error.message}`));
    }
  });
}

async function serve() {
  const { startServer } = await import("../src/service/server.js");
  const blender = process.env.BLENDER_BIN ?? (process.platform === "darwin" ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender");
  const output = logOutput("blender");
  const bridge = spawn(blender, ["--background", "--factory-startup", "--python", join(source, "runtime/blender/bridge.py"),
    "--", "--port", String(bridgePort)], { cwd: source, stdio: ["ignore", output, output] });
  closeSync(output);
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  try {
    await once(bridge, "spawn");
    bridge.once("exit", () => controller.abort());
    const pid = bridge.pid!;
    writeFileSync(join(logs, "blender.pid"), String(pid));
    writeFileSync(join(logs, "mcp.pid"), String(process.pid));
    await waitFor(() => {
      if (controller.signal.aborted) throw new Error("The dedicated Blender bridge exited during startup.");
      return listeners(bridgePort).includes(pid);
    }, Date.now() + 60000, `Blender did not start. Check ${join(logs, "blender.log")}.`);
    const { http, store, shutdown } = startServer();
    await once(http, "listening");
    let lastActivity = Date.now();
    let requests = 0;
    http.prependListener("request", (request, response) => {
      if (request.url === "/health") return;
      requests++;
      response.once("close", () => {
        requests--;
        lastActivity = Date.now();
      });
    });
    const idle = setInterval(() => {
      if (requests || Date.now() - lastActivity < idleMs) return;
      const busy = [...store.scenes.values()].some(scene => scene.job && ["queued", "running"].includes(scene.job.status));
      if (!busy) controller.abort();
    }, Math.min(1000, idleMs));
    if (!controller.signal.aborted) await once(controller.signal, "abort");
    clearInterval(idle);
    await shutdown();
  } finally {
    if (bridge.pid && bridge.exitCode === null && bridge.signalCode === null) {
      bridge.kill("SIGTERM");
      await once(bridge, "exit");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await serve().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

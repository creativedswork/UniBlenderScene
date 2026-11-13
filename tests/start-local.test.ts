import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

test("local startup refuses an unrelated occupied bridge port without stopping it", async () => {
  await mkdir(resolve(".canova/runs"), { recursive: true });
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
  const port = (occupied.address() as { port: number }).port;
  const runs = await mkdtemp(resolve(".canova/runs/startup-test-"));
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/start-local.ts"], {
      env: { ...process.env, RUNS_ROOT: runs, BLENDER_MCP_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`Port ${port} is already in use by an unrecognized process`));
    assert.equal(occupied.listening, true);
  } finally {
    occupied.close();
    await rm(runs, { recursive: true, force: true });
  }
});

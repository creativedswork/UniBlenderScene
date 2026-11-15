import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("local startup passes the project env file to the service process", async () => {
  const source = ts.createSourceFile("start-local.ts", readFileSync("scripts/start-local.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let argumentSource = "";
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "ensureProcess" &&
      node.arguments[0]?.getText(source) === '"mcp"') argumentSource = node.arguments[2]!.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(argumentSource);
  await mkdir(resolve(".canova/runs"), { recursive: true });
  const root = await mkdtemp(resolve(".canova/runs/startup-env-test-"));
  try {
    await mkdir(join(root, "src/service"), { recursive: true });
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, ".env"), "THREERT_BIN=/fixture/native-client\n");
    await writeFile(join(root, "src/service/server.ts"), 'process.stdout.write(process.env.THREERT_BIN ?? "missing");');
    const args = runInNewContext(argumentSource, { join, plugin: root }) as string[];
    const env = { ...process.env }; delete env.THREERT_BIN;
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, errors);
    assert.equal(output, "/fixture/native-client");
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer as netServer } from "node:net";
import { createServer as httpsServer } from "node:https";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = await mkdtemp(join(tmpdir(), "codex-blender-integration-"));
const binary = process.env.BLENDER_BIN ?? (process.platform === "darwin" ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender");
async function freePort(): Promise<number> {
  const server = netServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
function ready(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`Process did not report ${marker}`)), 60000);
    let output = "";
    const listen = (data: Buffer) => {
      output += data.toString();
      if (output.includes(marker)) { clearTimeout(timeout); child.stdout!.off("data", listen); done(); }
    };
    child.stdout!.on("data", listen);
    child.once("exit", (code) => { clearTimeout(timeout); fail(new Error(`Process exited: ${code}`)); });
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exit = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exit; clearTimeout(timer);
}

const blenderPort = await freePort(), port = await freePort();
const apiKey = randomBytes(32).toString("hex");
const origin = `http://127.0.0.1:${port}`;
let referenceBytes = Buffer.alloc(0);
const keyPath = join(root, "reference-key.pem"), certPath = join(root, "reference-cert.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
  "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
], { stdio: "ignore" });
const fileServer = httpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_, response) => {
  response.writeHead(200, { "Content-Type": "image/png" }); response.end(referenceBytes);
});
await new Promise<void>((done) => fileServer.listen(0, "127.0.0.1", done));
const filePort = (fileServer.address() as { port: number }).port;
const blender = spawn(binary, ["--background", "--factory-startup", "--python", resolve("blender/bridge.py"), "--", "--port", String(blenderPort)], { stdio: ["ignore", "pipe", "pipe"] });
let blenderLog = "";
blender.stdout!.on("data", (data) => { blenderLog += data.toString(); });
blender.stderr!.on("data", (data) => { blenderLog += data.toString(); });
const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  env: {
    ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_BASE_URL: origin,
    MCP_API_KEY: apiKey, BLENDER_MCP_PORT: String(blenderPort), RUNS_ROOT: join(root, ".canova/runs"),
    FILE_DOWNLOAD_HOSTS: `localhost:${filePort}`, NODE_EXTRA_CA_CERTS: certPath,
  }, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stderr!.on("data", (data) => { serverLog += data.toString(); });
const client = new Client({ name: "blender-integration", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
});
async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return await client.callTool({ name, arguments: args }) as CallToolResult;
}
async function poll(id: string, expectedStatus = "done"): Promise<Record<string, any>> {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const output = await call("scene_view", { sceneId: id });
    assert.equal(output.isError, undefined, JSON.stringify(output.content));
    assert.equal(output.content.some((item) => item.type === "image"), false);
    const scene = output.structuredContent as Record<string, any>;
    if (!["queued", "running"].includes(scene.job?.status)) {
      assert.equal(scene.job?.status, expectedStatus, scene.error);
      return scene;
    }
    // Poll a known asynchronous job without blocking the host's event loop.
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Scene job exceeded integration timeout.");
}
try {
  await ready(blender, "bridge ready"); await ready(server, "MCP listening");
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  const denied = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 8);
  const widget = await client.readResource({ uri: "ui://codex-blender/viewer.html" });
  assert.ok("text" in widget.contents[0]! && widget.contents[0]!.text.includes("Blender scene"));
  const created = await call("scene_create", { prompt: "Red cube on a warm floor, studio lighting." });
  const id = created.structuredContent!.id as string; await poll(id);
  await call("scene_plan", {
    sceneId: id, summary: "Red studio cube", steps: ["Build cube, floor, camera and area light"],
    criteria: [{ id: "red-cube", severity: "blocker", description: "Visible red cube on a lit floor" }], visualThreshold: 85,
  });
  await call("scene_edit", { sceneId: id, code: await readFile("tests/scene.py", "utf8") });
  const rendered = await poll(id);
  assert.equal(rendered.stage, "review");
  const evidence = await call("scene_get", { sceneId: id });
  assert.ok(evidence.content.some((item) => item.type === "image" && item.data.length > 10000));
  assert.ok(rendered.summary.objects.some((object: { name: string }) => object.name === "RedCube"));
  assert.ok(rendered.summary.objectCount >= rendered.summary.objects.length);
  const inspected = await call("scene_get", { sceneId: id, objectName: "RedCube" });
  assert.equal(inspected.content.some((item) => item.type === "image"), false);
  const object = inspected.structuredContent!.inspectedObject as Record<string, any>;
  assert.equal(object.name, "RedCube");
  assert.equal(object.rotationMode, "XYZ");
  assert.equal(object.polygonCount, 6);
  assert.equal(object.matrixWorld.length, 4);
  const missingObject = await call("scene_get", { sceneId: id, objectName: "MissingObject" });
  assert.equal(missingObject.isError, true);
  const badReview = await call("scene_review", {
    sceneId: id, iteration: 99, criteria: [{ id: "red-cube", passed: true, evidence: "Stale" }],
    visualScore: 90, regressions: [], repairable: false, nextAction: "Export",
  });
  assert.equal(badReview.isError, true);
  await writeFile(join(root, "render.png"), Buffer.from(evidence.content.find((item) => item.type === "image")!.data as string, "base64"));
  const reviewed = await call("scene_review", {
    sceneId: id, iteration: rendered.iteration,
    criteria: [{ id: "red-cube", passed: true, evidence: "Integration scene contains RedCube, floor, active camera and 512px render; visual review is performed separately." }],
    visualScore: 90, regressions: [], repairable: false, nextAction: "Export reviewed checkpoint",
  });
  assert.equal(reviewed.structuredContent!.stage, "completed");
  await call("scene_export", { sceneId: id }); const exported = await poll(id);
  const glb = exported.artifacts.find((file: { name: string }) => file.name === "final.glb");
  assert.ok(glb);
  const glbResponse = await fetch(glb.url); assert.equal(glbResponse.status, 200);
  const bytes = Buffer.from(await glbResponse.arrayBuffer());
  assert.equal(bytes.toString("ascii", 0, 4), "glTF"); assert.equal(bytes.readUInt32LE(4), 2);
  const profileURL = exported.artifacts.find((file: { name: string }) => file.name === "render-profile.json").url;
  const profile = await (await fetch(profileURL)).json() as Record<string, any>;
  assert.equal(profile.camera.name, "__CodexBlenderActiveCamera");
  assert.equal(profile.lights[0].type, "AREA");
  const forbidden = await fetch(`${origin}/artifacts/${id}/run.json?token=invalid`); assert.equal(forbidden.status, 403);
  const unauthorizedGLB = await fetch(glb.url.replace(/token=[^&]+/, "token=invalid")); assert.equal(unauthorizedGLB.status, 403);
  await writeFile(join(root, "scene.json"), JSON.stringify(exported, null, 2));
  await writeFile(join(root, "widget.html"), widget.contents[0]!.text as string);
  await writeFile(join(root, "final.glb"), bytes);
  referenceBytes = await readFile(join(root, "render.png"));
  const referenceScene = await call("scene_create", {
    prompt: "Create a scene from the uploaded studio cube", reference: { download_url: `https://localhost:${filePort}/reference.png`, file_id: "integration-image", mime_type: "image/png", file_name: "reference.png" },
  });
  const received = await poll(referenceScene.structuredContent!.id as string);
  assert.equal(received.reference.fileId, "integration-image");
  assert.equal(received.reference.mime, "image/png");
  const transferred = Buffer.from(await (await fetch(received.reference.url)).arrayBuffer());
  assert.deepEqual(transferred, referenceBytes);
  const view = await call("scene_view", { sceneId: id }); assert.equal(view.structuredContent!.id, id);
  await call("scene_continue", { sceneId: id, prompt: "Keep the red cube while refining the scene" });
  await call("scene_plan", {
    sceneId: id, summary: "Preserve the red cube", steps: ["Inspect and preserve cube"],
    criteria: [{ id: "red-cube", severity: "blocker", description: "The original RedCube remains intact" }], visualThreshold: 85,
  });
  await call("scene_edit", { sceneId: id, code: 'bpy.data.objects["RedCube"].name = "Broken"\nraise RuntimeError("Intentional integration failure")' });
  const failure = await poll(id, "failed");
  assert.equal(failure.stage, "edit");
  assert.ok(failure.error.includes("Intentional integration failure"));
  await call("scene_edit", {
    sceneId: id, code: 'assert bpy.data.objects.get("RedCube") is not None\nassert bpy.data.objects.get("Broken") is None',
  });
  await poll(id);
  const report = {
    status: "passed", tools: tools.tools.length, sceneId: id,
    blenderVersion: rendered.summary.blenderVersion, renderBytes: referenceBytes.length, glbBytes: bytes.length,
    checks: ["HTTP MCP initialization/tools/resource", "bearer authorization", "create/plan/edit/render/review/export/view", "lightweight job polling", "named-object inspection", "stale review rejection", "artifact access boundary", "HTTPS host-file image transfer", "new-request continuation", "failed-edit checkpoint recovery"],
  };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidenceDirectory: root }, null, 2));
  if (process.env.KEEP_INTEGRATION_SERVER === "1") {
    console.log(`Viewer inspection service remains active at ${origin}; evidence is at ${root}`);
    await new Promise<void>((done) => process.once("SIGTERM", done));
  }
} finally {
  await client.close().catch(() => {});
  await stop(server); await stop(blender);
  await new Promise<void>((done) => fileServer.close(() => done()));
  await writeFile(join(root, "blender.log"), blenderLog);
  await writeFile(join(root, "server.log"), serverLog);
}

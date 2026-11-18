import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer as netServer } from "node:net";
import { createServer as httpsServer } from "node:https";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BlenderClient } from "../src/service/blender.js";
import { testBoundedRevisionGuard } from "./bounded-revision.integration.js";
import { testGuardPerformance } from "./guard-performance.integration.js";
import { testExperienceLibrary } from "./experience.integration.js";
import { prepareSpatialTrial } from "./spatial.integration.js";

await mkdir(".canova/runs", { recursive: true });
const root = await mkdtemp(resolve(".canova/runs/blender-integration-"));
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
const blender = spawn(binary, ["--background", "--factory-startup", "--python", resolve("runtime/blender/bridge.py"), "--", "--port", String(blenderPort)], { stdio: ["ignore", "pipe", "pipe"] });
let blenderLog = "";
blender.stdout!.on("data", (data) => { blenderLog += data.toString(); });
blender.stderr!.on("data", (data) => { blenderLog += data.toString(); });
const server = spawn(process.execPath, ["--import", "tsx", "src/service/server.ts"], {
  env: {
    ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_BASE_URL: origin,
    MCP_API_KEY: apiKey, BLENDER_MCP_PORT: String(blenderPort), RUNS_ROOT: join(root, ".canova/runs"),
    FILE_DOWNLOAD_HOSTS: `localhost:${filePort}`, NODE_EXTRA_CA_CERTS: certPath,
    LOCAL_REFERENCE_ROOTS: root,
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
async function planFixture(args: Record<string, any>) {
  const s=(await call("scene_get",{sceneId:args.sceneId,images:"none"})).structuredContent as Record<string,any>;
  const graph=args.graph ?? [{id:"cube",label:"Cube",kind:"object",parentId:null,blenderObjectNames:["RedCube"],description:"Primitive fixture"}];
  const workflow=args.workflow ?? (s.references.length ? {stages:[{name:"composition",criterionIds:args.criteria.map((c:any)=>c.id),budget:2},{name:"final",criterionIds:args.criteria.map((c:any)=>c.id),budget:1}]} : undefined);
  const p=await call("scene_plan",{...args,graph,workflow,assets:graph.filter((n:any)=>n.kind!=="group").map((n:any)=>({nodeId:n.id,kind:"structure",reason:"Simple cube test fixture"}))});
  assert.equal(p.isError,undefined,JSON.stringify(p.content));
  const g=await call("scene_plan_review",{sceneId:args.sceneId,checks:["coverage","hierarchy","spatial","stage_checklists"].map(id=>({id,passed:true,evidence:"Fixture graph checked"})),referenceEvidence:s.references.map((r:any)=>({reference:r.assetName,observation:"Fixture geometry and camera checked"}))});
  assert.equal(g.isError,undefined,JSON.stringify(g.content));
  return p;
}
async function reviewFixture(args: Record<string,any>) {
  const s=(await call("scene_get",{sceneId:args.sceneId,images:"none"})).structuredContent as Record<string,any>;
  const observations=s.plan.workflow ? (args.observations ?? args.criteria.map((c:any)=>({criterionId:c.id,nodeId:"cube",target:"Visible cube",actual:"Cube shown",evidence:"Rendered fixture",reason:"Mismatch",correction:"Fix cube",acceptance:"Visible cube"}))).map((o:any)=>({...o,sceneEvidence:"Runtime inventory contains RedCube",...(s.references.length?{referenceView:s.references[0].assetName}:{})})) : undefined;
  const r=await call("scene_review",{...args,inspectionId:s.inspection.id,observations,referenceEvidence:s.references.map((r:any)=>({reference:r.assetName,observation:"Fixture spatial evidence checked"}))});
  assert.equal(r.isError,undefined,JSON.stringify(r.content));return r;
}
async function poll(id: string, expectedStatus = "done"): Promise<Record<string, any>> {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const output = await call("scene_get", { sceneId: id, images: "none" });
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
  const tools = await client.listTools(); assert.equal(tools.tools.length, 24);
  const widget = await client.readResource({ uri: "ui://uni-blender-scene/viewer.html" });
  assert.ok("text" in widget.contents[0]! && widget.contents[0]!.text.includes("Blender scene"));
  const created = await call("scene_create", { prompt: "Red cube on a warm floor, studio lighting." });
  const id = created.structuredContent!.id as string; await poll(id);
  await planFixture({
    sceneId: id, summary: "Red studio cube", steps: ["Build cube, floor, camera and area light"],
    criteria: [{ id: "red-cube", severity: "blocker", description: "Visible red cube on a lit floor" }], visualThreshold: 85,
    graph: [
      { id: "root", label: "Studio", kind: "group", parentId: null, blenderObjectNames: [], description: "Studio scene" },
      { id: "cube", label: "Red cube", kind: "object", parentId: "root", blenderObjectNames: ["RedCube"], description: "Main subject", status: "built" },
    ],
  });
  await call("scene_edit", { sceneId: id, code: await readFile("tests/scene.py", "utf8") });
  const rendered = await poll(id);
  assert.equal(rendered.stage, "review");
  const evidence = await call("scene_get", { sceneId: id });
  assert.ok(evidence.content.some((item) => item.type === "image" && item.data.length > 10000));
  const renderOnly = await call("scene_get", { sceneId: id, images: "render" });
  assert.equal(renderOnly.content.filter((item) => item.type === "image").length, 1);
  assert.deepEqual(renderOnly.content.find((item) => item.type === "image"), evidence.content.find((item) => item.type === "image"));
  const stateOnly = await call("scene_get", { sceneId: id, images: "none" });
  assert.equal(stateOnly.content.some((item) => item.type === "image"), false);
  assert.equal(stateOnly.structuredContent!.id, id);
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
    inspectionId: "stale",
    sceneId: id, iteration: 99, criteria: [{ id: "red-cube", passed: true, evidence: "Stale" }],
    visualScore: 90, regressions: [], repairable: false, nextAction: "Export",
  });
  assert.equal(badReview.isError, true);
  await writeFile(join(root, "render.png"), Buffer.from(evidence.content.find((item) => item.type === "image")!.data as string, "base64"));
  const reviewed = await reviewFixture({
    sceneId: id, iteration: rendered.iteration,
    criteria: [{ id: "red-cube", passed: true, evidence: "Integration scene contains RedCube, floor, active camera and 512px render; visual review is performed separately." }],
    visualScore: 90, regressions: [], repairable: false, nextAction: "Export reviewed checkpoint",
  });
  assert.equal(reviewed.structuredContent!.stage, "completed");
  const sourcePath = join(root, ".canova/runs", id, "best.blend");
  const sourceBeforeExport = await readFile(sourcePath);
  const previewAppearance = { exposureEV: 0.6, saturation: 1.1, whiteBalance: [0.9, 1, 1.4], contrast: 1.3, hazeScale: 0.25, dust: { color: [0.25, 0.18, 0.1], wind: [0.2, 0, 0],
    volumes: [{ center: [0, 0, 1], radius: [1.8, 1.8, 0.9], density: 0.2 }] } };
  await call("scene_export", { sceneId: id, lightingBakes: [{ objectName: "RedCube", resolution: 128 }], previewAppearance }); const exported = await poll(id);
  assert.deepEqual(await readFile(sourcePath), sourceBeforeExport, "Export baking must preserve the editable source.");
  const glb = exported.artifacts.find((file: { name: string }) => file.name === "final.glb");
  assert.ok(glb);
  const glbResponse = await fetch(glb.url); assert.equal(glbResponse.status, 200);
  const bytes = Buffer.from(await glbResponse.arrayBuffer());
  const graphURL = exported.artifacts.find((file: { name: string }) => file.name === "scene-graph.json").url;
  const graph = await (await fetch(graphURL)).json();
  assert.equal(graph.iteration, exported.exportedIteration);
  assert.ok(graph.nodes.find((node: { id: string }) => node.id === "cube").gltfNodeIndices.length >= 1);
  assert.equal(bytes.toString("ascii", 0, 4), "glTF"); assert.equal(bytes.readUInt32LE(4), 2);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  assert.ok(!gltf.nodes.some((node: any) => node.name === "PureVolumeProxy"),
    "A pure volume boundary must not become an opaque GLB cube");
  const cubeMesh = gltf.meshes[gltf.nodes.find((node: any) => node.name === "RedCube").mesh];
  for (const primitive of cubeMesh.primitives) {
    assert.equal(gltf.materials[primitive.material].emissiveTexture.texCoord ?? 0, 0,
      "The dedicated baked atlas must be the primary export UV for the path tracer.");
    assert.equal(primitive.attributes.TEXCOORD_1, undefined, "Unused tiled source UVs must not reach the baked GLB");
  }
  assert.ok(gltf.materials.some((material: { emissiveTexture?: unknown; emissiveFactor?: number[] }) =>
    material.emissiveTexture && material.emissiveFactor?.some((value) => value > 0)),
    "Opted-in floor must carry baked lighting in the GLB.");
  assert.ok(gltf.materials.some((material: { name?: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }) =>
    material.name?.startsWith("Procedural swatch") && material.pbrMetallicRoughness?.baseColorTexture),
    "Procedural base color must become a GLB texture.");
  const portableNormal = gltf.materials.find((material: any) => material.name === "Warm floor" && material.normalTexture);
  assert.ok(portableNormal, "The unbaked receiver retains its portable normal map");
  const normalImage = gltf.images[gltf.textures[portableNormal.normalTexture.index].source];
  const normalView = gltf.bufferViews[normalImage.bufferView];
  const normalBytes = bytes.subarray(28 + bytes.readUInt32LE(12) + (normalView.byteOffset ?? 0));
  assert.equal(normalImage.mimeType, "image/png");
  assert.equal(normalBytes.readUInt32BE(16), 64, "A tiled normal map must not become a 1024px procedural bake");
  const glbChunk = await call("scene_asset_chunk", { sceneId: id, name: "final.glb", offset: 0 });
  assert.equal(glbChunk.isError, undefined);
  assert.deepEqual(Buffer.from((glbChunk.structuredContent as { data: string }).data, "base64"), bytes.subarray(0, 256 * 1024));
  const profileURL = exported.artifacts.find((file: { name: string }) => file.name === "render-profile.json").url;
  const profile = await (await fetch(profileURL)).json() as Record<string, any>;
  assert.equal(profile.camera.name, "__CodexBlenderActiveCamera");
  assert.equal(profile.camera.projectionMatrix.length, 16);
  assert.ok(profile.colorManagement.displayLut.uri.startsWith("data:image/png;base64,"));
  assert.equal(profile.lights[0].type, "AREA");
  assert.ok(profile.lights[0].energy > 0);
  assert.deepEqual([...profile.bakedObjects].sort(), ["Floor", "RedCube"]);
  assert.ok(profile.world.environmentUri?.endsWith("environment.exr"));
  assert.ok(profile.world.backgroundEnvironmentUri?.startsWith("data:application/octet-stream;base64,"));
  assert.ok(Math.abs(profile.postprocessing.bloom.strength - 0.1) < 1e-6);
  assert.ok(Math.abs(profile.postprocessing.haze.strength - 0.03) < 1e-6);
  assert.deepEqual(profile.previewAppearance, previewAppearance);
  assert.deepEqual(profile.bakedTints.Floor, [1, 1, 1]);
  assert.ok(profile.materials.objects >= 1 && profile.materials.textures >= 1);
  const forbidden = await fetch(`${origin}/artifacts/${id}/run.json?token=invalid`); assert.equal(forbidden.status, 403);
  const unauthorizedGLB = await fetch(glb.url.replace(/token=[^&]+/, "token=invalid")); assert.equal(unauthorizedGLB.status, 403);
  await writeFile(join(root, "scene.json"), JSON.stringify(exported, null, 2));
  await writeFile(join(root, "widget.html"), widget.contents[0]!.text as string);
  await writeFile(join(root, "final.glb"), bytes);
  const experienceLibrary = await testExperienceLibrary(call, poll, id, root);
  // A generated asset fixture exercises the provider contract without paid API calls.
  const providerScene=(await call("scene_create",{prompt:"Standalone provider fixture"})).structuredContent!.id as string;
  await poll(providerScene);
  const providerPath=join(root,".canova/runs",providerScene,"provider.glb");await writeFile(providerPath,bytes);
  const providerPlan=await call("scene_plan",{sceneId:providerScene,summary:"Import external fixture",steps:["Import"],visualThreshold:85,
    criteria:[{id:"cube",severity:"major",description:"Imported object"}],
    graph:[{id:"cube",label:"Imported object",kind:"object",parentId:null,description:"Provider fixture",blenderObjectNames:[]}],
    assets:[{nodeId:"cube",kind:"object",reason:"Standalone generated object"}]});
  assert.equal(providerPlan.isError,undefined,JSON.stringify(providerPlan.content));
  await call("scene_plan_review",{sceneId:providerScene,checks:["coverage","hierarchy","spatial","stage_checklists"].map(id=>({id,passed:true,evidence:"Fixture graph checked"})),referenceEvidence:[]});
  assert.equal((await call("scene_edit",{sceneId:providerScene,code:"pass"})).isError,true);
  assert.equal((await call("scene_asset_strategy",{sceneId:providerScene,nodeId:"cube",providers:["fixture-provider"],evidence:"Provider available"})).isError,undefined);
  assert.equal((await call("scene_edit",{sceneId:providerScene,code:"pass"})).isError,true);
  const strategy=await call("scene_asset_strategy",{sceneId:providerScene,nodeId:"cube",providers:["fixture-provider"],provider:"fixture-provider",taskId:"fixture-task",artifactPath:providerPath,evidence:"Local GLB fixture standing in for a downloaded provider result"});
  assert.equal(strategy.isError,undefined,JSON.stringify(strategy.content));
  await call("scene_edit",{sceneId:providerScene,code:"pass"});const missingImport=await poll(providerScene,"failed");
  assert.match(missingImport.error,/Import and tag/);assert.equal(missingImport.iteration,0);
  const hash=(strategy.structuredContent as any).assetStrategies[0].sha256;
  await call("scene_edit",{sceneId:providerScene,code:`
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(providerPath)})
for obj in bpy.context.scene.objects:
    if obj.type == 'MESH':
        obj['scene_node_id']='cube'
        obj['provider_task_id']='fixture-task'
        obj['provider_asset_sha256']=${JSON.stringify(hash)}
bpy.context.scene.camera=next(o for o in bpy.context.scene.objects if o.type=='CAMERA')
bpy.context.scene.render.engine='CYCLES'
bpy.context.scene.cycles.samples=4
bpy.context.scene.render.resolution_x=128
bpy.context.scene.render.resolution_y=128
`});
  const imported=await poll(providerScene);assert.equal(imported.iteration,1);assert.ok(imported.summary.objectCount>0);
  referenceBytes = await readFile(join(root, "render.png"));
  await writeFile(join(root, "local-side.png"), referenceBytes);
  const localReferenceScene = await call("scene_create", {
    prompt: "Reconstruct the attached room views",
    references: [{ local_path: join(root, "render.png"), label: "primary" }, { local_path: join(root, "local-side.png"), label: "side" }],
  });
  // Separate attachment paths can contain identical pixels; camera observations may overlap.
  const localReceived = await poll(localReferenceScene.structuredContent!.id as string);
  assert.equal(localReceived.references.length, 2);
  const localEvidence = await call("scene_get", { sceneId: localReceived.id });
  assert.equal(localEvidence.content.filter((item) => item.type === "image").length, 2);
  const referenceScene = await call("scene_create", {
    prompt: "Create a scene from the uploaded studio cube", reference: { download_url: `https://localhost:${filePort}/reference.png`, file_id: "integration-image", mime_type: "image/png", file_name: "reference.png" },
  });
  const received = await poll(referenceScene.structuredContent!.id as string);
  assert.equal(received.reference.fileId, "integration-image");
  assert.equal(received.reference.mime, "image/png");
  const transferred = Buffer.from(await (await fetch(received.reference.url)).arrayBuffer());
  assert.deepEqual(transferred, referenceBytes);
  const multiReferenceScene = await call("scene_create", {
    prompt: "Reconstruct one room from its primary and side views",
    references: ["front", "side"].map((label) => ({
      download_url: `https://localhost:${filePort}/${label}.png`, file_id: `multi-${label}`, file_name: `${label}.png`, label,
    })),
  });
  const multi = await poll(multiReferenceScene.structuredContent!.id as string);
  assert.deepEqual(multi.references.map((image: { role: string; label: string }) => [image.role, image.label]), [["primary", "front"], ["auxiliary", "side"]]);
  const multiGet = await call("scene_get", { sceneId: multi.id });
  assert.equal(multiGet.content.filter((item) => item.type === "image").length, 2);
  const referenceOnly = await call("scene_get", { sceneId: multi.id, images: "references", referenceName: "reference-2" });
  assert.equal(referenceOnly.content.filter((item) => item.type === "image").length, 1);
  assert.deepEqual(Buffer.from(referenceOnly.content.find((item) => item.type === "image")!.data as string, "base64"), referenceBytes);
  for (const image of multi.references) {
    const response = await fetch(image.url);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), referenceBytes);
    assert.equal((await fetch(image.url.replace(/token=[^&]+/, "token=invalid"))).status, 403);
  }
  const sideChunk = await call("scene_asset_chunk", { sceneId: multi.id, name: "reference-2", offset: 0 });
  assert.equal(sideChunk.isError, undefined);
  assert.deepEqual(Buffer.from((sideChunk.structuredContent as { data: string }).data, "base64"), referenceBytes.subarray(0, 256 * 1024));
  // Give the viewer fixture the images downloaded through the actual host-file path.
  await writeFile(join(root, "scene.json"), JSON.stringify({ ...exported, reference: multi.reference, references: multi.references }, null, 2));
  const view = await call("scene_view", { sceneId: id }); assert.equal(view.structuredContent!.id, id);
  await call("scene_continue", { sceneId: id, prompt: "Keep the red cube while refining the scene", references: [{
    download_url: `https://localhost:${filePort}/new-view.png`, file_id: "continued-view", label: "New view",
  }] });
  const continued = await poll(id);
  assert.equal(continued.stage, "planning");
  assert.equal(continued.references[0].fileId, "continued-view");
  await planFixture({
    sceneId: id, summary: "Preserve the red cube", steps: ["Inspect and preserve cube"],
    criteria: [{ id: "red-cube", severity: "blocker", description: "The original RedCube remains intact" }], visualThreshold: 85,
    referenceAnchors: [
      { id: "cube", description: "Cube", targetBox: [0.3, 0.2, 0.7, 0.8] },
      { id: "ground", description: "Ground", targetBox: [0, 0.6, 1, 1] },
    ],
  });
  await call("scene_edit", { sceneId: id, code: 'bpy.data.objects["RedCube"].name = "Broken"\nraise RuntimeError("Intentional integration failure")' });
  const failure = await poll(id, "failed");
  assert.equal(failure.stage, "edit");
  assert.ok(failure.error.includes("Intentional integration failure"));
  await call("scene_edit", {
    sceneId: id, code: 'assert bpy.data.objects.get("RedCube") is not None\nassert bpy.data.objects.get("Broken") is None',
  });
  await poll(id);
  const stagedCreated = await call("scene_create", { prompt: "Staged red cube" });
  const stagedId = stagedCreated.structuredContent!.id as string; await poll(stagedId);
  await planFixture({ sceneId: stagedId, summary: "Staged cube", steps: ["Build", "Compose", "Review"],
    criteria: [{ id: "cube", severity: "blocker", description: "Red cube remains visible" }], visualThreshold: 80,
    graph: [{ id: "cube", label: "Red cube", kind: "object", parentId: null, blenderObjectNames: ["RedCube"], description: "Main cube", status: "built" }],
    workflow: { compositionApproval: true, stages: [
      { name: "geometry", criterionIds: ["cube"], budget: 1 },
      { name: "composition", criterionIds: ["cube"], budget: 1 },
      { name: "materials", criterionIds: ["cube"], budget: 1 },
      { name: "lighting", criterionIds: ["cube"], budget: 1 },
      { name: "final", criterionIds: ["cube"], budget: 1 },
    ] },
  });
  const stagedReview = (iteration: number) => ({ sceneId: stagedId, iteration,
    criteria: [{ id: "cube", passed: true, evidence: "Cube geometry is visible; original red source material is preserved" }],
    observations: [{ criterionId: "cube", nodeId: "cube", target: "Visible cube geometry", actual: "Cube geometry visible in gray rendering",
      evidence: "Rendered PNG and Blender object summary" }],
    visualScore: 90, regressions: [], repairable: false, nextAction: "Continue stage" });
  await call("scene_edit", { sceneId: stagedId, code: await readFile("tests/scene.py", "utf8") });
  const geometry = await poll(stagedId);
  assert.equal(geometry.workflowState.phase, "geometry");
  assert.deepEqual(geometry.workflowState.presentation, { mode: "structural", purpose: "work", source: "current", iteration: 1, contentIteration: 1 });
  const geometryPng = await readFile(join(root, ".canova/runs", stagedId, geometry.render));
  assert.equal(geometryPng[25], 0, "Geometry edits automatically render grayscale PNGs");
  const geometrySource = await readFile(join(root, ".canova/runs", stagedId, "current.blend"));
  await call("scene_preview", { sceneId: stagedId });
  const workPreview = await poll(stagedId);
  assert.equal(workPreview.stage, "review");
  assert.equal(workPreview.workflowState.phase, "geometry");
  assert.equal(workPreview.workflowState.presentation.purpose, "work");
  assert.equal(workPreview.iteration, 1);
  assert.equal(workPreview.startIteration, geometry.startIteration);
  assert.equal(workPreview.compositionApproved, false);
  assert.deepEqual(await readFile(join(root, ".canova/runs", stagedId, "current.blend")), geometrySource);
  const workProfile = JSON.parse(await readFile(join(root, ".canova/runs", stagedId, "previews/1/render-profile.json"), "utf8"));
  assert.deepEqual(workProfile.source, { kind: "current", purpose: "work", phase: "geometry", iteration: 1, contentIteration: 1 });
  await writeFile(join(root, "geometry.json"), JSON.stringify(workPreview, null, 2));
  assert.equal((await call("scene_review_decision", { sceneId: stagedId, approved: true })).isError, true);
  assert.equal((await call("scene_export", { sceneId: stagedId })).isError, true);
  await reviewFixture(stagedReview(1));
  await call("scene_edit",{sceneId:stagedId,code:"bpy.data.objects['RedCube'].data.vertices[0].co.x += 0.2"});
  const scopeFailure=await poll(stagedId,"failed");assert.match(scopeFailure.error,/Stage scope violation/);assert.equal(scopeFailure.iteration,1);
  await call("scene_edit", { sceneId: stagedId, code: "pass" });
  await poll(stagedId); await reviewFixture(stagedReview(2));
  const awaiting = await poll(stagedId);
  assert.equal(awaiting.stage, "awaiting_review");
  assert.match(awaiting.renderUrl, /review-main\.png/);
  assert.equal(awaiting.bestRenderUrl, awaiting.renderUrl);
  const grayImage = await call("scene_get", { sceneId: stagedId, images: "render" });
  const mainGray = await readFile(join(root, ".canova/runs", stagedId, "review-main.png"));
  assert.deepEqual(Buffer.from(grayImage.content.find((item) => item.type === "image")!.data as string, "base64"), mainGray);
  const grayAlias = await fetch(awaiting.bestRenderUrl.replace("review-main.png", "best.png"));
  assert.equal(grayAlias.status, 200);
  assert.deepEqual(Buffer.from(await grayAlias.arrayBuffer()), mainGray, "Existing best.png URLs must serve structural evidence while awaiting approval");
  assert.equal((await call("scene_export", { sceneId: stagedId })).isError, true);
  const checkpointPath = join(root, ".canova/runs", stagedId, "best.blend");
  const checkpoint = await readFile(checkpointPath);
  const currentPath = join(root, ".canova/runs", stagedId, "current.blend");
  const workingScene = await readFile(currentPath);
  assert.equal((await call("scene_preview", { sceneId: stagedId })).isError, undefined);
  const preview = await poll(stagedId);
  assert.equal(preview.stage, "awaiting_review");
  assert.notEqual(preview.compositionApproved, true);
  assert.equal(preview.previewedIteration, 2);
  assert.equal(preview.exportedIteration, undefined);
  assert.deepEqual(await readFile(checkpointPath), checkpoint);
  assert.deepEqual(await readFile(currentPath), workingScene);
  const previewDirectory = join(root, ".canova/runs", stagedId, "previews/2");
  const structuralBytes = await readFile(join(previewDirectory, "final.glb"));
  const structuralGltf = JSON.parse(structuralBytes.subarray(20, 20 + structuralBytes.readUInt32LE(12)).toString("utf8"));
  assert.equal(structuralGltf.images?.length ?? 0, 0, "Structural GLB must omit texture images");
  assert.equal(structuralGltf.textures?.length ?? 0, 0);
  assert.ok(structuralGltf.materials.length > 0);
  for (const material of structuralGltf.materials) {
    const color = material.pbrMetallicRoughness.baseColorFactor;
    assert.ok(Math.abs(color[0] - color[1]) < 1e-6 && Math.abs(color[1] - color[2]) < 1e-6);
    assert.equal(color[3], 1);
    assert.equal(material.pbrMetallicRoughness.baseColorTexture, undefined);
    assert.equal(material.emissiveTexture, undefined);
  }
  const profilePath = join(previewDirectory, "render-profile.json");
  const structuralProfile = JSON.parse(await readFile(profilePath, "utf8"));
  assert.equal(structuralProfile.previewMode, "structural");
  assert.equal(structuralProfile.world.environmentUri, null);
  assert.deepEqual(structuralProfile.bakedObjects, []);
  assert.equal(structuralProfile.materials.textures, 0);
  assert.equal(structuralProfile.camera.dof.enabled, false);
  assert.ok(structuralProfile.lights.every((light: { color: number[] }) => light.color.every((value) => value === 1)));
  // A cached pre-upgrade preview must be hidden and rebuilt, even for the same iteration.
  await writeFile(profilePath, JSON.stringify({ ...structuralProfile, previewMode: undefined }));
  await writeFile(join(previewDirectory, "final.glb"), bytes);
  const legacy = await call("scene_view", { sceneId: stagedId });
  assert.equal((legacy.structuredContent!.artifacts as { name: string }[]).some((item) => item.name === "final.glb"), false);
  await call("scene_preview", { sceneId: stagedId });
  const regenerated = await poll(stagedId);
  assert.equal(JSON.parse(await readFile(profilePath, "utf8")).previewMode, "structural");
  assert.deepEqual(await readFile(checkpointPath), checkpoint);
  await writeFile(join(root,"composition.json"),JSON.stringify(regenerated,null,2));
  const previewChunk = await call("scene_asset_chunk", { sceneId: stagedId, name: "final.glb", offset: 0 });
  assert.equal(previewChunk.isError, undefined);
  assert.equal(Buffer.from((previewChunk.structuredContent as { data: string }).data, "base64").toString("ascii", 0, 4), "glTF");
  for (const name of awaiting.reviewViews) {
    const chunk = await call("scene_asset_chunk", { sceneId: stagedId, name, offset: 0 });
    assert.equal(chunk.isError, undefined);
    assert.ok((chunk.structuredContent as { size: number }).size > 1000);
  }
  const approval = await call("scene_review_decision", { sceneId: stagedId, approved: true });
  assert.equal(approval.structuredContent?.stage, "edit");
  await call("scene_edit",{sceneId:stagedId,code:"bpy.context.scene.camera.location.x += 1"});
  assert.match((await poll(stagedId,"failed")).error,/frozen placement/);
  await call("scene_edit",{sceneId:stagedId,code:"assert bpy.data.objects['RedCube'].data.materials[0].name == 'Red'\nassert bpy.data.materials['Red'].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value[0] > 0.5\nbpy.data.materials['Red'].node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=0.45"});
  await poll(stagedId);await reviewFixture(stagedReview(3));
  await call("scene_edit",{sceneId:stagedId,code:"bpy.data.materials['Red'].node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=0.2"});
  assert.match((await poll(stagedId,"failed")).error,/frozen materials/);
  await call("scene_edit",{sceneId:stagedId,code:"bpy.data.objects['Key'].data.energy=1400"});
  await poll(stagedId);await reviewFixture(stagedReview(4));
  await call("scene_edit",{sceneId:stagedId,code:"bpy.context.scene.camera.location.x += 1"});
  assert.match((await poll(stagedId,"failed")).error,/frozen placement/);
  await call("scene_edit", { sceneId: stagedId, code: "pass" });
  await poll(stagedId); await reviewFixture(stagedReview(5));
  assert.equal((await call("scene_view", { sceneId: stagedId })).structuredContent?.stage, "completed");
  await call("scene_export", { sceneId: stagedId });
  const finalStage = await poll(stagedId);
  const finalStageBytes = await readFile(join(root, ".canova/runs", stagedId, `artifacts/${finalStage.exportedIteration}/final.glb`));
  const finalStageGltf = JSON.parse(finalStageBytes.subarray(20, 20 + finalStageBytes.readUInt32LE(12)).toString("utf8"));
  assert.ok(finalStageGltf.textures.length > 0, "Final export retains the original textures after structural approval");
  assert.ok(finalStageGltf.materials.some((material: any) => {
    const color = material.pbrMetallicRoughness?.baseColorFactor;
    return color && color[0] > color[1] * 2 && color[0] > color[2] * 2;
  }), "The red source material must survive gray preview generation");
  const lightmapSource = join(root, ".canova/runs", stagedId, "best.blend");
  const lightmapSourceBefore = await readFile(lightmapSource);
  await call("scene_bake", { sceneId: stagedId,
    lightingBakes: [{ objectName: "ShadowReceiver", resolution: 128, samples: 32 }] });
  const prepared = await poll(stagedId);
  assert.equal(prepared.stage, "completed");
  assert.equal(prepared.bake.cacheHit, false);
  assert.equal(prepared.bake.lightingBakes[0].mode, "lightmap");
  assert.ok((await readFile(join(root, ".canova/runs", stagedId, prepared.bake.directory, "prepared.blend"))).length > 0);
  assert.deepEqual(await readFile(lightmapSource), lightmapSourceBefore);
  await call("scene_export", { sceneId: stagedId,
    previewAppearance: { renderMode: "raster", planarReflection: "ShadowReceiver" } });
  const lightmapped = await poll(stagedId);
  assert.equal(lightmapped.bake.id, prepared.bake.id);
  assert.equal(lightmapped.bake.cacheHit, true);
  assert.deepEqual(await readFile(lightmapSource), lightmapSourceBefore);
  const lightmapDirectory = join(root, ".canova/runs", stagedId, `artifacts/${lightmapped.exportedIteration}`);
  const lightmapProfile = JSON.parse(await readFile(join(lightmapDirectory, "render-profile.json"), "utf8"));
  assert.equal(lightmapProfile.previewAppearance.renderMode, "raster");
  assert.equal(lightmapProfile.lightmaps.length, 1);
  const lightmap = lightmapProfile.lightmaps[0];
  assert.equal(lightmap.objectName, "ShadowReceiver");
  assert.equal(lightmap.uvChannel, 1);
  assert.equal(lightmap.samples, 32);
  const lightmapBytes = await readFile(join(lightmapDirectory, "final.glb"));
  const lightmapGltf = JSON.parse(lightmapBytes.subarray(20, 20 + lightmapBytes.readUInt32LE(12)).toString("utf8"));
  const receiverPrimitive = lightmapGltf.meshes[lightmapGltf.nodes.find((node: any) => node.name === "ShadowReceiver").mesh].primitives[0];
  assert.ok(receiverPrimitive.attributes.TEXCOORD_0 !== undefined);
  assert.ok(receiverPrimitive.attributes.TEXCOORD_1 !== undefined);
  const receiverMaterial = lightmapGltf.materials[receiverPrimitive.material];
  assert.ok(receiverMaterial.normalTexture, "Lightmap export preserves the source normal texture");
  assert.equal(receiverMaterial.normalTexture.texCoord ?? 0, 0);
  assert.equal(receiverMaterial.emissiveTexture, undefined, "Baked illumination must not become a physical emitter");
  assert.ok(Math.abs(receiverMaterial.pbrMetallicRoughness.roughnessFactor - 0.8) < 1e-6);
  assert.ok(lightmapped.artifacts.some((file: any) => file.name === lightmap.uri));
  const lightmapChunk = await call("scene_asset_chunk", { sceneId: stagedId, name: lightmap.uri, offset: 0 });
  assert.equal(lightmapChunk.isError, undefined, JSON.stringify(lightmapChunk.content));
  assert.equal(Buffer.from((lightmapChunk.structuredContent as { data: string }).data, "base64").readUInt32BE(0), 0x89504e47);
  const lightmapManifest = JSON.parse(await readFile(join(lightmapDirectory, "manifest.json"), "utf8"));
  assert.ok(lightmapManifest.files.includes(lightmap.uri));
  assert.equal(lightmapManifest.bake.id, prepared.bake.id);
  await writeFile(join(root, "lightmap-scene.json"), JSON.stringify(lightmapped, null, 2));
  // Measure through MCP and SceneStore on the dedicated test bridge, including
  // parent transforms, inherited tags and an abbreviated object inventory.
  const spatialTrial = await prepareSpatialTrial(call, poll, stagedId);
  const relationScene = await call("scene_create", { prompt: "Primitive row on a base for spatial relation integration" });
  const relationId = relationScene.structuredContent!.id as string;
  await poll(relationId);
  const relationGraph = [
    { id: "row", label: "Row", kind: "group", parentId: null, blenderObjectNames: ["RowRoot"], description: "Row group", status: "built" },
    ...[0, 1, 2].map((i) => ({ id: `item${i}`, label: `Item ${i}`, kind: "object", parentId: "row",
      blenderObjectNames: [`Item${i}Root`], description: "Primitive row member", status: "built" })),
    { id: "base", label: "Base", kind: "object", parentId: "row", blenderObjectNames: ["Base"], description: "Horizontal base", status: "built" },
  ];
  const members = [0, 1, 2].map((i) => ({ nodeId: `item${i}`, role: "member" }));
  const relationDefinitions = [
    { id: "contact", type: "support", description: "First item rests on base", criterionIds: ["layout"], axis: "z", tolerance: 0.001,
      participants: [{ nodeId: "item0", role: "subject" }, { nodeId: "base", role: "support" }] },
    { id: "row-alignment", type: "alignment", description: "Centers share world Y", criterionIds: ["layout"], axis: "y", tolerance: 0.001, participants: members },
    { id: "row-spacing", type: "spacing", description: "Centers are four world units apart", criterionIds: ["layout"], axis: "x", tolerance: 0.001, spacing: 4, participants: members },
  ];
  await planFixture({ sceneId: relationId, summary: "Three primitives in a row on a base", graph: relationGraph, relations: relationDefinitions,
    steps: ["Build primitives and verify support, alignment and spacing"], criteria: [{ id: "layout", severity: "blocker", description: "Supported and evenly spaced row" }] });
  const rowBuilt = await call("scene_edit", { sceneId: relationId, code: `
from mathutils import Vector
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
row = bpy.data.objects.new('RowRoot', None)
bpy.context.collection.objects.link(row)
row.location = (10, 5, 0)
row.scale = (2, 1, 1)
for i, x in enumerate([-2, 0.5, 2]):
    owner = bpy.data.objects.new('Item%dRoot' % i, None)
    bpy.context.collection.objects.link(owner)
    owner['scene_node_id'] = 'item%d' % i
    owner.parent = row
    owner.location = (x, 0, 1.5)
    bpy.ops.mesh.primitive_cube_add(size=1)
    mesh = bpy.context.object
    mesh.name = 'Piece%d' % i
    mesh.parent = owner
    mesh.location = (0, 0, 0)
    if i == 0:
        bpy.ops.mesh.primitive_cube_add(size=100)
        hidden = bpy.context.object
        hidden.parent = owner
        hidden.hide_render = True
bpy.ops.mesh.primitive_cube_add(size=1, location=(10, 5, 0.5))
base = bpy.context.object
base.name = 'Base'
base.scale = (20, 10, 1)
base['scene_node_id'] = 'base'
for i in range(305):
    empty = bpy.data.objects.new('InventoryPadding%d' % i, None)
    bpy.context.collection.objects.link(empty)
bpy.ops.object.camera_add(location=(23, -15, 15))
camera = bpy.context.object
camera.rotation_euler = (Vector((10, 5, 1)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type='AREA', location=(10, 0, 10))
bpy.context.object.data.energy = 1000
bpy.context.scene.render.engine = 'CYCLES'
bpy.context.scene.cycles.samples = 1
bpy.context.scene.render.resolution_x = 64
bpy.context.scene.render.resolution_y = 64
` });
  assert.equal(rowBuilt.isError, undefined, JSON.stringify(rowBuilt.content));
  const badRow = await poll(relationId);
  assert.equal(badRow.summary.inventoryTruncated, true);
  assert.deepEqual(badRow.inspection.summary.relationBounds.item0, { min: [5, 4.5, 1], max: [7, 5.5, 2] });
  assert.deepEqual(badRow.inspection.summary.relationChecks.map((c: any) => c.status), ["passed", "passed", "failed"]);
  const firstRelationReviews = badRow.inspection.summary.relationChecks.map((c: any) => ({ relationId: c.relationId,
    passed: c.status === "passed", evidence: c.evidence, ...(c.status === "failed" ? { correction: "Move middle item to local X=0" } : {}) }));
  const falsePass = await call("scene_review", { sceneId: relationId, iteration: badRow.iteration, inspectionId: badRow.inspection.id,
    criteria: [{ id: "layout", passed: true, evidence: "Attempt to override failed spacing measurement" }],
    relationReviews: firstRelationReviews.map((r: any) => ({ ...r, passed: true })),
    visualScore: 100, regressions: [], repairable: true, nextAction: "Export" });
  assert.equal(falsePass.isError, true);
  await reviewFixture({ sceneId: relationId, iteration: badRow.iteration, criteria: [{ id: "layout", passed: false, evidence: "Measured unequal row gaps" }],
    relationReviews: firstRelationReviews, visualScore: 60, regressions: [], repairable: true, nextAction: "Fix middle item" });
  const optimized = await call("scene_optimize", { sceneId: relationId, movableNodeIds: ["item1"], translationStep: 1, passes: 3,
    scorerOverrides: [{ relationId: "row-spacing", id: spatialTrial.candidate.id, hash: spatialTrial.candidate.hash }] });
  assert.equal(optimized.isError, undefined, JSON.stringify(optimized.content));
  const fixedRow = await poll(relationId);
  assert.ok(fixedRow.summary.layoutOptimization.after.score > fixedRow.summary.layoutOptimization.before.score);
  assert.ok(fixedRow.summary.layoutOptimization.acceptedMoves > 0);
  assert.equal(fixedRow.summary.layoutOptimization.candidateOverrides[0].id, spatialTrial.candidate.id);
  assert.equal(fixedRow.summary.spatialEvaluation.results.find((r: any) => r.relationId === "row-spacing").scorerId, "builtin-spatial",
    "A local candidate trial cannot replace the frozen review scorer");
  assert.deepEqual(fixedRow.summary.relationBounds.item0, badRow.summary.relationBounds.item0, "Unscoped anchor remains fixed");
  assert.deepEqual(fixedRow.inspection.summary.relationChecks.map((c: any) => c.status), ["passed", "passed", "passed"]);
  await reviewFixture({ sceneId: relationId, iteration: fixedRow.iteration, criteria: [{ id: "layout", passed: true, evidence: "Measured row restored; this test checks mechanics, not visual quality" }],
    relationReviews: fixedRow.inspection.summary.relationChecks.map((c: any) => ({ relationId: c.relationId, passed: true, evidence: c.evidence })),
    visualScore: 90, regressions: [], repairable: false, nextAction: "Export fixture" });
  await call("scene_export", { sceneId: relationId });
  const rowExport = await poll(relationId);
  const rowGraphURL = rowExport.artifacts.find((file: any) => file.name === "scene-graph.json").url;
  assert.deepEqual((await (await fetch(rowGraphURL)).json()).relations, relationDefinitions);
  await writeFile(join(root, "relation-scene.json"), JSON.stringify(rowExport, null, 2));
  const { shared: sharedSpatial, facing } = await spatialTrial.consolidate(relationId);
  const frozenRow = await call("scene_get", { sceneId: relationId, images: "none" });
  assert.deepEqual((frozenRow.structuredContent!.spatialLibrary as { bindings: unknown[] }).bindings, [], "Activating a new shared scorer cannot change an existing plan");
  await call("scene_continue", { sceneId: relationId, prompt: "Synthetic follow-up using the activated spacing scorer" });
  await poll(relationId);
  await planFixture({ sceneId: relationId, summary: "Verify activated scoring on a new plan", graph: relationGraph, relations: relationDefinitions,
    steps: ["Verify pinned scorer without moving correct geometry"], criteria: [{ id: "layout", severity: "blocker", description: "Supported and evenly spaced row" }] });
  const learnedRun = await call("scene_optimize", { sceneId: relationId, movableNodeIds: ["item1"], translationStep: .1, passes: 1 });
  assert.equal(learnedRun.isError, undefined, JSON.stringify(learnedRun.content));
  const learnedRow = await poll(relationId);
  assert.equal(learnedRow.spatialLibrary.bindings[0].id, sharedSpatial.id);
  assert.equal(learnedRow.summary.spatialEvaluation.results.find((r: any) => r.relationId === "row-spacing").scorerId, sharedSpatial.id);
  assert.equal(learnedRow.summary.layoutOptimization.acceptedMoves, 0, "A correct layout stays fixed");
  await reviewFixture({ sceneId: relationId, iteration: learnedRow.iteration, criteria: [{ id: "layout", passed: true, evidence: "Unchanged measured row" }],
    relationReviews: learnedRow.summary.relationChecks.map((c: any) => ({ relationId: c.relationId, passed: true, evidence: c.evidence })),
    visualScore: 90, regressions: [], repairable: false, nextAction: "Test custom orientation scorer" });
  await call("scene_continue", { sceneId: relationId, prompt: "Synthetic planar orientation score test" }); await poll(relationId);
  const facingRelation = { id: "face-base", type: "skill", description: "First item faces the base center in world XY", criterionIds: ["layout"],
    participants: [{ nodeId: "item0", role: "subject" }, { nodeId: "base", role: "target" }],
    scorer: { id: facing.id, hash: facing.hash }, minScore: .95, parameters: { forwardAxis: 1 } };
  await planFixture({ sceneId: relationId, summary: "Custom Python orientation reward", graph: relationGraph, relations: [facingRelation],
    steps: ["Rotate one existing item toward its target"], criteria: [{ id: "layout", severity: "blocker", description: "Subject faces target" }] });
  const rotated = await call("scene_optimize", { sceneId: relationId, movableNodeIds: ["item0"], translationStep: .0001, rotationStepDegrees: 45, passes: 4 });
  assert.equal(rotated.isError, undefined, JSON.stringify(rotated.content));
  const facingRow = await poll(relationId);
  assert.equal(facingRow.summary.relationChecks[0].scorerId, facing.id);
  assert.equal(facingRow.summary.relationChecks[0].status, "passed");
  assert.ok(facingRow.summary.layoutOptimization.after.score > facingRow.summary.layoutOptimization.before.score);
  const boundedRevisionCases = await testBoundedRevisionGuard(new BlenderClient("127.0.0.1", blenderPort), root);
  const guardPerformance = await testGuardPerformance(new BlenderClient("127.0.0.1", blenderPort), root);
  const report = {
    status: "passed", tools: tools.tools.length, sceneId: id, relationSceneId: relationId, spatialScorerId: sharedSpatial.id,
    reviewPreviewVerified: true, boundedRevisionCases, guardPerformance, experienceLibrary,
    blenderVersion: rendered.summary.blenderVersion, renderBytes: referenceBytes.length, glbBytes: bytes.length,
    checks: ["HTTP MCP initialization/tools/resource", "bearer authorization", "create/plan/edit/render/review/export/view", "provider GLB provenance and import gate (local fixture, no paid API)", "geometry/material/lighting/approved-camera scope rollback", "stable Scene Graph GLB mapping", "five Blender composition views and explicit approval", "lightweight job polling", "named-object inspection", "stale review rejection", "artifact access boundary", "HTTPS single and multi-view host-file transfer", "all reference images in scene_get", "auxiliary asset chunks and access tokens", "continued scene reference input", "failed-edit checkpoint recovery"],
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

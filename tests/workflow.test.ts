import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BlenderClient } from "../src/blender.js";
import { allowedDownloadURL, SceneStore, type Plan } from "../src/store.js";
import { createMcpServer } from "../src/server.js";

class FakeBlender extends BlenderClient {
  failNext = false;
  value = "initial";
  override async execute(code: string) {
    if (this.failNext) { this.failNext = false; throw new Error("Invalid Python edit"); }
    if (code.includes('obj = bpy.data.objects.get("Chair")')) {
      return { name: "Chair", type: "MESH", rotationMode: "QUATERNION", polygonCount: 42,
        matrixWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
    }
    if (code.includes("obj = bpy.data.objects.get(")) throw new Error("Object not found");
    for (const line of code.split("\n")) {
      const save = line.match(/save_as_mainfile\(filepath=(".*")\)/);
      if (save) writeFileSync(JSON.parse(save[1]!), this.value);
      const render = line.match(/render\.filepath = (".*")/);
      if (render) writeFileSync(JSON.parse(render[1]!), Buffer.from("render"));
    }
    return { objects: [], camera: "Camera" };
  }
}
const plan: Plan = {
  summary: "A red cube", steps: ["Build and light a cube"], visualThreshold: 85,
  criteria: [{ id: "cube", description: "Cube is visible", severity: "blocker" }],
};
function setup() {
  const blender = new FakeBlender();
  const root = mkdtempSync(join(tmpdir(), "codex-blender-unit-"));
  return { blender, store: new SceneStore(root, blender), root };
}
function review(iteration: number, score: number, passed = false) {
  return {
    iteration, criteria: [{ id: "cube", passed, evidence: "Rendered image inspected" }],
    visualScore: score, regressions: [], repairable: true, nextAction: "Improve lighting",
  };
}

test("freezes criteria, rejects stale reviews, stops regression and restores best checkpoint", async () => {
  const { store, blender } = setup();
  const scene = store.create("A red cube"); await store.settled();
  assert.throws(() => store.edit(scene.id, "result = {}"), /Plan/);
  store.plan(scene.id, plan);
  assert.throws(() => store.plan(scene.id, plan), /frozen/);
  blender.value = "best-scene";
  store.edit(scene.id, "result = {}"); await store.settled();
  assert.equal(scene.stage, "review");
  assert.throws(() => store.edit(scene.id, "result = {}"), /review/);
  assert.throws(() => store.review(scene.id, review(99, 80)), /latest/);
  assert.throws(() => store.review(scene.id, { ...review(1, 80), criteria: [] }), /every/);
  store.review(scene.id, review(1, 80));
  for (let iteration = 2; iteration <= 3; iteration++) {
    blender.value = `worse-${iteration}`;
    store.edit(scene.id, "result = {}"); await store.settled();
    store.review(scene.id, review(iteration, 60));
  }
  assert.equal(scene.stage, "best_effort");
  assert.equal(scene.best?.iteration, 1);
  assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "best-scene");
  const restored = new SceneStore(store.root, blender).get(scene.id);
  assert.equal(restored.stage, "best_effort");
  store.continue(scene.id, "A softer light");
  assert.equal(scene.stage, "planning");
  assert.equal(scene.startIteration, 3);
});

test("extends only improving repairable fifth review and enforces eight attempts", async () => {
  const { store } = setup();
  const scene = store.create("A cube"); await store.settled(); store.plan(scene.id, plan);
  for (let iteration = 1; iteration <= 8; iteration++) {
    store.edit(scene.id, "result = {}"); await store.settled();
    store.review(scene.id, review(iteration, iteration * 10));
    assert.equal(scene.stage, iteration === 8 ? "best_effort" : "edit");
  }
  assert.equal(scene.extended, true);
  assert.throws(() => store.edit(scene.id, "result = {}"), /review/);
});

test("restores failed edits, refuses unfinished exports, accepts verified criteria", async () => {
  const { store, blender } = setup();
  const scene = store.create("A cube"); await store.settled(); store.plan(scene.id, plan);
  const before = readFileSync(store.path(scene, "current.blend"));
  blender.failNext = true;
  store.edit(scene.id, "invalid python"); await store.settled();
  assert.equal(scene.job?.status, "failed");
  assert.equal(scene.stage, "edit");
  assert.deepEqual(readFileSync(store.path(scene, "current.blend")), before);
  assert.throws(() => store.export(scene.id), /review/);
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, review(2, 95, true));
  assert.equal(scene.stage, "completed");
});

test("validates file host boundary and excludes metadata from downloadable artifacts", async () => {
  assert.equal(allowedDownloadURL("https://files.oaiusercontent.com/image.png", ["oaiusercontent.com"]).protocol, "https:");
  for (const url of ["http://files.oaiusercontent.com/x", "https://oaiusercontent.com.evil.test/x", "https://127.0.0.1/x", "https://user:pass@files.oaiusercontent.com/x", "https://files.oaiusercontent.com:9877/x"]) {
    assert.throws(() => allowedDownloadURL(url, ["oaiusercontent.com"]));
  }
  const { store } = setup();
  const scene = store.create("A cube"); await store.settled();
  assert.equal("token" in store.snapshot(scene, "https://example.com"), false);
  assert.equal(store.allowedFiles(scene).includes("run.json"), false);
  assert.equal(store.allowedFiles(scene).includes("current.blend"), false);
});

test("MCP advertises file transfer, UI resource, prompt and validates tool inputs", async () => {
  const { store } = setup();
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const create = tools.tools.find((tool) => tool.name === "scene_create")!;
    assert.deepEqual(create._meta?.["openai/fileParams"], ["reference"]);
    assert.equal(tools.tools.find((tool) => tool.name === "scene_view")?._meta?.["openai/outputTemplate"], "ui://codex-blender/viewer.html");
    const resources = await client.listResources();
    assert.equal(resources.resources[0]?.mimeType, "text/html;profile=mcp-app");
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts[0]?.name, "blender-scene");
    const invalid = await client.callTool({ name: "scene_create", arguments: { prompt: "" } });
    assert.equal(invalid.isError, true);
    const scene = store.create("A chair"); await store.settled();
    const inspected = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, objectName: "Chair" } }) as CallToolResult;
    const object = inspected.structuredContent?.inspectedObject as { rotationMode: string };
    assert.equal(object.rotationMode, "QUATERNION");
    assert.equal(inspected.content.some((item) => item.type === "image"), false);
    const missing = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, objectName: "Missing" } });
    assert.equal(missing.isError, true);
  } finally { await client.close(); await server.close(); }
});

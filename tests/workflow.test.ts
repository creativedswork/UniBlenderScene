import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BlenderClient } from "../src/service/blender.js";
import { allowedDownloadURL, requestsImageReference, SceneStore, validateSceneGraph, type Plan, type Scene, type SceneNode } from "../src/service/store.js";
import { createMcpServer } from "../src/service/server.js";
import { writeGraphExport } from "../src/service/graph-export.js";
import { checkSceneTools } from "../scripts/check-mcp-tools.js";
import type { ReferenceCapture } from "../src/service/reference-checks.js";

class FakeBlender extends BlenderClient {
  relationBounds?: Record<string, { min: number[]; max: number[] }>;
  referenceCaptures?: ReferenceCapture[];
  bakeExecutions = 0;
  failNext = false;
  failMessage = "Invalid Python edit";
  value = "initial";
  override async execute(code: string) {
    if (this.failNext) { this.failNext = false; throw new Error(this.failMessage); }
    const bakeInfo = code.match(/^bake_info = json.loads\((".*")\)$/m);
    if (bakeInfo) {
      this.bakeExecutions++;
      const directory = JSON.parse(code.match(/^directory = (".*")$/m)![1]!);
      writeFileSync(join(directory, "prepared.blend"), this.value);
      writeFileSync(join(directory, "bake.json"), JSON.stringify({ ...JSON.parse(JSON.parse(bakeInfo[1]!)),
        bakedObjects: [], lightmaps: [], bakedTints: {}, materials: { objects: 0, textures: 0 } }));
      return {};
    }
    if (code.includes('obj = bpy.data.objects.get("Chair")')) {
      return { name: "Chair", type: "MESH", rotationMode: "QUATERNION", polygonCount: 42,
        matrixWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
    }
    if (code.includes("obj = bpy.data.objects.get(")) throw new Error("Object not found");
    if (code.includes('result = {"reviewViews": 5}')) for (const match of code.matchAll(/"([^"\n]+review-(?:main|front|side|top|perspective)\.png)"/g)) {
      writeFileSync(match[1]!, Buffer.from("review"));
    }
    for (const line of code.split("\n")) {
      const save = line.match(/save_as_mainfile\(filepath=(".*")\)/);
      if (save) writeFileSync(JSON.parse(save[1]!), this.value);
      const render = line.match(/render\.filepath = (".*")/);
      if (render) writeFileSync(JSON.parse(render[1]!), Buffer.from(code.includes('result = {"reviewViews": 5}') ? "review" : "render"));
    }
    return { objects: [], camera: "Camera", ...(this.relationBounds ? { relationBounds: this.relationBounds } : {}),
      ...(code.includes('result["referenceCaptures"]') ? { referenceCaptures: this.referenceCaptures } : {}) };
  }
}
const plan: Plan = {
  summary: "A red cube", steps: ["Build and light a cube"], visualThreshold: 85,
  criteria: [{ id: "cube", description: "Cube is visible", severity: "blocker" }],
  graph: [{ id: "cube", label: "Cube", kind: "object", parentId: null, description: "Primitive cube", blenderObjectNames: ["Cube"] }],
  assets: [{ nodeId: "cube", kind: "structure", reason: "Simple primitive fixture" }],
};
const referenceWorkflow: Plan["workflow"] = { stages: [
  { name: "composition", criterionIds: ["cube"], budget: 3 }, { name: "final", criterionIds: ["cube"], budget: 1 },
] };
function approveGraph(store: SceneStore, scene: Scene) {
  store.reviewGraph(scene.id, { checks: ["coverage", "hierarchy", "spatial", "stage_checklists"].map((id) => ({ id, passed: true, evidence: "Reviewed fixture graph" })),
    referenceEvidence: store.referenceImages(scene).map((r) => ({ reference: r.assetName, observation: "Fixture spatial relationship checked" })) });
}
function preparePlan(store: SceneStore, scene: Scene, value: Plan) {
  store.plan(scene.id, value); approveGraph(store, scene);
}
function setup() {
  const blender = new FakeBlender();
  const root = mkdtempSync(join(tmpdir(), "uni-blender-unit-"));
  return { blender, store: new SceneStore(root, blender), root };
}
function legacyRevisionFixture() {
  const context = setup();
  const scene = context.store.create("A cube");
  return context.store.settled().then(() => {
    preparePlan(context.store, scene, { ...plan, workflow: { stages: [
      { name: "geometry", criterionIds: ["cube"], budget: 5 },
      { name: "composition", criterionIds: ["cube"], budget: 3 }, { name: "final", criterionIds: ["cube"], budget: 2 },
    ] } });
    scene.iteration = 21; scene.startIteration = 21; scene.workflowIndex = 1;
    delete scene.stageAllowances;
    scene.reviews = [review(scene, 19, 73), review(scene, 20, 72), review(scene, 21, 60)];
    writeFileSync(context.store.path(scene, "current.blend"), "geometry19");
    writeFileSync(context.store.path(scene, "best.blend"), "geometry19");
    scene.inspection = { id: "stale-rejected21", iteration: 21, stage: "geometry", summary: {} };
    const directory = context.store.path(scene, "previews/19"); mkdirSync(directory, { recursive: true });
    // A source hash, not a filename, establishes restored content provenance.
    const hash = createHash("sha256").update("geometry19").digest("hex");
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({ iteration: 19, sourceBlendSha256: hash }));
    context.store.save(scene);
    const request = { targetPhase: "geometry" as const, additionalBudget: 3, feedback: "Only refine cube geometry", scopeNodeIds: ["cube"],
      expectedIteration: 21, expectedPhase: "composition" as const, expectedStatus: "edit" as const,
      expectedUpdatedAt: scene.updatedAt, requestId: "finite-three" };
    return { ...context, scene, request };
  });
}

function writeGlbFixture(directory: string, nodes: unknown[]) {
  const json = Buffer.from(JSON.stringify({ nodes }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const glb = Buffer.alloc(20 + padded.length);
  glb.write("glTF", 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  writeFileSync(join(directory, "final.glb"), glb);
}

test("finite revision preserves legacy content/history and grants exactly three successful edits", async () => {
  const { store, scene, request, blender, root } = await legacyRevisionFixture();
  const originalPlan = structuredClone(scene.plan), originalReviews = structuredClone(scene.reviews);
  store.revise(scene.id, request);
  const grant = scene.revisions![0]!;
  assert.equal(scene.iteration, 21); assert.equal(scene.startIteration, 21);
  assert.equal(scene.currentContentIteration, 19); assert.equal(scene.workflowIndex, 0);
  assert.equal(scene.inspection, undefined); assert.equal(scene.compositionApproved, false);
  assert.deepEqual(scene.plan, originalPlan); assert.deepEqual(scene.reviews, originalReviews);
  assert.equal(scene.stageAllowances!.geometry!.spent, null, "Unrecorded historical spend must remain unknown, not refillable");
  assert.equal(readFileSync(store.path(scene, `${grant.archive}/current.blend`), "utf8"), "geometry19");
  assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "geometry19");
  store.revise(scene.id, request); assert.equal(scene.revisions!.length, 1);
  assert.throws(() => store.revise(scene.id, { ...request, additionalBudget: 4 }), /requestId/);
  blender.failNext = true;
  store.edit(scene.id, "bad python"); await store.settled();
  assert.equal(scene.iteration, 21); assert.equal(grant.spent, 0); assert.equal(scene.currentContentIteration, 19);
  for (let index = 0; index < 3; index++) {
    blender.value = `candidate${22 + index}`;
    store.edit(scene.id, "pass"); await store.settled();
    assert.equal(scene.iteration, 22 + index); assert.equal(grant.spent, index + 1);
    store.review(scene.id, review(scene, scene.iteration, 74 + index)); await store.settled();
    const decision = store.workflowState(scene).pendingDecision!;
    assert.equal(decision.nextPhase, "composition");
    store.reviewDecision(scene.id, index === 2, undefined, undefined,
      { reviewId: decision.reviewId, ...(index === 2 ? { acceptGaps: true } : {}) });
    await store.settled();
  }
  assert.equal(grant.status, "closed"); assert.equal(scene.workflowIndex, 1);
  assert.equal(scene.stage, "review"); assert.equal(scene.inspection!.stage, "composition");
  assert.equal(scene.compositionRevalidation, true);
  store.review(scene.id, review(scene, scene.iteration, 77, false)); await store.settled();
  assert.equal(scene.stage, "awaiting_review"); assert.equal(scene.compositionApproved, false);
  assert.equal(grant.spent, 3); assert.equal(scene.stageAllowances!.composition!.spent, 0);
  assert.throws(() => store.edit(scene.id, "pass"), /review/);
  const restarted = new SceneStore(root, blender).get(scene.id);
  assert.deepEqual(restarted.revisions, scene.revisions);
  assert.equal(restarted.currentContentIteration, scene.currentContentIteration);
});

test("guard snapshot failures preserve finite revision spend and source", async () => {
  const { store, scene, request, blender } = await legacyRevisionFixture();
  store.revise(scene.id, request);
  for (const message of ["Revision scope violation: unrelated object changed: DeskAsset (object.matrix_world[0][3])", "Revision scope violation: unrelated object removed: DeskAsset", "Unable to read protected mesh channel"]) {
    blender.failMessage = message; blender.failNext = true;
    store.edit(scene.id, "fixture guard failure"); await store.settled();
    assert.equal(scene.job?.status, "failed"); assert.equal(scene.job?.error, message);
    assert.equal(scene.iteration, 21); assert.equal(scene.currentContentIteration, 19);
    assert.equal(scene.revisions![0]!.spent, 0); assert.equal(scene.stage, "edit");
    assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "geometry19");
    assert.equal(scene.pendingAttempt, undefined); assert.equal(scene.inspection, undefined);
  }
});

test("failed revision composition inspection retries without spending edits or approving", async () => {
  const { store, scene, request, blender } = await legacyRevisionFixture();
  const execute = blender.execute.bind(blender);
  blender.execute = async (code: string) => {
    assert.doesNotMatch(code, /\n bpy\.ops\.wm\.open_mainfile/, "Top-level Python must not be indented");
    return execute(code);
  };
  store.revise(scene.id, { ...request, additionalBudget: 1 });
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, review(scene, scene.iteration, 75));
  blender.failNext = true;
  const decision = store.workflowState(scene).pendingDecision!;
  store.reviewDecision(scene.id, true, undefined, undefined, { reviewId: decision.reviewId, acceptGaps: true });
  await store.settled();
  assert.equal(scene.job?.kind, "revision_revalidation");
  assert.equal(scene.job?.status, "failed");
  assert.equal(scene.inspection, undefined);
  const iteration = scene.iteration, spend = scene.revisions![0]!.spent;
  const source = readFileSync(store.path(scene, "current.blend"));
  store.retryReviewViews(scene.id); await store.settled();
  assert.equal(scene.job?.status, "done");
  assert.equal(scene.stage, "review");
  assert.equal(scene.inspection!.stage, "composition");
  assert.equal(scene.compositionApproved, false);
  assert.equal(scene.iteration, iteration);
  assert.equal(scene.revisions![0]!.spent, spend);
  assert.deepEqual(readFileSync(store.path(scene, "current.blend")), source);
});

test("revision rejects invalid budgets, stale state, unsafe scope and unreviewed jobs atomically", async () => {
  const { store, scene, request } = await legacyRevisionFixture();
  const before = JSON.stringify(scene);
  for (const budget of [0, -1, 1.5, 9, NaN, Infinity]) {
    assert.throws(() => store.revise(scene.id, { ...request, additionalBudget: budget }), /budget/);
    assert.equal(JSON.stringify(scene), before);
  }
  assert.throws(() => store.revise(scene.id, { ...request, expectedIteration: 20 }), /Scene changed/);
  assert.throws(() => store.revise(scene.id, { ...request, scopeNodeIds: ["missing"] }), /scope/);
  assert.throws(() => store.revise(scene.id, { ...request, scopeNodeIds: ["cube", "cube"] }), /scope/);
  assert.throws(() => store.revise(scene.id, { ...request, feedback: " " }), /feedback/);
  assert.equal(JSON.stringify(scene), before);
  scene.stage = "review";
  assert.throws(() => store.revise(scene.id, request), /Revision requires/);
  scene.stage = "edit"; scene.job = { id: "busy", kind: "preview", status: "running" };
  assert.throws(() => store.revise(scene.id, request), /still running/);
});

test("a revision failure to persist leaves the previous scene usable", async (t) => {
  const { store, scene, request } = await legacyRevisionFixture();
  const before = structuredClone(scene);
  t.mock.method(store, "save", () => { throw new Error("fixture disk failure"); });
  assert.throws(() => store.revise(scene.id, request), /disk failure/);
  assert.deepEqual(scene, before);
  assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "geometry19");
});

test("revision graphs and assets cannot expand the authorized scope", async () => {
  const { store, scene, request } = await legacyRevisionFixture();
  store.revise(scene.id, request);
  assert.throws(() => store.updateGraph(scene.id, scene.plan!.graph!.map((node) => ({ ...node, description: "Expanded semantics" }))), /frozen semantics/);
  assert.throws(() => store.recordAsset(scene.id, { nodeId: "missing", providers: [], evidence: "fixture" }), /outside/);
  store.updateGraph(scene.id, scene.plan!.graph!.map((node) => ({ ...node, blenderObjectNames: ["NewCube"] })));
  assert.deepEqual(scene.plan!.graph![0]!.blenderObjectNames, ["NewCube"]);
});

test("composition preview uses structural evidence, rebuilds legacy previews and preserves approval", async (t) => {
  const { store } = setup();
  const scene = store.create("Review a cube in 3D"); await store.settled();
  assert.throws(() => store.export(scene.id, true), /composition checkpoint/);
  preparePlan(store, scene, { ...plan, workflow: referenceWorkflow });
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, review(scene, 1, 95, true));
  assert.equal(store.snapshot(scene, "https://example.com").renderUrl, null, "Do not fall back to the beauty render while gray views are being prepared");
  await store.settled();
  assert.equal(scene.stage, "awaiting_review");
  assert.throws(() => store.export(scene.id), /review/);
  const blend = readFileSync(store.path(scene, "best.blend"));
  const directory = store.path(scene, "previews/1"); mkdirSync(directory, { recursive: true });
  writeGlbFixture(directory, [{ name: "Cube", mesh: 0, extras: { scene_node_id: "cube" } }, { name: "Camera", camera: 0 }]);
  const profilePath = join(directory, "render-profile.json");
  writeFileSync(profilePath, JSON.stringify({ camera: { name: "Camera" } }));
  scene.previewedIteration = 1;
  assert.equal(store.allowedFiles(scene).includes("previews/1/final.glb"), false, "Legacy textured previews are not advertised");
  const execute = store.blender.execute.bind(store.blender);
  const exporter = t.mock.method(store.blender, "execute", async (code: string) => {
    if (code.includes("structural_preview = True")) writeFileSync(profilePath, JSON.stringify({ camera: { name: "Camera" }, previewMode: "structural" }));
    return execute(code);
  });
  store.export(scene.id, true); await store.settled();
  assert.equal(scene.job?.status, "done", scene.error);
  assert.equal(scene.stage, "awaiting_review");
  assert.notEqual(scene.compositionApproved, true);
  assert.equal(scene.previewedIteration, 1);
  assert.equal(scene.exportedIteration, undefined);
  assert.deepEqual(readFileSync(store.path(scene, "best.blend")), blend);
  assert.ok(store.allowedFiles(scene).includes("previews/1/final.glb"));
  assert.equal(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")).outcome, "awaiting_review");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.ok(manifest.files.includes("../../review-main.png"));
  assert.equal(manifest.files.includes("../../best.png"), false);
  const snapshot = store.snapshot(scene, "https://example.com");
  assert.match(snapshot.renderUrl as string, /review-main\.png/);
  assert.equal(snapshot.renderUrl, snapshot.bestRenderUrl);
  assert.equal((snapshot.artifacts as { name: string }[]).some((item) => item.name === "best.png"), false);
  const client = new Client({ name: "structural-evidence-test", version: "1" });
  const server = createMcpServer(store, "https://example.com");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const result = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, images: "render" } }) as CallToolResult;
    const image = result.content.find((item) => item.type === "image")!;
    assert.equal(Buffer.from(image.data as string, "base64").toString(), "review");
    for (const name of ["render", "best.png"]) {
      const chunk = await client.callTool({ name: "scene_asset_chunk", arguments: { sceneId: scene.id, name } });
      assert.equal(Buffer.from((chunk.structuredContent as { data: string }).data, "base64").toString(), "review");
    }
  } finally { await client.close(); await server.close(); }
  const job = scene.job?.id;
  store.export(scene.id, true); assert.equal(scene.job?.id, job);
  assert.equal(exporter.mock.callCount(), 1, "A legacy preview must be rebuilt once, then reused");
  const restored = new SceneStore(store.root).get(scene.id);
  assert.ok(store.allowedFiles(restored).includes("previews/1/final.glb"));
  store.retryReviewViews(scene.id);
  assert.equal(scene.previewedIteration, undefined, "Regenerating gray views invalidates the preview manifest and cache");
  assert.equal(store.snapshot(scene, "https://example.com").renderUrl, null);
  await store.settled();
  store.export(scene.id, true); await store.settled();
  assert.equal(scene.previewedIteration, 1);
  store.reviewDecision(scene.id, true);
  assert.equal(store.renderFile(scene), scene.render, "Approval restores the ordinary render path");
  assert.equal(scene.previewedIteration, undefined);
  assert.equal(store.allowedFiles(scene).includes("previews/1/final.glb"), false);
});
function review(scene: Scene, iteration: number, score: number, passed = false) {
  return {
    inspectionId: scene.inspection?.id,
    referenceEvidence: (scene.references ?? (scene.reference ? [{ assetName: "reference" }] : [])).map((r) => ({ reference: r.assetName, observation: "Fixture reference inspected", matches: true })),
    ...(scene.plan?.workflow ? { observations: [{ criterionId: "cube", nodeId: "cube", target: "Visible cube", actual: "Fixture render", evidence: "Render", sceneEvidence: "Fixture inventory", referenceView: "reference", reason: "Mismatch", correction: "Fix cube", acceptance: "Cube visible" }] } : {}),
    iteration, criteria: [{ id: "cube", passed, evidence: "Rendered image inspected" }],
    visualScore: score, regressions: [], repairable: true, nextAction: "Improve lighting",
  };
}

test("workflow state selects phase, presentation source and approval purpose from persisted fields", async () => {
  const { store } = setup();
  const scene = store.create("A cube"); await store.settled();
  assert.equal(store.workflowState(scene).phase, null);
  preparePlan(store, scene, { ...plan, workflow: { stages: [
    { name: "geometry", criterionIds: ["cube"], budget: 5 }, { name: "composition", criterionIds: ["cube"], budget: 3 },
    { name: "materials", criterionIds: ["cube"], budget: 2 }, { name: "lighting", criterionIds: ["cube"], budget: 2 },
    { name: "final", criterionIds: ["cube"], budget: 2 },
  ] } });
  scene.iteration = 17;
  for (const [index, phase] of ["geometry", "composition", "materials", "lighting", "final"].entries()) {
    scene.workflowIndex = index;
    const state = store.workflowState(scene);
    assert.equal(state.phase, phase);
    assert.equal(state.status, "edit");
    assert.equal(state.presentation.mode, index < 2 ? "structural" : "appearance");
    assert.equal(state.presentation.source, "current");
    assert.equal(state.presentation.purpose, "work");
  }
  scene.workflowIndex = 1; scene.stage = "awaiting_review"; scene.best = { ...review(scene, 16, 90, true), iteration: 16 };
  assert.deepEqual(store.workflowState(scene).presentation, { mode: "structural", purpose: "confirmation", source: "checkpoint", iteration: 16 });
  scene.workflowIndex = 4; scene.stage = "completed"; scene.compositionApproved = true;
  assert.deepEqual(store.workflowState(scene).presentation, { mode: "appearance", purpose: "delivery", source: "best", iteration: 16 });
});

test("geometry revision 17 gets its own gray draft without using revision 16 or advancing approval", async () => {
  const { store, blender } = setup();
  const scene = store.create("A cube"); await store.settled();
  preparePlan(store, scene, { ...plan, workflow: { stages: [
    { name: "geometry", criterionIds: ["cube"], budget: 5 },
    { name: "composition", criterionIds: ["cube"], budget: 3 }, { name: "final", criterionIds: ["cube"], budget: 2 },
  ] } });
  scene.iteration = 17; scene.startIteration = 16;
  scene.best = { ...review(scene, 16, 90, true), iteration: 16 };
  scene.render = "renders/iteration-17.png";
  writeFileSync(store.path(scene, scene.render), "legacy-colored-17");
  writeFileSync(store.path(scene, "current.blend"), "working-17");
  writeFileSync(store.path(scene, "best.blend"), "best-16");
  writeFileSync(store.path(scene, "best.png"), "colored-16");
  scene.reviewViews = ["review-main.png", "review-front.png", "review-side.png", "review-top.png", "review-perspective.png"];
  scene.reviewEvidence = { source: "checkpoint", iteration: 16 };
  for (const view of scene.reviewViews) writeFileSync(store.path(scene, view), "old-gray-16");
  const before = store.snapshot(scene, "https://example.com");
  assert.equal(before.renderUrl, null, "Legacy colored geometry renders must be hidden");
  assert.deepEqual(before.reviewViews, [], "Revision 16 views cannot stand in for revision 17");
  const directory = store.path(scene, "previews/17"); mkdirSync(directory, { recursive: true });
  writeGlbFixture(directory, [{ name: "Cube", mesh: 0, extras: { scene_node_id: "cube" } }, { name: "Camera", camera: 0 }]);
  writeFileSync(join(directory, "render-profile.json"), JSON.stringify({ camera: { name: "Camera" }, previewMode: "structural" }));
  store.export(scene.id, true); await store.settled();
  assert.equal(scene.job?.status, "done", scene.error);
  assert.equal(scene.stage, "edit"); assert.equal(scene.workflowIndex, 0);
  assert.equal(scene.iteration, 17); assert.equal(scene.startIteration, 16);
  assert.equal(scene.best.iteration, 16); assert.equal(scene.compositionApproved, false);
  assert.deepEqual(scene.reviewEvidence, { source: "current", iteration: 17, phase: "geometry" });
  assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "working-17");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.source, { kind: "current", purpose: "work", phase: "geometry", iteration: 17 });
  assert.equal(manifest.files.includes("../../best.blend"), false);
  assert.throws(() => store.reviewDecision(scene.id, true), /not awaiting/);
  assert.throws(() => store.export(scene.id), /Complete scene review/);
  const restarted = new SceneStore(store.root, blender);
  assert.deepEqual(restarted.workflowState(restarted.get(scene.id)), store.workflowState(scene));
  assert.ok(restarted.allowedFiles(restarted.get(scene.id)).includes("previews/17/final.glb"));
  blender.value = "working-18";
  store.edit(scene.id, "pass"); await store.settled();
  assert.equal(scene.iteration, 18);
  assert.equal(scene.renderMode, "structural");
  assert.deepEqual(store.snapshot(scene, "https://example.com").reviewViews, []);
  assert.equal(store.allowedFiles(scene).includes("previews/17/final.glb"), false);
});

test("single objects require provider discovery, local generated artifacts or explicit no-provider fallback", async () => {
  const { store, root } = setup();
  const provider = "skill:canova-3d-creation";
  const scene = store.create("A chair"); await store.settled();
  store.plan(scene.id, { ...plan, assets: [{ nodeId: "cube", kind: "object", reason: "Standalone chair" }] });
  assert.throws(() => store.edit(scene.id, "pass"), /Graph review/);
  approveGraph(store, scene);
  assert.throws(() => store.edit(scene.id, "pass"), /asset strategy/);
  store.recordAsset(scene.id, { nodeId: "cube", providers: [provider], evidence: "User-level Skill provides image-to-model generation through its controlled CLI; no MCP generation tool is connected" });
  assert.throws(() => store.edit(scene.id, "pass"), /downloaded local GLB/);
  assert.throws(() => store.recordAsset(scene.id, { nodeId: "cube", providers: [], evidence: "API failed" }), /cannot become a Blender fallback/);
  const invalid = join(store.path(scene, "."), "model.glb"); writeFileSync(invalid, "not a model");
  assert.throws(() => store.recordAsset(scene.id, { nodeId: "cube", providers: [provider], provider, taskId: "task-1", artifactPath: invalid, evidence: "Generated" }), /valid GLB/);
  const bytes = Buffer.alloc(24); bytes.write("glTF");bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(24,8);
  const outside = join(root, "outside.glb");writeFileSync(outside,bytes);
  assert.throws(() => store.recordAsset(scene.id, { nodeId: "cube", providers: [provider], provider, taskId: "task-1", artifactPath: outside, evidence: "Generated" }), /workspace/);
  writeFileSync(invalid,bytes);
  store.recordAsset(scene.id, { nodeId: "cube", providers: [provider], provider, taskId: "task-1", artifactPath: invalid, evidence: "Provider task succeeded" });
  assert.match(scene.assetStrategies![0]!.sha256!, /^[a-f0-9]{64}$/);
  const restarted = new SceneStore(root, store.blender);
  assert.equal(restarted.get(scene.id).assetStrategies![0]!.taskId, "task-1");
  assert.equal(restarted.get(scene.id).assetStrategies![0]!.provider, provider);
  // A separate request can use Blender after checking both tools and Skills.
  const fallback=store.create("Standalone object with no Provider");await store.settled();
  preparePlan(store,fallback,{...plan,assets:[{nodeId:"cube",kind:"object",reason:"Standalone fixture"}]});
  const fallbackStrategy = { nodeId: "cube", providers: [], evidence: "No applicable 3D generation capability" };
  const discovery = { tools: "Connected tool inventory has only Blender editing operations", skills: "Available user and plugin Skill catalog inspected; no Skill exposes 3D generation" };
  assert.throws(() => store.recordAsset(fallback.id, fallbackStrategy), /discovery.tools and discovery.skills/);
  for (const incomplete of [{ ...discovery, tools: " " }, { ...discovery, skills: " " }]) {
    assert.throws(() => store.recordAsset(fallback.id, { ...fallbackStrategy, discovery: incomplete }), /discovery.tools and discovery.skills/);
  }
  // An old saved fallback must be rechecked before it can authorize a new edit.
  fallback.assetStrategies = [fallbackStrategy]; store.save(fallback);
  const legacy = new SceneStore(root, store.blender);
  assert.throws(() => legacy.edit(fallback.id, "pass"), /discovery.tools and discovery.skills/);
  assert.equal(legacy.get(fallback.id).iteration, 0);
  store.recordAsset(fallback.id, { ...fallbackStrategy, discovery });
  assert.deepEqual(new SceneStore(root, store.blender).get(fallback.id).assetStrategies![0]!.discovery, discovery);
  store.edit(fallback.id,"pass");await store.settled();assert.equal(fallback.stage,"review");
});

test("independent provider tasks resume and finish out of order before a single scene assembly", async () => {
  const { store, root, blender } = setup();
  const scene = store.create("A chair and lamp"); await store.settled();
  const provider = "skill:fixture-provider";
  const nodeIds = ["cube", "lamp"];
  preparePlan(store, scene, { ...plan,
    graph: [...plan.graph!, { id: "lamp", label: "Lamp", kind: "object", parentId: null,
      description: "Independent lamp", blenderObjectNames: ["Lamp"] }],
    assets: nodeIds.map(nodeId => ({ nodeId, kind: "object", reason: "Independent generated asset" })),
  });
  for (const nodeId of nodeIds) store.recordAsset(scene.id, { nodeId, providers: [provider], provider,
    taskId: `task-${nodeId}`, evidence: "Provider returned a verified running task; download is pending" });
  const resumed = new SceneStore(root, blender);
  const pending = resumed.get(scene.id);
  assert.deepEqual(pending.assetStrategies!.map(asset => [asset.nodeId, asset.taskId]),
    [["cube", "task-cube"], ["lamp", "task-lamp"]]);
  assert.throws(() => resumed.edit(scene.id, "pass"), /downloaded local GLB/);
  const source = readFileSync(resumed.path(pending, "current.blend"));
  // The second submitted asset finishes first; the first remains pending.
  for (const nodeId of [...nodeIds].reverse()) {
    const directory = resumed.path(pending, `inputs/${nodeId}`); mkdirSync(directory, { recursive: true });
    writeGlbFixture(directory, [{ name: nodeId }]);
    resumed.recordAsset(scene.id, { nodeId, providers: [provider], provider, taskId: `task-${nodeId}`,
      artifactPath: join(directory, "final.glb"), evidence: "Task succeeded and its local GLB was downloaded" });
    if (nodeId === "lamp") {
      const saved = new SceneStore(root, blender).get(scene.id);
      assert.match(saved.assetStrategies!.find(asset => asset.nodeId === "lamp")!.sha256!, /^[a-f0-9]{64}$/);
      assert.equal(saved.assetStrategies!.find(asset => asset.nodeId === "cube")!.artifactPath, undefined);
      assert.throws(() => resumed.edit(scene.id, "pass"), /downloaded local GLB/);
      assert.equal(pending.iteration, 0);
      assert.deepEqual(readFileSync(resumed.path(pending, "current.blend")), source);
    }
  }
  assert.equal(pending.assetStrategies!.length, 2);
  resumed.edit(scene.id, "pass");
  assert.throws(() => resumed.edit(scene.id, "pass"), /still running/);
  await resumed.settled();
  assert.equal(pending.iteration, 1);
  assert.equal(pending.stage, "review");
});

test("legacy fallback discovery can be refreshed after composition without reopening asset generation", async () => {
  const { store } = setup();
  const scene = store.create("An existing procedural object"); await store.settled();
  preparePlan(store, scene, { ...plan, assets: [{ nodeId: "cube", kind: "object", reason: "Standalone fixture" }],
    workflow: { stages: [
      { name: "geometry", criterionIds: ["cube"], budget: 1 },
      { name: "composition", criterionIds: ["cube"], budget: 1 },
      { name: "materials", criterionIds: ["cube"], budget: 1 },
      { name: "final", criterionIds: ["cube"], budget: 1 },
    ] } });
  const old = { nodeId: "cube", providers: [], evidence: "Legacy fallback" };
  scene.assetStrategies = [old]; scene.workflowIndex = 2; scene.compositionApproved = true;
  const source = readFileSync(store.path(scene, "current.blend"));
  const allowances = structuredClone(scene.stageAllowances);
  assert.throws(() => store.edit(scene.id, "pass"), /discovery.tools and discovery.skills/);
  assert.throws(() => store.recordAsset(scene.id, old), /discovery.tools and discovery.skills/);
  assert.throws(() => store.recordAsset(scene.id, { ...old, providers: ["skill:provider"] }), /belongs to geometry/);
  assert.throws(() => store.recordAsset(scene.id, { ...old, artifactPath: "/tmp/new.glb" }), /belongs to geometry/);
  assert.throws(() => store.recordAsset(scene.id, { ...old, nodeId: "unrecorded" }), /belongs to geometry/);
  const discovery = { tools: "Connected tool inventory inspected", skills: "Available Skills inspected" };
  store.recordAsset(scene.id, { ...old, discovery });
  assert.deepEqual(scene.assetStrategies![0]!.discovery, discovery);
  assert.deepEqual(scene.assetStrategyHistory![0]!.strategy, old);
  assert.equal(scene.workflowIndex, 2); assert.equal(scene.compositionApproved, true);
  assert.deepEqual(scene.stageAllowances, allowances);
  assert.deepEqual(readFileSync(store.path(scene, "current.blend")), source);
  store.edit(scene.id, "pass"); await store.settled();
  assert.equal(scene.stage, "review");
});

test("MCP rejects tools-only fallback evidence and accepts Skill-backed providers", async () => {
  const { store } = setup();
  const scene = store.create("A robed character"); await store.settled();
  preparePlan(store, scene, { ...plan, assets: [{ nodeId: "cube", kind: "object", reason: "Standalone character" }] });
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "provider-discovery-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const fallback = { sceneId: scene.id, nodeId: "cube", providers: [], evidence: "No MCP 3D generation tools" };
    const toolsOnly = await client.callTool({ name: "scene_asset_strategy", arguments: fallback });
    assert.equal(toolsOnly.isError, true);
    assert.equal(scene.assetStrategies!.length, 0);
    const incomplete = await client.callTool({ name: "scene_asset_strategy", arguments: { ...fallback, discovery: { tools: "Tool catalog inspected" } } });
    assert.equal(incomplete.isError, true);
    const complete = await client.callTool({ name: "scene_asset_strategy", arguments: { ...fallback,
      discovery: { tools: "No connected 3D generation tools", skills: "No applicable generation Skills in the host catalog" } } });
    assert.equal(complete.isError, undefined);
    assert.equal(scene.assetStrategies![0]!.discovery?.skills, "No applicable generation Skills in the host catalog");
    const discovered = await client.callTool({ name: "scene_asset_strategy", arguments: { ...fallback,
      providers: ["skill:canova-3d-creation"], evidence: "Corrected discovery: user-level Skill exposes image-to-model via CLI" } });
    assert.equal(discovered.isError, undefined);
    const edit = await client.callTool({ name: "scene_edit", arguments: { sceneId: scene.id, code: "pass" } });
    assert.equal(edit.isError, true, "A CLI-backed Provider still requires a generated GLB before Blender mutation");
    const downgrade = await client.callTool({ name: "scene_asset_strategy", arguments: { ...fallback,
      discovery: { tools: "No MCP provider", skills: "Known Skill awaiting user choices" } } });
    assert.equal(downgrade.isError, true);
    assert.equal(scene.iteration, 0);
  } finally { await client.close(); await server.close(); }
});

test("graph review covers every view and failed spatial checks return to planning", async () => {
  const { store } = setup();const scene=store.create("A room");await store.settled();
  scene.references=[{assetName:"reference",fileId:"a",name:"front",mime:"image/png"},{assetName:"reference-2",fileId:"b",name:"side",mime:"image/png"}];
  const p: Plan={...plan,workflow:referenceWorkflow};
  store.plan(scene.id,p);
  const checks=["coverage","hierarchy","spatial","stage_checklists"].map(id=>({id,passed:true,evidence:"Checked"}));
  assert.throws(()=>store.reviewGraph(scene.id,{checks,referenceEvidence:[]}),/every supplied reference/);
  store.reviewGraph(scene.id,{checks:checks.map(c=>({...c,passed:c.id!=="spatial"})),referenceEvidence:[{reference:"reference",observation:"Desk on rear wall"},{reference:"reference-2",observation:"Window perpendicular to desk"}]});
  assert.equal(scene.stage,"planning");assert.throws(()=>store.edit(scene.id,"pass"),/Plan/);
});

test("composition approval cannot be disabled and exhausted failed composition still pauses", async () => {
  const {store,root,blender}=setup();const scene=store.create("A room");await store.settled();
  const workflow: NonNullable<Plan['workflow']>={stages:[{name:"composition",criterionIds:["cube"],budget:1},{name:"materials",criterionIds:["cube"],budget:1},{name:"final",criterionIds:["cube"],budget:1}]};
  assert.throws(()=>store.plan(scene.id,{...plan,workflow:{...workflow,compositionApproval:false}}),/cannot be disabled/);
  preparePlan(store,scene,{...plan,workflow});
  assert.equal(scene.plan!.workflow!.compositionApproval,true);
  store.edit(scene.id,"pass");await store.settled();store.review(scene.id,review(scene,1,0,false));await store.settled();
  assert.equal(scene.stage,"awaiting_review");assert.equal(scene.workflowIndex,0);assert.deepEqual(scene.remainingGaps,["cube","visual_score"]);
  const restart=new SceneStore(root,blender);assert.equal(restart.get(scene.id).stage,"awaiting_review");
  assert.throws(()=>restart.edit(scene.id,"pass"),/review/);assert.throws(()=>restart.export(scene.id),/review/);
  const pending = restart.workflowState(restart.get(scene.id)).pendingDecision!;
  restart.reviewDecision(scene.id,true,undefined,undefined,{reviewId:pending.reviewId,acceptGaps:true});assert.equal(restart.get(scene.id).compositionApproved,true);
  assert.equal(restart.get(scene.id).plan!.workflow!.stages[restart.get(scene.id).workflowIndex!]?.name,"materials");
});

test("budget-one failed edit can retry the same candidate without resetting the request", async()=>{
  const {store,blender}=setup();const scene=store.create("Cube");await store.settled();
  preparePlan(store,scene,{...plan,workflow:{stages:[{name:"final",criterionIds:["cube"],budget:1}]}});
  blender.failNext=true;store.edit(scene.id,"bad python");await store.settled();
  assert.equal(scene.iteration,0);assert.equal(scene.stage,"edit");
  store.edit(scene.id,"fixed python");await store.settled();assert.equal(scene.iteration,1);
  assert.throws(()=>store.review(scene.id,{...review(scene,1,90,true),inspectionId:"stale"}),/inspectionId/);
  assert.throws(()=>store.review(scene.id,{...review(scene,1,90,true),observations:[{criterionId:"cube",nodeId:"cube",target:"Cube",actual:"Cube",evidence:"render"}]}),/sceneEvidence/);
  store.review(scene.id,review(scene,1,90,true));assert.equal(scene.stage,"completed");
});

test("multi-view reviews reject omitted auxiliary evidence and unknown reference names", async()=>{
  const {store}=setup();const scene=store.create("A room");await store.settled();
  scene.references=[{assetName:"reference",fileId:"a",name:"front",mime:"image/png"},{assetName:"reference-2",fileId:"b",name:"side",mime:"image/png"}];
  preparePlan(store,scene,{...plan,workflow:referenceWorkflow});store.edit(scene.id,"pass");await store.settled();
  const r=review(scene,1,95,true);
  assert.throws(()=>store.review(scene.id,{...r,referenceEvidence:r.referenceEvidence.slice(0,1)}),/every supplied reference/);
  assert.throws(()=>store.review(scene.id,{...r,referenceEvidence:r.referenceEvidence.map(({reference,observation})=>({reference,observation}))}),/explicit match verdict/);
  assert.throws(()=>store.review(scene.id,{...r,observations:r.observations!.map(o=>({...o,referenceView:"not-a-view"}))}),/supplied reference asset/);
});

test("a visible mismatch keeps a reference checkpoint as work after composition budget exhaustion", async () => {
  const { store, root, blender } = setup();
  const scene = store.create("Rebuild the landscape");
  await store.settled();
  scene.reference = { fileId: "photo", name: "Landscape", mime: "image/png" };
  const anchors: Plan["referenceAnchors"] = [
    { id: "subject", description: "Castle occupies half the frame", targetBox: [0.16, 0.16, 0.66, 0.55] },
    { id: "foreground", description: "Foreground wildflowers", targetBox: [0, 0.69, 1, 1] },
  ];
  const workflow = { stages: referenceWorkflow!.stages.map(stage => ({ ...stage, budget: 1 })) };
  preparePlan(store, scene, { ...plan, referenceAnchors: anchors, workflow });
  store.edit(scene.id, "pass");
  await store.settled();
  store.review(scene.id, {
    ...review(scene, 1, 95, true),
    referenceAlignment: anchors.map(anchor => ({ id: anchor.id, renderBox: anchor.targetBox, evidence: "Broad bounds align" })),
    referenceEvidence: [{ reference: "reference", matches: false, observation: "Grass occupies the foreground box, but the prominent flowers are absent." }],
  });
  await store.settled();
  const restarted = new SceneStore(root, blender);
  const saved = restarted.get(scene.id);
  assert.equal(saved.stage, "awaiting_review");
  assert.equal(restarted.workflowState(saved).presentation.purpose, "work");
  assert.deepEqual(saved.remainingGaps, ["reference_view:reference"]);
  assert.equal(restarted.renderFile(saved), "review-main.png");
  const decision = restarted.workflowState(saved).pendingDecision!;
  assert.equal(decision.nextPhase, "final");
  assert.throws(() => restarted.reviewDecision(scene.id, true), /reviewId/);
  assert.throws(() => restarted.reviewDecision(scene.id, true, undefined, undefined, { reviewId: decision.reviewId }), /accept the listed/);
  assert.equal(saved.compositionApproved, false);
});

test("failed geometry, material and lighting reviews wait for the user's stage decision", async () => {
  const { store } = setup();
  const scene = store.create("A room");
  await store.settled();
  scene.reference = { fileId: "photo", name: "Room", mime: "image/png" };
  const referenceAnchors: NonNullable<Plan["referenceAnchors"]> = [
    { id: "cube", description: "Cube silhouette", targetBox: [0.2, 0.25, 0.8, 0.75] },
    { id: "floor", description: "Visible floor", targetBox: [0, 0.6, 1, 1] },
  ];
  preparePlan(store, scene, { ...plan, referenceAnchors, workflow: { stages: (["geometry", "composition", "materials", "lighting", "final"] as const)
    .map(name => ({ name, criterionIds: ["cube"], budget: name === "geometry" ? 2 : 1 })) } });

  const runReview = async (passed: boolean, matches = true) => {
    store.edit(scene.id, "pass");
    await store.settled();
    const phase = store.workflowState(scene).phase;
    store.review(scene.id, { ...review(scene, scene.iteration, 95, passed),
      referenceEvidence: [{ reference: "reference", matches, observation: "The foreground finish loses the visible grain." }],
      ...(["composition", "final"].includes(phase!) ? { referenceAlignment: referenceAnchors.map(anchor => ({
        id: anchor.id, renderBox: anchor.targetBox, evidence: "The bounds align",
      })) } : {}),
    });
    await store.settled();
    return store.workflowState(scene);
  };
  const geometry = await runReview(false);
  assert.equal(geometry.status, "awaiting_review");
  assert.equal(geometry.pendingDecision?.nextPhase, "composition");
  assert.equal(geometry.pendingDecision?.remainingRounds, 1);
  assert.deepEqual(geometry.pendingDecision?.issues, [{ id: "cube", evidence: "Rendered image inspected" }]);
  assert.throws(() => store.edit(scene.id, "pass"), /review/);
  assert.throws(() => store.reviewDecision(scene.id, false, undefined, undefined, { reviewId: "stale" }), /reviewId/);
  store.reviewDecision(scene.id, false, "Refine the cube silhouette", undefined, { reviewId: geometry.pendingDecision!.reviewId });
  assert.equal(scene.stageAllowances!.geometry!.spent, 1);
  assert.equal(scene.reviewFeedback, "Refine the cube silhouette");
  assert.equal((await runReview(true)).phase, "composition");
  assert.equal((await runReview(true)).presentation.purpose, "confirmation");
  store.reviewDecision(scene.id, true);

  const materials = await runReview(true, false);
  assert.equal(materials.pendingDecision?.nextPhase, "lighting");
  assert.equal(materials.pendingDecision?.issues[0]?.id, "reference_view:reference");
  assert.equal(materials.presentation.mode, "appearance");
  assert.equal(store.renderFile(scene), "best.png");
  assert.throws(() => store.reviewDecision(scene.id, false, undefined, undefined, { reviewId: materials.pendingDecision!.reviewId }), /additional rounds/);
  store.reviewDecision(scene.id, false, undefined, undefined, { reviewId: materials.pendingDecision!.reviewId, additionalBudget: 1 });
  assert.deepEqual({ spent: scene.stageAllowances!.materials!.spent, limit: scene.stageAllowances!.materials!.budget }, { spent: 1, limit: 2 });
  assert.equal((await runReview(true)).phase, "lighting");

  const lighting = await runReview(false);
  assert.equal(lighting.pendingDecision?.nextPhase, "final");
  store.reviewDecision(scene.id, true, undefined, undefined, { reviewId: lighting.pendingDecision!.reviewId, acceptGaps: true });
  assert.equal(scene.reviews.at(-1)?.criteria[0]?.passed, false);
  assert.equal(scene.acceptedStageGaps?.at(-1)?.phase, "lighting");
  assert.equal((await runReview(true)).status, "completed");
});

test("legacy active workflows replan from the saved checkpoint after upgrade", async()=>{
  const {store,root,blender}=setup();const scene=store.create("Legacy scene");await store.settled();
  preparePlan(store,scene,plan);delete scene.plan!.assets;store.save(scene);
  const restored=new SceneStore(root,blender).get(scene.id);
  assert.equal(restored.stage,"planning");assert.match(restored.reviewFeedback!,/Workflow upgraded/);
  assert.equal(readFileSync(store.path(scene,"current.blend"),"utf8"),"initial");
});

test("freezes criteria, rejects stale reviews, stops regression and restores best checkpoint", async () => {
  const { store, blender } = setup();
  const scene = store.create("A red cube"); await store.settled();
  assert.throws(() => store.edit(scene.id, "result = {}"), /Plan/);
  preparePlan(store, scene, plan);
  assert.throws(() => store.plan(scene.id, plan), /frozen/);
  blender.value = "best-scene";
  store.edit(scene.id, "result = {}"); await store.settled();
  assert.equal(scene.stage, "review");
  assert.throws(() => store.edit(scene.id, "result = {}"), /review/);
  assert.throws(() => store.review(scene.id, review(scene, 99, 80)), /latest/);
  assert.throws(() => store.review(scene.id, { ...review(scene, 1, 80), criteria: [] }), /every/);
  store.review(scene.id, review(scene, 1, 80));
  for (let iteration = 2; iteration <= 3; iteration++) {
    blender.value = `worse-${iteration}`;
    store.edit(scene.id, "result = {}"); await store.settled();
    store.review(scene.id, review(scene, iteration, 60));
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
  const scene = store.create("A cube"); await store.settled(); preparePlan(store, scene, plan);
  for (let iteration = 1; iteration <= 8; iteration++) {
    store.edit(scene.id, "result = {}"); await store.settled();
    store.review(scene.id, review(scene, iteration, iteration * 10));
    assert.equal(scene.stage, iteration === 8 ? "best_effort" : "edit");
  }
  assert.equal(scene.extended, true);
  assert.throws(() => store.edit(scene.id, "result = {}"), /review/);
});

test("restores failed edits, refuses unfinished exports, accepts verified criteria", async () => {
  const { store, blender } = setup();
  const scene = store.create("A cube"); await store.settled(); preparePlan(store, scene, plan);
  const before = readFileSync(store.path(scene, "current.blend"));
  blender.failNext = true;
  store.edit(scene.id, "invalid python"); await store.settled();
  assert.equal(scene.job?.status, "failed");
  assert.equal(scene.stage, "edit");
  assert.deepEqual(readFileSync(store.path(scene, "current.blend")), before);
  assert.throws(() => store.export(scene.id), /review/);
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, review(scene, 1, 95, true));
  assert.equal(scene.stage, "completed");
});

test("standalone baking preserves workflow and invalidates prepared results when inputs or files change", async () => {
  const { store, blender } = setup();
  const scene = store.create("A cube"); await store.settled();
  assert.throws(() => store.bake(scene.id), /review/);
  preparePlan(store, scene, plan);
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, review(scene, 1, 95, true));
  const source = readFileSync(store.path(scene, "best.blend"));
  store.bake(scene.id, [{ objectName: "Cube", resolution: 128 }]); await store.settled();
  assert.equal(scene.job?.status, "done", scene.error);
  assert.equal(scene.stage, "completed"); assert.equal(scene.iteration, 1);
  assert.equal(scene.bake?.lightingBakes[0]?.mode, "lightmap");
  const firstId = scene.bake!.id;
  store.bake(scene.id); await store.settled();
  assert.equal(scene.bake?.cacheHit, true); assert.equal(blender.bakeExecutions, 1);
  assert.deepEqual(readFileSync(store.path(scene, "best.blend")), source);
  store.bake(scene.id, [{ objectName: "Cube", resolution: 256 }]); await store.settled();
  assert.notEqual(scene.bake?.id, firstId); assert.equal(blender.bakeExecutions, 2);
  const secondId = scene.bake!.id;
  writeFileSync(store.path(scene, "best.blend"), "changed fixture checkpoint");
  store.bake(scene.id); await store.settled();
  assert.notEqual(scene.bake?.id, secondId); assert.equal(blender.bakeExecutions, 3);
  unlinkSync(store.path(scene, `${scene.bake!.directory}/prepared.blend`));
  store.bake(scene.id); await store.settled();
  assert.equal(scene.bake?.cacheHit, false); assert.equal(blender.bakeExecutions, 4);
  const metadataPath = store.path(scene, `${scene.bake!.directory}/bake.json`);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  writeFileSync(metadataPath, JSON.stringify({ ...metadata, lightmaps: [{ uri: "lightmap-99.png" }] }));
  store.bake(scene.id); await store.settled();
  assert.equal(scene.bake?.cacheHit, false); assert.equal(blender.bakeExecutions, 5);
  unlinkSync(store.path(scene, `${scene.bake!.directory}/prepared.blend`));
  blender.failNext = true;
  store.bake(scene.id); await store.settled();
  assert.equal(scene.job?.status, "failed");
  assert.equal(scene.stage, "completed");
  assert.throws(() => readFileSync(metadataPath), /ENOENT/, "Failed rebuilds cannot retain a completion report");
  store.bake(scene.id); await store.settled();
  assert.equal(scene.job?.status, "done"); assert.equal(blender.bakeExecutions, 6);
  assert.throws(() => store.bake(scene.id, [{ objectName: "Cube", resolution: 128, samples: 1 }]), /samples/);
  assert.equal(scene.exportedIteration, undefined, "Baking does not publish an export");
});

test("explicit lighting bakes invalidate final export cache without changing the checkpoint", async () => {
  const { store, blender } = setup();
  const scene = store.create("A cube"); await store.settled(); preparePlan(store, scene, plan);
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, review(scene, 1, 95, true));
  const source = readFileSync(store.path(scene, "best.blend"));
  const directory = store.path(scene, "artifacts/1"); mkdirSync(directory, { recursive: true });
  writeGlbFixture(directory, [{ name: "Cube", mesh: 0, extras: { scene_node_id: "cube" } }, { name: "Camera", camera: 0 }]);
  writeFileSync(join(directory, "render-profile.json"), JSON.stringify({ camera: { name: "Camera" } }));
  store.export(scene.id); await store.settled();
  assert.equal(scene.job?.status, "done", scene.error);
  const originalVersion = scene.exportVersion;
  store.export(scene.id, false, [{ objectName: "Cube", resolution: 512 }]); await store.settled();
  assert.equal(scene.job?.status, "done", scene.error);
  assert.notEqual(scene.exportVersion, originalVersion);
  const version = scene.exportVersion;
  store.export(scene.id); await store.settled();
  assert.equal(scene.exportVersion, version, "Omitted settings reuse the baked export");
  assert.deepEqual(scene.exportLighting, [{ objectName: "Cube", resolution: 512 }]);
  scene.exportPipelineHash = "older exporter";
  store.export(scene.id); await store.settled();
  assert.notEqual(scene.exportVersion, version, "An exporter upgrade rebuilds the asset and invalidates viewer URLs");
  const previousAppearanceVersion = scene.exportVersion;
  store.export(scene.id, false, undefined, { exposureEV: 0.8, saturation: 1.15, whiteBalance: [0.9, 1, 1.4], contrast: 1.3, hazeScale: 0.25, dust: {
    color: [0.6, 0.3, 0.1], wind: [0.2, 0, 0], volumes: [{ center: [0, 0, 1], radius: [2, 2, 1], density: 0.2 }],
  } }); await store.settled();
  assert.notEqual(scene.exportVersion, previousAppearanceVersion, "Changing web appearance rebuilds the delivery profile");
  const appearanceVersion = scene.exportVersion;
  store.export(scene.id); await store.settled();
  assert.equal(scene.exportVersion, appearanceVersion);
  assert.equal(scene.exportAppearance?.exposureEV, 0.8);
  assert.deepEqual(scene.exportAppearance?.whiteBalance, [0.9, 1, 1.4]);
  assert.equal(scene.exportAppearance?.contrast, 1.3);
  assert.equal(blender.bakeExecutions, 2, "Exporter and appearance changes reuse prepared textures");
  assert.throws(() => store.export(scene.id, false, undefined, { exposureEV: Infinity }), /appearance/);
  assert.throws(() => store.export(scene.id, false, undefined, { whiteBalance: [1, 0, 1] }), /appearance/);
  assert.throws(() => store.export(scene.id, false, undefined, { contrast: 3 }), /appearance/);
  assert.throws(() => store.export(scene.id, false, undefined, { hazeScale: -1 }), /appearance/);
  assert.throws(() => store.export(scene.id, false, undefined, { dust: { color: [1, 1, 1], wind: [0, 0, 0],
    volumes: [{ center: [0, 0, 0], radius: [0, 1, 1], density: 0.1 }] } }), /appearance/);
  assert.throws(() => store.export(scene.id, false, [{ objectName: "Cube", resolution: 32 }]), /resolution|bake/i);
  assert.throws(() => store.export(scene.id, false, [{ objectName: "Cube", resolution: 512 }, { objectName: "Cube", resolution: 512 }]), /unique|bake/i);
  assert.equal(scene.iteration, 1);
  assert.deepEqual(readFileSync(store.path(scene, "best.blend")), source);
});

test("reference alignment blocks a high-scoring review until major regions match", async () => {
  const { store } = setup();
  const scene = store.create("Rebuild a room"); await store.settled();
  scene.reference = { fileId: "photo", name: "Room", mime: "image/png" };
  const referencePlan: Plan = {
    ...plan, workflow: referenceWorkflow,
    referenceAnchors: [
      { id: "desk", description: "Main desk", targetBox: [0.1, 0.4, 0.8, 0.75] },
      { id: "chair", description: "Foreground chair", targetBox: [0.55, 0.45, 0.9, 0.95] },
    ],
  };
  assert.throws(() => store.plan(scene.id, plan), /two image-space anchors/);
  preparePlan(store, scene, referencePlan);
  store.edit(scene.id, "result = {}"); await store.settled();
  const mismatch = {
    ...review(scene, 1, 95, true),
    referenceAlignment: [
      { id: "desk", renderBox: [0.1, 0.4, 0.62, 0.75] as [number, number, number, number], evidence: "Desk ends too early" },
      { id: "chair", renderBox: [0.55, 0.25, 0.9, 0.8] as [number, number, number, number], evidence: "Chair sits too high" },
    ],
  };
  assert.throws(() => store.review(scene.id, review(scene, 1, 95, true)), /every reference anchor/);
  store.review(scene.id, mismatch);
  await store.settled();
  assert.equal(scene.stage, "awaiting_review");
  assert.equal(scene.best?.alignmentMaxError, 0.2);
  store.reviewDecision(scene.id, false, undefined, undefined, { reviewId: store.workflowState(scene).pendingDecision!.reviewId });
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, {
    ...review(scene, 2, 95, true),
    referenceAlignment: [
      { id: "desk", renderBox: [0.11, 0.42, 0.77, 0.74], evidence: "Desk now fills the planned frame" },
      { id: "chair", renderBox: [0.56, 0.47, 0.88, 0.93], evidence: "Chair position matches" },
    ],
  });
  assert.equal(scene.stage, "awaiting_review");
  assert.ok(scene.best!.alignmentMaxError! < 0.08);
});

test("checkpoint reference checks gate acceptance and survive a continuation", async () => {
  const { store, root, blender } = setup();
  const scene = store.create("Rebuild a room");
  await store.settled();
  scene.reference = { fileId: "photo", name: "Room", mime: "image/png" };
  const referencePlan: Plan = {
    ...plan, workflow: referenceWorkflow,
    referenceAnchors: [
      { id: "desk", description: "Main desk", targetBox: [0.1, 0.4, 0.8, 0.75] },
      { id: "chair", description: "Foreground chair", targetBox: [0.55, 0.45, 0.9, 0.95] },
    ],
    referenceChecks: [
      { id: "edge", kind: "edge", side: "right", reference: "reference", nodeId: "cube", target: [[0.65, 0.4], [0.65, 0.6]], tolerance: 0.02 },
      { id: "point", kind: "point", landmarkId: "center", reference: "reference", nodeId: "cube", target: [0.5, 0.5], tolerance: 0.02 },
    ],
  };
  const alignment = referencePlan.referenceAnchors!.map(anchor => ({
    id: anchor.id, renderBox: anchor.targetBox, evidence: "Matched reference box",
  }));
  const capture = (x: number): ReferenceCapture[] => [
    { id: "edge", samples: [{ point: [x, 0.4], objectName: "Cube" }, { point: [x, 0.6], objectName: "Cube" }] },
    { id: "point", samples: [{ point: [0.5, 0.5], objectName: "Cube" }] },
  ];
  preparePlan(store, scene, referencePlan);
  blender.referenceCaptures = capture(0.8);
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, { ...review(scene, 1, 100, true), referenceAlignment: alignment });
  await store.settled();
  assert.equal(scene.stage, "awaiting_review");
  assert.deepEqual(scene.best!.referenceMeasurements!.map(item => item.status), ["failed", "passed"]);
  store.reviewDecision(scene.id, false, undefined, undefined, { reviewId: store.workflowState(scene).pendingDecision!.reviewId });

  blender.referenceCaptures = capture(0.65);
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, { ...review(scene, 2, 80, true), referenceAlignment: alignment });
  await store.settled();
  assert.equal(scene.stage, "awaiting_review");
  assert.equal(scene.best!.iteration, 2);
  store.reviewDecision(scene.id, false, undefined, undefined, { reviewId: store.workflowState(scene).pendingDecision!.reviewId });

  blender.referenceCaptures = capture(0.66);
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, { ...review(scene, 3, 90, true), referenceAlignment: alignment });
  await store.settled();
  assert.equal(scene.stage, "awaiting_review");
  assert.equal(scene.best!.iteration, 3);
  assert.equal(store.referenceAlignmentEvidence(scene, "reference")?.file, "renders/iteration-3.png");
  store.reviewDecision(scene.id, true);

  blender.referenceCaptures = undefined;
  store.edit(scene.id, "pass"); await store.settled();
  store.review(scene.id, { ...review(scene, 4, 100, true), referenceAlignment: alignment });
  assert.equal(scene.stage, "awaiting_review");
  assert.deepEqual(scene.remainingGaps, ["reference_check:edge", "reference_check:point"]);
  assert.equal(store.workflowState(scene).presentation.purpose, "work");
  assert.throws(() => store.export(scene.id), /Complete scene review/);
  assert.throws(() => store.bake(scene.id), /Complete scene review/);

  const resumed = new SceneStore(root, blender);
  const pending = resumed.workflowState(resumed.get(scene.id)).pendingDecision!;
  assert.equal(pending.nextPhase, "delivery");
  resumed.reviewDecision(scene.id, true, undefined, undefined, { reviewId: pending.reviewId, acceptGaps: true });
  assert.equal(resumed.get(scene.id).stage, "best_effort");
  assert.equal(resumed.workflowState(resumed.get(scene.id)).presentation.purpose, "delivery");
  assert.deepEqual(resumed.get(scene.id).acceptedStageGaps?.at(-1)?.issues.map(item => item.id), scene.remainingGaps);
  resumed.continue(scene.id, "Adjust only the light");
  const changed = { ...referencePlan, referenceChecks: referencePlan.referenceChecks!.map(item => ({ ...item, tolerance: 1 })) };
  assert.throws(() => resumed.plan(scene.id, changed), /Frozen reference check/);
  const nextPlan = { ...referencePlan, referenceChecks: undefined };
  resumed.plan(scene.id, nextPlan);
  assert.deepEqual(resumed.get(scene.id).plan?.referenceChecks, referencePlan.referenceChecks);
});

test("reference requests cannot silently create a text-only scene", () => {
  const { store } = setup();
  assert.equal(requestsImageReference("制作一个如图所示的场景"), true);
  assert.equal(requestsImageReference("Rebuild this room from the attached photo"), true);
  assert.equal(requestsImageReference("Create a room with a framed picture"), false);
  assert.throws(() => store.create("制作一个如图所示的场景"), /reference or references/);
  assert.equal(store.scenes.size, 0);
});

test("plans keep a bounded global contract", async () => {
  const { store } = setup();
  const scene = store.create("A room"); await store.settled();
  assert.throws(() => store.plan(scene.id, {
    ...plan,
    criteria: Array.from({ length: 13 }, (_, index) => ({
      id: `criterion-${index}`, description: "Visible", severity: "major" as const,
    })),
  }), /1-12 global criteria/);
  assert.equal(scene.stage, "planning");
});

test("Scene Graph rejects duplicate names, unknown relations, and parent cycles", () => {
  const nodes: SceneNode[] = [
    { id: "root", label: "Root", kind: "group", parentId: null, blenderObjectNames: [], description: "All parts" },
    { id: "cube", label: "Cube", kind: "object", parentId: "root", blenderObjectNames: ["Cube"], description: "Main subject" },
  ];
  validateSceneGraph(nodes);
  assert.throws(() => validateSceneGraph([...nodes, { ...nodes[1]!, id: "other" }]), /object names/);
  assert.throws(() => validateSceneGraph([{ ...nodes[0]!, parentId: "cube" }, nodes[1]!]), /cycle/);
  assert.throws(() => validateSceneGraph([nodes[0]!, { ...nodes[1]!, relations: [{ targetId: "missing", description: "beside" }] }]), /relation target/);
});

test("staged review pauses at composition and resumes from the same checkpoint", async () => {
  const { store, blender } = setup();
  const scene = store.create("A cube"); await store.settled();
  const graph: SceneNode[] = [{ id: "cube", label: "Cube", kind: "object", parentId: null,
    blenderObjectNames: ["Cube"], description: "Main subject", status: "planned" }];
  const stagedReview = (iteration: number, score: number) => ({ ...review(scene, iteration, score, true),
    observations: [{ criterionId: "cube", nodeId: "cube", target: "Visible cube", actual: "Cube shown",
      evidence: "Rendered frame", sceneEvidence: "Fixture inventory" }] });
  preparePlan(store, scene, { ...plan, graph, workflow: { compositionApproval: true, stages: [
    { name: "geometry", criterionIds: ["cube"], budget: 1 },
    { name: "composition", criterionIds: ["cube"], budget: 1 },
    { name: "final", criterionIds: ["cube"], budget: 1 },
  ] } });
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, stagedReview(1, 90));
  assert.equal(scene.workflowIndex, 1);
  assert.equal(scene.stage, "edit");
  store.updateGraph(scene.id, [{ ...graph[0]!, status: "built" }]);
  store.edit(scene.id, "result = {}"); await store.settled();
  blender.failNext = true;
  store.review(scene.id, stagedReview(2, 91)); await store.settled();
  assert.equal(scene.stage, "awaiting_review");
  assert.equal(scene.job?.status, "failed");
  assert.throws(() => store.reviewDecision(scene.id, true), /views are not ready/);
  store.retryReviewViews(scene.id); await store.settled();
  assert.equal(scene.reviewViews?.length, 5);
  assert.throws(() => store.edit(scene.id, "result = {}"), /review/);
  assert.throws(() => store.export(scene.id), /review/);
  assert.equal(new SceneStore(store.root, blender).get(scene.id).stage, "awaiting_review");
  store.reviewDecision(scene.id, false, "Move the camera", "composition");
  assert.equal(scene.workflowIndex, 1);
  assert.match(scene.reviewFeedback!, /Move the camera/);
  assert.equal(scene.stage, "awaiting_review", "Rejecting confirmation must not refill the composition budget");
  assert.throws(() => store.edit(scene.id, "result = {}"), /review/);
  store.revise(scene.id, { targetPhase: "composition", additionalBudget: 1, feedback: "Move the camera", scopeNodeIds: ["cube"],
    expectedIteration: scene.iteration, expectedPhase: "composition", expectedStatus: "awaiting_review",
    expectedUpdatedAt: scene.updatedAt, requestId: "camera-revision" });
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, stagedReview(3, 92)); await store.settled();
  assert.equal(scene.stage, "review", "Revision closes with a fresh zero-edit composition inspection");
  store.review(scene.id, stagedReview(3, 92)); await store.settled();
  store.reviewDecision(scene.id, true);
  assert.equal(scene.workflowIndex, 2);
  assert.equal(scene.stage, "edit");
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, stagedReview(4, 95));
  assert.equal(scene.stage, "completed");
});

test("relation review binds measured geometry to criteria and survives service restart", async () => {
  const { store, blender, root } = setup();
  const scene = store.create("Two primitives with an explicit support relation");
  await store.settled();
  const relation = { id: "cube-on-base", type: "support" as const, description: "Cube rests on base",
    participants: [{ nodeId: "cube", role: "subject" }, { nodeId: "base", role: "support" }],
    criterionIds: ["cube"], axis: "z" as const, tolerance: 0.01 };
  const graph: SceneNode[] = [...plan.graph!, { id: "base", label: "Base", kind: "object", parentId: null,
    blenderObjectNames: ["Base"], description: "Base primitive" }];
  const relationPlan = { ...plan, graph, relations: [relation], assets: [...plan.assets!, { nodeId: "base", kind: "structure" as const, reason: "Primitive base" }] };
  assert.throws(() => store.plan(scene.id, { ...relationPlan, relations: [{ ...relation, criterionIds: ["missing"] }] }), /criterionIds/);
  preparePlan(store, scene, relationPlan);
  blender.relationBounds = { cube: { min: [0, 0, 2], max: [1, 1, 3] }, base: { min: [-1, -1, 0], max: [2, 2, 1] } };
  store.edit(scene.id, "result = {}"); await store.settled();
  assert.equal((scene.inspection!.summary.relationChecks as { status: string }[])[0]!.status, "failed");
  const oldInspection = scene.inspection!.id;
  const relationReview = { relationId: relation.id, passed: true, evidence: "Measured and visually inspected support" };
  assert.throws(() => store.review(scene.id, review(scene, 1, 95, true)), /active relation/);
  assert.throws(() => store.review(scene.id, { ...review(scene, 1, 95, true), relationReviews: [relationReview] }), /cannot pass/);
  assert.throws(() => store.review(scene.id, { ...review(scene, 1, 95, true), relationReviews: [{ ...relationReview, passed: false, correction: "Lower cube" }] }), /criterion cannot pass/);
  store.review(scene.id, { ...review(scene, 1, 60, false), relationReviews: [{ ...relationReview, passed: false, correction: "Lower cube" }] });
  assert.equal(scene.stage, "edit");
  blender.relationBounds.cube = { min: [0, 0, 1], max: [1, 1, 2] };
  store.edit(scene.id, "result = {}"); await store.settled();
  assert.throws(() => store.review(scene.id, { ...review(scene, 2, 95, true), inspectionId: oldInspection, relationReviews: [relationReview] }), /inspectionId/);
  const resumed = new SceneStore(root, blender);
  const restored = resumed.get(scene.id);
  assert.equal(restored.plan!.relations![0]!.id, relation.id);
  assert.equal((restored.inspection!.summary.relationChecks as { status: string }[])[0]!.status, "passed");
  resumed.review(scene.id, { ...review(restored, 2, 95, true), relationReviews: [relationReview] });
  assert.equal(restored.stage, "completed");
});

test("GLB export maps stable IDs across multiple meshes and rejects missing built nodes", () => {
  const root = mkdtempSync(join(tmpdir(), "uni-graph-export-"));
  const directory = join(root, "artifacts", "7"); mkdirSync(directory, { recursive: true });
  const gltf = { nodes: [
    { name: "Renamed subject", extras: { scene_node_id: "subject" }, children: [1, 2] },
    { name: "Part A", mesh: 0 }, { name: "Part B", mesh: 1 }, { name: "Camera", camera: 0 },
  ] };
  writeGlbFixture(directory, gltf.nodes);
  writeFileSync(join(directory, "render-profile.json"), JSON.stringify({ camera: { name: "Camera" } }));
  writeFileSync(join(root, "best.blend"), "blend");
  writeFileSync(join(root, "best.png"), "render");
  const graph: SceneNode[] = [
    { id: "root", label: "Root", kind: "group", parentId: null, blenderObjectNames: [], description: "All", status: "built" },
    { id: "subject", label: "Subject", kind: "object", parentId: "root", blenderObjectNames: ["Original name"], description: "Main", status: "built" },
  ];
  const relations = [{ id: "subject-in-group", type: "semantic" as const, description: "Subject belongs to the composition",
    participants: [{ nodeId: "root", role: "group" }, { nodeId: "subject", role: "subject" }], criterionIds: ["layout"] }];
  writeGraphExport(directory, 7, graph, "completed", [], undefined, root, relations);
  const output = JSON.parse(readFileSync(join(directory, "scene-graph.json"), "utf8"));
  assert.deepEqual(output.nodes[1].gltfNodeIndices, [1, 2]);
  assert.deepEqual(output.relations, relations);
  assert.equal(output.nodes[0].status, "renderable");
  assert.equal(output.nodes[1].status, "renderable");
  assert.equal(JSON.parse(readFileSync(join(directory, "render-profile.json"), "utf8")).iteration, 7);
  assert.throws(() => writeGraphExport(directory, 7, [{ ...graph[1]!, id: "missing" }], "completed", []), /unknown Scene Graph ID|no GLB mesh/);
});

test("imports local harness attachments only from approved directories", async () => {
  const { store, root } = setup();
  const previous = process.env.LOCAL_REFERENCE_ROOTS;
  const outside = mkdtempSync(join(tmpdir(), "uni-reference-outside-"));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const front = join(root, "front.png"), side = join(root, "side.png");
  writeFileSync(front, png); writeFileSync(side, png);
  writeFileSync(join(outside, "outside.png"), png);
  symlinkSync(join(outside, "outside.png"), join(root, "escape.png"));
  writeFileSync(join(root, "invalid.png"), "not an image");
  try {
    delete process.env.LOCAL_REFERENCE_ROOTS;
    const denied = store.create("A room", undefined, [{ local_path: front }]);
    await store.settled();
    assert.match(denied.error!, /LOCAL_REFERENCE_ROOTS/);
    process.env.LOCAL_REFERENCE_ROOTS = root;
    const scene = store.create("如图创建", undefined, [{ local_path: front }, { local_path: side, label: "side" }]);
    await store.settled();
    assert.equal(scene.job?.status, "done");
    assert.deepEqual(store.referenceImages(scene).map((item) => item.name), ["front.png", "side.png"]);
    assert.equal(scene.references![1]!.label, "side");
    assert.deepEqual(readFileSync(store.path(scene, "reference-2")), png);
    for (const [path, error] of [[join(root, "escape.png"), /LOCAL_REFERENCE_ROOTS/], [join(root, "invalid.png"), /PNG, JPG, or WebP/]] as const) {
      const invalid = store.create("A room", undefined, [{ local_path: path }]);
      await store.settled();
      assert.match(invalid.error!, error);
      assert.equal(invalid.references, undefined);
    }
    const server = createMcpServer(store, "http://localhost");
    const client = new Client({ name: "local-attachments", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const created = await client.callTool({ name: "scene_create", arguments: { prompt: "A room", references: [{ local_path: front }] } }) as CallToolResult;
      assert.equal(created.isError, undefined);
      await store.settled();
      assert.equal(store.get(created.structuredContent!.id as string).job?.status, "done");
      const invalid = await client.callTool({ name: "scene_create", arguments: { prompt: "A room", references: [{ local_path: front, download_url: "https://files.oaiusercontent.com/x", file_id: "x" }] } });
      assert.equal(invalid.isError, true);
    } finally { await client.close(); await server.close(); }
  } finally {
    if (previous === undefined) delete process.env.LOCAL_REFERENCE_ROOTS;
    else process.env.LOCAL_REFERENCE_ROOTS = previous;
  }
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

test("MCP numeric vectors use homogeneous item schemas and retain input constraints", async (t) => {
  const { store } = setup();
  const scene = store.create("Schema validation fixture"); await store.settled();
  const planCall = t.mock.method(store, "plan", () => scene);
  const reviewCall = t.mock.method(store, "review", () => scene);
  const exportCall = t.mock.method(store, "export", () => scene);
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "schema-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    function checkItems(value: unknown, path: string) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "items") assert.equal(Array.isArray(child), false, `${path}.items must be a schema, not a tuple array`);
        checkItems(child, `${path}.${key}`);
      }
    }
    for (const tool of tools) checkItems(tool.inputSchema, tool.name);

    const boxes = ["scene_plan", "scene_review"].map((name) => ({
      name, length: 4, minimum: undefined, maximum: undefined,
      path: name === "scene_plan" ? ["referenceAnchors", "items", "targetBox"] : ["referenceAlignment", "items", "renderBox"],
      args: (box: unknown) => name === "scene_plan" ? { sceneId: scene.id, ...plan,
        referenceAnchors: ["first", "second"].map(id => ({ id, description: "Anchor", targetBox: box })) } : {
        sceneId: scene.id, iteration: 1, inspectionId: "fixture", criteria: [{ id: "cube", passed: true, evidence: "Fixture" }],
        visualScore: 90, regressions: [], repairable: false, nextAction: "Complete",
        referenceAlignment: ["first", "second"].map(id => ({ id, renderBox: box, evidence: "Measured" })),
      },
      calls: () => (name === "scene_plan" ? planCall : reviewCall).mock.callCount(),
    }));
    const vectors = [
      { path: ["reflectionProbe"], minimum: -10000, maximum: 10000 },
      { path: ["whiteBalance"], minimum: 0.25, maximum: 4 },
      { path: ["dust", "color"], minimum: 0, maximum: 10 },
      { path: ["dust", "wind"], minimum: -10, maximum: 10 },
      { path: ["dust", "volumes", "items", "center"], minimum: -10000, maximum: 10000 },
      { path: ["dust", "volumes", "items", "radius"], minimum: 0.05, maximum: 1000 },
    ].map(({ path, minimum, maximum }) => ({
      name: "scene_export", path: ["previewAppearance", ...path], length: 3, minimum, maximum,
      args: (vector: unknown) => {
        const appearance: Record<string, any> = { reflectionProbe: [0, 0, 0], whiteBalance: [1, 1, 1],
          dust: { color: [1, 1, 1], wind: [0, 0, 0], volumes: [{ center: [0, 0, 0], radius: [1, 1, 1], density: 1 }] } };
        let target = appearance;
        for (const key of path.slice(0, -1)) target = key === "items" ? target[0] : target[key];
        target[path.at(-1)!] = vector;
        return { sceneId: scene.id, previewAppearance: appearance };
      },
      calls: () => exportCall.mock.callCount(),
    }));
    for (const spec of [...boxes, ...vectors]) {
      let schema: any = tools.find(tool => tool.name === spec.name)!.inputSchema;
      for (const key of spec.path) schema = key === "items" ? schema.items : schema.properties[key];
      assert.equal(schema.type, "array");
      assert.equal(schema.minItems, spec.length); assert.equal(schema.maxItems, spec.length);
      assert.deepEqual(schema.items, { type: "number", ...(spec.minimum === undefined ? {} : { minimum: spec.minimum, maximum: spec.maximum }) });
      const valid = Array(spec.length).fill(spec.minimum ?? 0);
      for (const vector of [valid, Array(spec.length).fill(spec.maximum ?? 1)]) {
        const before = spec.calls();
        const result = await client.callTool({ name: spec.name, arguments: spec.args(vector) });
        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        assert.equal(spec.calls(), before + 1);
      }
      const invalid: unknown[] = [valid.slice(1), [...valid, 0], ["0", ...valid.slice(1)], null];
      if (spec.minimum !== undefined) invalid.push([spec.minimum - 1, ...valid.slice(1)], [spec.maximum! + 1, ...valid.slice(1)]);
      for (const vector of invalid) {
        const before = spec.calls();
        const result = await client.callTool({ name: spec.name, arguments: spec.args(vector) });
        assert.equal(result.isError, true, `${spec.name}.${spec.path.join(".")} accepted ${JSON.stringify(vector)}`);
        assert.equal(spec.calls(), before, "Invalid vectors must not reach the store");
      }
    }
  } finally { await client.close(); await server.close(); }
});

test("MCP advertises file transfer, UI resource, prompt and validates tool inputs", async () => {
  const { store } = setup();
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const tools = await client.listTools();
    checkSceneTools(tools.tools);
    assert.equal(tools.tools.length, 25);
    assert.equal(tools.tools.find((tool) => tool.name === "scene_render_high_quality")?._meta?.["openai/widgetAccessible"], true);
    assert.ok(tools.tools.some((tool) => tool.name === "scene_preview"));
    const create = tools.tools.find((tool) => tool.name === "scene_create")!;
    assert.deepEqual(create._meta?.["openai/fileParams"], ["reference", "references"]);
    assert.deepEqual(tools.tools.find((tool) => tool.name === "scene_continue")?._meta?.["openai/fileParams"], ["references"]);
    assert.equal(tools.tools.find((tool) => tool.name === "scene_view")?._meta?.["openai/outputTemplate"], "ui://uni-blender-scene/viewer.html");
    assert.equal(tools.tools.find((tool) => tool.name === "scene_get")?._meta?.["openai/widgetAccessible"], true);
    for (const tool of tools.tools) {
      if (tool.name === "scene_view") continue;
      assert.equal(tool._meta?.["openai/outputTemplate"], undefined, `${tool.name} must not open a viewer`);
      assert.equal((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined, tool.name);
    }
    const resources = await client.listResources();
    assert.equal(resources.resources[0]?.mimeType, "text/html;profile=mcp-app");
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts[0]?.name, "blender-scene");
    const invalid = await client.callTool({ name: "scene_create", arguments: { prompt: "" } });
    assert.equal(invalid.isError, true);
    for (const references of [[], Array.from({ length: 7 }, (_, index) => ({ download_url: "https://files.oaiusercontent.com/x.png", file_id: String(index) }))]) {
      const invalid = await client.callTool({ name: "scene_create", arguments: { prompt: "A room", references } });
      assert.equal(invalid.isError, true);
    }
    const scene = store.create("A chair"); await store.settled();
    const progress = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, images: "none" } }) as CallToolResult;
    assert.equal(progress.isError, undefined);
    assert.equal(progress.structuredContent?.renderUrl, null);
    assert.equal(progress.content.some((item) => item.type === "image"), false);
    const pendingView = await client.callTool({ name: "scene_view", arguments: { sceneId: scene.id } });
    assert.equal(pendingView.isError, true);
    assert.match(JSON.stringify(pendingView.content), /scene_get/);
    assert.equal(pendingView.structuredContent, undefined, "Do not pass an empty scene to the viewer");
    const inspected = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, objectName: "Chair" } }) as CallToolResult;
    const object = inspected.structuredContent?.inspectedObject as { rotationMode: string };
    assert.equal(object.rotationMode, "QUATERNION");
    assert.equal(inspected.content.some((item) => item.type === "image"), false);
    const missing = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, objectName: "Missing" } });
    assert.equal(missing.isError, true);
    const unavailable = await client.callTool({ name: "scene_asset_chunk", arguments: { sceneId: scene.id, name: "best.png" } });
    assert.equal(unavailable.isError, true);
    preparePlan(store, scene, plan); store.edit(scene.id, "result = {}"); await store.settled();
    const readyView = await client.callTool({ name: "scene_view", arguments: { sceneId: scene.id } }) as CallToolResult;
    assert.equal(readyView.isError, undefined);
    assert.ok(readyView.structuredContent?.renderUrl);
    store.review(scene.id, review(scene, 1, 95, true));
    const chunk = await client.callTool({ name: "scene_asset_chunk", arguments: { sceneId: scene.id, name: "best.png" } });
    assert.equal(chunk.isError, undefined);
    assert.equal(Buffer.from((chunk.structuredContent as { data: string }).data, "base64").toString(), "render");
    const compatibleChunk = await client.callTool({ name: "scene_view", arguments: { sceneId: scene.id, asset: { name: "best.png", offset: 0 } } });
    assert.equal(Buffer.from((compatibleChunk.structuredContent as { data: string }).data, "base64").toString(), "render");
    const beyond = await client.callTool({ name: "scene_asset_chunk", arguments: { sceneId: scene.id, name: "best.png", offset: 7 } });
    assert.equal(beyond.isError, true);
  } finally { await client.close(); await server.close(); }
});

test("scene_get selects images without replaying six references during render reviews", async () => {
  const { store } = setup();
  const scene = store.create("A primitive cube"); await store.settled();
  const referenceBytes = Buffer.from("reference-image");
  scene.references = Array.from({ length: 6 }, (_, index) => ({
    assetName: index ? `reference-${index + 1}` : "reference", fileId: String(index),
    name: `view-${index}`, mime: "image/png", label: `view-${index}`,
  })) as NonNullable<Scene["references"]>;
  for (const reference of scene.references) writeFileSync(store.path(scene, reference.assetName), referenceBytes);
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "image-selection-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const get = async (args: Record<string, unknown> = {}) =>
    await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, ...args } }) as CallToolResult;
  const images = (result: CallToolResult) => result.content.filter((item) => item.type === "image");
  try {
    assert.equal(images(await get({ images: "references" })).length, 6);
    assert.equal(images(await get({ images: "render" })).length, 0, "No render exists before the first edit");
    scene.iteration = 1;
    scene.render = "renders/iteration-1.png";
    const renderBytes = Buffer.from("latest-render");
    writeFileSync(store.path(scene, scene.render), renderBytes);
    const before = JSON.stringify(scene);
    assert.equal(images(await get()).length, 7, "Omitting images preserves legacy behavior");
    assert.equal(images(await get({ images: "all" })).length, 7);
    assert.equal(images(await get({ images: "references" })).length, 6);
    for (let review = 0; review < 2; review++) {
      const onlyRender = images(await get({ images: "render" }));
      assert.equal(onlyRender.length, 1);
      assert.deepEqual(Buffer.from(onlyRender[0]!.data, "base64"), renderBytes);
    }
    const metadata = await get({ images: "none" });
    assert.equal(images(metadata).length, 0);
    assert.equal((metadata.structuredContent!.references as unknown[]).length, 6);
    const priorJob = scene.job;
    scene.job = { id: "pending-image-test", kind: "preview", status: "running" };
    assert.equal(images(await get({ images: "render" })).length, 0, "Running jobs return state instead of potentially changing image evidence");
    scene.job = priorJob;
    const selected = await get({ images: "references", referenceName: "reference-2" });
    assert.equal(images(selected).length, 1);
    assert.ok(selected.content.some((item) => item.type === "text" && item.text.includes("view-1")));
    assert.equal(images(await get({ referenceName: "reference" })).length, 1);
    assert.equal(images(await get({ objectName: "Chair", images: "none" })).length, 0);
    for (const args of [
      { images: "invalid" }, { objectName: "Chair", images: "render" },
      { objectName: "Chair", referenceName: "reference" }, { referenceName: "reference", images: "none" },
    ]) assert.equal((await get(args)).isError, true, JSON.stringify(args));
    assert.equal(JSON.stringify(scene), before, "Image selection must not change scene state or review budgets");
  } finally { await client.close(); await server.close(); }
});

test("reference guidance is available at MCP initialization and scene_create preserves the user's request", async (t) => {
  const { store } = setup();
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.from("89504e470d0a1a0a01020304", "hex")));
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "reference-intake-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /Before the first user-facing update, keep image 1 as the primary reference and default camera/);
    assert.match(instructions, /俯瞰视角和第五张图一致[^.]+only applies to Camera 5/);
    const { tools } = await client.listTools();
    const schema = tools.find(tool => tool.name === "scene_create")!.inputSchema;
    assert.match((schema.properties?.prompt as { description: string }).description, /verbatim/);
    const prompt = "构建如图所示的场景，并且俯瞰视角和第五张图一致";
    const references = [1, 2, 3, 4, 5].map(attachmentNumber => ({
      download_url: `https://files.oaiusercontent.com/camera-${attachmentNumber}.png`,
      file_id: `image-${attachmentNumber}`, attachmentNumber,
    }));
    const created = await client.callTool({ name: "scene_create", arguments: {
      prompt, references: [references[4], ...references.slice(0, 4)],
    } });
    assert.equal(created.isError, undefined);
    await store.settled();
    const scene = store.get((created.structuredContent as { id: string }).id);
    assert.equal(scene.prompt, prompt);
    assert.equal(scene.reference?.fileId, "image-1");
    const cameras = (store.snapshot(scene, "https://example.com").referenceCameras as { default: boolean }[]);
    assert.deepEqual(cameras.map(camera => camera.default), [true, false, false, false, false]);
  } finally { await client.close(); await server.close(); }
});

test("auxiliary appearance alignment and image selection preserve the first reference as primary", async (t) => {
  const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
  t.mock.method(globalThis, "fetch", async (input: URL | string) =>
    new Response(Buffer.concat([png, Buffer.from(String(input))])));
  const { store, blender } = setup();
  const scene = store.create("第一张是主图，最后效果要和第三张图对齐", undefined,
    ["front", "side", "appearance"].map((name) => ({
      download_url: `https://files.oaiusercontent.com/${name}.png`, file_id: name,
    })));
  await store.settled();
  assert.equal(scene.job?.status, "done");
  const before = JSON.stringify(scene);
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "appearance-reference-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const selected = await client.callTool({ name: "scene_get", arguments: {
      sceneId: scene.id, referenceName: "reference-3", images: "references",
    } }) as CallToolResult;
    assert.equal(selected.isError, undefined);
    const images = selected.content.filter((item) => item.type === "image");
    assert.equal(images.length, 1);
    assert.deepEqual(Buffer.from(images[0]!.data, "base64"), readFileSync(store.path(scene, "reference-3")));
    const state = selected.structuredContent!;
    assert.equal((state.reference as { fileId: string }).fileId, "front");
    assert.deepEqual((state.references as { assetName: string; role: string }[]).map((r) => [r.assetName, r.role]), [
      ["reference", "primary"], ["reference-2", "auxiliary"], ["reference-3", "auxiliary"],
    ]);
    assert.equal(JSON.stringify(scene), before);
    const restarted = new SceneStore(store.root, blender);
    assert.equal(restarted.get(scene.id).reference?.fileId, "front");
    assert.equal(restarted.referenceImages(restarted.get(scene.id))[2]?.fileId, "appearance");
  } finally { await client.close(); await server.close(); }
});

test("multi-view references keep primary order, persist, and append atomically", async (t) => {
  const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
  t.mock.method(globalThis, "fetch", async (input: URL | string) =>
    new Response(String(input).includes("blocked") ? null : png, String(input).includes("blocked") ?
      { status: 302, headers: { location: "https://unapproved.example/image.png" } } : { status: 200 }));
  const { store, blender } = setup();
  const image = (id: string) => ({ download_url: `https://files.oaiusercontent.com/${id}.png`, file_id: id, label: id });
  assert.throws(() => store.create("A room", image("front"), [image("side")]), /not both/);
  assert.throws(() => store.create("A room", undefined, [image("front"), image("front")]), /distinct/);
  assert.throws(() => store.create("A room", undefined, []), /1-6/);
  const scene = store.create("A room", undefined, [image("front"), image("side")]);
  await store.settled();
  assert.equal(scene.job?.status, "done");
  const snapshot = store.snapshot(scene, "https://example.com") as { reference: { assetName: string }; references: { role: string; label: string; assetName: string }[] };
  assert.deepEqual(snapshot.references.map((view) => [view.assetName, view.role, view.label]), [
    ["reference", "primary", "front"], ["reference-2", "auxiliary", "side"],
  ]);
  assert.equal(snapshot.reference.assetName, "reference");
  for (const view of store.referenceImages(scene)) assert.deepEqual(readFileSync(store.path(scene, view.assetName)), png);
  const server = createMcpServer(store, "https://example.com");
  const client = new Client({ name: "multi-view-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const all = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id } }) as CallToolResult;
    assert.equal(all.content.filter((item) => item.type === "image").length, 2);
    const one = await client.callTool({ name: "scene_get", arguments: { sceneId: scene.id, referenceName: "reference-2" } }) as CallToolResult;
    assert.equal(one.content.filter((item) => item.type === "image").length, 1);
    const chunk = await client.callTool({ name: "scene_asset_chunk", arguments: { sceneId: scene.id, name: "reference-2" } });
    assert.deepEqual(Buffer.from((chunk.structuredContent as { data: string }).data, "base64"), png);
    assert.equal((chunk.structuredContent as { mimeType: string }).mimeType, "image/png");
    const missing = await client.callTool({ name: "scene_asset_chunk", arguments: { sceneId: scene.id, name: "reference-6" } });
    assert.equal(missing.isError, true);
  } finally { await client.close(); await server.close(); }
  const anchors: Plan["referenceAnchors"] = [
    { id: "left", description: "Left subject", targetBox: [0, 0, 0.5, 1] },
    { id: "right", description: "Right subject", targetBox: [0.5, 0, 1, 1] },
  ];
  preparePlan(store, scene, { ...plan, workflow: referenceWorkflow, referenceAnchors: anchors });
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, { ...review(scene, 1, 95, true), referenceAlignment: anchors.map((anchor) => ({
    id: anchor.id, renderBox: anchor.targetBox, evidence: "Primary-view alignment inspected",
  })) });
  await store.settled();
  store.reviewDecision(scene.id, true);
  store.edit(scene.id, "result = {}"); await store.settled();
  store.review(scene.id, { ...review(scene, 2, 95, true), referenceAlignment: anchors.map((anchor) => ({ id: anchor.id, renderBox: anchor.targetBox, evidence: "Fixture alignment" })) });
  const best = scene.best;
  assert.throws(() => store.continue(scene.id, "Too many views", Array.from({ length: 5 }, (_, index) => image(`extra-${index}`))), /1-6/);
  assert.equal(scene.stage, "completed");
  store.continue(scene.id, "New angles", [image("back"), image("blocked")]); await store.settled();
  assert.equal(scene.job?.status, "failed");
  assert.equal(scene.stage, "completed");
  assert.equal(scene.best, best);
  assert.equal(store.referenceImages(scene).length, 2);
  assert.equal(store.allowedFiles(scene).includes("reference-3"), false);
  store.continue(scene.id, "Match the final effect to image 3", [image("back")]); await store.settled();
  assert.equal(scene.stage, "planning");
  assert.equal(scene.startIteration, 2);
  assert.equal(scene.reference?.fileId, "front");
  assert.deepEqual(store.referenceImages(scene).map((view) => view.fileId), ["front", "side", "back"]);
  assert.equal(scene.best, undefined);
  const restoredStore = new SceneStore(store.root, blender);
  assert.equal(restoredStore.referenceImages(restoredStore.get(scene.id))[2]?.label, "back");
  assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "initial");
  const failed = store.create("A room", undefined, [image("valid"), image("blocked")]); await store.settled();
  assert.equal(failed.job?.status, "failed");
  assert.deepEqual(store.referenceImages(failed), []);
  assert.equal(store.allowedFiles(failed).some((file) => file.startsWith("reference")), false);
  // Legacy scenes with only reference metadata remain readable after restart.
  const legacy = store.create("A chair"); await store.settled();
  legacy.reference = { fileId: "legacy", name: "Old input", mime: "image/png" };store.save(legacy);
  const legacyStore = new SceneStore(store.root, blender);
  assert.equal(legacyStore.referenceImages(legacyStore.get(legacy.id))[0]?.assetName, "reference");
});

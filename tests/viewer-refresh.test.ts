import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { transformSync } from "esbuild";

// Exercise the shipped handlers without a GPU or a running Blender instance.
const source = ts.createSourceFile("widget.ts", readFileSync("src/viewer/widget.ts", "utf8"), ts.ScriptTarget.Latest, true);
const handlers = source.statements.filter((statement) =>
  ts.isFunctionDeclaration(statement) && ["receive", "refreshScene"].includes(statement.name?.text ?? "") ||
  statement.getText(source).startsWith("app.ontoolresult ="));
const code = transformSync(handlers.map((statement) => statement.getText(source)).join("\n"), { loader: "ts" }).code;

const scene = (stage: string, iteration: number) => ({
  id: "scene_fixture", stage, iteration, renderUrl: "render.png", bestRenderUrl: "best.png", artifacts: [],
  reference: null, reviewViews: [], plan: { graph: [] },
  workflowState: { phase: stage === "completed" ? "final" : "composition", status: stage,
    compositionApproved: stage === "completed", presentation: { mode: stage === "completed" ? "appearance" : "structural",
      purpose: stage === "completed" ? "delivery" : "confirmation", iteration, source: "checkpoint" } },
});

function setup(latest = scene("completed", 7), failRender = false) {
  const nodes = new Map<string, any>();
  const el = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, dataset: {}, textContent: "", value: "",
      removeAttribute() {}, replaceChildren() {}, appendChild() {}, close() {},
      querySelector: () => el(`${id}-heading`) });
    return nodes.get(id);
  };
  let refreshes = 0;
  let nativePreviews = 0;
  const timers = new Map<number, () => void>();
  const app = { ontoolresult: undefined as any, callServerTool: async (input: any) => {
    assert.equal(input.name, "scene_get"); assert.equal(input.arguments.images, "none");
    refreshes++;
    return { structuredContent: latest };
  } };
  const context = createContext({ app, el, console: { error() {} },
    document: { createElement: () => ({}) },
    assetURL: (name: string) => failRender || name === "render" ? Promise.reject(new Error("Expired asset")) : Promise.resolve("blob:current-render"),
    referenceViews: () => [], renderGraph() {}, showReference() {}, setMode() {}, dispose() {}, updateThreeRT() {},
    showPreview() { nativePreviews++; },
    message: (text: string) => { el("message").textContent = text; },
    setTimeout: (callback: () => void) => { timers.set(1, callback); return 1; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  runInContext(`let snapshot, viewer, timer, graphNodes = [], loadedURL = "", mode = "render";
    let referenceListKey = "", reviewImagesKey = "", selectedNodeId = "", preferredBackend;
    let liveViewer, liveWanted = false, liveStatus = "";
    const expanded = new Set();
    const threeRTLiveUnavailableReason = () => snapshot?.threeRT?.liveAvailable && snapshot.exportVersion &&
      ["completed", "best_effort"].includes(snapshot.stage) ? "" : "Unavailable";
    const artifact = (name) => snapshot?.artifacts.find(item => item.name === name)?.url;
    ${code}`, context);
  return { app, el, context, timers, refreshes: () => refreshes, nativePreviews: () => nativePreviews };
}

test("opening a saved approval card refreshes to the current scene and render", async () => {
  const fixture = setup();
  await fixture.app.ontoolresult({ structuredContent: scene("awaiting_review", 4) });
  assert.equal(fixture.refreshes(), 1);
  assert.equal(runInContext("snapshot.iteration", fixture.context), 7);
  assert.equal(fixture.el("render").src, "blob:current-render");
  assert.equal(fixture.el("empty").style.display, "none");
  assert.equal(fixture.el("review-panel").hidden, true);
});

test("an idle approval card continues polling for approval recorded outside the card", async () => {
  const fixture = setup();
  runInContext(`receive(${JSON.stringify(scene("awaiting_review", 4))})`, fixture.context);
  assert.equal(fixture.timers.size, 1);
  fixture.timers.get(1)!();
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(runInContext("snapshot.stage", fixture.context), "completed");
  assert.equal(fixture.timers.size, 0);
});

test("failed render loading replaces the loading message", async () => {
  const fixture = setup(scene("completed", 7), true);
  await fixture.app.ontoolresult({ structuredContent: scene("completed", 7) });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(fixture.el("empty").textContent, "Scene render could not be loaded.");
});

test("asset chunk results do not trigger scene refreshes", async () => {
  const fixture = setup();
  await fixture.app.ontoolresult({ structuredContent: { name: "render", data: "bytes" } });
  assert.equal(fixture.refreshes(), 0);
});

test("an exported scene defaults to native preview once and preserves a manual web choice", () => {
  const fixture = setup();
  const native = { ...scene("completed", 9), exportVersion: "v1", threeRT: { available: true, liveAvailable: true } };
  runInContext(`receive(${JSON.stringify(native)}); receive(${JSON.stringify(native)})`, fixture.context);
  assert.equal(fixture.nativePreviews(), 1);
  assert.equal(runInContext("preferredBackend", fixture.context), "threert");
  runInContext(`preferredBackend = "web"; receive(${JSON.stringify(native)})`, fixture.context);
  assert.equal(fixture.nativePreviews(), 1);
  assert.equal(runInContext("preferredBackend", fixture.context), "web");
  runInContext(`receive(${JSON.stringify({ ...native, id: "scene_next" })})`, fixture.context);
  assert.equal(fixture.nativePreviews(), 2);
});

test("native default waits for pending scene work to finish", () => {
  const fixture = setup();
  const native = { ...scene("completed", 9), exportVersion: "v1", threeRT: { available: true, liveAvailable: true } };
  runInContext(`receive(${JSON.stringify({ ...native, job: { kind: "export", status: "running" } })})`, fixture.context);
  assert.equal(fixture.nativePreviews(), 0);
  runInContext(`receive(${JSON.stringify(native)})`, fixture.context);
  assert.equal(fixture.nativePreviews(), 1);
});

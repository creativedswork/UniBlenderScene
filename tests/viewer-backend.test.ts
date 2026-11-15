import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { transformSync } from "esbuild";

const source = ts.createSourceFile("widget.ts", readFileSync("src/viewer/widget.ts", "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["threeRTLiveUnavailableReason", "showPreview", "setMode", "updateThreeRT", "startThreeRT", "openRealtime"];
const handlers = source.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && functions.includes(statement.name?.text ?? "") ||
  statement.getText(source).startsWith('el<HTMLSelectElement>("render-backend").onchange =') ||
  statement.getText(source).startsWith('el("mode-3d").onclick ='));
const code = transformSync(handlers.map(statement => statement.getText(source)).join("\n"), { loader: "ts" }).code;

function setup(capability: object, webViewer = true, failRequest = false) {
  const nodes = new Map<string, any>();
  const el = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, src: id === "render" ? "blob:render" : "",
      value: "", setAttribute() {}, querySelector: () => el("threert-option") });
    return nodes.get(id);
  };
  let requests = 0;
  const context = createContext({ el, updateSelectionBox() {}, artifact() {}, receive() {},
    message(text: string) { el("message").textContent = text; },
    connectThreeRT: async () => { throw new Error("Live connection failed"); },
    app: { callServerTool: async () => {
      requests++;
      if (failRequest) throw new Error("Engine startup failed");
      return { structuredContent: {} };
    } },
  });
  runInContext(`let snapshot = ${JSON.stringify({ id: "scene_test", stage: "completed", exportVersion: "v1",
    realtimeUrl: "http://localhost/realtime", threeRT: capability })};
    let viewer = ${webViewer ? "{}" : "undefined"}, mode = "render", liveViewer, liveConnecting = false, preferredBackend;
    let liveWanted = false, liveStatus = "", threeRTRequestPending = false, threeRTImageKey = "";
    ${code}`, context);
  return { context, el, requests: () => requests };
}

test("switching to an unavailable native engine keeps a visible web preview and makes no request", async () => {
  for (const webViewer of [true, false]) {
    const fixture = setup({ available: false, reason: "ThreeRT not installed" }, webViewer);
    fixture.el("render-backend").value = "threert";
    fixture.el("render-backend").onchange();
    await runInContext("startThreeRT()", fixture.context);
    assert.equal(fixture.requests(), 0);
    assert.equal(runInContext("mode", fixture.context), webViewer ? "3d" : "render");
    assert.equal(fixture.el(webViewer ? "canvas" : "render").style.display, webViewer ? "flex" : "block");
    assert.equal(fixture.el("render-backend").value, "web");
    assert.equal(fixture.el("threert-option").disabled, true);
    assert.match(fixture.el("message").textContent, /已保留网页预览/);
  }
});

test("static-only engines cannot be selected for realtime, while native clients remain available", async () => {
  const staticOnly = setup({ available: true, liveAvailable: false, liveReason: "Static only" });
  runInContext("updateThreeRT()", staticOnly.context);
  assert.equal(staticOnly.el("threert-option").disabled, true);
  await runInContext("startThreeRT()", staticOnly.context);
  assert.equal(staticOnly.requests(), 0);

  const native = setup({ available: true, liveAvailable: true });
  native.el("render-backend").value = "threert";
  native.el("render-backend").onchange();
  await new Promise<void>(done => setImmediate(done));
  assert.equal(native.el("threert-option").disabled, false);
  assert.equal(runInContext("mode", native.context), "threert");
  assert.equal(native.requests(), 1);
});

test("a refreshed unavailable capability restores the preview from an old native selection", () => {
  const fixture = setup({ available: true, liveAvailable: true });
  runInContext('setMode("threert"); snapshot.threeRT.available = false; updateThreeRT()', fixture.context);
  assert.equal(runInContext("mode", fixture.context), "3d");
  assert.equal(fixture.el("canvas").style.display, "flex");
});

test("native preparation and live connection failures restore the existing preview", async () => {
  for (const operation of ["startThreeRT", "openRealtime"]) {
    const fixture = setup({ available: true, liveAvailable: true }, true, true);
    await runInContext(`setMode("threert"); ${operation}()`, fixture.context);
    assert.equal(runInContext("mode", fixture.context), "3d");
    assert.equal(fixture.el("canvas").style.display, "flex");
    assert.match(fixture.el("message").textContent, /失败|failed/);
    assert.equal(runInContext("preferredBackend", fixture.context), "web");
  }
});

test("Render and 3D retain the selected native backend without requiring the web model", () => {
  const fixture = setup({ available: true, liveAvailable: true }, false);
  runInContext(`preferredBackend = "threert"; liveViewer = { setActive() {} };
    setMode("threert"); setMode("render")`, fixture.context);
  assert.equal(fixture.el("render-backend").value, "threert");
  assert.equal(fixture.el("mode-3d").disabled, false);
  fixture.el("mode-3d").onclick();
  assert.equal(runInContext("mode", fixture.context), "threert");
  assert.equal(fixture.el("threert-live").style.display, "flex");
  assert.equal(fixture.requests(), 0);
});

test("structural review cannot select native delivery rendering", async () => {
  const fixture = setup({ available: true, liveAvailable: true });
  runInContext('snapshot.stage = "awaiting_review"; updateThreeRT()', fixture.context);
  assert.equal(fixture.el("threert-option").disabled, true);
  await runInContext("startThreeRT()", fixture.context);
  assert.equal(fixture.requests(), 0);
  assert.equal(runInContext("mode", fixture.context), "3d");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { transformSync } from "esbuild";
import ts from "typescript";

const source = ts.createSourceFile("viewer-host.ts", readFileSync("tests/viewer-host.ts", "utf8"), ts.ScriptTarget.Latest, true);
const loader = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "loadAssetBytes")!;
const code = transformSync(loader.getText(source), { loader: "ts" }).code;

test("preview chunks reuse a single download of the full asset", async () => {
  let requests = 0;
  const payload = new Uint8Array(1024 * 1024);
  const context = createContext({ Map, Uint8Array, fetch: async () => {
    requests++;
    return { ok: true, arrayBuffer: async () => payload.buffer };
  } });
  runInContext(`const assetBuffers = new Map(); ${code}`, context);
  const [first, second] = await runInContext('Promise.all([loadAssetBytes("model.glb"), loadAssetBytes("model.glb")])', context);
  assert.equal(first, second);
  assert.equal(first.length, payload.length);
  await runInContext('loadAssetBytes("model.glb")', context);
  assert.equal(requests, 1, "Each chunk must not download the full model again");
});

test("failed preview downloads can be retried", async () => {
  let requests = 0;
  const context = createContext({ Map, Uint8Array, fetch: async () => ({
    ok: ++requests > 1, arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
  }) });
  runInContext(`const assetBuffers = new Map(); ${code}`, context);
  await assert.rejects(runInContext('loadAssetBytes("model.glb")', context), /could not be loaded/);
  assert.deepEqual(Array.from(await runInContext('loadAssetBytes("model.glb")', context)), [1, 2]);
  assert.equal(requests, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { transformSync } from "esbuild";
import * as THREE from "three";
import { volumeUniforms } from "../src/viewer/volumes.js";

// Run the shipped frame callback: camera movement resets samples below the denoise threshold.
const source = ts.createSourceFile("widget.ts", readFileSync("src/viewer/widget.ts", "utf8"), ts.ScriptTarget.Latest, true);
let frameSource = "";
let sunlightSource = "";
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "frameTimer") frameSource = node.initializer!.getText(source);
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === "sunColor") sunlightSource = node.initializer.getText(source);
  ts.forEachChild(node, find);
}
find(source);
assert.ok(frameSource);
const code = transformSync(frameSource, { loader: "ts" }).code;

test("isotropic single scattering conserves sunlight energy", () => {
  assert.ok(sunlightSource);
  const irradiance = 20, opticalDepth = 0.7;
  const sun = { intensity: irradiance, color: { clone: () => ({ multiplyScalar: (gain: number) => gain }) } };
  const radiance = runInContext(`(${sunlightSource}).value`, createContext({ sun, Math })) as number;
  const scatteredFlux = radiance * (1 - Math.exp(-opticalDepth)) * 4 * Math.PI;
  assert.ok(Math.abs(scatteredFlux - irradiance * (1 - Math.exp(-opticalDepth))) < 1e-10);
});

test("animated dust uses local lights without a separate fog volume", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const light = new THREE.PointLight(0xffffff, 20);
  light.position.set(2, 3, -4);
  scene.add(light);

  const dust = volumeUniforms([], scene, camera, true);
  dust.update();
  assert.equal(dust.uniforms.volumeCount.value, 0);
  assert.equal(dust.uniforms.localCount.value, 1);
  assert.deepEqual(dust.uniforms.localColor.value[0]!.toArray(), [20, 20, 20, -2]);
  assert.equal(volumeUniforms([], scene, camera).hasLocalLights, false);
});

test("moving and converged previews both apply atmosphere to the linear scene image", () => {
  for (const samples of [0, 8]) {
    const calls: string[] = [];
    const texture = {}, display = {}, target = { texture, setSize() {} };
    const tracer = { samples, target: { texture: {}, width: 80, height: 45 }, renderSample() {}, updateCamera() {} };
    const renderer = { domElement: { dataset: {} }, setRenderTarget(value: unknown) { calls.push(value === target ? "target" : "screen"); },
      render() { calls.push("raster"); } };
    const effects = { animated: true, depthDirty: false, render(image: unknown, transform: unknown) {
      assert.equal(image, texture); assert.equal(transform, display); calls.push("atmosphere");
    } };
    const same = { equals: () => true };
    const context = createContext({ mode: "3d", viewer: { tracer, renderer }, navigation: { update() {} }, controls: { update() {} }, updateSelectionBox() {},
      camera: { position: same, quaternion: same, projectionMatrix: same }, previousPosition: same, previousQuaternion: same, previousProjection: same,
      renderer, tracer, effects, denoiseTarget: target, display, scene: {},
      denoise: { material: {}, render() { calls.push("denoise"); } },
      gl: { fenceSync() {}, flush() {} }, setInterval(callback: () => void) { callback(); } });
    runInContext(code, context);
    assert.deepEqual(calls, ["target", samples < 4 ? "raster" : "denoise", "screen", "atmosphere"]);
  }
});

test("raster previews cache the scene during atmosphere animation and redraw after projection changes", () => {
  const calls: string[] = [], texture = {}, display = {};
  const target = { texture, setSize() {} }, same = { equals: () => true, copy() {} };
  let projectionChanged = false;
  const projection = { equals: () => !projectionChanged }, previousProjection = { copy() { projectionChanged = false; } };
  const renderer = { domElement: { dataset: {}, width: 80, height: 45 },
    setRenderTarget(value: unknown) { calls.push(value === target ? "target" : "screen"); }, render() { calls.push("scene"); } };
  const reflection = { capture() { calls.push("reflection"); } };
  const context = createContext({ mode: "3d", viewer: { renderer, reflection }, navigation: { update() {} }, controls: { update() {} }, updateSelectionBox() {},
    camera: { position: same, quaternion: same, projectionMatrix: projection }, previousPosition: same, previousQuaternion: same, previousProjection,
    renderer, tracer: undefined, effects: { animated: true, render(image: unknown) { assert.equal(image, texture); calls.push("atmosphere"); } },
    denoiseTarget: target, display, scene: {}, gl: { fenceSync() {}, flush() {} },
    setInterval(callback: () => void) { callback(); callback(); projectionChanged = true; callback(); } });
  runInContext(`let rasterDirty = true; ${code}`, context);
  assert.deepEqual(calls, ["reflection", "target", "scene", "screen", "atmosphere", "atmosphere",
    "reflection", "target", "scene", "screen", "atmosphere"]);
});

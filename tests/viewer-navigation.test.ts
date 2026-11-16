import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { keyboardNavigation } from "../src/viewer/navigation.js";

function fixture() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { defaultView: window, hidden: false, activeElement: null as unknown });
  const canvas = Object.assign(new EventTarget(), { ownerDocument: document, tabIndex: -1,
    focus() { document.activeElement = canvas; } });
  const camera = new PerspectiveCamera(); camera.position.set(0, 3, 10); camera.lookAt(0, 3, 0);
  let active = true, now = 0;
  const controls = { target: new Vector3(0, 3, 0), enabled: true, update() {} } as unknown as OrbitControls;
  const navigation = keyboardNavigation(camera, controls, canvas as unknown as HTMLCanvasElement, () => active);
  const key = (code: string, type = "keydown", modifiers = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { code, ...modifiers });
    canvas.dispatchEvent(event); return event;
  };
  navigation.update(0);
  return { canvas, camera, controls, document, window, navigation, key,
    tick: (delta = 50) => { now += delta; navigation.update(now); },
    deactivate: () => { active = false; } };
}

test("WASD translates camera and orbit target along the view axes, with normalized diagonals and Shift acceleration", () => {
  const f = fixture(); f.canvas.dispatchEvent(new Event("pointerdown"));
  assert.equal(f.document.activeElement, f.canvas);
  assert.equal(f.key("KeyW").defaultPrevented, true); f.tick();
  assert.ok(Math.abs(f.camera.position.z - 9.9) < 1e-9);
  assert.equal(f.camera.position.y, 3); assert.equal(f.controls.target.y, 3);
  assert.ok(Math.abs(f.camera.position.distanceTo(f.controls.target) - 10) < 1e-9);
  const start = f.camera.position.clone(); f.key("KeyD"); f.tick();
  assert.ok(Math.abs(f.camera.position.distanceTo(start) - 0.1) < 1e-9);
  assert.ok(f.camera.position.x > start.x);
  f.key("KeyW", "keyup"); f.key("KeyD", "keyup");
  f.key("KeyS"); f.key("ShiftLeft"); const before = f.camera.position.clone(); f.tick();
  assert.ok(Math.abs(f.camera.position.z - before.z - 0.3) < 1e-9);
  f.navigation.clear(); f.key("KeyA"); const x = f.camera.position.x; f.tick();
  assert.ok(f.camera.position.x < x);
  f.navigation.clear();
  f.camera.lookAt(f.camera.position.clone().add(new Vector3(10, 0, 0)));
  const turned = f.camera.position.clone(); f.key("KeyW"); f.tick();
  assert.ok(f.camera.position.x > turned.x, "Forward follows the camera heading");
  assert.ok(Math.abs(f.camera.position.z - turned.z) < 1e-9);
  f.navigation.dispose();
});

test("looking down or up lets W/S change altitude continuously without changing the view or orbit distance", () => {
  for (const direction of [new Vector3(0, -1, 0), new Vector3(0, 1, 0), new Vector3(0, -1, -1).normalize()]) {
    const f = fixture(); f.canvas.focus();
    f.camera.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), direction);
    f.controls.target.copy(f.camera.position).addScaledVector(direction, 10);
    const start = f.camera.position.clone(), rotation = f.camera.quaternion.clone();
    f.key("KeyW");
    for (let i = 0; i < 20; i++) f.tick();
    assert.ok(f.camera.position.clone().sub(start).distanceTo(direction.clone().multiplyScalar(2)) < 1e-9);
    assert.ok(Math.abs(f.camera.position.distanceTo(f.controls.target) - 10) < 1e-9);
    assert.ok(f.camera.quaternion.equals(rotation));
    f.key("KeyW", "keyup"); f.key("KeyS");
    for (let i = 0; i < 20; i++) f.tick();
    assert.ok(f.camera.position.distanceTo(start) < 1e-9, "S reverses the ascent or descent");
    f.navigation.dispose();
  }
});

test("keyboard movement stops on blur, hidden pages, inactive previews and disposal, and ignores shortcuts", () => {
  for (const stop of ["blur", "window", "hidden", "inactive", "focus", "dispose"] as const) {
    const f = fixture(); f.canvas.focus(); f.key("KeyW"); f.tick();
    const before = f.camera.position.clone();
    if (stop === "blur") f.canvas.dispatchEvent(new Event("blur"));
    if (stop === "window") f.window.dispatchEvent(new Event("blur"));
    if (stop === "hidden") { f.document.hidden = true; f.document.dispatchEvent(new Event("visibilitychange")); }
    if (stop === "inactive") f.deactivate();
    if (stop === "focus") f.document.activeElement = {};
    if (stop === "dispose") f.navigation.dispose();
    f.tick(); assert.ok(f.camera.position.equals(before), stop);
    f.navigation.dispose();
  }
  const f = fixture(); f.canvas.focus();
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    assert.equal(f.key("KeyW", "keydown", modifiers).defaultPrevented, false); f.tick();
  }
  assert.ok(f.camera.position.equals(new Vector3(0, 3, 10)));
  f.key("KeyW"); f.tick(10000);
  assert.ok(Math.abs(f.camera.position.z - 9.9) < 1e-9, "Long frame pauses cannot cause a camera jump");
  f.navigation.dispose();
});

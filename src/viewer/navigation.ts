import { Camera, MathUtils, Vector3 } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** Move the camera and orbit pivot together along the camera's view axes. */
export function keyboardNavigation(camera: Camera, controls: OrbitControls, canvas: HTMLCanvasElement, enabled: () => boolean) {
  const keys = new Set<string>();
  const forward = new Vector3(), right = new Vector3(), movement = new Vector3();
  const speed = MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.2, 0.25, 12);
  const document = canvas.ownerDocument, window = document.defaultView!;
  let previous = performance.now();
  const clear = () => keys.clear();
  const focus = () => canvas.focus({ preventScroll: true });
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) { clear(); return; }
    if (!enabled() || !["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"].includes(event.code)) return;
    event.preventDefault(); keys.add(event.code);
  };
  const keyup = (event: KeyboardEvent) => { if (keys.delete(event.code)) event.preventDefault(); };
  const visibility = () => { if (document.hidden) clear(); };
  canvas.tabIndex = 0;
  canvas.addEventListener("pointerdown", focus);
  canvas.addEventListener("keydown", keydown);
  canvas.addEventListener("keyup", keyup);
  canvas.addEventListener("blur", clear);
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", visibility);
  return {
    clear,
    update(now = performance.now()) {
      const seconds = Math.min(Math.max(now - previous, 0) / 1000, 0.05); previous = now;
      if (!enabled() || document.activeElement !== canvas) { clear(); return; }
      const ahead = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
      const side = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
      if (!ahead && !side) return;
      camera.getWorldDirection(forward);
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      movement.copy(forward).multiplyScalar(ahead).addScaledVector(right, side).normalize()
        .multiplyScalar(seconds * speed * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1));
      camera.position.add(movement); controls.target.add(movement); controls.update();
    },
    dispose() {
      clear();
      canvas.removeEventListener("pointerdown", focus);
      canvas.removeEventListener("keydown", keydown);
      canvas.removeEventListener("keyup", keyup);
      canvas.removeEventListener("blur", clear);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}

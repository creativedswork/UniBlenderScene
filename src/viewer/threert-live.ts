import { PerspectiveCamera } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { keyboardNavigation } from "./navigation.js";

type CameraPose = { position: number[]; target: number[]; fov: number };
const endpoint = (base: string, action: string, session?: string) => {
  const url = new URL(base); url.pathname += `/${action}`;
  if (session) url.searchParams.set("session", session);
  return url.href;
};

export async function connectThreeRT(canvas: HTMLCanvasElement, base: string, status: (text: string) => void) {
  const response = await fetch(endpoint(base, "start"), { method: "POST" });
  const connection = await response.json();
  if (!response.ok) throw new Error(connection.error ?? "ThreeRT 连接失败。");
  const initial = connection.camera as CameraPose, session = connection.sessionId as string;
  const camera = new PerspectiveCamera(initial.fov, 16 / 9, 0.01, 100000);
  camera.position.fromArray(initial.position);
  const controls = new OrbitControls(camera, canvas);
  controls.target.fromArray(initial.target); controls.update(); controls.enableDamping = false;
  const context = canvas.getContext("2d")!;
  let active = true, disposed = false, running = false, pendingPose: CameraPose | undefined, controller: AbortController | undefined;
  const navigation = keyboardNavigation(camera, controls, canvas, () => active && !disposed && controls.enabled);
  const navigationTimer = setInterval(() => navigation.update(), 16);
  let count = 0, since = performance.now(), lastSize = "";
  controls.addEventListener("change", () => {
    pendingPose = { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov };
  });
  const resize = () => {
    const bounds = canvas.parentElement!.getBoundingClientRect(), aspect = canvas.width / canvas.height;
    const width = Math.min(bounds.width, bounds.height * aspect);
    canvas.style.width = `${width}px`; canvas.style.height = `${width / aspect}px`;
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!);
  const loop = async () => {
    if (running || !active || disposed) return;
    running = true;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      controller = new AbortController();
      const stream = await fetch(endpoint(base, "stream", session), { signal: controller.signal, cache: "no-store" });
      if (!stream.ok || !stream.body) throw new Error("实时会话已中断，请重新连接。");
      reader = stream.body.getReader();
      let pending: Uint8Array = new Uint8Array(0), offset = 0;
      const readBytes = async (size: number) => {
        const result = new Uint8Array(size);
        for (let written = 0; written < size;) {
          if (offset === pending.length) {
            const chunk = await reader!.read();
            if (chunk.done) throw new Error("画面连接已断开，请重新连接。");
            pending = chunk.value; offset = 0;
          }
          const count = Math.min(size - written, pending.length - offset);
          result.set(pending.subarray(offset, offset + count), written); offset += count; written += count;
        }
        return result;
      };
      while (active && !disposed) {
        if (pendingPose) {
          const pose = pendingPose; pendingPose = undefined;
          const result = await fetch(endpoint(base, "camera", session), { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(pose), signal: controller.signal });
          if (!result.ok) throw new Error("相机同步失败，请重新连接。");
          canvas.dataset.camera = JSON.stringify(pose);
        }
        const header = new DataView((await readBytes(16)).buffer);
        const size = header.getUint32(0), sequence = header.getUint32(4);
        if (!size || size > 64 * 1024 * 1024) throw new Error("实时画面数据无效，请重新连接。");
        const image = await createImageBitmap(new Blob([await readBytes(size)], { type: "image/png" }));
        if (!active || disposed) { image.close(); break; }
        if (`${image.width}:${image.height}` !== lastSize) {
          canvas.width = image.width; canvas.height = image.height; lastSize = `${image.width}:${image.height}`; resize();
        }
        context.drawImage(image, 0, 0); image.close();
        canvas.dataset.frame = String(sequence);
        canvas.dataset.renderer = "threert-native-live";
        count++;
        const elapsed = performance.now() - since;
        if (elapsed >= 1000) {
          const fps = count * 1000 / elapsed;
          canvas.dataset.fps = fps.toFixed(1);
          status(`ThreeRT 实时交互 · ${fps.toFixed(1)} 帧/秒 · WASD 移动，Shift 加速`);
          count = 0; since = performance.now();
        }
      }
    } catch (error) {
      if (active && !disposed && !(error instanceof Error && error.name === "AbortError")) {
        active = false;
        status(error instanceof TypeError ? "画面连接已断开，请重新连接。" : error instanceof Error ? error.message : "ThreeRT 实时连接失败。");
      }
    } finally { await reader?.cancel().catch(() => {}); running = false; if (active && !disposed) void loop(); }
  };
  void loop();
  return {
    setActive(value: boolean) { active = value; controls.enabled = value; if (value) { since = performance.now(); count = 0; void loop(); } else { navigation.clear(); controller?.abort(); } },
    reset() { camera.position.fromArray(initial.position); camera.fov = initial.fov; controls.target.fromArray(initial.target); controls.update(); },
    dispose() { disposed = true; active = false; clearInterval(navigationTimer); navigation.dispose(); controller?.abort(); observer.disconnect(); controls.dispose();
      void fetch(endpoint(base, "stop", session), { method: "POST", keepalive: true }).catch(() => {}); },
  };
}

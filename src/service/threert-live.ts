import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Quaternion, Vector3 } from "three";

export type LiveCamera = { position: number[]; target: number[]; fov: number };
type NativeRequest = (method: string, route: string, body?: unknown) => Promise<any>;
const execute = promisify(execFile);

export function validateLiveCamera(value: unknown): LiveCamera {
  const camera = value as LiveCamera;
  const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 100000);
  if (!camera || !vector(camera.position) || !vector(camera.target) || !Number.isFinite(camera.fov) || camera.fov < 5 || camera.fov > 150 ||
    new Vector3().fromArray(camera.position).distanceTo(new Vector3().fromArray(camera.target)) < 0.001) {
    throw new Error("Invalid live camera.");
  }
  return { position: [...camera.position], target: [...camera.target], fov: camera.fov };
}

async function nativeRequest(method: string, route: string, body?: unknown) {
  // The native credential stays on the service host; it never reaches the browser.
  const client = JSON.parse(await readFile(join(homedir(), ".threert/client.json"), "utf8"));
  if (!Number.isInteger(client.port) || client.port < 1 || client.port > 65535 || typeof client.token !== "string") throw new Error("Invalid ThreeRT client configuration.");
  const response = await fetch(`http://127.0.0.1:${client.port}${route}`, { method,
    headers: { "x-threert-token": client.token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const result = await response.json() as { ok: boolean; error?: string };
  if (!response.ok || !result.ok) throw new Error("原生 ThreeRT 连接已中断，请重新连接。");
  return result;
}

/** One native client owns one viewport. New connections supersede old ones instead of racing their cameras. */
export class ThreeRTLive {
  private active?: { id: string; sceneId: string; version: string; directory: string; sequence: number; camera: LiveCamera;
    pendingFrame?: Promise<{ bytes: Buffer; sequence: number; capturedAt: number }> };
  private connecting = false;
  constructor(private request: NativeRequest = nativeRequest) {}

  async connect(sceneId: string, version: string, directory: string, binary: string) {
    if (basename(binary).replace(/\.exe$/i, "") !== "threert") throw new Error("实时交互需要 ThreeRT 原生客户端 CLI。");
    if (this.connecting) throw new Error("ThreeRT 正在连接，请稍后重试。");
    this.connecting = true;
    try {
      this.active = undefined;
      try {
        await execute(binary, ["open", directory, "--json"], { timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      } catch (error) { throw new Error("ThreeRT 无法打开场景，请检查原生客户端后重新连接。", { cause: error }); }
      const input = JSON.parse(await readFile(join(directory, "input.json"), "utf8"));
      const position = new Vector3().fromArray(input.camera.position);
      const target = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().fromArray(input.camera.quaternion))
        .multiplyScalar(Math.max(1, position.length())).add(position);
      const camera = validateLiveCamera({ position: position.toArray(), target: target.toArray(), fov: input.camera.fov });
      const session = { id: randomUUID(), sceneId, version, directory, sequence: 0, camera };
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await this.request("GET", "/status");
        if (!status.loading && status.project?.url?.startsWith(directory)) {
          this.active = session;
          await this.request("POST", "/camera", camera);
          return { sessionId: session.id, camera };
        }
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error("ThreeRT 场景加载超时。");
    } finally { this.connecting = false; }
  }

  private session(sceneId: string, version: string, id: string) {
    const session = this.active;
    if (!session || session.id !== id || session.sceneId !== sceneId || session.version !== version) throw new Error("实时会话已失效，请重新连接。");
    return session;
  }

  async camera(sceneId: string, version: string, id: string, input: unknown) {
    const session = this.session(sceneId, version, id), camera = validateLiveCamera(input);
    const status = await this.request("GET", "/status");
    if (status.loading || !status.project?.url?.startsWith(session.directory)) throw new Error("原生场景已切换，请重新连接。");
    this.session(sceneId, version, id);
    await this.request("POST", "/camera", camera);
    session.camera = camera;
    return { camera };
  }

  frame(sceneId: string, version: string, id: string) {
    const session = this.session(sceneId, version, id);
    // ponytail: current-frame PNG readback limits transport FPS; use the engine's streaming codec for higher rates.
    if (!session.pendingFrame) session.pendingFrame = (async () => {
      const status = await this.request("GET", "/status");
      if (status.loading || !status.project?.url?.startsWith(session.directory)) throw new Error("原生场景已切换，请重新连接。");
      this.session(sceneId, version, id);
      const path = join(session.directory, `live-${session.id}.png`);
      await this.request("POST", "/screenshot", { path, history: 0, timeout: 3 });
      const bytes = await readFile(path);
      this.session(sceneId, version, id);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("ThreeRT frame is invalid.");
      return { bytes, sequence: ++session.sequence, capturedAt: Date.now() };
    })().finally(() => { session.pendingFrame = undefined; });
    return session.pendingFrame;
  }

  disconnect(sceneId: string, version: string, id: string) {
    this.session(sceneId, version, id);
    this.active = undefined;
  }
}

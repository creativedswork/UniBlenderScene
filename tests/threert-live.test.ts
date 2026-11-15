import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreeRTLive, validateLiveCamera } from "../src/service/threert-live.js";

test("native live frames share readbacks, synchronize cameras, and reject superseded sessions", async t => {
  if (process.platform === "win32") return t.skip("POSIX client fixture");
  const directory = await mkdtemp(join(tmpdir(), "threert-live-")), binary = join(directory, "threert");
  await writeFile(binary, "#!/usr/bin/env node\nif(process.argv[2]!=='open')process.exit(1);", { mode: 0o755 });
  await writeFile(join(directory, "input.json"), JSON.stringify({ camera: { position: [10, 5, 10], quaternion: [0, 0, 0, 1], fov: 50 } }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=", "base64");
  let captures = 0, pose: unknown, project = directory;
  const live = new ThreeRTLive(async (method, route, body: any) => {
    if (route === "/status") return { ok: true, project: { url: project }, loading: null };
    if (route === "/camera") { pose = body; return { ok: true }; }
    assert.equal(route, "/screenshot"); assert.equal(method, "POST"); assert.equal(body.history, 0, "Read the ongoing live frame without waiting for a converged still");
    captures++; await writeFile(body.path, png); return { ok: true };
  });
  const first = await live.connect("scene_a", "v1", directory, binary);
  const results = await Promise.all([live.frame("scene_a", "v1", first.sessionId), live.frame("scene_a", "v1", first.sessionId)]);
  assert.equal(captures, 1); assert.equal(results[0]!.sequence, results[1]!.sequence);
  const camera = { position: [4, 6, 8], target: [0, 1, 0], fov: 55 };
  await live.camera("scene_a", "v1", first.sessionId, camera); assert.deepEqual(pose, camera);
  assert.equal((await live.frame("scene_a", "v1", first.sessionId)).sequence, 2);
  const second = await live.connect("scene_a", "v1", directory, binary);
  assert.throws(() => live.frame("scene_a", "v1", first.sessionId), /失效/);
  assert.throws(() => live.frame("scene_a", "v2", second.sessionId), /失效/);
  project = "/another-project";
  await assert.rejects(live.camera("scene_a", "v1", second.sessionId, camera), /场景已切换/);
  await assert.rejects(live.frame("scene_a", "v1", second.sessionId), /场景已切换/);
  live.disconnect("scene_a", "v1", second.sessionId);
  assert.throws(() => live.frame("scene_a", "v1", second.sessionId), /失效/);
  for (const bad of [{ ...camera, position: [NaN, 0, 0] }, { ...camera, target: camera.position }, { ...camera, fov: Infinity }]) {
    assert.throws(() => validateLiveCamera(bad), /Invalid live camera/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlenderClient } from "../src/service/blender.js";
import { SceneStore, type Scene } from "../src/service/store.js";
import { cameraFromGLB, modelWithoutPunctualLights, renderThreeRT } from "../src/service/threert.js";
import { buildThreeRTScene, type ThreeRTInput } from "../runtime/threert/scene.js";
import { FogVolume } from "@threert/scene";

function glb(cameraType = "perspective") {
  const text = JSON.stringify({ nodes: [{ translation: [10, 0, 0], children: [1] },
    { name: "Main", camera: 0, translation: [0, 2, 5] }],
    cameras: [{ type: cameraType, perspective: { yfov: Math.PI / 3, aspectRatio: 2, znear: 0.1, zfar: 300 } }],
    extensionsRequired: ["KHR_lights_punctual"], extensions: { KHR_lights_punctual: { lights: [] } } });
  const bytes = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(bytes.length + 20, 8); header.writeUInt32LE(bytes.length, 12); header.write("JSON", 16);
  return Buffer.concat([header, bytes]);
}
const profile = { colorManagement: { exposure: 0.65 }, render: { resolutionX: 1280, resolutionY: 640 },
  camera: { name: "Main" }, world: { color: [0.1, 0.1, 0.1], strength: 1 }, lights: [],
  previewAppearance: { dust: { color: [0.8, 0.7, 0.6], volumes: [{ center: [2, 3, 4], radius: [5, 6, 7], density: 0.1 }] } } };

test("thin atmosphere retains physical extinction through ThreeRT's fog coverage combination", () => {
  for (const density of [0.004, 0.14]) {
    const input: ThreeRTInput = { camera: cameraFromGLB(glb()), profile: structuredClone(profile) };
    input.profile.previewAppearance!.dust!.volumes[0]!.density = density;
    input.profile.previewAppearance!.dust!.wind = [0.12, 0.04, 0.025];
    const fog = buildThreeRTScene(input).scene.children.find(child => child instanceof FogVolume) as FogVolume;
    const { Radial, Height } = fog.volume.params as { Radial: number; Height: number };
    // ThreeRT's local_fog combines transmittances as A + B - A*B, not extinction sums.
    // At the sphere centre, the height term must not suppress the specified radial density.
    const a = Math.exp(-Height), b = Math.exp(-Radial);
    const extinction = -Math.log(a + b - a * b);
    assert.ok(Math.abs(extinction / density - 1) < 0.00001);
    assert.ok(Math.abs(Math.exp(-extinction * 20) - Math.exp(-density * 20)) < 0.00001);
    assert.equal(fog.animated, true, "The native viewport must update the drifting medium");
    assert.deepEqual(fog.volume.params.Wind, [0.12, 0.025, -0.04, 0], "Convert Blender Z-up wind to native Y-up");
  }
});

test("ThreeRT preserves a parented camera and converts local dust from Z-up to Y-up", () => {
  const camera = cameraFromGLB(glb(), "Main");
  assert.deepEqual(camera.position, [10, 2, 5]);
  assert.ok(Math.abs(camera.fov - 60) < 1e-9);
  assert.throws(() => cameraFromGLB(glb("orthographic")), /perspective/);
  const source = glb(), tail = Buffer.from([4, 0, 0, 0, 66, 73, 78, 0, 1, 2, 3, 4]);
  const model = modelWithoutPunctualLights(Buffer.concat([source, tail]));
  const modelJSON = JSON.parse(model.toString("utf8", 20, 20 + model.readUInt32LE(12)));
  assert.equal(modelJSON.extensionsRequired, undefined);
  assert.deepEqual(model.subarray(-tail.length), tail, "Binary mesh/texture bytes must stay intact");
  assert.deepEqual(cameraFromGLB(model), camera);
  const input: ThreeRTInput = { camera, profile: structuredClone(profile) };
  input.profile.lights = [{ name: "Sun", type: "SUN", energy: 5, color: [1, 0.8, 0.4], useShadow: true,
    size: 0, sizeY: 0, shape: "", spotSize: 0, spotBlend: 0, worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }];
  const built = buildThreeRTScene(input);
  const sun = built.scene.children.find(child => child.name === "Sun")!;
  assert.deepEqual([sun.position.x, sun.position.y, sun.position.z], [0, 0, 0], "Remove the constructor's default offset");
  assert.equal((sun as unknown as { target: unknown }).target, null);
  input.profile.lights[0]!.type = "AREA";
  input.profile.lights[0]!.worldMatrix = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 25, 5, 1];
  const area = buildThreeRTScene(input).scene.children.find(child => child.name === "Sun")!;
  assert.deepEqual([area.position.x, area.position.y, area.position.z], [0, 25, 5]);
  assert.equal((area as unknown as { card: boolean }).card, false, "Fill lights must not become visible occluding cards");
  const fog = built.scene.children.find(child => child.name === "fog-volume")!;
  assert.deepEqual([fog.position.x, fog.position.y, fog.position.z], [2, 4, -3]);
  assert.deepEqual([fog.scale.x, fog.scale.y, fog.scale.z], [10, 14, 12]);
  assert.equal(built.camera.exposure.mode, "manual");
});

test("ThreeRT jobs preserve source/workflow, expose only current successful output, and retain failures", async t => {
  if (process.platform === "win32") return t.skip("POSIX executable fixture");
  const root = mkdtempSync(join(tmpdir(), "native-render-"));
  const binary = join(root, "threert-render");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=";
  writeFileSync(binary, `#!/usr/bin/env node
    const fs=require('node:fs'),path=require('node:path');
    const args=process.argv.slice(2);if(args[0]!=='render')throw Error('wrong command');
    const dir=args.includes('--assets')?args[args.indexOf('--assets')+1]:args[1];
    if(!fs.existsSync(path.join(dir,'final.glb')))throw Error('missing source GLB');
    if(!args.includes('--assets')&&!fs.existsSync(path.join(dir,'threert.config.json')))throw Error('missing project');
    fs.writeFileSync(args[args.indexOf('-o')+1],Buffer.from('${png}','base64'));
    console.log(JSON.stringify({spp:args[args.indexOf('--spp')+1]}));`, { mode: 0o755 });
  class Exporter extends BlenderClient {
    override async execute(code: string) {
      const directory = JSON.parse(code.match(/^directory = (".*")$/m)![1]!);
      const bakeInfo = code.match(/^bake_info = json.loads\((".*")\)$/m);
      if (bakeInfo) {
        assert.match(code, /lighting_enabled = False/);
        const info = JSON.parse(JSON.parse(bakeInfo[1]!));
        writeFileSync(join(directory, "prepared.blend"), "source materials");
        writeFileSync(join(directory, "bake.json"), JSON.stringify({ ...info,
          bakedObjects: [], lightmaps: [], bakedTints: {}, materials: { objects: 0, textures: 0 } }));
        return {};
      }
      const metadata = JSON.parse(JSON.parse(code.match(/^bake_metadata = json.loads\((".*")\)$/m)![1]!));
      assert.equal(metadata.lightingEnabled, false);
      assert.deepEqual(metadata.bakedObjects, []);
      writeFileSync(join(directory, "final.glb"), glb());
      writeFileSync(join(directory, "render-profile.json"), JSON.stringify(profile));
      return {};
    }
  }
  const store = new SceneStore(root, new Exporter());
  const scene: Scene = { id: "scene_1234", prompt: "Fixture", token: "token", createdAt: "", updatedAt: "",
    stage: "best_effort", iteration: 4, startIteration: 3, noImprovement: 0, extended: false, reviews: [],
    exportVersion: "export-one", exportedIteration: 4, compositionApproved: true,
    best: { iteration: 4, criteria: [], visualScore: 80, regressions: [], repairable: false, nextAction: "deliver" } };
  mkdirSync(store.path(scene, "artifacts/4"), { recursive: true });
  writeFileSync(store.path(scene, "best.blend"), "source"); writeFileSync(store.path(scene, "best.png"), "render");
  writeFileSync(store.path(scene, "artifacts/4/final.glb"), "original export");
  store.scenes.set(scene.id, scene); store.save(scene);
  const before = process.env.THREERT_BIN;
  try {
    process.env.THREERT_BIN = join(root, "not-installed");
    assert.throws(() => store.renderHighQuality(scene.id), /未找到 ThreeRT/);
    assert.equal(scene.job, undefined);
    process.env.THREERT_BIN = binary;
    store.renderHighQuality(scene.id); assert.throws(() => store.renderHighQuality(scene.id), /still running/);
    await store.settled();
    assert.equal(scene.threeRTRender?.status, "done");
    assert.equal(scene.stage, "best_effort"); assert.equal(scene.iteration, 4);
    assert.equal(scene.compositionApproved, true); assert.equal(scene.exportVersion, "export-one");
    assert.equal(readFileSync(store.path(scene, "best.blend"), "utf8"), "source");
    assert.equal(readFileSync(store.path(scene, "artifacts/4/final.glb"), "utf8"), "original export");
    assert.ok(store.allowedFiles(scene).some(file => file.endsWith("/threert.png")));
    scene.job!.status = "running"; scene.threeRTRender!.status = "running"; store.save(scene);
    const recovered = new SceneStore(root, new Exporter()).get(scene.id);
    assert.equal(recovered.threeRTRender?.status, "failed");
    assert.equal(recovered.iteration, 4); assert.equal(recovered.stage, "best_effort");
    scene.job!.status = "done"; scene.threeRTRender!.status = "done";
    const directory = store.path(scene, scene.threeRTRender!.directory);
    const cli = join(root, "threert"); writeFileSync(cli, readFileSync(binary), { mode: 0o755 });
    await renderThreeRT(directory, cli);
    assert.match(readFileSync(join(directory, "game.js"), "utf8"), /@threert\/scene/);
    scene.exportVersion = "export-two";
    assert.ok(!store.allowedFiles(scene).some(file => file.endsWith("/threert.png")), "Old results must not appear as current");
    writeFileSync(binary, "#!/usr/bin/env node\nprocess.exit(2)", { mode: 0o755 });
    await assert.rejects(renderThreeRT(directory, binary), /ThreeRT/);
    store.renderHighQuality(scene.id); await store.settled();
    assert.equal(scene.threeRTRender?.status, "failed");
    assert.match(scene.threeRTRender?.error ?? "", /ThreeRT/);
    assert.ok(!store.allowedFiles(scene).some(file => file.endsWith("/threert.png")));
    assert.equal(scene.stage, "best_effort"); assert.equal(scene.iteration, 4);
  } finally { if (before === undefined) delete process.env.THREERT_BIN; else process.env.THREERT_BIN = before; }
});

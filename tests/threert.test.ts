import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlenderClient } from "../src/service/blender.js";
import { SceneStore, type Scene } from "../src/service/store.js";
import { cameraFromGLB, collectThreeRTWarnings, modelWithoutPunctualLights, renderThreeRT } from "../src/service/threert.js";
import { buildThreeRTScene, type ThreeRTInput } from "../runtime/threert/scene.js";
import { DirectionalLight, FogVolume, HomogeneousVolume, RainCurtain, VolumeMesh } from "@threert/scene";
import { PNG } from "pngjs";
import { DataTexture, FloatType, RGBAFormat } from "three";
import { EXRExporter, NO_COMPRESSION } from "three/addons/exporters/EXRExporter.js";

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

test("native visible sky preserves panorama orientation and radiance separately from ambient lighting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "threert-sky-"));
  const cli = join(directory, "threert");
  const data = new Float32Array([
    0.25, 0, 0, 1, 0.5, 0, 0, 1,
    0, 0.25, 0, 1, 0, 0.5, 0, 1,
    0, 0, 1, 1, 0, 0, 2, 1,
  ]);
  const sky = new DataTexture(data, 2, 3, RGBAFormat, FloatType);
  const exr = Buffer.from(await new EXRExporter().parse(sky, { compression: NO_COMPRESSION, type: FloatType }));
  const stubImage = PNG.sync.write(new PNG({ width: 1, height: 1 })).toString("base64");
  writeFileSync(cli, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.argv[process.argv.indexOf("-o") + 1], Buffer.from("${stubImage}", "base64"));
`, { mode: 0o755 });
  try {
    writeFileSync(join(directory, "final.glb"), glb());
    writeFileSync(join(directory, "environment.exr"), exr);
    writeFileSync(join(directory, "background.exr"), exr);
    writeFileSync(join(directory, "render-profile.json"), JSON.stringify({ ...profile, world: { ...profile.world,
      environmentUri: "environment.exr", backgroundEnvironmentUri: "background.exr",
      environmentRotationY: Math.PI / 2 } }));
    await renderThreeRT(directory, cli);
    const input: ThreeRTInput = JSON.parse(readFileSync(join(directory, "input.json"), "utf8"));
    assert.deepEqual(input.environment, { zenith: [0, 0, 1.5], horizon: [0, 0.375, 0], ground: [0.375, 0, 0] });
    assert.equal(input.skyRadianceScale, 2);
    const png = PNG.sync.read(readFileSync(join(directory, "assets", "sky.png")));
    assert.deepEqual([...png.data.subarray(0, 8)], [0, 0, 255, 255, 0, 0, 188, 255]);
    assert.deepEqual([...png.data.subarray(16, 20)], [137, 0, 0, 255]);
    const { scene } = buildThreeRTScene(input);
    assert.equal(scene.children.find(child => child.name === "Sky panorama")?.rotation.y, Math.PI / 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native models normalize RGB16 and RGBA16 PNGs without changing source, mesh bytes or 8-bit textures", () => {
  const pixel = (data: Buffer) => Object.assign(new PNG({ width: 1, height: 1 }), { data });
  const rgb = PNG.sync.write(pixel(Buffer.from(new Uint16Array([0, 32768, 65535]).buffer)),
    { bitDepth: 16, colorType: 2, inputColorType: 2 });
  const rgba = PNG.sync.write(pixel(Buffer.from(new Uint16Array([65535, 16384, 0, 32768]).buffer)),
    { bitDepth: 16, colorType: 6 });
  const eight = PNG.sync.write(pixel(Buffer.from([1, 2, 3, 4])));
  const geometry = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const binary = Buffer.concat([geometry, rgb, rgba, eight]);
  const document = JSON.parse(glb().toString("utf8", 20).trim());
  document.buffers = [{ byteLength: binary.length }];
  document.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: geometry.length }];
  let offset = geometry.length;
  for (const png of [rgb, rgba, eight]) {
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length }); offset += png.length;
  }
  document.images = [1, 2, 3].map(bufferView => ({ bufferView, mimeType: "image/png" }));
  const jsonText = JSON.stringify(document), json = Buffer.from(jsonText.padEnd(Math.ceil(jsonText.length / 4) * 4, " "));
  const header = Buffer.from(glb().subarray(0, 20)), chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(Math.ceil(binary.length / 4) * 4); chunk.write("BIN\0", 4);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(20 + json.length + 8 + chunk.readUInt32LE(0), 8);
  const source = Buffer.concat([header, json, chunk, binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const original = Buffer.from(source), result = modelWithoutPunctualLights(source);
  assert.deepEqual(source, original);
  const converted = JSON.parse(result.toString("utf8", 20, 20 + result.readUInt32LE(12)));
  const binOffset = 28 + result.readUInt32LE(12);
  assert.deepEqual(result.subarray(binOffset, binOffset + binary.length), binary);
  const images = converted.images.map((image: { bufferView: number }) => {
    const view = converted.bufferViews[image.bufferView];
    return result.subarray(binOffset + view.byteOffset, binOffset + view.byteOffset + view.byteLength);
  });
  assert.equal(images[0][24], 8); assert.equal(images[1][24], 8);
  assert.deepEqual([...PNG.sync.read(images[0]).data], [0, 128, 255, 255]);
  assert.deepEqual([...PNG.sync.read(images[1]).data], [255, 64, 0, 128]);
  assert.deepEqual(images[2], eight);
  assert.deepEqual(cameraFromGLB(result), cameraFromGLB(source));
  assert.equal(result.length, result.readUInt32LE(8));
  assert.equal(modelWithoutPunctualLights(result).length, result.length, "Conversion must be idempotent");
});

test("thin atmosphere retains physical extinction through ThreeRT's fog coverage combination", () => {
  for (const [density, hazeScale] of [[0.004, undefined], [0.14, 0.53]] as const) {
    const input: ThreeRTInput = { camera: cameraFromGLB(glb()), profile: structuredClone(profile) };
    input.profile.previewAppearance!.hazeScale = hazeScale;
    input.profile.previewAppearance!.dust!.volumes[0]!.density = density;
    input.profile.previewAppearance!.dust!.wind = [0.12, 0.04, 0.025];
    const fog = buildThreeRTScene(input).scene.children.find(child => child instanceof FogVolume) as FogVolume;
    const { Radial, Height } = fog.volume.params as { Radial: number; Height: number };
    // ThreeRT's local_fog combines transmittances as A + B - A*B, not extinction sums.
    // At the sphere centre, the height term must not suppress the specified radial density.
    const a = Math.exp(-Height), b = Math.exp(-Radial);
    const extinction = -Math.log(a + b - a * b);
    const expectedDensity = density * (hazeScale ?? 1);
    assert.ok(Math.abs(extinction / expectedDensity - 1) < 0.00001);
    assert.ok(Math.abs(Math.exp(-extinction * 20) - Math.exp(-expectedDensity * 20)) < 0.00001);
    assert.equal(fog.animated, true, "The native viewport must update the drifting medium");
    assert.deepEqual(fog.volume.params.Wind, [0.12, 0.025, -0.04, 0], "Convert Blender Z-up wind to native Y-up");
  }
});

test("native sunlight and volume shaders use the exported sun and shaft axis", () => {
  const input: ThreeRTInput = { camera: cameraFromGLB(glb()), profile: structuredClone(profile) };
  input.profile.lights = [{ name: "Sun", type: "SUN", energy: 5, color: [1, 0.8, 0.4], useShadow: true,
    size: 0, sizeY: 0, shape: "", spotSize: 0, spotBlend: 0, worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }];
  input.profile.effects = { version: 1, sun: { name: "Sun", direction: [0, 0, 1], angularRadius: Math.PI / 360,
    radiance: [1, 0.8, 0.4], inBackground: true }, fog: [], issues: [], shafts: [
    { name: "shaft", start: [1, 2, 6], end: [1, 2, 4], radii: [0.2, 0.4], density: 0.02,
      albedo: [1, 1, 1], emission: [0.3, 0.2, 0.1], anisotropy: 0.7 },
  ] };
  const { scene } = buildThreeRTScene(input);
  const sun = scene.children.find(child => child.name === "Sun");
  assert.ok(sun instanceof DirectionalLight);
  assert.equal(sun.angularDiameter, 1);
  const disk = scene.children.find(child => child.name === "Solar disk");
  assert.ok(disk);
  assert.deepEqual(disk.position.toArray(), [10, 2, 100005]);
  const shaft = scene.children.find(child => child.name === "shaft");
  assert.ok(shaft instanceof VolumeMesh);
  assert.deepEqual(shaft.volume.params.Start, [1, 2, 6, 0.2]);
  assert.deepEqual(shaft.volume.params.End, [1, 2, 4, 0.4]);
  assert.ok(shaft.majorant >= 0.02);

  input.profile.effects.fog = [
    { name: "air", min: [-20, 0, -30], max: [20, 20, 10], density: 1,
      ramps: [{ axis: 2, range: [-15, -5], density: [0.02, 0.005] }, { axis: 1, range: [0, 10], density: [1, 0.5] }],
      emission: [0, 0, 0], albedo: [1, 0.9, 0.8], anisotropy: 0.6 },
  ];
  input.skyRadianceScale = 1;
  const fittedScene = buildThreeRTScene(input).scene;
  assert.ok(fittedScene.fog?.volumetric);
  assert.equal(fittedScene.fog.startDistance, 11.25);
  assert.equal(fittedScene.fog.volumetric.distance, 35);
  assert.deepEqual(fittedScene.fog.volumetric.albedo, [1, 0.9, 0.8]);
  assert.ok(fittedScene.children.some(child => child.name === "Sky panorama"));
  assert.ok(!fittedScene.children.some(child => child.name === "Solar disk"), "The panorama already contains the sun");
  assert.ok(!fittedScene.children.some(child => child.name === "air"), "Avoid counting both haze approximations");
  input.camera.position[1] = 30;
  assert.ok(buildThreeRTScene(input).scene.children.some(child => child.name === "air"), "Preserve a local volume viewed from outside");
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
  assert.deepEqual((sun as unknown as { color: { toArray(): number[] } }).color.toArray(), [1, 0.8, 0.4],
    "Profile light colors are already linear and must not be decoded from sRGB again");
  assert.deepEqual(built.options.overrides.post.colorGrading, { expandGamut: 0, blueCorrection: 0 },
    "The native adapter must not add a second artistic color grade");
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

test("native VFX maps exported boxes, phase and rain to ThreeRT objects", () => {
  const input: ThreeRTInput = { camera: cameraFromGLB(glb()), profile: {
    ...profile, previewAppearance: undefined, vfx: {
      volumes: [{ name: "Upper haze", min: [-1, 2, -3], max: [3, 8, 1],
        density: 0.007, anisotropy: 0.25, color: [0.2, 0.5, 0.8] },
      { name: "Ground haze", min: [-1, 0, -3], max: [3, 2, 1], density: 0.05, anisotropy: 0.45,
        color: [0.6, 0.3, 0.15], height: { mode: "exponential", start: 0.2, depth: 0.5 } }],
      precipitation: [{ name: "Rain", kind: "rain", center: [0, 2, 0], size: [4, 4, 4], velocity: [1, -4, 0],
        count: 20, period: 2, lives: 2, seed: 1, radius: 0.003, streak: 0.1, sway: 0, near: 0, splash: 0, ground: [],
        color: [0.5, 0.6, 0.7], emission: [0, 0, 0] }],
    }, postprocessing: { haze: { color: [0.4, 0.5, 0.6], strength: 0.5, start: 10, depth: 100, falloff: "LINEAR" } },
  } };
  const { scene } = buildThreeRTScene(input);
  const box = scene.children.find(child => child instanceof HomogeneousVolume) as HomogeneousVolume;
  assert.equal(box.shape, "box");
  assert.equal(box.anisotropy, 0.25);
  assert.deepEqual([box.position.x, box.position.y, box.position.z], [1, 5, -1]);
  const fog = scene.children.find(child => child instanceof FogVolume) as FogVolume;
  assert.deepEqual(fog.volume.params.Albedo, [0.6, 0.3, 0.15, 0]);
  assert.equal(fog.anisotropy, 0.45);
  assert.ok(scene.children.some(child => child instanceof RainCurtain));
  assert.equal(scene.fog?.startDistance, 10);
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

test("collectThreeRTWarnings deduplicates volume density warnings already listed in effects.issues", () => {
  const warnings = collectThreeRTWarnings({
    render: { resolutionX: 640, resolutionY: 360, filmTransparent: false },
    world: { color: [0, 0, 0], strength: 1, environmentUri: "environment.exr", environmentRotationY: 0 },
    colorManagement: { viewTransform: "AgX", exposure: 0 },
    lights: [],
    warnings: [
      "WebGL only warning",
      "Compositor Fog Glow is approximated with Bloom.",
      "Volume Street Haze: unsupported density graph.",
      "Volume Standalone Fog: unsupported density graph.",
    ],
    effects: {
      version: 1,
      shafts: [],
      fog: [],
      issues: [
        { object: "Street Haze", effect: "fog", status: "missing", reason: "the density graph uses unsupported inputs" },
        { object: "Water", effect: "reflection", status: "approximate", reason: "threejs only", target: "threejs" },
      ],
    },
  });
  assert.deepEqual(warnings, [
    "Compositor Fog Glow is approximated with Bloom.",
    "Volume Standalone Fog: unsupported density graph.",
    "Street Haze · fog: the density graph uses unsupported inputs",
    "ThreeRT 使用原生 Filmic 色调映射，未应用 Blender 的 AgX 显示 LUT。",
    "ThreeRT 使用渐变天空近似环境照明。",
  ]);
});

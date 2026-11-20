import { execFile } from "node:child_process";
import { constants, accessSync, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { PNG } from "pngjs";
import { FloatType, Matrix4, Quaternion, Vector3 } from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import type { ThreeRTInput } from "../../runtime/threert/scene.js";

const execute = promisify(execFile);

function environmentBands(bytes: Buffer): NonNullable<ThreeRTInput["environment"]> {
  const exr = new EXRLoader().setDataType(FloatType).parse(new Uint8Array(bytes).buffer);
  const bands = { zenith: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0] }, counts = { zenith: 0, horizon: 0, ground: 0 };
  const stride = exr.data.length / (exr.width * exr.height);
  for (let y = 0; y < exr.height; y++) {
    const band = y < exr.height * 0.2 ? "zenith" : y > exr.height * 0.8 ? "ground" : Math.abs(y / exr.height - 0.5) < 0.1 ? "horizon" : undefined;
    if (!band) continue;
    for (let x = 0; x < exr.width; x++) {
      const offset = (y * exr.width + x) * stride;
      for (let channel = 0; channel < 3; channel++) bands[band][channel]! += Math.max(0, exr.data[offset + channel]!);
      counts[band]++;
    }
  }
  for (const band of ["zenith", "horizon", "ground"] as const) bands[band] = bands[band].map(value => value / Math.max(1, counts[band]));
  return bands;
}

export function threeRTCapability() {
  const configured = process.env.THREERT_BIN;
  const extension = process.platform === "win32" ? ".exe" : "";
  const candidates = configured ? [configured] : (process.env.PATH ?? "").split(delimiter).flatMap(dir =>
    [join(dir, `threert-render${extension}`), join(dir, `threert${extension}`)]);
  const binary = candidates.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
  const liveAvailable = Boolean(binary && basename(binary).replace(/\.exe$/i, "") === "threert");
  return binary ? { available: true as const, binary: resolve(binary),
    liveAvailable, liveReason: liveAvailable ? undefined : "当前 ThreeRT 仅支持静态渲染，实时交互需要原生客户端",
  } : {
    available: false as const, liveAvailable: false, reason: "未找到 ThreeRT。请安装原生客户端，并在服务端设置 THREERT_BIN 为 threert 或 threert-render 的路径。",
  };
}

export function cameraFromGLB(bytes: Buffer, cameraName?: string): ThreeRTInput["camera"] {
  if (bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2) throw new Error("ThreeRT input is not a GLB 2 file.");
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
  const nodes = gltf.nodes as { name?: string; camera?: number; children?: number[]; matrix?: number[];
    translation?: number[]; rotation?: number[]; scale?: number[] }[];
  const normalized = (name: string) => name.replace(/\s/g, "_").replace(/[\[\].:/]/g, "");
  let index = nodes.findIndex(n => n.camera !== undefined && normalized(n.name ?? "") === normalized(cameraName ?? ""));
  if (index < 0) index = nodes.findIndex(n => n.camera !== undefined);
  if (index < 0) throw new Error("The scene has no exported camera.");
  const view = gltf.cameras[nodes[index]!.camera!];
  if (view.type !== "perspective") throw new Error("ThreeRT rendering currently requires a perspective camera.");
  const parents = new Map<number, number>();
  nodes.forEach((node, parent) => node.children?.forEach(child => parents.set(child, parent)));
  const matrix = new Matrix4(), seen = new Set<number>();
  for (let current: number | undefined = index; current !== undefined; current = parents.get(current)) {
    if (seen.has(current)) throw new Error("Invalid GLB camera hierarchy.");
    seen.add(current);
    const node = nodes[current]!;
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
      new Vector3().fromArray(node.scale ?? [1, 1, 1]));
    matrix.premultiply(local);
  }
  const position = new Vector3(), quaternion = new Quaternion();
  matrix.decompose(position, quaternion, new Vector3());
  return { position: position.toArray(), quaternion: quaternion.toArray(), fov: view.perspective.yfov * 180 / Math.PI,
    aspect: view.perspective.aspectRatio ?? 1, near: view.perspective.znear, far: view.perspective.zfar ?? 10000 };
}

/** Native-only copy: profile lights replace glTF lights; unsupported 16-bit PNGs become RGBA8. */
export function modelWithoutPunctualLights(bytes: Buffer): Buffer {
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + length));
  for (const owner of [gltf, ...(gltf.nodes ?? [])]) {
    if (owner.extensions) {
      delete owner.extensions.KHR_lights_punctual;
      if (!Object.keys(owner.extensions).length) delete owner.extensions;
    }
  }
  for (const field of ["extensionsRequired", "extensionsUsed"]) if (gltf[field]) {
    gltf[field] = gltf[field].filter((name: string) => name !== "KHR_lights_punctual");
    if (!gltf[field].length) delete gltf[field];
  }
  let tail = bytes.subarray(20 + length);
  const additions: Buffer[] = [];
  let binaryLength = gltf.buffers?.[0]?.byteLength ?? 0;
  for (const image of gltf.images ?? []) {
    const view = gltf.bufferViews?.[image.bufferView];
    if (!view || view.buffer !== 0 || tail.toString("ascii", 4, 8) !== "BIN\0") continue;
    const png = tail.subarray(8 + (view.byteOffset ?? 0), 8 + (view.byteOffset ?? 0) + view.byteLength);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png[24] !== 16) continue;
    // pngjs rescales samples without applying gamma; glTF texture semantics still set the color space.
    const converted = PNG.sync.write(PNG.sync.read(png), { bitDepth: 8, colorType: 6 });
    const padding = (4 - binaryLength % 4) % 4;
    additions.push(Buffer.alloc(padding), converted);
    image.bufferView = gltf.bufferViews.length;
    gltf.bufferViews.push({ buffer: 0, byteOffset: binaryLength + padding, byteLength: converted.length });
    binaryLength += padding + converted.length;
  }
  if (additions.length) {
    const binary = Buffer.concat([tail.subarray(8, 8 + gltf.buffers[0].byteLength), ...additions,
      Buffer.alloc((4 - binaryLength % 4) % 4)]);
    const chunk = Buffer.alloc(8); chunk.writeUInt32LE(binary.length); chunk.write("BIN\0", 4);
    tail = Buffer.concat([chunk, binary, tail.subarray(8 + tail.readUInt32LE(0))]);
    gltf.buffers[0].byteLength = binaryLength;
  }
  const text = Buffer.from(JSON.stringify(gltf)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + json.length + tail.length, 8); header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, json, tail]);
}

/** Execute only the configured local engine. No shell, scene code or executable paths come from the widget. */
export async function renderThreeRT(directory: string, binary: string) {
  const profile = JSON.parse(await readFile(join(directory, "render-profile.json"), "utf8"));
  const glb = await readFile(join(directory, "final.glb"));
  const input: ThreeRTInput = { profile, camera: cameraFromGLB(glb, profile.camera?.name) };
  const warnings: string[] = (Array.isArray(profile.warnings) ? profile.warnings : []).filter((warning: unknown): warning is string =>
    typeof warning === "string" && !warning.startsWith("WebGL ") && !warning.startsWith("Three.js "));
  const vfx = input.profile.vfx;
  if (vfx?.volumes?.some(volume => volume.height || volume.noiseScale)) {
    warnings.push("ThreeRT 使用原生雾近似 Blender 的逐层密度曲线和噪声。");
  }
  if (input.profile.postprocessing?.haze) {
    const worldFog = vfx?.volumes?.some(volume => !volume.min || !volume.max);
    warnings.push(worldFog ? "ThreeRT 优先使用世界雾，未叠加 Mist 深度合成。" : "ThreeRT 使用原生指数雾近似 Mist 深度合成。");
  }
  if (vfx?.precipitation?.some(effect => effect.kind === "rain")) {
    warnings.push("ThreeRT 原生雨使用跟随相机的雨幕，Blender 的碰撞和飞溅未应用。");
  }
  if (vfx?.precipitation?.some(effect => effect.kind !== "rain") || vfx?.ripples?.length || vfx?.animation) {
    warnings.push("当前 ThreeRT 预览保留静态材质和灯光，未重建非雨粒子、涟漪或采样动画。");
  }
  warnings.push(...(input.profile.effects?.issues ?? []).filter(issue => !issue.target || issue.target === "threeRT")
    .map(issue => `${issue.object} · ${issue.effect}: ${issue.reason}`));
  if (typeof profile.colorManagement.viewTransform === "string") {
    warnings.push(`ThreeRT 使用原生 Filmic 色调映射，未应用 Blender 的 ${profile.colorManagement.viewTransform} 显示 LUT。`);
  }
  if (profile.world.environmentUri) {
    input.environment = environmentBands(await readFile(join(directory, "environment.exr")));
    warnings.push("环境贴图使用渐变天空近似。");
  }
  const background = profile.world.backgroundEnvironmentUri;
  if (typeof background === "string" && background.startsWith("data:")) {
    const bands = environmentBands(Buffer.from(background.split(",")[1]!, "base64"));
    input.background = bands.horizon;
  }
  await writeFile(join(directory, "model.glb"), modelWithoutPunctualLights(glb));
  input.camera.aspect = profile.render.resolutionX / profile.render.resolutionY;
  const adapter = fileURLToPath(new URL("../../runtime/threert/scene.ts", import.meta.url));
  const clientCLI = basename(binary).replace(/\.exe$/i, "") === "threert";
  if (clientCLI) {
    input.assetPrefix = "assets/";
    await mkdir(join(directory, "assets"), { recursive: true });
    await copyFile(join(directory, "model.glb"), join(directory, "assets/model.glb"));
    if (profile.world.environmentUri) await copyFile(join(directory, "environment.exr"), join(directory, "assets/environment.exr"));
  }
  // The macOS CLI's host uses its bundled SDK. Resolve scene classes to that same SDK to preserve instanceof checks.
  const bundledScene = resolve(dirname(realpathSync(binary)), "../Resources/sdk/engine/packages/scene/src/index.ts");
  const sceneModule = clientCLI && existsSync(bundledScene) ? bundledScene : "@threert/scene";
  const bundle = await build({ stdin: { contents: `
    import { buildThreeRTScene } from ${JSON.stringify(adapter)};
    ${clientCLI ? `export default () => buildThreeRTScene(${JSON.stringify(input)});` : `
      import { defineGame, installNodeHost } from "@threert/gameplay";
      installNodeHost(defineGame({state:{},setup:()=>buildThreeRTScene(${JSON.stringify(input)}),handlers:{}}));`}`,
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)), sourcefile: "threert-scene.ts", loader: "ts" },
    bundle: true, format: clientCLI ? "esm" : "iife", external: clientCLI ? [sceneModule] : [],
    ...(sceneModule !== "@threert/scene" ? { alias: { "@threert/scene": sceneModule } } : {}),
    platform: "neutral", target: "es2022", write: false, legalComments: "none" });
  const script = join(directory, clientCLI ? "game.js" : "scene.js"), output = join(directory, "threert.png");
  await writeFile(script, bundle.outputFiles[0]!.contents);
  await writeFile(join(directory, "input.json"), JSON.stringify(input, null, 2));
  if (clientCLI) await writeFile(join(directory, "threert.config.json"), JSON.stringify({ id: "blender-preview", name: "Blender preview", entry: "game.js" }));
  try {
    await rm(output, { force: true });
    const args = clientCLI ? ["render", directory, "-o", output, "--spp", "128", "--json"] :
      ["render", script, "--assets", directory, "-o", output, "--spp", "128"];
    const result = await execute(binary, args, {
      cwd: directory, timeout: 600000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    await writeFile(join(directory, "engine.log"), result.stdout + result.stderr);
    const png = await readFile(output);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("ThreeRT did not produce a PNG image.");
    return warnings;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    await writeFile(join(directory, "engine.log"), `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message}`);
    throw new Error("ThreeRT 渲染失败，可重试或切回网页交互。详细日志保存在场景的 ThreeRT 输出目录。", { cause: error });
  }
}

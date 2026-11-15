import { execFile } from "node:child_process";
import { constants, accessSync, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
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

/** ThreeRT reads geometry from glTF; the profile supplies its lights separately. */
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
  const text = Buffer.from(JSON.stringify(gltf)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const header = Buffer.from(bytes.subarray(0, 20)), tail = bytes.subarray(20 + length);
  header.writeUInt32LE(20 + json.length + tail.length, 8); header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, json, tail]);
}

/** Execute only the configured local engine. No shell, scene code or executable paths come from the widget. */
export async function renderThreeRT(directory: string, binary: string) {
  const profile = JSON.parse(await readFile(join(directory, "render-profile.json"), "utf8"));
  const glb = await readFile(join(directory, "final.glb"));
  const input: ThreeRTInput = { profile, camera: cameraFromGLB(glb, profile.camera?.name) };
  const warnings: string[] = [];
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

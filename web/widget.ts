import { App } from "@modelcontextprotocol/ext-apps";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { calibrate } from "./calibration.js";

type Snapshot = {
  id: string; prompt: string; stage: string; iteration: number; renderUrl: string | null; bestRenderUrl: string | null;
  reference: { url: string } | null; best?: { iteration: number };
  job?: { status: string; kind: string }; exportedIteration?: number; error?: string;
  artifacts: { name: string; url: string }[];
};
type Profile = {
  version: number; colorManagement: { viewTransform: string; exposure: number };
  render: { resolutionX: number; resolutionY: number; filmTransparent: boolean };
  world: { color: number[]; strength: number; environmentUri: string | null; environmentRotationY: number };
  camera: { name: string } | null;
  lightMapping: { intensityScale: number; maxShadowLights: number; shadowPowerRatio: number };
  lights: { name: string; type: string; color: number[]; webPower: number; useShadow: boolean; size: number; sizeY: number; shape: string; spotSize: number; spotBlend: number; worldMatrix: number[] }[];
};
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = new App({ name: "CodexBlenderPlugin viewer", version: "0.1.0" }, {});
let snapshot: Snapshot | undefined, loadedURL = "", loadingURL = "", mode = "render";
let timer: ReturnType<typeof setTimeout> | undefined;
let viewer: {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls; composer: EffectComposer; ao: GTAOPass; position: THREE.Vector3; target: THREE.Vector3;
  textures: THREE.Texture[]; resize: ResizeObserver; aspect: number; calibration?: SVGSVGElement;
} | undefined;
const message = (text: string) => { el("message").textContent = text; };
const artifact = (name: string) => snapshot?.artifacts.find((item) => item.name === name)?.url;
type AssetChunk = { name: string; offset: number; size: number; mimeType: string; data: string };
const assetURLs = new Map<string, Promise<string>>();
let assetTransport: "chunk" | "scene_view" = "chunk";

async function requestAssetChunk(sceneId: string, name: string, offset: number): Promise<AssetChunk> {
  const fallback = () => app.callServerTool({ name: "scene_view", arguments: { sceneId, asset: { name, offset } } });
  let result;
  if (assetTransport === "chunk") {
    try {
      result = await app.callServerTool({ name: "scene_asset_chunk", arguments: { sceneId, name, offset } });
      if (result.isError || !result.structuredContent || !("data" in result.structuredContent)) throw new Error("Asset tool unavailable.");
    } catch {
      assetTransport = "scene_view";
      result = await fallback();
    }
  } else result = await fallback();
  if (result.isError) throw new Error(`Could not read ${name}.`);
  return result.structuredContent as AssetChunk;
}

function assetURL(name: string, version: string): Promise<string> {
  const sceneId = snapshot?.id;
  if (!sceneId) return Promise.reject(new Error("Scene is unavailable."));
  const key = `${sceneId}:${name}:${version}`;
  const cached = assetURLs.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const parts: ArrayBuffer[] = [];
    let offset = 0, size = -1, mimeType = "application/octet-stream";
    do {
      const chunk = await requestAssetChunk(sceneId, name, offset);
      if (!chunk || chunk.name !== name || chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size > 100 * 1024 * 1024) {
        throw new Error(`Invalid ${name} chunk.`);
      }
      if (size >= 0 && chunk.size !== size) throw new Error(`${name} changed while loading.`);
      size = chunk.size; mimeType = chunk.mimeType;
      const binary = atob(chunk.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (!bytes.length && offset < size) throw new Error(`Incomplete ${name} chunk.`);
      parts.push(bytes.buffer as ArrayBuffer); offset += bytes.length;
    } while (offset < size);
    return URL.createObjectURL(new Blob(parts, { type: mimeType }));
  })().catch((error) => { assetURLs.delete(key); throw error; });
  assetURLs.set(key, pending);
  return pending;
}

function dispose() {
  if (!viewer) return;
  viewer.renderer.setAnimationLoop(null);
  viewer.resize.disconnect();
  viewer.controls.dispose();
  viewer.calibration?.remove();
  viewer.scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    }
    if (object instanceof THREE.Light) object.dispose();
  });
  for (const texture of viewer.textures) texture.dispose();
  viewer.composer.passes.forEach((pass) => pass.dispose());
  viewer.composer.dispose();
  viewer.renderer.dispose();
  el("canvas").replaceChildren();
  viewer = undefined;
}

function setMode(value: string) {
  mode = value;
  el("mode-render").setAttribute("aria-pressed", String(mode === "render"));
  el("mode-3d").setAttribute("aria-pressed", String(mode === "3d"));
  el("canvas").style.display = mode === "3d" ? "flex" : "none";
  el("render").style.display = mode === "render" && Boolean(el<HTMLImageElement>("render").src) ? "block" : "none";
  el<HTMLButtonElement>("reset").disabled = mode !== "3d" || !viewer;
}

function normalized(name: string) { return name.replace(/\s/g, "_").replace(/[\[\].:/]/g, ""); }
function applyLights(model: THREE.Group, profile: Profile, extent: number, center: THREE.Vector3) {
  RectAreaLightUniformsLib.init();
  const imported: THREE.Light[] = [];
  model.traverse((object) => { if (object instanceof THREE.Light) imported.push(object); });
  const shadowNames = new Set(profile.lights.filter((light) => light.useShadow)
    .sort((a, b) => b.webPower - a.webPower).slice(0, profile.lightMapping.maxShadowLights).map((light) => light.name));
  for (const definition of profile.lights) {
    const index = imported.findIndex((light) => normalized(light.name) === normalized(definition.name));
    const marker = imported.splice(index >= 0 ? index : 0, 1)[0];
    if (!marker?.parent) continue;
    const holder = new THREE.Group();
    holder.position.copy(marker.position); holder.quaternion.copy(marker.quaternion); holder.scale.copy(marker.scale);
    if (definition.worldMatrix?.length === 16) {
      marker.parent.matrixWorld.clone().invert().multiply(new THREE.Matrix4().fromArray(definition.worldMatrix))
        .decompose(holder.position, holder.quaternion, holder.scale);
    }
    marker.parent.add(holder); marker.parent.remove(marker);
    const color = new THREE.Color().setRGB(...definition.color.slice(0, 3) as [number, number, number], THREE.LinearSRGBColorSpace);
    const power = definition.webPower * profile.lightMapping.intensityScale;
    let light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight;
    if (definition.type === "SUN") light = new THREE.DirectionalLight(color, power);
    else if (definition.type === "SPOT") {
      light = new THREE.SpotLight(color, 1, 0, Math.max(0.01, Math.min(Math.PI / 2, definition.spotSize / 2)), definition.spotBlend);
      light.power = power;
    } else if (definition.type === "AREA") {
      light = new THREE.RectAreaLight(color, 1, Math.max(0.01, definition.size),
        ["RECTANGLE", "ELLIPSE"].includes(definition.shape) ? Math.max(0.01, definition.sizeY) : Math.max(0.01, definition.size));
      light.power = power;
    } else { light = new THREE.PointLight(color); light.power = power; }
    holder.add(light);
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      light.target.position.set(0, 0, -1); holder.add(light.target);
    }
    if (shadowNames.has(definition.name)) {
      let shadowLight: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;
      if (light instanceof THREE.RectAreaLight) {
        light.power = power * (1 - profile.lightMapping.shadowPowerRatio);
        const distance = holder.getWorldPosition(new THREE.Vector3()).distanceTo(center);
        const angle = THREE.MathUtils.clamp(Math.atan2(extent * 1.5, Math.max(distance, 0.01)), 0.15, 1.2);
        shadowLight = new THREE.SpotLight(color, 1, 0, angle, 0.4);
        shadowLight.power = power * profile.lightMapping.shadowPowerRatio;
        shadowLight.target.position.set(0, 0, -1); holder.add(shadowLight, shadowLight.target);
      } else shadowLight = light;
      shadowLight.castShadow = true;
      shadowLight.shadow.mapSize.set(1024, 1024);
      shadowLight.shadow.camera.near = Math.max(0.01, extent / 10000);
      shadowLight.shadow.camera.far = Math.max(20, extent * 10);
      shadowLight.shadow.normalBias = Math.max(0.0005, extent * 0.0005);
      shadowLight.shadow.bias = -0.0002;
      if (shadowLight instanceof THREE.DirectionalLight) {
        Object.assign(shadowLight.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent });
      }
    }
  }
}

async function loadModel(url: string) {
  loadingURL = url;
  try {
    const profileURL = await assetURL("render-profile.json", url);
    const profileResponse = await fetch(profileURL);
    if (!profileResponse.ok) throw new Error("Export profile could not be loaded.");
    const profile = await profileResponse.json() as Profile;
    const gltf = await new GLTFLoader().loadAsync(await assetURL("final.glb", url));
    if (artifact("final.glb") !== url) return;
    dispose();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = profile.colorManagement.viewTransform.toLowerCase().includes("agx") ? THREE.AgXToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = 2 ** profile.colorManagement.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene(); scene.add(gltf.scene);
    let bounds = new THREE.Box3().setFromObject(gltf.scene);
    const solidBounds = new THREE.Box3();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(object);
      // Ignore huge zero-thickness ground planes when sizing contact shadows.
      if (Math.min(...box.getSize(new THREE.Vector3()).toArray()) > 0.0001) solidBounds.union(box);
    });
    if (!solidBounds.isEmpty()) bounds = solidBounds;
    const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    const extent = bounds.isEmpty() ? 2 : Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 1);
    // A single 1024px shadow map across a wide landscape turns tiny grass and
    // flowers almost black. Use broad sky fill for these outdoor previews.
    const wideOutdoor = !profile.world.environmentUri && extent > 100 && profile.lights.some((light) => light.type === "SUN");
    if (wideOutdoor) {
      renderer.shadowMap.enabled = false;
      renderer.toneMapping = THREE.NoToneMapping;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x9aaa76, 1.2));
    }
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
    });
    applyLights(gltf.scene, profile, extent, center);
    const textures: THREE.Texture[] = [];
    const world = profile.world;
    let environment: THREE.Texture;
    if (world.environmentUri) {
      const environmentURL = await assetURL("environment.exr", url);
      environment = await new EXRLoader().loadAsync(environmentURL);
    } else {
      const [r = 0, g = 0, b = 0] = world.color;
      environment = new THREE.DataTexture(new Float32Array([r, g, b, 1, r, g, b, 1]), 2, 1, THREE.RGBAFormat, THREE.FloatType);
      environment.needsUpdate = true;
    }
    environment.colorSpace = THREE.LinearSRGBColorSpace;
    environment.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(environment).texture;
    textures.push(environment, scene.environment); pmrem.dispose();
    scene.environmentIntensity = world.strength;
    scene.environmentRotation.y = world.environmentRotationY;
    if (!profile.render.filmTransparent) {
      scene.background = environment; scene.backgroundIntensity = world.strength;
      scene.backgroundRotation.y = world.environmentRotationY;
    }
    const exportedCamera = gltf.cameras.find((camera) => camera.name === normalized(profile.camera?.name ?? "")) ?? gltf.cameras[0];
    const camera = exportedCamera instanceof THREE.PerspectiveCamera || exportedCamera instanceof THREE.OrthographicCamera ?
      exportedCamera : new THREE.PerspectiveCamera(45, 1, 0.01, extent * 100);
    if (!exportedCamera) { camera.position.copy(center).add(new THREE.Vector3(extent * 1.5, extent, extent * 1.5)); camera.lookAt(center); }
    scene.updateMatrixWorld(true);
    if (exportedCamera) {
      const position = camera.getWorldPosition(new THREE.Vector3()), rotation = camera.getWorldQuaternion(new THREE.Quaternion());
      camera.removeFromParent(); scene.add(camera); camera.position.copy(position); camera.quaternion.copy(rotation);
    }
    const controls = new OrbitControls(camera, renderer.domElement);
    const focusDistance = wideOutdoor ? Math.min(camera.position.distanceTo(center), extent * 0.02) : camera.position.distanceTo(center) || extent;
    controls.target.copy(exportedCamera ? camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(focusDistance)) : center);
    controls.enableDamping = true; controls.update();
    const aspect = profile.render.resolutionX / profile.render.resolutionY;
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, 512, 512);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.updateGtaoMaterial({ radius: Math.min(0.08, extent * 0.005), distanceExponent: 1.5, thickness: 1, scale: 1, samples: 12 });
    ao.blendIntensity = 0.3;
    composer.addPass(ao); composer.addPass(new OutputPass());
    const resize = new ResizeObserver(() => {
      const width = el("stage").clientWidth, height = el("stage").clientHeight;
      const w = Math.min(width, height * aspect), h = w / aspect;
      renderer.setSize(w, h); composer.setSize(w, h);
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
      camera.updateProjectionMatrix();
    });
    el("canvas").appendChild(renderer.domElement);
    viewer = { renderer, scene, camera, controls, composer, ao, position: camera.position.clone(), target: controls.target.clone(), textures, resize, aspect };
    resize.observe(el("stage"));
    renderer.setAnimationLoop(() => { if (mode === "3d") { controls.update(); composer.render(); } });
    loadedURL = url;
    el<HTMLButtonElement>("mode-3d").disabled = false;
    el("empty").style.display = "none";
    setMode("3d");
    const currentViewer = viewer;
    void el<HTMLImageElement>("render").decode().then(() => {
      requestAnimationFrame(() => {
        if (viewer !== currentViewer) return;
        composer.render();
        try { currentViewer.calibration = calibrate(renderer.domElement, el<HTMLImageElement>("render")); } catch { /* Preview remains usable without calibration. */ }
      });
    }).catch(() => {});
  } catch (error) {
    console.error("Scene preview failed:", error);
    message("3D preview could not be loaded. Use the render or download the Blender file.");
  } finally { loadingURL = ""; }
}

function receive(data: unknown) {
  if (!data || typeof data !== "object" || !("id" in data)) return;
  const next = data as Snapshot;
  if (snapshot && snapshot.id !== next.id) {
    dispose(); loadedURL = ""; mode = "render";
    el("render").removeAttribute("src"); el("render").style.display = "none";
    el("reference").style.display = "none";
    el("empty").style.display = "grid";
    el<HTMLButtonElement>("mode-3d").disabled = true;
  }
  snapshot = next;
  const busy = next.job && ["queued", "running"].includes(next.job.status);
  el("status").textContent = busy ? `${next.job!.kind === "export" ? "Exporting" : "Rendering"} scene` :
    next.error ? "Scene needs attention" : next.stage === "completed" ? "Ready" :
    next.stage === "best_effort" ? "Best version" : next.stage === "review" ? "Awaiting review" : "Building scene";
  el<HTMLButtonElement>("send").disabled = busy || !["completed", "best_effort"].includes(next.stage);
  const render = ["completed", "best_effort"].includes(next.stage) ? next.bestRenderUrl : next.renderUrl;
  if (render) {
    const name = ["completed", "best_effort"].includes(next.stage) ? "best.png" : "render";
    el("empty").textContent = "Loading scene render";
    void assetURL(name, `${next.iteration}:${next.best?.iteration ?? 0}`).then((url) => {
      if (snapshot?.id !== next.id) return;
      el<HTMLImageElement>("render").src = url;
      el("empty").style.display = "none";
      setMode(mode);
    }).catch((error) => { console.error("Scene render failed:", error); message("Scene render could not be loaded."); });
  }
  if (next.reference) void assetURL("reference", next.reference.url).then((url) => {
    if (snapshot?.id === next.id) { el<HTMLImageElement>("reference").src = url; el("reference").style.display = "block"; }
  }).catch((error) => console.error("Reference image failed:", error));
  for (const [element, name] of [["download-glb", "final.glb"], ["download-blend", "best.blend"]]) {
    const link = el<HTMLAnchorElement>(element!), url = artifact(name!);
    link.hidden = !url;
    if (url) {
      link.href = url; link.download = name!;
      link.onclick = (event) => {
        event.preventDefault();
        void assetURL(name!, url).then((blobURL) => {
          const download = document.createElement("a");
          download.href = blobURL; download.download = name!; download.click();
        }).catch((error) => { console.error("Scene download failed:", error); message(`${name} could not be downloaded.`); });
      };
    }
  }
  if (next.error) message("The scene operation failed. Ask in the conversation to inspect it and retry.");
  const glb = artifact("final.glb");
  if (glb && glb !== loadedURL && glb !== loadingURL) void loadModel(glb);
  setMode(mode);
  clearTimeout(timer);
  if (busy) timer = setTimeout(async () => {
    try {
      const output = await app.callServerTool({ name: "scene_view", arguments: { sceneId: next.id } });
      receive(output.structuredContent);
    } catch { message("Scene progress could not be refreshed. Check the conversation."); }
  }, 2000);
}

app.ontoolresult = (output) => receive(output.structuredContent);
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  if (context.displayMode) document.documentElement.dataset.display = context.displayMode;
};
el("mode-render").onclick = () => setMode("render");
el("mode-3d").onclick = () => setMode("3d");
el("reset").onclick = () => {
  if (viewer) {
    viewer.controls.enableDamping = false; viewer.controls.update();
    viewer.camera.position.copy(viewer.position); viewer.controls.target.copy(viewer.target); viewer.controls.update();
    viewer.controls.enableDamping = true;
  }
};
el("fullscreen").onclick = async () => {
  try {
    const result = await app.requestDisplayMode({ mode: "fullscreen" });
    document.documentElement.dataset.display = result.mode;
    if (result.mode === "fullscreen") el("stage").style.height = "calc(100vh - 180px)";
  } catch { message("Expanded view is unavailable in this client."); }
};
async function sendRefinement() {
  const input = el<HTMLInputElement>("prompt");
  if (!snapshot || !input.value.trim()) return;
  try {
    const output = await app.sendMessage({
      role: "user", content: [{ type: "text", text: `Refine Blender scene ${snapshot.id}: ${input.value.trim()}` }],
    });
    if (output.isError) throw new Error("Message rejected.");
    input.value = ""; message("Refinement sent to the conversation");
  } catch { message("Refinement could not be sent. Enter it in the conversation."); }
}
el("send").onclick = () => { void sendRefinement(); };
el<HTMLInputElement>("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !el<HTMLButtonElement>("send").disabled) void sendRefinement();
};

type OpenAIHost = {
  uploadFile(file: File): Promise<{ fileId: string }>;
  getFileDownloadUrl(input: { fileId: string }): Promise<{ downloadUrl: string }>;
};
const host = (window as unknown as { openai?: OpenAIHost }).openai;
if (host?.uploadFile && host.getFileDownloadUrl) {
  el("upload").style.display = "inline-block";
  el("upload").onclick = () => el<HTMLInputElement>("file").click();
  el<HTMLInputElement>("file").onchange = async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { message("Use an image smaller than 20 MB."); return; }
    try {
      message("Uploading reference image");
      const { fileId } = await host.uploadFile(file);
      const { downloadUrl } = await host.getFileDownloadUrl({ fileId });
      const output = await app.callServerTool({
        name: "scene_create", arguments: {
          prompt: el<HTMLInputElement>("prompt").value.trim() || "Create a Blender scene matching the uploaded image.",
          reference: { download_url: downloadUrl, file_id: fileId, mime_type: file.type, file_name: file.name },
        },
      });
      if (output.isError) throw new Error("Scene creation failed.");
      receive(output.structuredContent);
      await app.sendMessage({ role: "user", content: [{ type: "text", text: `Plan, build and review Blender scene ${(output.structuredContent as unknown as Snapshot).id} from its uploaded reference; export and show the result.` }] });
      message("Reference ready in the conversation");
    } catch { message("Image upload failed. Attach the image in the conversation and try again."); }
  };
}
window.addEventListener("pagehide", () => { clearTimeout(timer); dispose(); });
void app.connect().then(() => {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.style.colorScheme = theme;
}).catch(() => {
  el("status").textContent = "Open in a supported chat client";
  message("This viewer connects through the installed Blender plugin.");
});

import type { VfxProfile } from "../shared/vfx.js";
import { createWeather } from "./weather.js";
import { volumeUniforms, volumeShader } from "./volumes.js";
import { version } from "../../package.json";
import { App } from "@modelcontextprotocol/ext-apps";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { TexturePass } from "three/addons/postprocessing/TexturePass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { DenoiseMaterial, PhysicalCamera, WebGLPathTracer } from "three-gpu-pathtracer";
import { connectThreeRT } from "./threert-live.js";
import { keyboardNavigation } from "./navigation.js";
import { addPlanarReflection, applyLightmaps, captureEnvironment, limitPreviewShadows, limitRasterLights, setPreviewLightEnergy, sharpenThinGlass, type Lightmap } from "./lighting.js";
import { solarVolumeShader, fogUniforms, shaftUniforms } from "./solar-volumes.js";
import { maxViewerAssetBytes, type ExportEffects } from "../render-effects.js";

type ReferenceView = { assetName: string; name?: string; label?: string; role?: string; url: string };
type GraphNode = { id: string; label: string; kind: string; parentId: string | null; description: string;
  status?: string; gltfNodeIndices?: number[] };
type GraphFile = { iteration: number; nodes: GraphNode[] };
type Snapshot = {
  id: string; prompt: string; stage: string; iteration: number; renderUrl: string | null; bestRenderUrl: string | null;
  reference: { url: string; name?: string; label?: string } | null; references?: ReferenceView[]; best?: { iteration: number };
  referenceCameras?: { reference: string; cameraName: string; default: boolean; renderUrl: string | null }[];
  job?: { id: string; status: string; kind: string }; exportedIteration?: number; previewedIteration?: number; error?: string;
  exportVersion?: string;
  exportAlignment?: { status: "supported" | "approximate" | "degraded"; issues: ExportEffects["issues"] };
  realtimeUrl?: string | null;
  threeRT?: { available: boolean; reason?: string; liveAvailable?: boolean; liveReason?: string };
  threeRTRender?: { status: string; iteration: number; exportVersion: string; error?: string; warnings?: string[] };
  artifacts: { name: string; url: string }[];
  plan?: { graph?: GraphNode[]; workflow?: { stages: { name: string }[] } }; workflowIndex?: number;
  reviewViews?: string[]; remainingGaps?: string[];
  workflowState?: { phase: string | null; status: string; compositionApproved: boolean; presentation: {
    mode: "structural" | "appearance"; purpose: "work" | "confirmation" | "delivery"; source: string; iteration: number;
  } };
};
type Profile = {
  vfx?: VfxProfile;
  warnings?: string[];
  version: number; previewMode?: string; source?: { kind: string; purpose: string; phase: string | null; iteration: number }; colorManagement: { viewTransform: string; exposure: number; displayLut?: { uri: string; size: number; maxLinear: number } };
  render: { resolutionX: number; resolutionY: number; filmTransparent: boolean };
  world: { color: number[]; strength: number; environmentUri: string | null; environmentRotationY: number; backgroundEnvironmentUri?: string | null };
  camera: { name: string; projectionMatrix?: number[]; lens?: number; dof?: { enabled: boolean; focusDistance: number; fStop: number; blades: number; rotation: number; ratio: number } } | null;
  bakedObjects?: string[];
  bakedTints?: Record<string, number[]>;
  lightmaps?: Lightmap[];
  effects?: ExportEffects;
  previewAppearance?: { renderMode?: "pathtracing" | "raster"; planarReflection?: string; reflectionProbe?: number[]; exposureEV?: number; saturation?: number; whiteBalance?: number[]; contrast?: number; hazeScale?: number;
    dust?: { color: number[]; wind: number[]; volumes: { center: number[]; radius: number[]; density: number }[] } };
  postprocessing?: {
    bloom?: { strength?: number; threshold?: number; radius?: number };
    haze?: { start: number; depth: number; falloff: string; strength: number; color: number[] };
  };
  lights: { name: string; type: string; color: number[]; energy: number; webPower: number; useShadow: boolean; size: number; sizeY: number; shape: string; spotSize: number; spotBlend: number; worldMatrix: number[] }[];
};
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = new App({ name: "UniBlenderScene viewer", version }, {});
let snapshot: Snapshot | undefined, loadedURL = "", loadingURL = "", mode = "render";
let preferredBackend: "web" | "threert" | undefined;
let threeRTImageKey = "", threeRTRequestPending = false;
let liveViewer: Awaited<ReturnType<typeof connectThreeRT>> | undefined;
let liveConnecting = false, liveWanted = false, liveStatus = "";
let referenceListKey = "", reviewImagesKey = "", referenceRequest = 0;
let graphNodes: GraphNode[] = [], selectedNodeId = "";
const expanded = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let viewer: {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls; tracer?: WebGLPathTracer; denoise: FullScreenQuad; denoiseTarget?: THREE.WebGLRenderTarget;
  navigation: ReturnType<typeof keyboardNavigation>;
  reflection?: ReturnType<typeof addPlanarReflection>;
  probe?: THREE.WebGLRenderTarget;
  display?: FullScreenQuad; frameTimer: ReturnType<typeof setInterval>; gpuFence?: WebGLSync;
  effects?: ReturnType<typeof previewEffects>;
  weather?: ReturnType<typeof createWeather>;
  position: THREE.Vector3; target: THREE.Vector3; zoom: number; textures: THREE.Texture[]; resize: ResizeObserver; aspect: number;
  meshesById: Map<string, THREE.Mesh[]>;
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
      if (!chunk || chunk.name !== name || chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size > maxViewerAssetBytes) {
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

function nodeMeshes(id: string): THREE.Mesh[] {
  if (!viewer) return [];
  const included = nodeDescendants(id);
  return [...new Set([...included].flatMap((nodeId) => viewer!.meshesById.get(nodeId) ?? []))];
}

function nodeDescendants(id: string): Set<string> {
  const included = new Set<string>();
  const visit = (nodeId: string) => {
    if (included.has(nodeId)) return;
    included.add(nodeId);
    for (const child of graphNodes.filter((node) => node.parentId === nodeId)) visit(child.id);
  };
  visit(id);
  return included;
}

function selectedBounds(): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (const mesh of nodeMeshes(selectedNodeId)) bounds.union(new THREE.Box3().setFromObject(mesh));
  return bounds;
}

function updateSelectionBox() {
  const overlay = el("selection-box");
  if (mode !== "3d" || !viewer || !selectedNodeId) { overlay.style.display = "none"; return; }
  const bounds = selectedBounds();
  if (bounds.isEmpty()) { overlay.style.display = "none"; return; }
  viewer.camera.updateMatrixWorld();
  const canvas = viewer.renderer.domElement.getBoundingClientRect(), stage = el("stage").getBoundingClientRect();
  const svg = document.getElementById("selection-gizmo")!;
  svg.setAttribute("viewBox", `0 0 ${stage.width} ${stage.height}`);
  const project = (world: THREE.Vector3) => {
    const p = world.clone().project(viewer!.camera);
    return { x: canvas.left - stage.left + (p.x + 1) * canvas.width / 2,
      y: canvas.top - stage.top + (1 - p.y) * canvas.height / 2, z: p.z };
  };
  const corners: ReturnType<typeof project>[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const point = project(new THREE.Vector3(x, y, z));
    if (point.z < -1 || point.z > 1) { overlay.style.display = "none"; return; }
    corners.push(point);
  }
  // Project all 12 world-space box edges; helpers never enter the traced scene.
  const edges: string[] = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) {
    const a = corners[i]!, b = corners[i | bit]!;
    edges.push(`M${a.x},${a.y}L${b.x},${b.y}`);
  }
  el("selection-outline").setAttribute("d", edges.join(" "));
  const center = bounds.getCenter(new THREE.Vector3()), origin = project(center);
  const camera = viewer.camera;
  const worldPerPixel = camera instanceof THREE.PerspectiveCamera ?
    2 * camera.position.distanceTo(center) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (canvas.height * camera.zoom) :
    (camera.top - camera.bottom) / (canvas.height * camera.zoom);
  const length = Math.max(worldPerPixel * 54, 0.0001);
  for (const [axis, direction] of [["x", new THREE.Vector3(1, 0, 0)], ["y", new THREE.Vector3(0, 1, 0)], ["z", new THREE.Vector3(0, 0, 1)]] as const) {
    const end = project(center.clone().addScaledVector(direction, length));
    el(`selection-axis-${axis}`).setAttribute("d", `M${origin.x},${origin.y}L${end.x},${end.y}`);
    const label = el(`selection-axis-label-${axis}`);
    label.setAttribute("x", String(end.x + 7)); label.setAttribute("y", String(end.y - 5));
  }
  el("selection-origin").setAttribute("cx", String(origin.x));
  el("selection-origin").setAttribute("cy", String(origin.y));
  const label = el("selection-label");
  label.style.left = `${Math.max(2, Math.min(stage.width - label.offsetWidth - 2, Math.min(...corners.map((p) => p.x))))}px`;
  label.style.top = `${Math.max(2, Math.min(...corners.map((p) => p.y)) - 26)}px`;
  overlay.dataset.nodeId = selectedNodeId;
  overlay.style.display = "block";
}

function selectNode(id: string, focus = true) {
  const node = graphNodes.find((n) => n.id === id);
  selectedNodeId = node?.id ?? "";
  const visited = new Set<string>();
  let reveal = false;
  let parent = node?.parentId;
  while (parent && !visited.has(parent)) {
    if (!expanded.has(parent)) reveal = true;
    visited.add(parent); expanded.add(parent);
    parent = graphNodes.find((n) => n.id === parent)?.parentId;
  }
  if (reveal) renderGraph();
  else {
    el("graph-list").querySelectorAll<HTMLButtonElement>('[role="treeitem"]').forEach((row) => row.setAttribute("aria-selected", String(row.dataset.nodeId === selectedNodeId)));
    el<HTMLButtonElement>("selection-clear").disabled = !selectedNodeId;
  }
  el("selection-label").textContent = node?.label ?? "";
  if (!node) { el("graph-detail").textContent = ""; updateSelectionBox(); return; }
  const missing = [...nodeDescendants(node.id)].filter((childId) =>
    graphNodes.some((item) => item.id === childId && item.kind !== "group" && item.status !== "renderable"));
  el("graph-detail").textContent = `${node.description}${missing.length ? ` · ${missing.length} node(s) unavailable in preview` : ""}`;
  if (viewer) { preferredBackend = "web"; setMode("3d"); if (focus) focusNode(id); else updateSelectionBox(); }
  else message("Preview is not ready; the Scene Graph remains available.");
}

function focusNode(id: string) {
  if (!viewer) return;
  const bounds = selectedBounds();
  if (bounds.isEmpty()) { message("This node has no previewable object yet."); return; }
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.05);
  const direction = viewer.camera.position.clone().sub(viewer.controls.target).normalize();
  if (direction.lengthSq() < 0.5) direction.set(1, 1, 1).normalize();
  if (viewer.camera instanceof THREE.PerspectiveCamera) {
    const vertical = THREE.MathUtils.degToRad(viewer.camera.fov) / viewer.camera.zoom;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * viewer.camera.aspect);
    const distance = radius * 1.25 / Math.sin(Math.min(vertical, horizontal) / 2);
    viewer.camera.position.copy(center).addScaledVector(direction, distance);
  } else {
    const camera = viewer.camera;
    const span = Math.min(camera.right - camera.left, camera.top - camera.bottom);
    camera.zoom = Math.max(0.01, span / (radius * 2.6));
    camera.updateProjectionMatrix();
    viewer.camera.position.copy(center).addScaledVector(direction, Math.max(radius * 3, 1));
  }
  viewer.controls.target.copy(center); viewer.controls.update();
  updateSelectionBox();
}

function renderGraph() {
  const panel = el("graph-panel");
  el<HTMLButtonElement>("selection-clear").disabled = !selectedNodeId;
  panel.hidden = !graphNodes.length;
  const list = el("graph-list"); list.replaceChildren();
  const children = new Map<string | null, GraphNode[]>();
  for (const node of graphNodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const append = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      const row = document.createElement("div"); row.className = "graph-row"; row.style.paddingLeft = `${depth * 16}px`;
      const descendants = children.get(node.id)?.length ?? 0;
      const toggle = document.createElement("button"); toggle.className = "graph-toggle";
      toggle.textContent = descendants ? expanded.has(node.id) ? "▾" : "▸" : "";
      toggle.setAttribute("aria-label", `${expanded.has(node.id) ? "Collapse" : "Expand"} ${node.label}`);
      toggle.disabled = !descendants;
      toggle.onclick = () => { expanded.has(node.id) ? expanded.delete(node.id) : expanded.add(node.id); renderGraph(); };
      const button = document.createElement("button");
      button.dataset.nodeId = node.id;
      button.textContent = `${node.label} · ${node.kind}${node.status && node.status !== "renderable" ? ` · ${node.status}` : ""}`;
      button.setAttribute("role", "treeitem"); button.setAttribute("aria-level", String(depth + 1));
      button.setAttribute("aria-selected", String(selectedNodeId === node.id));
      if (descendants) button.setAttribute("aria-expanded", String(expanded.has(node.id)));
      button.onclick = () => selectNode(node.id);
      row.append(toggle, button); list.appendChild(row);
      if (expanded.has(node.id)) append(node.id, depth + 1);
    }
  };
  append(null, 0);
}

function updateSceneStats(root?: THREE.Object3D) {
  const stats = el("scene-stats");
  stats.hidden = !root;
  stats.textContent = "";
  if (!root) return;
  let meshes = 0, vertices = 0, triangles = 0;
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
    const positions = object.geometry.getAttribute("position")?.count ?? 0;
    meshes += instances;
    vertices += positions * instances;
    triangles += (object.geometry.index?.count ?? positions) / 3 * instances;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  stats.textContent = `GLB preview: ${meshes.toLocaleString("en-US")} meshes · ${vertices.toLocaleString("en-US")} vertices · ${triangles.toLocaleString("en-US")} triangles · ${materials.size.toLocaleString("en-US")} materials`;
}

function dispose() {
  updateSceneStats();
  el("selection-box").style.display = "none";
  if (!viewer) return;
  viewer.weather?.dispose();
  clearInterval(viewer.frameTimer);
  viewer.navigation.dispose();
  viewer.resize.disconnect();
  viewer.controls.dispose();
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
  viewer.tracer?.dispose();
  viewer.reflection?.dispose();
  viewer.probe?.dispose();
  viewer.denoise.material.dispose(); viewer.denoise.dispose();
  viewer.denoiseTarget?.dispose();
  viewer.display?.material.dispose(); viewer.display?.dispose();
  viewer.effects?.dispose();
  if (viewer.gpuFence) (viewer.renderer.getContext() as WebGL2RenderingContext).deleteSync(viewer.gpuFence);
  viewer.renderer.dispose();
  viewer.renderer.forceContextLoss();
  el("canvas").replaceChildren();
  viewer = undefined;
}

function threeRTLiveUnavailableReason() {
  const capability = snapshot?.threeRT;
  if (!capability?.available) return capability?.reason ?? "当前服务未配置 ThreeRT 原生客户端";
  if (!snapshot?.exportVersion || !["completed", "best_effort"].includes(snapshot.stage)) return "完成场景审核与导出后可用";
  return capability.liveAvailable === false ? capability.liveReason ?? "ThreeRT 实时交互需要原生客户端" : "";
}

function showPreview() {
  setMode(preferredBackend === "threert" ? "threert" : viewer ? "3d" : "render");
  updateThreeRT();
  if (mode === "threert" && !liveViewer && !liveConnecting) void startThreeRT();
}

function setMode(value: string) {
  const previousMode = mode;
  const unavailable = value === "threert" && threeRTLiveUnavailableReason();
  mode = unavailable ? viewer ? "3d" : "render" : value;
  if (mode !== previousMode) viewer?.navigation?.clear();
  if (unavailable) { preferredBackend = "web"; message(`ThreeRT 实时交互不可用，已保留网页预览。${unavailable}`); }
  el("mode-render").setAttribute("aria-pressed", String(mode === "render"));
  el("mode-3d").setAttribute("aria-pressed", String(mode === "3d" || mode === "threert"));
  el<HTMLButtonElement>("mode-3d").disabled = !viewer && !(preferredBackend === "threert" && !threeRTLiveUnavailableReason());
  el("canvas").style.display = mode === "3d" ? "flex" : "none";
  el("render").style.display = mode === "render" && Boolean(el<HTMLImageElement>("render").src) ? "block" : "none";
  el<HTMLSelectElement>("render-backend").value = mode === "threert" ? "threert" : mode === "3d" ? "web" : preferredBackend ?? "web";
  el("threert-panel").hidden = mode !== "threert";
  el("threert-live").style.display = mode === "threert" ? "flex" : "none";
  liveViewer?.setActive(mode === "threert");
  if (mode === "threert") el("empty").style.display = "none";
  el("note").textContent = mode === "threert" ? "点击画面后 WASD 移动 · Shift 加速 · 拖动绕转 · 滚轮缩放 · 右键平移" : "Click view, then WASD to move · Shift to speed up · Drag to orbit · Scroll to zoom · Right-drag to pan";
  el<HTMLButtonElement>("reset").disabled = mode === "threert" ? !liveViewer : mode !== "3d" || !viewer;
  updateSelectionBox();
}

function updateThreeRT() {
  const scene = snapshot;
  if (!scene) return;
  const unavailable = threeRTLiveUnavailableReason();
  const option = el<HTMLSelectElement>("render-backend").querySelector<HTMLOptionElement>('option[value="threert"]')!;
  option.disabled = Boolean(unavailable);
  option.textContent = unavailable ? "ThreeRT · 实时交互（不可用）" : "ThreeRT · 实时交互";
  option.title = unavailable;
  if (mode === "threert" && unavailable) setMode(mode);
  const busy = Boolean(threeRTRequestPending || liveConnecting || scene.job && ["queued", "running"].includes(scene.job.status));
  const eligible = ["completed", "best_effort"].includes(scene.stage) && Boolean(scene.exportVersion);
  const state = scene.threeRTRender;
  const current = state?.exportVersion === scene.exportVersion && state?.iteration === scene.workflowState?.presentation.iteration;
  el<HTMLButtonElement>("render-threert").disabled = busy || !eligible || Boolean(unavailable);
  el("render-threert").textContent = busy ? "正在连接……" : liveViewer ? "重新连接" : "连接实时渲染";
  el("threert-status").textContent = !eligible ? "完成场景审核与导出后可用。" :
    unavailable ? unavailable :
    current && state?.status === "failed" ? state.error ?? "ThreeRT 渲染失败，可重试或切回网页交互。" :
    threeRTRequestPending || scene.job?.kind === "threert" && ["queued", "running"].includes(scene.job.status) ? "正在准备材质与本机渲染场景，完成后连接实时视图。" :
    (liveStatus || "连接后可在网页拖动、缩放和平移；画面帧率取决于本机渲染与传输速度。") + (current ? ` ${state?.warnings?.join(" ") ?? ""}` : "");
  const url = current && state?.status === "done" ? artifact("threert.png") : undefined;
  const download = el<HTMLAnchorElement>("download-threert");
  download.hidden = !url;
  if (!url) {
    threeRTImageKey = "";
  } else if (threeRTImageKey !== url) {
    threeRTImageKey = url;
    void assetURL("threert.png", `${url}:${scene.job?.id ?? ""}`).then(image => {
      if (snapshot?.id !== scene.id || threeRTImageKey !== url) return;
      download.href = image; download.download = "threert.png";
      setMode(mode);
    }).catch(() => {
      if (snapshot?.id !== scene.id || threeRTImageKey !== url) return;
      threeRTImageKey = "";
      el("threert-status").textContent = "ThreeRT 图片加载失败，请重新渲染。";
    });
  }
  if (liveWanted && mode === "threert" && current && state?.status === "done" && !liveViewer && !liveConnecting) void openRealtime();
}

async function openRealtime() {
  if (!snapshot?.realtimeUrl || liveConnecting) return;
  const scene = snapshot;
  liveConnecting = true; liveStatus = "正在连接本机 ThreeRT 实时视图……";
  updateThreeRT();
  try {
    const connection = await connectThreeRT(el<HTMLCanvasElement>("threert-render"), scene.realtimeUrl!, text => {
      if (snapshot?.id === scene.id && snapshot.exportVersion === scene.exportVersion) {
        liveStatus = text; el("threert-status").textContent = text + ` ${scene.threeRTRender?.warnings?.join(" ") ?? ""}`;
      }
    });
    if (snapshot?.id !== scene.id || snapshot.exportVersion !== scene.exportVersion) { connection.dispose(); return; }
    liveViewer = connection; liveViewer.setActive(mode === "threert");
    setMode(mode);
  } catch (error) {
    liveWanted = false; liveStatus = error instanceof Error ? error.message : "实时连接失败，请重试。";
    if (snapshot?.id === scene.id && snapshot.exportVersion === scene.exportVersion) {
      preferredBackend = "web"; setMode(viewer ? "3d" : "render"); message(liveStatus);
    }
  } finally { liveConnecting = false; updateThreeRT(); }
}

async function startThreeRT() {
  if (!snapshot || threeRTRequestPending) return;
  if (threeRTLiveUnavailableReason()) { setMode("threert"); return; }
  const id = snapshot.id;
  liveViewer?.dispose(); liveViewer = undefined; liveWanted = true; liveStatus = "";
  message("");
  if (snapshot.threeRTRender?.status === "done" && snapshot.threeRTRender.exportVersion === snapshot.exportVersion) {
    await openRealtime(); return;
  }
  threeRTRequestPending = true; updateThreeRT();
  try {
    const output = await app.callServerTool({ name: "scene_render_high_quality", arguments: { sceneId: id } });
    if (snapshot?.id !== id) return;
    if (output.isError) throw new Error(output.content?.filter(item => item.type === "text").map(item => item.text).join(" ") || "ThreeRT 渲染请求失败。");
    receive(output.structuredContent);
  } catch (error) {
    if (snapshot?.id === id) {
      liveWanted = false; preferredBackend = "web"; setMode(viewer ? "3d" : "render");
      message(error instanceof Error ? error.message : "ThreeRT 渲染请求失败。");
    }
  } finally { threeRTRequestPending = false; updateThreeRT(); }
}

function referenceViews(scene: Snapshot): ReferenceView[] {
  return scene.references ?? (scene.reference ? [{ ...scene.reference, assetName: "reference", role: "primary" }] : []);
}

async function showReference() {
  if (!snapshot) return;
  const request = ++referenceRequest;
  const matchImage = el<HTMLImageElement>("reference-match");
  matchImage.hidden = true;
  const selected = el<HTMLSelectElement>("reference-select").value;
  const view = referenceViews(snapshot).find((image) => image.assetName === selected);
  if (!view) return;
  try {
    const url = await assetURL(view.assetName, view.url);
    if (request !== referenceRequest) return;
    const caption = `${view.role === "primary" ? "Primary" : "Auxiliary"}: ${view.label ?? view.name ?? view.assetName}`;
    for (const id of ["reference", "reference-full"]) {
      const image = el<HTMLImageElement>(id); image.src = url; image.alt = caption;
    }
    el("reference").style.display = "block";
    el("reference-caption").textContent = caption;
    const match = snapshot?.referenceCameras?.find(camera => camera.reference === selected);
    if (!match?.renderUrl || !el<HTMLDialogElement>("reference-dialog").open) return;
    const name = match.default ? "render" : new URL(match.renderUrl).pathname.split("/").at(-1)!;
    const rendered = await assetURL(name, match.renderUrl);
    if (request !== referenceRequest) return;
    matchImage.src = rendered;
    matchImage.hidden = false;
  } catch (error) { console.error("Reference image failed:", error); message("Reference view could not be loaded."); }
}

el<HTMLSelectElement>("reference-select").onchange = () => { void showReference(); };
el("graph-collapse").onclick = () => {
  const panel = el("graph-panel"), collapsed = panel.classList.toggle("collapsed");
  el("graph-collapse").textContent = collapsed ? "Expand" : "Collapse";
  el("graph-collapse").setAttribute("aria-expanded", String(!collapsed));
};
el("reference-open").onclick = () => {
  el<HTMLDialogElement>("reference-dialog").showModal();
  void showReference();
};
el("reference-close").onclick = () => el<HTMLDialogElement>("reference-dialog").close();

function normalized(name: string) { return name.replace(/\s/g, "_").replace(/[\[\].:/]/g, ""); }
function applyLights(model: THREE.Group, profile: Profile) {
  RectAreaLightUniformsLib.init();
  const imported: THREE.Light[] = [];
  model.traverse((object) => { if (object instanceof THREE.Light) imported.push(object); });
  for (const definition of profile.lights) {
    const index = imported.findIndex((light) => normalized(light.name) === normalized(definition.name));
    const marker = imported.splice(index >= 0 ? index : 0, 1)[0];
    if (!marker?.parent) continue;
    const holder = new THREE.Group();
    holder.userData.sourceLight = definition.name;
    holder.position.copy(marker.position); holder.quaternion.copy(marker.quaternion); holder.scale.copy(marker.scale);
    if (definition.worldMatrix?.length === 16) {
      marker.parent.matrixWorld.clone().invert().multiply(new THREE.Matrix4().fromArray(definition.worldMatrix))
        .decompose(holder.position, holder.quaternion, holder.scale);
    }
    marker.parent.add(holder); marker.parent.remove(marker);
    const color = new THREE.Color().setRGB(...definition.color.slice(0, 3) as [number, number, number], THREE.LinearSRGBColorSpace);
    const power = Math.max(0, definition.energy ?? definition.webPower / (683 * 0.012));
    let light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight;
    if (definition.type === "SUN") light = new THREE.DirectionalLight(color);
    else if (definition.type === "SPOT") {
      light = new THREE.SpotLight(color, 1, 0, Math.max(0.01, Math.min(Math.PI / 2, definition.spotSize / 2)), definition.spotBlend);
    } else if (definition.type === "AREA") {
      light = new THREE.RectAreaLight(color, 1, Math.max(0.01, definition.size),
        ["RECTANGLE", "ELLIPSE"].includes(definition.shape) ? Math.max(0.01, definition.sizeY) : Math.max(0.01, definition.size));
      (light as THREE.RectAreaLight & { isCircular?: boolean }).isCircular = ["DISK", "ELLIPSE"].includes(definition.shape);
    } else light = new THREE.PointLight(color);
    setPreviewLightEnergy(light, power);
    // The holder carries Blender's transform; Three's sun/spot defaults offset the light.
    light.name = definition.name;
    light.position.set(0, 0, 0);
    holder.add(light);
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      light.target.position.set(0, 0, -1); holder.add(light.target);
    }
    if (definition.useShadow && "shadow" in light) light.castShadow = true;
  }
}

async function displayTransform(profile: Profile, textures: THREE.Texture[]): Promise<FullScreenQuad | undefined> {
  const definition = profile.colorManagement.displayLut;
  if (!definition) return;
  const lut = await new THREE.TextureLoader().loadAsync(definition.uri);
  lut.colorSpace = THREE.NoColorSpace;
  lut.minFilter = lut.magFilter = THREE.LinearFilter;
  lut.generateMipmaps = false;
  textures.push(lut);
  const material = new THREE.ShaderMaterial({
    toneMapped: false, depthTest: false, depthWrite: false,
    uniforms: {
      source: { value: null }, displayLut: { value: lut },
      lutSize: { value: definition.size }, maxLinear: { value: definition.maxLinear },
    },
    vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}",
    fragmentShader: `
      uniform sampler2D source,displayLut;
      uniform float lutSize,maxLinear;
      varying vec2 vUv;
      void main(){
        vec4 color=texture2D(source,vUv);
        vec3 p=pow(clamp(color.rgb/maxLinear,0.0,1.0),vec3(1.0/3.0))*(lutSize-1.0);
        float b=floor(p.b);
        vec2 a=vec2((p.r+b*lutSize+0.5)/(lutSize*lutSize),(p.g+0.5)/lutSize);
        vec2 c=vec2((p.r+min(b+1.0,lutSize-1.0)*lutSize+0.5)/(lutSize*lutSize),a.y);
        gl_FragColor=vec4(mix(texture2D(displayLut,a).rgb,texture2D(displayLut,c).rgb,fract(p.b)),color.a);
      }`,
  });
  return new FullScreenQuad(material);
}

function previewEffects(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, profile: Profile) {
  const settings = profile.postprocessing;
  const appearance = profile.previewAppearance, dust = appearance?.dust;
  const volumes = profile.vfx?.volumes ?? [];
  const shafts = profile.effects?.shafts ?? [];
  const fog = (profile.effects?.fog ?? []).filter(fog => !volumes.some(volume => volume.name === fog.name));
  const solar = profile.effects?.sun;
  const drawSun = Boolean(solar && !solar.inBackground && !profile.render.filmTransparent);
  const hasVolumes = volumes.length > 0 || shafts.length > 0 || fog.length > 0;
  if (!settings?.bloom && !settings?.haze && !dust && !hasVolumes && !drawSun && !appearance?.exposureEV && appearance?.saturation === undefined && !appearance?.whiteBalance && appearance?.contrast === undefined) return;
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const composer = new EffectComposer(renderer, target);
  composer.renderToScreen = false;
  composer.setPixelRatio(1);
  const source = new TexturePass();
  source.material.toneMapped = false;
  composer.addPass(source);
  let sun: THREE.DirectionalLight | undefined;
  const sunDirection = new THREE.Vector3(...(solar?.direction ?? [0, 1, 0]));
  if (dust || hasVolumes) {
    scene.traverse(object => {
      if (!sun && object instanceof THREE.DirectionalLight && (!solar || object.parent?.userData.sourceLight === solar.name)) sun = object;
    });
    if (sun) {
      scene.updateMatrixWorld(true);
      sunDirection.copy(sun.getWorldPosition(new THREE.Vector3())).sub(sun.target.getWorldPosition(new THREE.Vector3())).normalize();
      const bounds = new THREE.Box3().setFromObject(scene), center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(5, bounds.getBoundingSphere(new THREE.Sphere()).radius * 1.05);
      // Directional illumination is position-independent; fit its shadow camera to the static scene.
      sun.position.copy(sun.parent!.worldToLocal(center.clone().addScaledVector(sunDirection, radius * 2)));
      sun.target.position.copy(sun.target.parent!.worldToLocal(center.clone()));
      Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.1, far: radius * 4 });
      sun.shadow.camera.updateProjectionMatrix(); sun.shadow.mapSize.set(2048, 2048);
      if (sun.castShadow) sun.shadow.needsUpdate = true;
      scene.updateMatrixWorld(true);
    }
  }
  const bloom = settings?.bloom;
  const bloomPass = bloom && new UnrealBloomPass(new THREE.Vector2(1, 1), bloom.strength ?? 0.25,
    bloom.radius ?? 0.35, bloom.threshold ?? 1.2);
  if (bloomPass && !hasVolumes && !drawSun) composer.addPass(bloomPass);
  let depth: THREE.WebGLRenderTarget | undefined, depthMaterial: THREE.MeshDepthMaterial | undefined;
  let hazePass: ShaderPass | undefined;
  const atmosphere = volumeUniforms(volumes, scene, camera);
  if (settings?.haze || appearance || hasVolumes || drawSun) {
    const haze = settings?.haze;
    const centers = Array.from({ length: 6 }, (_, i) => {
      const v = dust?.volumes[i]; return v ? new THREE.Vector4(v.center[0], v.center[2], -v.center[1]!, v.density) : new THREE.Vector4();
    });
    const radii = Array.from({ length: 6 }, (_, i) => {
      const v = dust?.volumes[i]; return v ? new THREE.Vector3(v.radius[0], v.radius[2], v.radius[1]) : new THREE.Vector3(1, 1, 1);
    });
    depth = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    hazePass = new ShaderPass({
      uniforms: {
        ...atmosphere.uniforms,
        tDiffuse: { value: null }, depthImage: { value: null }, orthographic: { value: camera instanceof THREE.OrthographicCamera },
        projectionInverse: { value: camera.projectionMatrixInverse.clone() },
        cameraWorld: { value: camera.matrixWorld.clone() }, time: { value: 0 },
        start: { value: haze?.start ?? 0 }, range: { value: Math.max(haze?.depth ?? 1, 0.001) },
        strength: { value: (haze?.strength ?? 0) * (appearance?.hazeScale ?? 1) }, quadratic: { value: haze?.falloff === "QUADRATIC" },
        hazeColor: { value: new THREE.Color().setRGB(...(haze?.color ?? [0, 0, 0]).slice(0, 3) as [number, number, number], THREE.LinearSRGBColorSpace) },
        dustCenters: { value: centers }, dustRadii: { value: radii }, dustCount: { value: dust?.volumes.length ?? 0 },
        dustColor: { value: new THREE.Vector3(...(dust?.color ?? [0, 0, 0]) as [number, number, number]) },
        wind: { value: new THREE.Vector3(dust?.wind[0] ?? 0, dust?.wind[2] ?? 0, -(dust?.wind[1] ?? 0)) },
        exposureGain: { value: 2 ** (appearance?.exposureEV ?? 0) }, saturation: { value: appearance?.saturation ?? 1 },
        whiteBalance: { value: new THREE.Vector3(...(appearance?.whiteBalance ?? [1, 1, 1]) as [number, number, number]) },
        contrast: { value: appearance?.contrast ?? 1 },
        sunDepth: { value: null }, sunMatrix: { value: new THREE.Matrix4() }, sunDirection: { value: sunDirection },
        sunDisk: { value: new THREE.Vector4(...(solar?.radiance ?? [0, 0, 0]), drawSun ? Math.cos(solar!.angularRadius) : 2) },
        ...shaftUniforms(shafts),
        ...fogUniforms(fog),
        // The shader's HG lobe omits 1/(4π); normalize here to conserve scattered energy.
        sunColor: { value: sun ? sun.color.clone().multiplyScalar(sun.intensity / (4 * Math.PI)) : new THREE.Color(0, 0, 0) },
        hasSunShadow: { value: false }, shadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      },
      vertexShader: "varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}",
      fragmentShader: `
        #include <packing>
        uniform sampler2D tDiffuse,depthImage,sunDepth;
        uniform mat4 projectionInverse,cameraWorld,sunMatrix;
        uniform float start,range,strength,time,exposureGain,saturation,contrast;
        uniform bool quadratic,hasSunShadow,orthographic;
        uniform vec2 shadowTexel;
        uniform vec3 hazeColor,dustColor,wind,dustRadii[6],whiteBalance,sunDirection,sunColor;
        uniform vec4 dustCenters[6];
        uniform vec4 sunDisk;
        uniform int dustCount;
        varying vec2 vUv;
        float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
        float noise(vec3 p){
          vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
        }
        float sunlight(vec3 world){
          if(!hasSunShadow)return 1.0;
          vec4 projected=sunMatrix*vec4(world,1.0);vec3 q=projected.xyz/projected.w;
          if(any(lessThan(q,vec3(0)))||any(greaterThan(q,vec3(1))))return 1.0;
          float visible=0.0;
          for(int y=0;y<2;y++)for(int x=0;x<2;x++){
            vec2 offset=(vec2(float(x),float(y))-0.5)*shadowTexel;
            visible+=step(q.z-0.0003,unpackRGBAToDepth(texture2D(sunDepth,q.xy+offset)));
          }
          return visible*0.25;
        }
        ${volumeShader}
        ${solarVolumeShader}
        void main(){
          float depth=unpackRGBAToDepth(texture2D(depthImage,vUv));
          vec4 p=projectionInverse*vec4(vUv*2.0-1.0,depth*2.0-1.0,1.0);
          float mist=clamp((length(p.xyz/p.w)-start)/range,0.0,1.0);
          if(quadratic)mist*=mist;
          vec4 color=texture2D(tDiffuse,vUv);
          vec4 nearPoint=projectionInverse*vec4(vUv*2.0-1.0,-1.0,1.0);
          vec3 viewOrigin=orthographic ? nearPoint.xyz/nearPoint.w : vec3(0);
          vec3 viewRay=p.xyz/p.w-viewOrigin;
          vec3 origin=(cameraWorld*vec4(viewOrigin,1.0)).xyz;
          vec3 direction=normalize(mat3(cameraWorld)*viewRay);
          float solarCosine=dot(direction,sunDirection);
          float solarEdge=max(fwidth(solarCosine),0.0000001);
          if(depth>=0.999999) color.rgb+=sunDisk.rgb*smoothstep(sunDisk.w-solarEdge,sunDisk.w+solarEdge,solarCosine);
          float surfaceDistance=length(viewRay),optical=0.0;
          vec3 scatter=vec3(0);
          float entries[6],exits[6];
          for(int cloud=0;cloud<6;cloud++){
            entries[cloud]=1e20;exits[cloud]=0.0;
            if(cloud>=dustCount)continue;
            vec3 radius=dustRadii[cloud],ro=(origin-dustCenters[cloud].xyz)/radius,rd=direction/radius;
            float a=dot(rd,rd),b=dot(ro,rd),c=dot(ro,ro)-1.0,d=b*b-a*c;
            if(d<=0.0)continue;
            float entry=max(0.0,(-b-sqrt(d))/a),exit=min(surfaceDistance,(-b+sqrt(d))/a);
            if(exit<=entry)continue;
            entries[cloud]=entry;exits[cloud]=exit;
          }
          // ponytail: single scattering from one sun; thick smoke needs multiple scattering.
          float g=0.45,mu=dot(direction,sunDirection);
          float phase=(1.0-g*g)/pow(1.0+g*g-2.0*g*mu,1.5);
          for(int pass=0;pass<6;pass++){
            int cloud=-1;float entry=1e19;
            for(int i=0;i<6;i++)if(entries[i]<entry){entry=entries[i];cloud=i;}
            if(cloud<0)break;
            entries[cloud]=1e20;
            vec3 radius=dustRadii[cloud];float stepLength=(exits[cloud]-entry)/32.0;
            float jitter=hash(vec3(vUv*900.0,float(cloud)));
            for(int j=0;j<32;j++){
              float t=entry+(float(j)+jitter)*stepLength;
              vec3 world=origin+direction*t,q=(world-dustCenters[cloud].xyz)/radius;
              float envelope=pow(max(0.0,1.0-dot(q,q)),1.2);
              vec3 drift=world*vec3(0.32,1.1,0.32)-wind*time*0.3;
              float billow=0.57*noise(drift)+0.28*noise(drift*2.1)+0.15*noise(drift*4.3);
              float tau=stepLength*dustCenters[cloud].w*envelope*smoothstep(0.26,0.72,billow);
              if(tau<=0.00001)continue;
              vec3 illumination=vec3(0.045,0.055,0.075)+sunColor*sunlight(world)*phase;
              scatter+=exp(-optical)*(1.0-exp(-tau))*dustColor*illumination;
              optical+=tau;
            }
          }
          color.rgb=applyVolumes(color.rgb,origin,direction,surfaceDistance);
          color.rgb=color.rgb*exp(-optical)+scatter;
          vec4 fog=integrateFog(origin,direction,surfaceDistance);
          color.rgb=color.rgb*fog.a+fog.rgb;
          vec4 shafts=integrateShafts(origin,direction,surfaceDistance);
          color.rgb=color.rgb*shafts.a+shafts.rgb;
          color.rgb=mix(color.rgb,hazeColor,mist*strength)*exposureGain*whiteBalance;
          // A luminance curve preserves hue while separating sunlit and shaded regions.
          float preContrastLuminance=max(dot(color.rgb,vec3(0.2126,0.7152,0.0722)),0.00001);
          color.rgb*=pow(preContrastLuminance/0.18,contrast-1.0);
          float luminance=dot(color.rgb,vec3(0.2126,0.7152,0.0722));
          color.rgb=max(vec3(0),mix(vec3(luminance),color.rgb,saturation));
          gl_FragColor=color;
        }`,
    });
    Object.assign(hazePass.uniforms, atmosphere.uniforms);
    hazePass.uniforms.depthImage!.value = depth.texture;
    hazePass.material.toneMapped = false;
    composer.addPass(hazePass);
  }
  if (bloomPass && (hasVolumes || drawSun)) composer.addPass(bloomPass);
  return {
    animated: Boolean(dust?.volumes.length),
    shadowedDust: Boolean((dust || hasVolumes) && sun?.castShadow),
    depthDirty: true,
    resize(width: number, height: number) {
      composer.setSize(width, height); depth?.setSize(width, height); this.depthDirty = true;
    },
    render(texture: THREE.Texture, display?: FullScreenQuad) {
      if (this.depthDirty && depth && depthMaterial && hazePass) {
        const previousTarget = renderer.getRenderTarget(), previousMaterial = scene.overrideMaterial, previousBackground = scene.background;
        const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
        try {
          scene.overrideMaterial = depthMaterial; scene.background = null;
          renderer.setRenderTarget(depth); renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, camera);
          hazePass.uniforms.projectionInverse!.value.copy(camera.projectionMatrixInverse);
          hazePass.uniforms.cameraWorld!.value.copy(camera.matrixWorld);
          if (sun?.shadow.map) {
            hazePass.uniforms.sunDepth!.value = sun.shadow.map.texture;
            hazePass.uniforms.sunMatrix!.value.copy(sun.shadow.matrix);
            hazePass.uniforms.hasSunShadow!.value = true;
          }
          // The exported scene is static; camera orbit only needs a fresh camera-depth image.
          renderer.shadowMap.autoUpdate = false;
        } finally {
          scene.overrideMaterial = previousMaterial; scene.background = previousBackground;
          renderer.setClearColor(clearColor, clearAlpha); renderer.setRenderTarget(previousTarget);
        }
        this.depthDirty = false;
      }
      if (hazePass) {
        hazePass.uniforms.time!.value = performance.now() / 1000;
        if (sun) hazePass.uniforms.sunColor!.value.copy(sun.color).multiplyScalar(sun.intensity / (4 * Math.PI));
      }
      atmosphere.update();
      source.map = texture; composer.render();
      if (display) {
        (display.material as THREE.ShaderMaterial).uniforms.source!.value = composer.readBuffer.texture;
        renderer.setRenderTarget(null); display.render(renderer);
      } else {
        source.map = composer.readBuffer.texture; source.renderToScreen = true;
        source.render(renderer, composer.writeBuffer, composer.readBuffer, 0, false); source.renderToScreen = false;
      }
    },
    dispose() {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose(); depth?.dispose(); depthMaterial?.dispose();
    },
  };
}

async function loadModel(url: string) {
  loadingURL = url;
  if (viewer && loadedURL !== url) {
    dispose(); loadedURL = ""; graphNodes = snapshot?.plan?.graph ?? []; renderGraph(); setMode("render");
    el<HTMLButtonElement>("mode-3d").disabled = true;
  }
  try {
    const profileURL = await assetURL("render-profile.json", url);
    const profileResponse = await fetch(profileURL);
    if (!profileResponse.ok) throw new Error("Export profile could not be loaded.");
    const profile = await profileResponse.json() as Profile;
    const state = snapshot?.workflowState, expectedPresentation = state?.presentation;
    if (expectedPresentation?.mode === "structural" && (profile.previewMode !== "structural" ||
        profile.source?.kind !== expectedPresentation.source || profile.source.purpose !== expectedPresentation.purpose ||
        profile.source.iteration !== expectedPresentation.iteration || profile.source.phase !== state?.phase)) {
      throw new Error("Regenerate the structural gray preview with scene_preview before reviewing composition.");
    }
    const graphResponse = await fetch(await assetURL("scene-graph.json", url));
    if (!graphResponse.ok) throw new Error("Scene Graph could not be loaded.");
    const exportedGraph = await graphResponse.json() as GraphFile;
    if (exportedGraph.iteration !== (expectedPresentation?.iteration ?? snapshot?.exportedIteration ?? snapshot?.previewedIteration) ||
      (profile as Profile & { iteration?: number }).iteration !== exportedGraph.iteration) {
      throw new Error("Preview files belong to different iterations.");
    }
    const gltf = await new GLTFLoader().loadAsync(await assetURL("final.glb", url));
    if (artifact("final.glb") !== url) return;
    dispose();
    graphNodes = exportedGraph.nodes;
    if (selectedNodeId && !graphNodes.some((node) => node.id === selectedNodeId)) selectedNodeId = "";
    renderGraph();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.domElement.dataset.previewMode = profile.previewMode ?? "final";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = profile.colorManagement.displayLut ? THREE.NoToneMapping :
      profile.colorManagement.viewTransform.toLowerCase().includes("agx") ? THREE.AgXToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = 2 ** profile.colorManagement.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene(); scene.add(gltf.scene);
    const raster = profile.previewAppearance?.renderMode === "raster" || Boolean(gltf.animations.length ||
      profile.vfx?.precipitation?.some(effect => effect.count > 0) || profile.vfx?.ripples?.length || profile.vfx?.animation);
    if (raster) { renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true; }
    const meshesById = new Map<string, THREE.Mesh[]>();
    const indexMeshes = (object: THREE.Object3D, inherited?: string, visible = true) => {
      const id = typeof object.userData.scene_node_id === "string" ? object.userData.scene_node_id : inherited;
      const showing = visible && object.visible;
      if (showing && id && object instanceof THREE.Mesh) meshesById.set(id, [...(meshesById.get(id) ?? []), object]);
      for (const child of object.children) indexMeshes(child, id, showing);
    };
    indexMeshes(gltf.scene);
    const meshNodes = new Map<THREE.Object3D, string>();
    for (const [id, meshes] of meshesById) for (const mesh of meshes) meshNodes.set(mesh, id);
    const raycaster = new THREE.Raycaster();
    let press: { x: number; y: number } | undefined;
    renderer.domElement.addEventListener("pointerdown", (event) => {
      press = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
    });
    renderer.domElement.addEventListener("pointercancel", () => { press = undefined; });
    renderer.domElement.addEventListener("pointerup", (event) => {
      const start = press; press = undefined;
      if (event.button !== 0 || !start || mode !== "3d" || !viewer || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
      viewer.camera.updateMatrixWorld();
      raycaster.setFromCamera(pointer, viewer.camera);
      const hit = raycaster.intersectObjects([...meshNodes.keys()], false)[0];
      selectNode(hit ? meshNodes.get(hit.object) ?? "" : "", false);
    });
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
    const bakedObjects = new Set((profile.bakedObjects ?? []).map(normalized));
    const bakedTints = new Map(Object.entries(profile.bakedTints ?? {}).map(([name, tint]) => [normalized(name), tint]));
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = !bakedObjects.has(normalized(object.name));
        const tint = bakedTints.get(normalized(object.name));
        if (tint?.length === 3) {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material instanceof THREE.MeshStandardMaterial) material.emissive.multiply(
              new THREE.Color().setRGB(tint[0]!, tint[1]!, tint[2]!, THREE.LinearSRGBColorSpace));
          }
        }
      }
    });
    applyLights(gltf.scene, profile);
    const textures: THREE.Texture[] = [];
    if (raster) {
      textures.push(...await applyLightmaps(gltf.scene, profile.lightmaps ?? [], name => assetURL(name, url)));
      sharpenThinGlass(gltf.scene);
    }
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
    scene.environment = environment;
    textures.push(environment);
    scene.environmentIntensity = world.strength;
    scene.environmentRotation.y = world.environmentRotationY;
    if (!profile.render.filmTransparent) {
      scene.background = environment; scene.backgroundIntensity = world.strength;
      scene.backgroundRotation.y = world.environmentRotationY;
      if (world.backgroundEnvironmentUri) {
        const encoded = world.backgroundEnvironmentUri.split(",")[1]!;
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        const image = new EXRLoader().parse(bytes.buffer);
        const background = new THREE.DataTexture(image.data, image.width, image.height, image.format, image.type);
        background.needsUpdate = true;
        background.colorSpace = THREE.LinearSRGBColorSpace; background.mapping = THREE.EquirectangularReflectionMapping;
        textures.push(background); scene.background = background; scene.backgroundIntensity = 1;
      }
    }
    const sceneCameras: THREE.Camera[] = [];
    gltf.scene.traverse((object) => { if (object instanceof THREE.Camera) sceneCameras.push(object); });
    const exportedCamera = sceneCameras.find((camera) => camera.name === normalized(profile.camera?.name ?? "")) ??
      sceneCameras[0] ?? gltf.cameras[0];
    const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = exportedCamera instanceof THREE.OrthographicCamera ?
      exportedCamera : new PhysicalCamera(exportedCamera instanceof THREE.PerspectiveCamera ? exportedCamera.fov : 45,
        1, exportedCamera instanceof THREE.PerspectiveCamera ? exportedCamera.near : 0.01,
        exportedCamera instanceof THREE.PerspectiveCamera ? exportedCamera.far : extent * 100);
    if (!exportedCamera) { camera.position.copy(center).add(new THREE.Vector3(extent * 1.5, extent, extent * 1.5)); camera.lookAt(center); }
    scene.updateMatrixWorld(true);
    if (exportedCamera) {
      const position = exportedCamera.getWorldPosition(new THREE.Vector3());
      const rotation = exportedCamera.getWorldQuaternion(new THREE.Quaternion());
      exportedCamera.removeFromParent(); scene.add(camera); camera.position.copy(position); camera.quaternion.copy(rotation);
    }
    if (camera instanceof PhysicalCamera && profile.camera?.dof) {
      const dof = profile.camera.dof;
      camera.bokehSize = dof.enabled ? (profile.camera.lens ?? 50) / Math.max(dof.fStop, 0.1) : 0;
      camera.focusDistance = dof.focusDistance;
      camera.apertureBlades = dof.blades;
      camera.apertureRotation = dof.rotation;
      camera.anamorphicRatio = dof.ratio;
    }
    const initialDirection = camera.getWorldDirection(new THREE.Vector3());
    const controls = new OrbitControls(camera, renderer.domElement);
    // A wide city foundation can put the orbit pivot hundreds of metres away.
    const focusDistance = raster && (profile.camera?.dof?.focusDistance ?? 0) > 0 ?
      profile.camera!.dof!.focusDistance : camera.position.distanceTo(center) || extent;
    controls.target.copy(exportedCamera ? camera.position.clone().addScaledVector(initialDirection, focusDistance) : center);
    controls.enableDamping = true; controls.update();
    const navigation = keyboardNavigation(camera, controls, renderer.domElement, () => mode === "3d" && controls.enabled);
    const aspect = profile.render.resolutionX / profile.render.resolutionY;
    const planarReflection = raster ? profile.previewAppearance?.planarReflection : undefined;
    const shadowMaps = limitPreviewShadows(scene, camera, renderer.capabilities.maxTextures, Boolean(planarReflection));
    const probe = raster && profile.previewAppearance?.reflectionProbe ?
      captureEnvironment(renderer, scene, profile.previewAppearance.reflectionProbe, camera.far) : undefined;
    if (probe) {
      scene.environment = probe.texture; scene.environmentIntensity = 1;
      limitRasterLights(scene, camera);
    }
    const reflection = planarReflection ? addPlanarReflection(scene, gltf.scene, planarReflection) : undefined;
    const tracer = raster ? undefined : new WebGLPathTracer(renderer);
    if (tracer) {
      tracer.bounces = 8;
      tracer.transmissiveBounces = 12;
      tracer.filterGlossyFactor = 0.2;
      tracer.renderScale = Math.min(1, 1 / renderer.getPixelRatio());
      tracer.tiles.set(1, 1);
      tracer.minSamples = 1;
      tracer.renderDelay = 100;
      tracer.dynamicLowRes = true;
      tracer.textureSize.set(1024, 1024);
      tracer.setScene(scene, camera);
      tracer.renderToCanvas = false;
    }
    const display = await displayTransform(profile, textures);
    const effects = previewEffects(renderer, scene, camera, profile);
    const weather = createWeather(profile.vfx, scene, gltf.scene, gltf.animations);
    if (raster) renderer.shadowMap.needsUpdate = true;
    const denoise = new FullScreenQuad(new DenoiseMaterial({ sigma: 1, kSigma: 1, threshold: 0.02, toneMapped: !display && !effects }));
    const denoiseTarget = display || effects ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, samples: raster ? 4 : 0 }) : undefined;
    let rasterDirty = true;
    const resize = new ResizeObserver(() => {
      const w = el("stage").clientWidth, h = el("stage").clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      const viewportAspect = w / h;
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = viewportAspect;
      else {
        const center = (camera.left + camera.right) / 2;
        const halfWidth = (camera.top - camera.bottom) * viewportAspect / 2;
        camera.left = center - halfWidth; camera.right = center + halfWidth;
      }
      camera.updateProjectionMatrix();
      if (camera instanceof THREE.PerspectiveCamera && profile.camera?.projectionMatrix?.length === 16) {
        camera.projectionMatrix.fromArray(profile.camera.projectionMatrix);
        camera.projectionMatrix.elements[0]! *= aspect / viewportAspect;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      tracer?.updateCamera();
      rasterDirty = true;
      effects?.resize(w, h);
    });
    el("canvas").appendChild(renderer.domElement);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const position = camera.position.clone(), target = controls.target.clone();
    const previousPosition = position.clone(), previousQuaternion = camera.quaternion.clone();
    const previousProjection = camera.projectionMatrix.clone();
    const frameTimer = setInterval(() => {
      navigation.update();
      if (mode !== "3d" || !viewer || viewer.tracer !== tracer) return;
      controls.update();
      updateSelectionBox();
      if (viewer.gpuFence) {
        if (gl.clientWaitSync(viewer.gpuFence, 0, 0) === gl.TIMEOUT_EXPIRED) return;
        gl.deleteSync(viewer.gpuFence); viewer.gpuFence = undefined;
      }
      if (!camera.position.equals(previousPosition) || !camera.quaternion.equals(previousQuaternion) || !camera.projectionMatrix.equals(previousProjection)) {
        tracer?.updateCamera(); previousPosition.copy(camera.position); previousQuaternion.copy(camera.quaternion);
        previousProjection.copy(camera.projectionMatrix);
        rasterDirty = true;
        if (effects) effects.depthDirty = true;
      }
      if (viewer.weather) {
        viewer.weather.update(camera);
        rasterDirty = true;
        if (viewer.weather.geometryChanges) {
          if (effects) effects.depthDirty = true;
          renderer.shadowMap.needsUpdate = true;
        }
      }
      if (tracer && tracer.samples >= 512 && !effects?.animated) return;
      if (!tracer && !rasterDirty && !effects?.animated) return;
      if (tracer && tracer.samples < 512) tracer.renderSample();
      if (tracer && tracer.samples >= 4) {
        (denoise.material as DenoiseMaterial).map = tracer.target.texture;
        if (denoiseTarget) {
          denoiseTarget.setSize(tracer.target.width, tracer.target.height);
          renderer.setRenderTarget(denoiseTarget); denoise.render(renderer); renderer.setRenderTarget(null);
        } else denoise.render(renderer);
      } else if (denoiseTarget && (tracer || rasterDirty)) {
        // Preserve atmosphere and the display transform while orbiting, before samples converge.
        denoiseTarget.setSize(tracer?.target.width ?? renderer.domElement.width, tracer?.target.height ?? renderer.domElement.height);
        renderer.setRenderTarget(denoiseTarget); renderer.render(scene, camera); renderer.setRenderTarget(null);
      } else if (!denoiseTarget && (tracer || rasterDirty)) renderer.render(scene, camera);
      if (denoiseTarget) {
        if (effects) effects.render(denoiseTarget.texture, display);
        else if (display) {
          (display.material as THREE.ShaderMaterial).uniforms.source!.value = denoiseTarget.texture;
          display.render(renderer);
        }
      }
      renderer.domElement.dataset.samples = tracer?.samples.toFixed(1) ?? "0";
      renderer.domElement.dataset.frame = String(Number(renderer.domElement.dataset.frame ?? 0) + 1);
      rasterDirty = false;
      viewer.gpuFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? undefined;
      gl.flush();
    }, 16);
    viewer = { renderer, scene, camera, controls, navigation, tracer, reflection, probe, denoise, denoiseTarget, display, effects, weather, frameTimer,
      position, target, zoom: camera.zoom, textures, resize, aspect, meshesById };
    resize.observe(el("stage"));
    renderer.domElement.dataset.renderer = raster ? "raster" : "path-tracing";
    renderer.domElement.dataset.bounces = String(tracer?.bounces ?? 0);
    renderer.domElement.dataset.displayTransform = display ? "blender-lut" : "three-tone-mapping";
    renderer.domElement.dataset.samples = "0";
    renderer.domElement.dataset.shadowMaps = String(shadowMaps);
    renderer.domElement.dataset.effects = Object.keys(profile.postprocessing ?? {}).join(",");
    if (profile.previewAppearance?.dust) renderer.domElement.dataset.effects += ",dust";
    if (profile.vfx?.volumes?.length) renderer.domElement.dataset.effects += ",volumes";
    if (weather) renderer.domElement.dataset.effects += ",weather";
    renderer.domElement.title = (profile.warnings ?? []).join("\n");
    if (profile.effects?.shafts.length) renderer.domElement.dataset.effects += ",sun-shafts";
    if (profile.effects?.fog?.some(fog => !profile.vfx?.volumes?.some(volume => volume.name === fog.name))) renderer.domElement.dataset.effects += ",local-fog";
    renderer.domElement.dataset.dustLighting = effects?.shadowedDust ? "sun-shadow" : "ambient";
    loadedURL = url;
    el<HTMLButtonElement>("mode-3d").disabled = false;
    el("empty").style.display = "none";
    setMode(mode === "threert" ? "threert" : mode === "render" && preferredBackend === "threert" ? "render" : "3d");
    renderer.render(scene, camera);
    updateSceneStats(gltf.scene);
    if (selectedNodeId && graphNodes.some((node) => node.id === selectedNodeId)) focusNode(selectedNodeId);
  } catch (error) {
    console.error("Scene preview failed:", error);
    message("3D preview could not be loaded. Use the render or download the Blender file.");
  } finally { loadingURL = ""; }
}

function receive(data: unknown) {
  if (!data || typeof data !== "object" || !("id" in data)) return;
  const next = data as Snapshot;
  if (snapshot && snapshot.id !== next.id) {
    preferredBackend = undefined;
    liveViewer?.dispose(); liveViewer = undefined; liveWanted = false; liveStatus = "";
    dispose(); loadedURL = ""; mode = "render";
    referenceListKey = ""; reviewImagesKey = ""; selectedNodeId = ""; expanded.clear(); graphNodes = [];
    el<HTMLDialogElement>("reference-dialog").close();
    el("render").removeAttribute("src"); el("render").style.display = "none";
    el("reference").style.display = "none";
    el("empty").style.display = "grid";
    el<HTMLButtonElement>("mode-3d").disabled = true;
  }
  if (snapshot?.exportVersion !== next.exportVersion) {
    liveViewer?.dispose(); liveViewer = undefined; liveWanted = false; liveStatus = "";
  }
  snapshot = next;
  updateThreeRT();
  if (!artifact("final.glb") && viewer) { dispose(); loadedURL = ""; mode = "render"; }
  if (!viewer) {
    graphNodes = next.plan?.graph ?? [];
    if (selectedNodeId && !graphNodes.some((node) => node.id === selectedNodeId)) selectedNodeId = "";
    renderGraph();
  }
  const busy = next.job && ["queued", "running"].includes(next.job.status);
  const state = next.workflowState, presentation = state?.presentation;
  const structural = presentation?.mode === "structural", pending = next.stage === "awaiting_review";
  el("status").textContent = busy ? next.job!.kind === "threert" ? "ThreeRT 渲染中" : next.job!.kind === "references" ? "Loading reference views" :
    next.job!.kind === "create" ? "Preparing scene" : next.job!.kind === "bake" ? "正在烘焙场景" : next.job!.kind === "preview" ? "Preparing 3D review preview" : `${next.job!.kind === "export" ? "Exporting" : "Rendering"} scene` :
    next.error ? next.job?.kind === "threert" ? "ThreeRT 渲染失败" : "Scene needs attention" : next.stage === "completed" ? "Ready" :
    next.stage === "best_effort" ? "Best version" : next.stage === "awaiting_review" ? "Confirm composition" :
    next.stage === "review" ? "Awaiting review" :
    next.plan?.workflow ? `Building ${next.plan.workflow.stages[next.workflowIndex ?? 0]?.name ?? "scene"}` : "Building scene";
  if (!busy && !next.error && presentation) el("status").textContent = `${state!.phase ?? "Planning"} / ${state!.status} · ${presentation.purpose === "work" ? "work draft" : presentation.purpose === "confirmation" ? "awaiting approval" : "delivery"} · iteration ${presentation.iteration} · ${presentation.mode}`;
  const webIssues = next.exportAlignment?.issues.filter(issue => !issue.target || issue.target === "threejs") ?? [];
  el("status").title = webIssues.map(issue => `${issue.object} · ${issue.effect} — ${issue.reason}`).join("\n");
  if (!busy && !next.error && next.exportAlignment?.status === "degraded") el("status").textContent += " · 3D export is missing effects";
  el("review-panel").hidden = !pending && !(structural && next.reviewViews?.length);
  el("review-panel").querySelector("h2")!.textContent = pending ? "Geometry and composition preview" : "Structural work preview — not approved";
  el("review-gaps").textContent = (next.remainingGaps?.length ? `Remaining differences: ${next.remainingGaps.join(", ")}. ` : "") + `${pending ? "Review" : "Work draft: review"} geometry, wall directions and camera in neutral gray. Original materials are preserved for later stages. Auxiliary views hide walls and ceilings to reveal the layout.`;
  if (structural && !busy && next.reviewViews) {
    const key = `${next.id}:${next.iteration}:${next.job?.id ?? ""}:${next.reviewViews.join(",")}`;
    if (key !== reviewImagesKey) {
      reviewImagesKey = key;
      const holder = el("review-images"); holder.replaceChildren();
      for (const name of next.reviewViews) {
        const image = document.createElement("img"); image.alt = name.replace("review-", "").replace(".png", " view");
        holder.appendChild(image);
        void assetURL(name, key).then((url) => { if (snapshot?.id === next.id) image.src = url; })
          .catch(() => { image.alt = `${name} unavailable`; });
      }
    }
  }
  const render = ["completed", "best_effort"].includes(next.stage) ? next.bestRenderUrl : next.renderUrl;
  if (render) {
    const name = structural && next.reviewViews?.includes("review-main.png") ? "review-main.png" : ["completed", "best_effort"].includes(next.stage) ? "best.png" : "render";
    el("empty").textContent = "Loading scene render";
    void assetURL(name, `${next.stage}:${next.iteration}:${next.best?.iteration ?? 0}:${next.job?.id ?? ""}`).then((url) => {
      if (snapshot?.id !== next.id || snapshot?.stage !== next.stage) return;
      el<HTMLImageElement>("render").src = url;
      el("render").dataset.asset = name;
      el("empty").style.display = "none";
      setMode(mode);
    }).catch((error) => {
      if (snapshot !== next) return;
      console.error("Scene render failed:", error);
      el("empty").textContent = "Scene render could not be loaded.";
      message("Scene render could not be loaded.");
    });
  } else {
    el("render").removeAttribute("src");
    el("render").style.display = "none";
    el("empty").textContent = structural ? "Preparing structural gray views" : "Current-stage render is not ready";
    el("empty").style.display = "grid";
  }
  const views = referenceViews(next);
  const key = `${next.id}:${JSON.stringify([views, next.referenceCameras])}`;
  el("references").hidden = !views.length;
  if (key !== referenceListKey) {
    referenceListKey = key;
    const select = el<HTMLSelectElement>("reference-select"), selected = select.value;
    select.replaceChildren(...views.map((view, index) => new Option(
      `${index === 0 ? "Primary" : `View ${index + 1}`}: ${view.label ?? view.name ?? view.assetName}`, view.assetName)));
    if (views.some((view) => view.assetName === selected)) select.value = selected;
    void showReference();
  }
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
  if (next.error) message(next.job?.kind === "threert" ? next.threeRTRender?.error ?? "ThreeRT 渲染失败，可重试或切回网页交互。" : "The scene operation failed. Ask in the conversation to inspect it and retry.");
  const glb = artifact("final.glb");
  if (glb && glb !== loadedURL && glb !== loadingURL) void loadModel(glb);
  setMode(mode);
  if (!busy && !preferredBackend && !threeRTLiveUnavailableReason()) {
    preferredBackend = "threert";
    showPreview();
  }
  clearTimeout(timer);
  if (busy || (!next.error && !["completed", "best_effort"].includes(next.stage))) {
    timer = setTimeout(() => { void refreshScene(next.id); }, 2000);
  }
}

async function refreshScene(sceneId: string) {
  try {
    const output = await app.callServerTool({ name: "scene_get", arguments: { sceneId, images: "none" } });
    if (output.isError) throw new Error("Scene refresh failed.");
    if (snapshot?.id === sceneId) receive(output.structuredContent);
  } catch { message("Scene progress could not be refreshed. Check the conversation."); }
}

app.ontoolresult = async (output) => {
  const next = output.structuredContent as Snapshot | undefined;
  if (!next?.id) return;
  receive(next);
  await refreshScene(next.id);
};
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  if (context.displayMode) document.documentElement.dataset.display = context.displayMode;
};
el("mode-render").onclick = () => setMode("render");
el("mode-3d").onclick = showPreview;
el<HTMLSelectElement>("render-backend").onchange = () => {
  preferredBackend = el<HTMLSelectElement>("render-backend").value === "threert" ? "threert" : "web";
  showPreview();
};
el("render-threert").onclick = () => { void startThreeRT(); };
el("reset").onclick = () => {
  if (mode === "threert") { liveViewer?.reset(); return; }
  if (viewer) {
    viewer.controls.enableDamping = false; viewer.controls.update();
    viewer.camera.position.copy(viewer.position); viewer.camera.zoom = viewer.zoom; viewer.camera.updateProjectionMatrix();
    viewer.controls.target.copy(viewer.target); viewer.controls.update(); updateSelectionBox();
    viewer.controls.enableDamping = true;
  }
};
el("selection-clear").onclick = () => selectNode("");
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.key === "Escape" && !(target instanceof HTMLElement && (target.isContentEditable || target.matches("input,textarea,select")))) selectNode("");
});
el("fullscreen").onclick = async () => {
  try {
    const result = await app.requestDisplayMode({ mode: "fullscreen" });
    document.documentElement.dataset.display = result.mode;
    if (result.mode === "fullscreen") el("stage").style.height = "calc(100vh - 180px)";
  } catch { message("Expanded view is unavailable in this client."); }
};
type OpenAIHost = {
  uploadFile(file: File): Promise<{ fileId: string }>;
  getFileDownloadUrl(input: { fileId: string }): Promise<{ downloadUrl: string }>;
};
const host = (window as unknown as { openai?: OpenAIHost }).openai;
if (typeof host?.uploadFile === "function" && typeof host.getFileDownloadUrl === "function") {
  let files: File[] = [], uploading = false;
  const clearSelection = () => { files = []; el("reference-upload").hidden = true; el<HTMLInputElement>("file").value = ""; };
  el("upload").style.display = "inline-block";
  el("upload").onclick = () => el<HTMLInputElement>("file").click();
  el<HTMLInputElement>("file").onchange = async (event) => {
    const selected = Array.from((event.target as HTMLInputElement).files ?? []);
    if (!selected.length || uploading) return;
    if (selected.length > 6 || selected.some((file) => file.size > 20 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      clearSelection(); message("Use up to 6 PNG, JPEG or WebP images, each at most 20 MB."); return;
    }
    files = selected;
    el("selected-count").textContent = `${files.length} reference image${files.length === 1 ? "" : "s"} selected`;
    el("reference-upload").hidden = false;
    el("append-images").hidden = !snapshot || !["completed", "best_effort"].includes(snapshot.stage);
  };
  el("cancel-images").onclick = clearSelection;
  async function submitImages(append: boolean) {
    if (uploading || !files.length) return;
    const current = snapshot;
    if (append && (!current || !["completed", "best_effort"].includes(current.stage))) return;
    if (append && referenceViews(current!).length + files.length > 6) { message("A scene can have at most 6 reference images in total."); return; }
    uploading = true;
    for (const id of ["upload", "create-images", "append-images", "cancel-images"]) el<HTMLButtonElement>(id).disabled = true;
    try {
      const references = [];
      for (const [index, file] of files.entries()) {
        message(`Uploading reference image ${index + 1} of ${files.length}`);
        const { fileId } = await host!.uploadFile(file);
        const { downloadUrl } = await host!.getFileDownloadUrl({ fileId });
        references.push({ download_url: downloadUrl, file_id: fileId, mime_type: file.type, file_name: file.name, attachmentNumber: index + 1 });
      }
      const output = await app.callServerTool({
        name: append ? "scene_continue" : "scene_create", arguments: {
          ...(append ? { sceneId: current!.id } : {}),
          prompt: append ? "Refine the same scene using these additional views to correct spatial layout." : "Create a Blender scene from these views. Use one camera per supplied view of the same scene. The first image sets the default camera and composition.",
          references,
        },
      });
      if (output.isError) throw new Error("Reference input failed.");
      receive(output.structuredContent);
      clearSelection();
      await app.sendMessage({ role: "user", content: [{ type: "text", text: `Poll scene_get with images=none for Blender scene ${(output.structuredContent as unknown as Snapshot).id} until reference downloads finish, then inspect every labeled view with scene_get. ${append ? "Refine the existing scene" : "Plan, build and review the scene"} using the stored reference order. If scene_get lists referenceCameras, fit those cameras in one scene and compare each matched render against its reference and shared landmarks. Export and show the bundled viewer.` }] });
      message("Reference images sent to the conversation");
    } catch { message("Reference images could not be submitted. Retry or attach them in the conversation."); }
    finally {
      uploading = false;
      for (const id of ["upload", "create-images", "append-images", "cancel-images"]) el<HTMLButtonElement>(id).disabled = false;
    }
  }
  el("create-images").onclick = () => { void submitImages(false); };
  el("append-images").onclick = () => { void submitImages(true); };
}
window.addEventListener("pagehide", () => { clearTimeout(timer); dispose(); });
void app.connect().then(() => {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.style.colorScheme = theme;
}).catch(() => {
  el("status").textContent = "Open in a supported chat client";
  message("This viewer connects through the installed Blender plugin.");
});

import { App } from "@modelcontextprotocol/ext-apps";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { DenoiseMaterial, PhysicalCamera, WebGLPathTracer } from "three-gpu-pathtracer";

type ReferenceView = { assetName: string; name?: string; label?: string; role?: string; url: string };
type GraphNode = { id: string; label: string; kind: string; parentId: string | null; description: string;
  status?: string; gltfNodeIndices?: number[] };
type GraphFile = { iteration: number; nodes: GraphNode[] };
type Snapshot = {
  id: string; prompt: string; stage: string; iteration: number; renderUrl: string | null; bestRenderUrl: string | null;
  reference: { url: string; name?: string; label?: string } | null; references?: ReferenceView[]; best?: { iteration: number };
  job?: { id: string; status: string; kind: string }; exportedIteration?: number; previewedIteration?: number; error?: string;
  artifacts: { name: string; url: string }[];
  plan?: { graph?: GraphNode[]; workflow?: { stages: { name: string }[] } }; workflowIndex?: number;
  reviewViews?: string[]; reviewFeedback?: string; remainingGaps?: string[];
  workflowState?: { phase: string | null; status: string; compositionApproved: boolean; presentation: {
    mode: "structural" | "appearance"; purpose: "work" | "confirmation" | "delivery"; source: string; iteration: number;
  } };
};
type Profile = {
  version: number; previewMode?: string; source?: { kind: string; purpose: string; phase: string | null; iteration: number }; colorManagement: { viewTransform: string; exposure: number; displayLut?: { uri: string; size: number; maxLinear: number } };
  render: { resolutionX: number; resolutionY: number; filmTransparent: boolean };
  world: { color: number[]; strength: number; environmentUri: string | null; environmentRotationY: number };
  camera: { name: string; projectionMatrix?: number[]; lens?: number; dof?: { enabled: boolean; focusDistance: number; fStop: number; blades: number; rotation: number; ratio: number } } | null;
  bakedObjects?: string[];
  bakedTints?: Record<string, number[]>;
  lights: { name: string; type: string; color: number[]; energy: number; webPower: number; useShadow: boolean; size: number; sizeY: number; shape: string; spotSize: number; spotBlend: number; worldMatrix: number[] }[];
};
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = new App({ name: "UniBlenderScene viewer", version: "0.3.3" }, {});
let snapshot: Snapshot | undefined, loadedURL = "", loadingURL = "", mode = "render";
let referenceListKey = "", reviewImagesKey = "";
let graphNodes: GraphNode[] = [], selectedNodeId = "";
const expanded = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let viewer: {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls; tracer: WebGLPathTracer; denoise: FullScreenQuad; denoiseTarget?: THREE.WebGLRenderTarget;
  display?: FullScreenQuad; frameTimer: ReturnType<typeof setInterval>; gpuFence?: WebGLSync;
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
      if (!chunk || chunk.name !== name || chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size > 256 * 1024 * 1024) {
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
  if (viewer) { setMode("3d"); if (focus) focusNode(id); else updateSelectionBox(); }
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

function dispose() {
  el("selection-box").style.display = "none";
  if (!viewer) return;
  clearInterval(viewer.frameTimer);
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
  viewer.tracer.dispose();
  viewer.denoise.material.dispose(); viewer.denoise.dispose();
  viewer.denoiseTarget?.dispose();
  viewer.display?.material.dispose(); viewer.display?.dispose();
  if (viewer.gpuFence) (viewer.renderer.getContext() as WebGL2RenderingContext).deleteSync(viewer.gpuFence);
  viewer.renderer.dispose();
  viewer.renderer.forceContextLoss();
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
  updateSelectionBox();
}

function referenceViews(scene: Snapshot): ReferenceView[] {
  return scene.references ?? (scene.reference ? [{ ...scene.reference, assetName: "reference", role: "primary" }] : []);
}

async function showReference() {
  if (!snapshot) return;
  const sceneId = snapshot.id;
  const selected = el<HTMLSelectElement>("reference-select").value;
  const view = referenceViews(snapshot).find((image) => image.assetName === selected);
  if (!view) return;
  try {
    const url = await assetURL(view.assetName, view.url);
    if (snapshot?.id !== sceneId || el<HTMLSelectElement>("reference-select").value !== selected) return;
    const caption = `${view.role === "primary" ? "Primary" : "Auxiliary"}: ${view.label ?? view.name ?? view.assetName}`;
    for (const id of ["reference", "reference-full"]) {
      const image = el<HTMLImageElement>(id); image.src = url; image.alt = caption;
    }
    el("reference").style.display = "block";
    el("reference-caption").textContent = caption;
  } catch (error) { console.error("Reference image failed:", error); message("Reference view could not be loaded."); }
}

el<HTMLSelectElement>("reference-select").onchange = () => { void showReference(); };
el("graph-collapse").onclick = () => {
  const panel = el("graph-panel"), collapsed = panel.classList.toggle("collapsed");
  el("graph-collapse").textContent = collapsed ? "Expand" : "Collapse";
  el("graph-collapse").setAttribute("aria-expanded", String(!collapsed));
};
el("reference-open").onclick = () => el<HTMLDialogElement>("reference-dialog").showModal();
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
    holder.position.copy(marker.position); holder.quaternion.copy(marker.quaternion); holder.scale.copy(marker.scale);
    if (definition.worldMatrix?.length === 16) {
      marker.parent.matrixWorld.clone().invert().multiply(new THREE.Matrix4().fromArray(definition.worldMatrix))
        .decompose(holder.position, holder.quaternion, holder.scale);
    }
    marker.parent.add(holder); marker.parent.remove(marker);
    const color = new THREE.Color().setRGB(...definition.color.slice(0, 3) as [number, number, number], THREE.LinearSRGBColorSpace);
    // Path tracing uses Blender's source energy; raster lumen scaling overexposes it.
    const power = Math.max(0, definition.energy ?? definition.webPower / (683 * 0.012));
    let light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight;
    if (definition.type === "SUN") light = new THREE.DirectionalLight(color, power);
    else if (definition.type === "SPOT") {
      light = new THREE.SpotLight(color, 1, 0, Math.max(0.01, Math.min(Math.PI / 2, definition.spotSize / 2)), definition.spotBlend);
      light.power = power;
    } else if (definition.type === "AREA") {
      light = new THREE.RectAreaLight(color, 1, Math.max(0.01, definition.size),
        ["RECTANGLE", "ELLIPSE"].includes(definition.shape) ? Math.max(0.01, definition.sizeY) : Math.max(0.01, definition.size));
      (light as THREE.RectAreaLight & { isCircular?: boolean }).isCircular = ["DISK", "ELLIPSE"].includes(definition.shape);
      light.power = power;
    } else { light = new THREE.PointLight(color); light.power = power; }
    holder.add(light);
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      light.target.position.set(0, 0, -1); holder.add(light.target);
    }
    if (definition.useShadow && "castShadow" in light) light.castShadow = true;
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
    const focusDistance = camera.position.distanceTo(center) || extent;
    controls.target.copy(exportedCamera ? camera.position.clone().addScaledVector(initialDirection, focusDistance) : center);
    controls.enableDamping = true; controls.update();
    const aspect = profile.render.resolutionX / profile.render.resolutionY;
    const tracer = new WebGLPathTracer(renderer);
    tracer.bounces = 8;
    tracer.transmissiveBounces = 12;
    tracer.filterGlossyFactor = 0.2;
    tracer.renderScale = Math.min(1, 1 / renderer.getPixelRatio());
    tracer.tiles.set(1, 1);
    tracer.minSamples = 1;
    tracer.renderDelay = 100;
    tracer.dynamicLowRes = true;
    tracer.textureSize.set(512, 512);
    tracer.setScene(scene, camera);
    tracer.renderToCanvas = false;
    const display = await displayTransform(profile, textures);
    const denoise = new FullScreenQuad(new DenoiseMaterial({ sigma: 2, kSigma: 1, threshold: 0.07, toneMapped: !display }));
    const denoiseTarget = display ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }) : undefined;
    const resize = new ResizeObserver(() => {
      const width = el("stage").clientWidth, height = el("stage").clientHeight;
      const w = Math.min(width, height * aspect), h = w / aspect;
      renderer.setSize(w, h);
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
      camera.updateProjectionMatrix();
      if (camera instanceof THREE.PerspectiveCamera && profile.camera?.projectionMatrix?.length === 16) {
        camera.projectionMatrix.fromArray(profile.camera.projectionMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      tracer.updateCamera();
    });
    el("canvas").appendChild(renderer.domElement);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const position = camera.position.clone(), target = controls.target.clone();
    const previousPosition = position.clone(), previousQuaternion = camera.quaternion.clone();
    const frameTimer = setInterval(() => {
      if (mode !== "3d" || !viewer || viewer.tracer !== tracer) return;
      controls.update();
      updateSelectionBox();
      if (viewer.gpuFence) {
        if (gl.clientWaitSync(viewer.gpuFence, 0, 0) === gl.TIMEOUT_EXPIRED) return;
        gl.deleteSync(viewer.gpuFence); viewer.gpuFence = undefined;
      }
      if (!camera.position.equals(previousPosition) || !camera.quaternion.equals(previousQuaternion)) {
        tracer.updateCamera(); previousPosition.copy(camera.position); previousQuaternion.copy(camera.quaternion);
      }
      if (tracer.samples >= 512) return;
      tracer.renderSample();
      if (tracer.samples >= 4) {
        (denoise.material as DenoiseMaterial).map = tracer.target.texture;
        if (display && denoiseTarget) {
          denoiseTarget.setSize(tracer.target.width, tracer.target.height);
          renderer.setRenderTarget(denoiseTarget); denoise.render(renderer); renderer.setRenderTarget(null);
          (display.material as THREE.ShaderMaterial).uniforms.source!.value = denoiseTarget.texture;
          display.render(renderer);
        } else denoise.render(renderer);
      } else renderer.render(scene, camera);
      renderer.domElement.dataset.samples = tracer.samples.toFixed(1);
      viewer.gpuFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? undefined;
      gl.flush();
    }, 16);
    viewer = { renderer, scene, camera, controls, tracer, denoise, denoiseTarget, display, frameTimer,
      position, target, zoom: camera.zoom, textures, resize, aspect, meshesById };
    resize.observe(el("stage"));
    renderer.domElement.dataset.renderer = "path-tracing";
    renderer.domElement.dataset.bounces = String(tracer.bounces);
    renderer.domElement.dataset.displayTransform = display ? "blender-lut" : "three-tone-mapping";
    renderer.domElement.dataset.samples = "0";
    loadedURL = url;
    el<HTMLButtonElement>("mode-3d").disabled = false;
    el("empty").style.display = "none";
    setMode("3d");
    renderer.render(scene, camera);
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
    dispose(); loadedURL = ""; mode = "render";
    referenceListKey = ""; reviewImagesKey = ""; selectedNodeId = ""; expanded.clear(); graphNodes = [];
    el<HTMLDialogElement>("reference-dialog").close();
    el("render").removeAttribute("src"); el("render").style.display = "none";
    el("reference").style.display = "none";
    el("empty").style.display = "grid";
    el<HTMLButtonElement>("mode-3d").disabled = true;
  }
  snapshot = next;
  if (!artifact("final.glb") && viewer) { dispose(); loadedURL = ""; mode = "render"; }
  if (!viewer) {
    graphNodes = next.plan?.graph ?? [];
    if (selectedNodeId && !graphNodes.some((node) => node.id === selectedNodeId)) selectedNodeId = "";
    renderGraph();
  }
  const busy = next.job && ["queued", "running"].includes(next.job.status);
  const state = next.workflowState, presentation = state?.presentation;
  const structural = presentation?.mode === "structural", pending = next.stage === "awaiting_review";
  el("status").textContent = busy ? next.job!.kind === "references" ? "Loading reference views" :
    next.job!.kind === "create" ? "Preparing scene" : next.job!.kind === "preview" ? "Preparing 3D review preview" : `${next.job!.kind === "export" ? "Exporting" : "Rendering"} scene` :
    next.error ? "Scene needs attention" : next.stage === "completed" ? "Ready" :
    next.stage === "best_effort" ? "Best version" : next.stage === "awaiting_review" ? "Confirm composition" :
    next.stage === "review" ? "Awaiting review" :
    next.plan?.workflow ? `Building ${next.plan.workflow.stages[next.workflowIndex ?? 0]?.name ?? "scene"}` : "Building scene";
  if (!busy && !next.error && presentation) el("status").textContent = `${state!.phase ?? "Planning"} / ${state!.status} · ${presentation.purpose === "work" ? "work draft" : presentation.purpose === "confirmation" ? "awaiting approval" : "delivery"} · iteration ${presentation.iteration} · ${presentation.mode}`;
  el("review-panel").hidden = !pending && !(structural && next.reviewViews?.length);
  el("review-panel").querySelector("h2")!.textContent = pending ? "Confirm geometry and composition" : "Structural work preview — not approved";
  for (const name of ["review-approve", "review-composition", "review-geometry", "review-feedback"]) {
    const control = el<HTMLButtonElement | HTMLInputElement>(name);
    control.hidden = !pending; control.disabled = Boolean(busy);
  }
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
  el<HTMLButtonElement>("send").disabled = busy || !["completed", "best_effort"].includes(next.stage);
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
    }).catch((error) => { console.error("Scene render failed:", error); message("Scene render could not be loaded."); });
  } else {
    el("render").removeAttribute("src");
    el("render").style.display = "none";
    el("empty").textContent = structural ? "Preparing structural gray views" : "Current-stage render is not ready";
    el("empty").style.display = "grid";
  }
  const views = referenceViews(next);
  const key = `${next.id}:${JSON.stringify(views)}`;
  el("references").hidden = !views.length;
  if (key !== referenceListKey) {
    referenceListKey = key;
    const select = el<HTMLSelectElement>("reference-select"), selected = select.value;
    select.replaceChildren(...views.map((view, index) => new Option(
      `${index === 0 ? "Primary" : `Auxiliary ${index}`}: ${view.label ?? view.name ?? view.assetName}`, view.assetName)));
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
async function decideReview(approved: boolean, returnTo?: "geometry" | "composition") {
  if (!snapshot || snapshot.stage !== "awaiting_review") return;
  const feedback = el<HTMLInputElement>("review-feedback").value.trim();
  if (!approved && !feedback) { message("Describe the requested change first."); return; }
  const output = await app.callServerTool({ name: "scene_review_decision", arguments: {
    sceneId: snapshot.id, approved, ...(approved ? {} : { feedback, returnTo }),
  } });
  if (output.isError) { message("Review decision failed. Check the scene in the conversation."); return; }
  receive(output.structuredContent);
  await app.sendMessage({ role: "user", content: [{ type: "text", text: approved ?
    `I confirm the geometry and composition of Blender scene ${snapshot.id}. Continue from the approved checkpoint.` :
    `Revise Blender scene ${snapshot.id} at the ${returnTo} stage: ${feedback}` }] });
}
el("review-approve").onclick = () => { void decideReview(true); };
el("review-composition").onclick = () => { void decideReview(false, "composition"); };
el("review-geometry").onclick = () => { void decideReview(false, "geometry"); };
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
    el<HTMLSelectElement>("primary-view").replaceChildren(...files.map((file, index) => new Option(file.name, String(index))));
    el("reference-upload").hidden = false;
    el("append-images").hidden = !snapshot || !["completed", "best_effort"].includes(snapshot.stage);
  };
  el("cancel-images").onclick = clearSelection;
  async function submitImages(append: boolean) {
    if (uploading || !files.length) return;
    const current = snapshot;
    if (append && (!current || !["completed", "best_effort"].includes(current.stage))) return;
    if (append && referenceViews(current!).length + files.length > 6) { message("A scene can have at most 6 reference images in total."); return; }
    const primary = Number(el<HTMLSelectElement>("primary-view").value);
    const ordered = append ? files : [files[primary]!, ...files.filter((_, index) => index !== primary)];
    uploading = true;
    for (const id of ["upload", "create-images", "append-images", "cancel-images"]) el<HTMLButtonElement>(id).disabled = true;
    try {
      const references = [];
      for (const [index, file] of ordered.entries()) {
        message(`Uploading reference image ${index + 1} of ${ordered.length}`);
        const { fileId } = await host!.uploadFile(file);
        const { downloadUrl } = await host!.getFileDownloadUrl({ fileId });
        references.push({ download_url: downloadUrl, file_id: fileId, mime_type: file.type, file_name: file.name });
      }
      const output = await app.callServerTool({
        name: append ? "scene_continue" : "scene_create", arguments: {
          ...(append ? { sceneId: current!.id } : {}),
          prompt: el<HTMLInputElement>("prompt").value.trim() || (append ? "Refine the same scene using these additional views to correct spatial layout." : "Create a Blender scene from these views. The first image sets the camera and composition; auxiliary views calibrate spatial layout."),
          references,
        },
      });
      if (output.isError) throw new Error("Reference input failed.");
      receive(output.structuredContent);
      clearSelection();
      await app.sendMessage({ role: "user", content: [{ type: "text", text: `Poll scene_view for Blender scene ${(output.structuredContent as unknown as Snapshot).id} until reference downloads finish, then inspect every labeled view with scene_get. ${append ? "Refine the existing scene" : "Plan, build and review the scene"} using the primary view for composition and all auxiliary views for spatial layout; export and show the bundled viewer.` }] });
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

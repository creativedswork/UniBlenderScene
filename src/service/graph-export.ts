import { createHash } from "node:crypto";
import { maxViewerAssetBytes, type ExportEffects } from "../render-effects.js";
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { SceneNode } from "./store.js";
import type { SceneRelation } from "./relations.js";

type GltfNode = { name?: string; mesh?: number; camera?: number; children?: number[];
  extras?: { scene_node_id?: string } };

export function readGlbNodes(path: string): GltfNode[] {
  const file = openSync(path, "r");
  try {
    const header = Buffer.alloc(20), size = fstatSync(file).size;
    if (readSync(file, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 4) !== "glTF" ||
      header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== size || header.readUInt32LE(16) !== 0x4e4f534a ||
      header.readUInt32LE(12) > size - header.length) throw new Error("Exported GLB has an invalid JSON header.");
    const data = Buffer.alloc(header.readUInt32LE(12));
    if (readSync(file, data, 0, data.length, header.length) !== data.length) throw new Error("Exported GLB has incomplete JSON.");
    const json = JSON.parse(data.toString("utf8")) as { nodes?: GltfNode[] };
    return json.nodes ?? [];
  } finally { closeSync(file); }
}

function glbChecksum(path: string) {
  const file = openSync(path, "r");
  try {
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let size = 0, count = 0;
    while ((count = readSync(file, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    return { glbSha256: hash.digest("hex"), glbBytes: size };
  } finally { closeSync(file); }
}

export function writeGraphExport(directory: string, iteration: number, graph: SceneNode[], outcome: string, gaps: string[],
  source: { blend: string; render: string; kind: string; purpose: string; phase: string | null;
    revisionId?: string; contentIteration?: number } = { blend: "best.blend", render: "best.png", kind: "best", purpose: "delivery", phase: null },
  sceneDirectory = resolve(directory, "../.."), relations: SceneRelation[] = []) {
  const glb = join(directory, "final.glb");
  const nodes = readGlbNodes(glb);
  const index = new Map<string, number[]>();
  const walk = (nodeIndex: number, inherited?: string) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const id = node.extras?.scene_node_id ?? inherited;
    if (id && node.mesh !== undefined) index.set(id, [...(index.get(id) ?? []), nodeIndex]);
    for (const child of node.children ?? []) walk(child, id);
  };
  const childIndices = new Set(nodes.flatMap((node) => node.children ?? []));
  nodes.forEach((_, nodeIndex) => { if (!childIndices.has(nodeIndex)) walk(nodeIndex); });
  const known = new Set(graph.map((node) => node.id));
  if (graph.length) for (const id of index.keys()) if (!known.has(id)) throw new Error(`GLB mesh refers to unknown Scene Graph ID: ${id}`);
  const output = graph.map((node) => {
    const meshIndices = index.get(node.id) ?? [];
    if (node.kind !== "group" && node.status === "built" && !meshIndices.length) throw new Error(`Built Scene Graph node has no GLB mesh: ${node.id}`);
    return { ...node, status: meshIndices.length ? "renderable" : node.status ?? "planned", gltfNodeIndices: meshIndices };
  });
  const hasDescendantMesh = (id: string): boolean => output.some((node) =>
    node.parentId === id && (node.gltfNodeIndices.length > 0 || hasDescendantMesh(node.id)));
  for (const node of output) if (node.kind === "group") {
    if (hasDescendantMesh(node.id)) node.status = "renderable";
    else if (node.status === "built") throw new Error(`Built Scene Graph group has no GLB mesh descendants: ${node.id}`);
  }
  const { glbSha256, glbBytes } = glbChecksum(glb);
  const profilePath = join(directory, "render-profile.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
  const world = profile.world as { environmentUri?: string; backgroundEnvironmentUri?: string } | undefined;
  const panoramas = [world?.environmentUri === "environment.exr" ? "environment.exr" : null,
    world?.backgroundEnvironmentUri === "background.exr" ? "background.exr" : null].filter((name): name is string => name !== null);
  for (const name of panoramas) {
    const file = openSync(join(directory, name), "r");
    closeSync(file);
  }
  const effects = profile.effects as ExportEffects | undefined;
  const issues = effects?.issues ?? [];
  if (effects && glbBytes > maxViewerAssetBytes) issues.push({ object: "final.glb", effect: "interactive model",
    status: "missing", target: "threejs", reason: `The GLB exceeds the viewer's ${maxViewerAssetBytes / (1024 * 1024)} MiB asset limit.` });
  const webIssues = issues.filter(issue => !issue.target || issue.target === "threejs");
  const status = webIssues.some(issue => issue.status === "missing") ? "degraded" : webIssues.length ? "approximate" : "supported";
  const alignment = { status, issues } as const;
  const lightmaps = (profile.lightmaps ?? []) as { uri: string }[];
  if (lightmaps.length > 100 || lightmaps.some(map => !/^lightmap-\d+\.png$/.test(map.uri))) {
    throw new Error("Export profile contains an invalid lightmap filename.");
  }
  for (const map of lightmaps) readFileSync(join(directory, map.uri));
  const camera = profile.camera as { name?: string; projectionMatrix?: number[] } | null;
  if (!camera?.name || !nodes.some((node) => node.camera !== undefined && node.name === camera.name) ||
    camera.projectionMatrix && (camera.projectionMatrix.length !== 16 || camera.projectionMatrix.some((value) => !Number.isFinite(value)))) {
    throw new Error("Export profile camera does not match a valid GLB camera.");
  }
  for (const light of (profile.lights ?? []) as { energy?: number }[]) if (!Number.isFinite(light.energy) || light.energy! < 0) {
    throw new Error("Export profile has invalid light energy.");
  }
  const graphData = { version: 1, iteration, glbSha256, nodes: output, relations };
  writeFileSync(join(directory, "scene-graph.json"), JSON.stringify(graphData, null, 2));
  profile.iteration = iteration;
  profile.source = { kind: source.kind, purpose: source.purpose, phase: source.phase, iteration,
    ...(source.revisionId ? { revisionId: source.revisionId } : {}),
    ...(source.contentIteration !== undefined ? { contentIteration: source.contentIteration } : {}) };
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const render = relative(directory, resolve(sceneDirectory, source.render)).replaceAll("\\", "/");
  const blend = relative(directory, resolve(sceneDirectory, source.blend)).replaceAll("\\", "/");
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version: 1, iteration, outcome, remainingGaps: gaps,
    previewMode: profile.previewMode,
    source: profile.source, glbSha256, glbBytes, sourceBlendSha256: hash(resolve(directory, blend)),
    bake: profile.bake, ...(profile.effects ? { alignment } : {}),
    sourceRenderSha256: hash(resolve(directory, render)),
    ...(source.blend === "best.blend" ? { bestBlendSha256: hash(resolve(directory, blend)), bestRenderSha256: hash(resolve(directory, render)) } : {}),
    files: [...(source.blend === "best.blend" ? [blend] : []), render, "final.glb", "render-profile.json", "scene-graph.json",
      ...panoramas, ...lightmaps.map(map => map.uri)] }, null, 2));
  return profile.effects ? alignment : undefined;
}

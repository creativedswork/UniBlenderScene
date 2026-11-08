import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { open, readFile, realpath } from "node:fs/promises";
import { BlenderClient, factorGuardCode, inspectObjectCode, renderCode, sceneSummaryCode } from "./blender.js";
import { writeGraphExport } from "./graph-export.js";
import { verifyAssetStrategy, verifyGraphReview, type AssetRequirement, type AssetStrategy, type GraphReview } from "./workflow-guards.js";

export type Criterion = { id: string; description: string; severity: "blocker" | "major" | "minor" };
export type ImageBox = [number, number, number, number];
export type ReferenceAnchor = { id: string; description: string; targetBox: ImageBox };
export type Plan = {
  summary: string; criteria: Criterion[]; steps: string[]; visualThreshold: number;
  referenceAnchors?: ReferenceAnchor[];
  graph?: SceneNode[];
  assets?: AssetRequirement[];
  workflow?: { stages: { name: StageName; criterionIds: string[]; budget: number }[]; compositionApproval?: boolean };
};
export type StageName = "geometry" | "composition" | "materials" | "lighting" | "final";
export type SceneNode = { id: string; label: string; kind: "group" | "object" | "part"; parentId: string | null;
  blenderObjectNames: string[]; description: string; status?: "planned" | "built" | "hidden" | "unsupported";
  relations?: { targetId: string; description: string }[] };
export type Review = {
  inspectionId?: string;
  referenceEvidence?: { reference: string; observation: string }[];
  iteration: number;
  criteria: { id: string; passed: boolean; evidence: string }[];
  referenceAlignment?: { id: string; renderBox: ImageBox; evidence: string }[];
  alignmentMaxError?: number;
  visualScore: number;
  regressions: string[];
  repairable: boolean;
  nextAction: string;
  observations?: { criterionId: string; nodeId: string; referenceView?: string; target: string; actual: string;
    evidence: string; sceneEvidence?: string; reason?: string; correction?: string; acceptance?: string }[];
  repairs?: string[];
};
type Job = { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; error?: string };
export type Scene = {
  id: string; prompt: string; token: string; createdAt: string; updatedAt: string;
  stage: "planning" | "edit" | "review" | "awaiting_review" | "completed" | "best_effort";
  iteration: number; startIteration: number; noImprovement: number; extended: boolean;
  plan?: Plan; summary?: Record<string, unknown>; reviews: Review[]; best?: Review;
  reference?: { fileId: string; name: string; mime: string; label?: string };
  references?: StoredReference[];
  render?: string; exportedIteration?: number; previewedIteration?: number; job?: Job; error?: string;
  workflowIndex?: number; reviewViews?: string[]; reviewFeedback?: string; remainingGaps?: string[];
  graphReview?: GraphReview; assetStrategies?: AssetStrategy[];
  inspection?: { id: string; iteration: number; stage: string; summary: Record<string, unknown> };
  compositionApproved?: boolean;
  pendingIteration?: number;
};
export const REFERENCE_ASSETS = ["reference", "reference-2", "reference-3", "reference-4", "reference-5", "reference-6"] as const;
export type Reference = { download_url?: string; file_id?: string; local_path?: string; mime_type?: string; file_name?: string; label?: string };
type StoredReference = NonNullable<Scene["reference"]> & { assetName: typeof REFERENCE_ASSETS[number] };
const py = JSON.stringify;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ANCHOR_ERROR = 0.08;
const REFERENCE_REQUEST = /如图|参考图|图中|根据.{0,12}(?:图片|照片)|(?:this|attached|provided|reference)\s+(?:image|photo|picture)|(?:from|based on)\s+(?:the|this|an?|attached)\s+(?:image|photo|picture)/i;

export function requestsImageReference(prompt: string): boolean {
  return REFERENCE_REQUEST.test(prompt);
}

function validImageBox(box: ImageBox): boolean {
  return box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
    box[0] < box[2] && box[1] < box[3];
}

export function validateSceneGraph(nodes: SceneNode[]): void {
  if (!nodes.length || nodes.length > 500) throw new Error("Scene Graph needs 1-500 nodes.");
  const ids = new Set<string>(), names = new Set<string>();
  for (const node of nodes) {
    if (!node.id.trim() || ids.has(node.id)) throw new Error("Scene Graph node IDs must be unique and nonempty.");
    ids.add(node.id);
    for (const name of node.blenderObjectNames) {
      if (!name.trim() || names.has(name)) throw new Error("Scene Graph Blender object names must be unique and nonempty.");
      names.add(name);
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) throw new Error(`Unknown Scene Graph parent: ${node.parentId}`);
    for (const relation of node.relations ?? []) if (!byId.has(relation.targetId)) {
      throw new Error(`Unknown Scene Graph relation target: ${relation.targetId}`);
    }
    const seen = new Set<string>();
    let current: SceneNode | undefined = node;
    while (current) {
      if (seen.has(current.id)) throw new Error("Scene Graph contains a parent cycle.");
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
}

export function allowedDownloadURL(value: string, hosts: string[]): URL {
  const url = new URL(value);
  const allowed = hosts.some((host) => host.includes(":") ? url.host === host :
    (!url.port || url.port === "443") && (url.hostname === host || url.hostname.endsWith(`.${host}`)));
  if (url.protocol !== "https:" || url.username || url.password || !allowed) {
    throw new Error("Reference download URL must use HTTPS on an approved file host.");
  }
  return url;
}

function imageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Reference must be a PNG, JPG, or WebP image.");
}

export class SceneStore {
  readonly scenes = new Map<string, Scene>();
  // ponytail: one Blender process means one execution queue; use separate workers for throughput.
  private queue: Promise<void> = Promise.resolve();
  private recoveryRequired = false;
  readonly root: string;

  constructor(root: string, readonly blender = new BlenderClient()) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^scene_[a-f0-9-]+$/.test(entry.name)) continue;
      const scene = JSON.parse(readFileSync(resolve(this.root, entry.name, "run.json"), "utf8")) as Scene;
      this.scenes.set(scene.id, scene);
      if (scene.job && ["queued", "running"].includes(scene.job.status)) {
        scene.job.status = "failed";
        scene.job.error = scene.error = "Service restarted during an operation. Inspect the scene and retry.";
        const before = this.path(scene, "checkpoint.blend");
        if (scene.job.kind === "edit" && existsSync(before)) {
          copyFileSync(before, this.path(scene, "current.blend"));
          if (scene.pendingIteration === scene.iteration) scene.iteration--;
          delete scene.pendingIteration;
          scene.stage = "edit";
        }
        this.save(scene);
      }
      if (scene.plan && !scene.plan.assets && !["completed", "best_effort"].includes(scene.stage)) {
        scene.stage = "planning";
        scene.startIteration = scene.iteration;
        scene.noImprovement = 0;
        delete scene.best;
        scene.reviewFeedback = "Workflow upgraded: replan the saved scene with asset requirements, graph verification and mandatory composition approval.";
        this.save(scene);
      }
    }
  }

  get(id: string): Scene {
    const scene = this.scenes.get(id);
    if (!scene) throw new Error("Unknown scene ID.");
    return scene;
  }
  path(scene: Scene, file: string): string { return resolve(this.root, scene.id, file); }
  save(scene: Scene): void {
    scene.updatedAt = new Date().toISOString();
    const path = this.path(scene, "run.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(scene, null, 2));
    renameSync(`${path}.tmp`, path);
  }
  private idle(scene: Scene): void {
    if (this.recoveryRequired) throw new Error("Blender recovery failed. Restart the dedicated bridge and service before editing.");
    if (scene.job && ["queued", "running"].includes(scene.job.status)) {
      throw new Error("Scene operation is still running. Poll scene_get before continuing.");
    }
  }
  private enqueue(scene: Scene, kind: string, work: () => Promise<void>): void {
    this.idle(scene);
    const job: Job = { id: randomUUID(), kind, status: "queued" };
    scene.job = job;
    delete scene.error;
    this.save(scene);
    this.queue = this.queue.then(async () => {
      job.status = "running";
      this.save(scene);
      try {
        if (this.recoveryRequired) throw new Error("Blender recovery failed. Restart the dedicated bridge and service.");
        await work();
        job.status = "done";
      } catch (error) {
        job.status = "failed";
        job.error = scene.error = error instanceof Error ? error.message : String(error);
      }
      this.save(scene);
    });
  }
  async settled(): Promise<void> { await this.queue; }

  inspectObject(id: string, name: string): Promise<Record<string, unknown>> {
    const scene = this.get(id);
    this.idle(scene);
    const operation = this.queue.then(() => this.blender.execute(
      inspectObjectCode(this.path(scene, "current.blend"), name),
    ));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  referenceImages(scene: Scene): StoredReference[] {
    return scene.references ?? (scene.reference ? [{ ...scene.reference, assetName: "reference" }] : []);
  }

  private validateReferences(references: Reference[], existing: StoredReference[] = []): void {
    if (!references.length || existing.length + references.length > REFERENCE_ASSETS.length) {
      throw new Error("Use 1-6 reference images in total. The first image is the primary view.");
    }
    for (const image of references) {
      if (Boolean(image.local_path) === Boolean(image.download_url) || (!image.local_path && !image.file_id)) {
        throw new Error("Pass local_path, or download_url with file_id, for each reference.");
      }
    }
    const ids = [...existing.map((image) => image.fileId), ...references.map((image) => image.file_id ?? image.local_path!)];
    if (new Set(ids).size !== ids.length) throw new Error("Each reference image must have a distinct file_id.");
  }

  create(prompt: string, reference?: Reference, references?: Reference[]): Scene {
    if (reference && references) throw new Error("Pass reference or references, not both.");
    const images = references ?? (reference ? [reference] : []);
    if (reference || references) this.validateReferences(images);
    if (requestsImageReference(prompt) && !images.length) {
      throw new Error("This request refers to an image. Attach it in scene_create reference or references before creating the scene.");
    }
    const scene: Scene = {
      id: `scene_${randomUUID()}`, prompt, token: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stage: "planning", iteration: 0, startIteration: 0, noImprovement: 0, extended: false, reviews: [],
    };
    mkdirSync(this.path(scene, "renders"), { recursive: true });
    mkdirSync(this.path(scene, "artifacts"), { recursive: true });
    this.scenes.set(scene.id, scene);
    this.enqueue(scene, "create", async () => {
      if (images.length) await this.downloadReferences(scene, images);
      scene.summary = await this.blender.execute(`
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.resolution_x = 512
bpy.context.scene.render.resolution_y = 512
bpy.context.scene.render.resolution_percentage = 100
bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.samples = 32
bpy.ops.wm.save_as_mainfile(filepath=${py(this.path(scene, "current.blend"))})
${sceneSummaryCode()}`);
    });
    return scene;
  }

  private async downloadReferences(scene: Scene, references: Reference[]): Promise<void> {
    const images = [...this.referenceImages(scene)];
    this.validateReferences(references, images);
    for (const reference of references) {
      const image = await this.downloadReference(scene, reference, REFERENCE_ASSETS[images.length]!);
      if (images.some((existing) => existing.fileId === image.fileId)) throw new Error("Each reference image must be distinct.");
      images.push(image);
    }
    scene.references = images;
    const { assetName: _, ...primary } = images[0]!;
    scene.reference = primary;
  }

  private async downloadReference(scene: Scene, reference: Reference, assetName: StoredReference["assetName"]): Promise<StoredReference> {
    if (reference.local_path) {
      if (!isAbsolute(reference.local_path)) throw new Error("Reference local_path must be absolute.");
      const roots = (process.env.LOCAL_REFERENCE_ROOTS ?? "").split(delimiter).filter(Boolean);
      const path = await realpath(reference.local_path);
      const allowed = await Promise.all(roots.map(async (root) => {
        const rel = relative(await realpath(root), path);
        return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      }));
      if (!allowed.some(Boolean)) throw new Error("Local reference is outside LOCAL_REFERENCE_ROOTS. Copy the attached image into an approved input directory.");
      const handle = await open(path, "r");
      let data: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("Reference must be an image file no larger than 20 MB.");
        data = Buffer.alloc(MAX_IMAGE_BYTES + 1);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        if (bytesRead > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds 20 MB.");
        data = data.subarray(0, bytesRead);
      } finally { await handle.close(); }
      const mime = imageMime(data);
      writeFileSync(this.path(scene, assetName), data);
      return { assetName, fileId: reference.file_id ?? `local:${createHash("sha256").update(path).digest("hex")}`,
        name: reference.file_name ?? basename(path), mime, ...(reference.label ? { label: reference.label } : {}) };
    }
    const hosts = (process.env.FILE_DOWNLOAD_HOSTS ??
      "oaiusercontent.com,usercontent.openai.com").split(",").map((host) => host.trim()).filter(Boolean);
    let url = allowedDownloadURL(reference.download_url!, hosts);
    let response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Reference redirect has no destination.");
        url = allowedDownloadURL(new URL(location, url).href, hosts);
      } else break;
    }
    if (!response?.ok || !response.body) throw new Error("Reference image download failed.");
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
      await response.body.cancel();
      throw new Error("Reference image exceeds 20 MB.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds 20 MB.");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const data = Buffer.concat(chunks);
    const mime = imageMime(data);
    writeFileSync(this.path(scene, assetName), data);
    return { assetName, fileId: reference.file_id!, name: reference.file_name ?? "Reference image", mime,
      ...(reference.label ? { label: reference.label } : {}) };
  }

  plan(id: string, plan: Plan): Scene {
    const scene = this.get(id);
    this.idle(scene);
    plan = structuredClone(plan);
    if (scene.stage !== "planning") throw new Error("Plan is frozen. Use scene_continue for a new user request.");
    if (!existsSync(this.path(scene, "current.blend"))) throw new Error("Scene initialization failed; create a new scene.");
    if (plan.criteria.length < 1 || plan.criteria.length > 12 ||
      plan.steps.length < 1 || plan.steps.length > 8) {
      throw new Error("Plan needs 1-12 global criteria and 1-8 bounded steps.");
    }
    if (new Set(plan.criteria.map((item) => item.id)).size !== plan.criteria.length) {
      throw new Error("Criterion IDs must be unique.");
    }
    if (scene.reference && (!plan.referenceAnchors || plan.referenceAnchors.length < 2)) {
      throw new Error("Reference scenes need at least two image-space anchors in the plan.");
    }
    if (plan.referenceAnchors && (plan.referenceAnchors.length < 2 || plan.referenceAnchors.length > 8 ||
      new Set(plan.referenceAnchors.map((anchor) => anchor.id)).size !== plan.referenceAnchors.length ||
      plan.referenceAnchors.some((anchor) => !validImageBox(anchor.targetBox)))) {
      throw new Error("Reference anchors need unique IDs and valid normalized target boxes.");
    }
    if (plan.graph) validateSceneGraph(plan.graph);
    if (!plan.graph?.length || !plan.assets) throw new Error("Plan needs a Scene Graph and explicit asset requirements.");
    const subjects = plan.graph.filter((n) => n.kind !== "group");
    if (plan.assets.length !== subjects.length || new Set(plan.assets.map((a) => a.nodeId)).size !== subjects.length ||
        subjects.some((n) => !plan.assets!.some((a) => a.nodeId === n.id && a.reason.trim() &&
          ["object", "structure", "existing"].includes(a.kind)))) {
      throw new Error("Classify every non-group graph node as object, structure or existing with a reason.");
    }
    if (plan.assets.some((a) => a.kind === "existing") && !Number(scene.summary?.objectCount)) {
      throw new Error("An empty scene cannot declare existing assets.");
    }
    const stages = plan.workflow?.stages.map((s) => s.name) ?? [];
    if ((this.referenceImages(scene).length || stages.includes("geometry") || stages.includes("materials") || stages.includes("lighting")) && !stages.includes("composition")) {
      throw new Error("Reconstruction workflows must include composition and user approval before downstream stages.");
    }
    if (stages.includes("composition")) {
      if (plan.workflow!.compositionApproval === false) throw new Error("Composition approval cannot be disabled by the host.");
      plan.workflow!.compositionApproval = true;
    }
    if (plan.workflow) {
      if (!plan.graph) throw new Error("Staged workflow needs a Scene Graph.");
      const names = plan.workflow.stages.map((stage) => stage.name);
      const order: StageName[] = ["geometry", "composition", "materials", "lighting", "final"];
      if (!names.length || names.at(-1) !== "final" || new Set(names).size !== names.length ||
        names.some((name, index) => index > 0 && order.indexOf(name) <= order.indexOf(names[index - 1]!) ) ||
        plan.workflow.compositionApproval && !names.includes("composition")) {
        throw new Error("Workflow stages must be ordered, unique, end in final, and include composition for approval.");
      }
      for (const stage of plan.workflow.stages) {
        if (!Number.isInteger(stage.budget) || stage.budget < 1 || stage.budget > 8 ||
          !stage.criterionIds.length || new Set(stage.criterionIds).size !== stage.criterionIds.length ||
          stage.criterionIds.some((criterionId) => !plan.criteria.some((item) => item.id === criterionId))) {
          throw new Error("Each workflow stage needs a 1-8 round budget and valid unique criterion IDs.");
        }
      }
      if (names[0] === "geometry" && !plan.graph?.some((node) => node.kind !== "group")) {
        throw new Error("Geometry workflow needs a Scene Graph with object or part nodes.");
      }
    }
    scene.plan = plan;
    delete scene.graphReview;
    delete scene.inspection;
    scene.assetStrategies = [];
    scene.compositionApproved = false;
    scene.workflowIndex = plan.workflow ? 0 : undefined;
    scene.stage = "edit";
    this.save(scene);
    return scene;
  }

  reviewGraph(id: string, review: GraphReview): Scene {
    const scene = this.get(id); this.idle(scene);
    if (scene.stage !== "edit" || !scene.plan) {
      throw new Error("Review the planned graph before construction starts.");
    }
    verifyGraphReview(review, this.referenceImages(scene).map((r) => r.assetName));
    scene.graphReview = review;
    if (review.checks.some((c) => !c.passed)) scene.stage = "planning";
    this.save(scene); return scene;
  }

  recordAsset(id: string, strategy: AssetStrategy): Scene {
    const scene = this.get(id); this.idle(scene);
    if (scene.stage !== "edit" || !scene.plan) throw new Error("Record assets during the geometry edit stage.");
    const stage = scene.plan.workflow?.stages[scene.workflowIndex ?? 0]?.name;
    if (stage && stage !== "geometry") throw new Error("Asset generation belongs to geometry.");
    const requirement = scene.plan.assets?.find((a) => a.nodeId === strategy.nodeId);
    if (!requirement) throw new Error("Unknown asset requirement.");
    if (!strategy.providers.length && scene.assetStrategies?.some((s) => s.nodeId === strategy.nodeId && s.providers.length)) {
      throw new Error("A discovered Provider remains unresolved; failure or pending approval cannot become a Blender fallback.");
    }
    const record = verifyAssetStrategy(this.path(scene, "."), requirement, strategy, true);
    scene.assetStrategies = [...(scene.assetStrategies ?? []).filter((a) => a.nodeId !== strategy.nodeId), record];
    this.save(scene); return scene;
  }

  edit(id: string, code: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "edit" || !scene.plan) throw new Error("Plan and review must precede further edits.");
    if (!scene.graphReview?.checks.every((c) => c.passed)) throw new Error("A read-only Scene Graph review must pass before scene editing.");
    for (const asset of scene.plan.assets ?? []) if (asset.kind === "object") {
      const strategy = scene.assetStrategies?.find((s) => s.nodeId === asset.nodeId);
      if (!strategy) throw new Error(`Resolve provider discovery and asset strategy for ${asset.nodeId} before Blender mutation.`);
      verifyAssetStrategy(this.path(scene, "."), asset, strategy);
    }
    const activeStage = scene.plan.workflow?.stages[scene.workflowIndex ?? 0]?.name;
    if (activeStage && ["materials", "lighting", "final"].includes(activeStage) &&
        scene.plan.workflow?.stages.some((s) => s.name === "composition") && !scene.compositionApproved) {
      throw new Error("User composition approval is required before downstream edits.");
    }
    const stageBudget = scene.plan.workflow?.stages[scene.workflowIndex ?? 0]?.budget;
    if (scene.iteration - scene.startIteration >= (stageBudget ?? 8)) throw new Error("Stage edit budget reached.");
    this.enqueue(scene, "edit", async () => {
      const current = this.path(scene, "current.blend");
      const before = this.path(scene, "checkpoint.blend");
      copyFileSync(current, before);
      scene.iteration++;
      scene.pendingIteration = scene.iteration;
      delete scene.inspection;
      this.save(scene);
      const render = `renders/iteration-${scene.iteration}.png`;
      const [beforeGuard, afterGuard] = factorGuardCode(activeStage, scene.compositionApproved);
      try {
        scene.summary = await this.blender.execute(`
bpy.ops.wm.open_mainfile(filepath=${py(current)})
${beforeGuard}
${code}
${afterGuard}
_provider_assets = ${py((scene.assetStrategies ?? []).filter((a) => a.provider).map((a) => ({ node: a.nodeId, task: a.taskId, hash: a.sha256 })))}
for _asset in _provider_assets:
    _matches = []
    for _mesh in bpy.context.scene.objects:
        if _mesh.type != 'MESH' or not len(_mesh.data.vertices) or _mesh.hide_render: continue
        _owner = _mesh
        while _owner:
            if _owner.get('scene_node_id') == _asset['node'] and _owner.get('provider_task_id') == _asset['task'] and _owner.get('provider_asset_sha256') == _asset['hash']:
                _matches.append(_mesh.name); break
            _owner = _owner.parent
    if not _matches: raise RuntimeError('Import and tag the recorded provider asset before rendering: ' + _asset['node'])
bpy.ops.wm.save_as_mainfile(filepath=${py(current)})
${renderCode(this.path(scene, render))}
${sceneSummaryCode()}`);
        scene.render = render;
        scene.inspection = { id: randomUUID(), iteration: scene.iteration, stage: activeStage ?? "scene", summary: scene.summary };
        scene.stage = "review";
        delete scene.pendingIteration;
      } catch (error) {
        // Roll back on Blender's queue after any timed-out edit has actually stopped.
        try {
          await this.blender.execute(`import shutil
shutil.copyfile(${py(before)}, ${py(current)})
bpy.ops.wm.open_mainfile(filepath=${py(current)})`);
        } catch {
          copyFileSync(before, current);
          this.recoveryRequired = true;
          throw new Error("Blender recovery failed. Stop and restart the dedicated Blender bridge and service before continuing.");
        }
        scene.iteration--;
        delete scene.pendingIteration;
        scene.stage = "edit";
        throw error;
      }
    });
    return scene;
  }

  review(id: string, input: Omit<Review, "iteration" | "alignmentMaxError"> & { iteration: number }): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "review" || !scene.plan || input.iteration !== scene.iteration) {
      throw new Error("Review must evaluate the latest rendered iteration.");
    }
    const workflowStage = scene.plan.workflow?.stages[scene.workflowIndex ?? 0];
    if (!scene.inspection || input.inspectionId !== scene.inspection.id || scene.inspection.iteration !== input.iteration) {
      throw new Error("Review must bind the current runtime inspectionId from scene_get.");
    }
    const expectedIds = workflowStage?.name === "final" || !workflowStage ? scene.plan.criteria.map((item) => item.id) : workflowStage.criterionIds;
    if (input.criteria.length !== expectedIds.length ||
      new Set(input.criteria.map((criterion) => criterion.id)).size !== input.criteria.length ||
      expectedIds.some((id) => !input.criteria.some((result) => result.id === id))) {
      throw new Error("Review must cover every criterion for the current stage exactly once.");
    }
    if (input.repairs && input.repairs.length > 3) throw new Error("Review allows at most three ranked repairs.");
    if (workflowStage && (!input.observations || input.observations.length !== expectedIds.length ||
      new Set(input.observations.map((item) => item.criterionId)).size !== expectedIds.length)) {
      throw new Error("Staged review needs one structured observation per stage criterion.");
    }
    const referenceNames = this.referenceImages(scene).map((r) => r.assetName);
    if (referenceNames.length && (input.referenceEvidence?.length !== referenceNames.length ||
        new Set(input.referenceEvidence?.map((r) => r.reference)).size !== referenceNames.length ||
        referenceNames.some((name) => !input.referenceEvidence?.some((r) => r.reference === name && r.observation.trim())))) {
      throw new Error("Review needs spatial evidence for every supplied reference, including auxiliary views.");
    }
    if (input.observations) for (const observation of input.observations) {
      if (!expectedIds.includes(observation.criterionId) ||
        !scene.plan.graph?.some((node) => node.id === observation.nodeId)) {
        throw new Error("Review observation must reference a current criterion and Scene Graph node.");
      }
      if (!observation.sceneEvidence?.trim()) throw new Error("Each staged criterion needs sceneEvidence from the runtime inspection or an explicit limitation.");
      const references = this.referenceImages(scene).map((r) => r.assetName);
      if (references.length && (!observation.referenceView || !references.includes(observation.referenceView as typeof REFERENCE_ASSETS[number]))) {
        throw new Error("referenceView must name a supplied reference asset.");
      }
      if (!input.criteria.find((item) => item.id === observation.criterionId)?.passed &&
        (!observation.reason || !observation.correction || !observation.acceptance)) {
        throw new Error("Failed staged criteria need reason, correction, and a rerender acceptance check.");
      }
    }
    const anchors = !workflowStage || ["composition", "final"].includes(workflowStage.name) ?
      scene.plan.referenceAnchors : undefined;
    if (anchors) {
      const alignment = input.referenceAlignment;
      if (!alignment || alignment.length !== anchors.length ||
        new Set(alignment.map((item) => item.id)).size !== alignment.length ||
        anchors.some((anchor) => !alignment.some((item) => item.id === anchor.id)) ||
        alignment.some((item) => !validImageBox(item.renderBox))) {
        throw new Error("Review must measure every reference anchor with a valid normalized render box.");
      }
    } else if (input.referenceAlignment?.length) {
      throw new Error("Reference alignment was not frozen in the plan.");
    }
    const alignmentMaxError = anchors ? Math.max(...anchors.flatMap((anchor) => {
      const render = input.referenceAlignment!.find((item) => item.id === anchor.id)!.renderBox;
      return anchor.targetBox.map((value, index) => Math.abs(value - render[index]!));
    })) : 0;
    const reviewed: Review = { ...input, ...(anchors ? { alignmentMaxError } : {}) };
    const quality = (review: Review): number[] => [
      -(Number((review.alignmentMaxError ?? 0) > MAX_ANCHOR_ERROR)),
      ...(["blocker", "major"] as const).map((severity) => -scene.plan!.criteria.filter((criterion) =>
        expectedIds.includes(criterion.id) &&
        criterion.severity === severity && !review.criteria.find((item) => item.id === criterion.id)!.passed).length),
      -review.regressions.length, -(review.alignmentMaxError ?? 0), review.visualScore,
    ];
    const better = !scene.best || (() => {
      const a = quality(reviewed), b = quality(scene.best!);
      for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return a[index]! > b[index]!;
      }
      return false;
    })();
    scene.reviews.push(reviewed);
    if (better) {
      scene.best = reviewed;
      scene.noImprovement = 0;
      copyFileSync(this.path(scene, "current.blend"), this.path(scene, "best.blend"));
      copyFileSync(this.path(scene, scene.render!), this.path(scene, "best.png"));
    } else scene.noImprovement++;
    const accepted = alignmentMaxError <= MAX_ANCHOR_ERROR &&
      input.criteria.every((criterion) => criterion.passed) &&
      input.regressions.length === 0 && input.visualScore >= scene.plan.visualThreshold;
    const attempts = scene.iteration - scene.startIteration;
    if (!workflowStage && attempts === 5 && better && input.repairable) scene.extended = true;
    const stop = scene.noImprovement >= 2 || attempts >= (workflowStage?.budget ?? 8) ||
      (!workflowStage && attempts >= 5 && !scene.extended);
    if (workflowStage && (accepted || stop) && workflowStage.name !== "final") {
      copyFileSync(this.path(scene, "best.blend"), this.path(scene, "current.blend"));
      if (workflowStage.name === "composition" && scene.plan.workflow?.compositionApproval) {
        scene.remainingGaps = scene.best!.criteria.filter((c) => !c.passed).map((c) => c.id);
        if ((scene.best!.alignmentMaxError ?? 0) > MAX_ANCHOR_ERROR) scene.remainingGaps.push("reference_alignment");
        scene.stage = "awaiting_review";
        this.enqueueReviewViews(scene);
      } else this.advanceWorkflow(scene);
    } else {
      scene.stage = accepted ? "completed" : stop ? "best_effort" : "edit";
      if (accepted || stop) copyFileSync(this.path(scene, "best.blend"), this.path(scene, "current.blend"));
      if (accepted) delete scene.remainingGaps;
      if (stop && !accepted) scene.remainingGaps = scene.best!.criteria.filter((item) => !item.passed).map((item) => item.id);
    }
    this.save(scene);
    return scene;
  }

  private advanceWorkflow(scene: Scene, targetIndex = (scene.workflowIndex ?? 0) + 1): void {
    scene.workflowIndex = targetIndex;
    scene.startIteration = scene.iteration;
    scene.noImprovement = 0;
    scene.extended = false;
    delete scene.best;
    delete scene.previewedIteration;
    delete scene.reviewFeedback;
    scene.stage = "edit";
  }

  updateGraph(id: string, graph: SceneNode[]): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (!["edit", "review"].includes(scene.stage) || !scene.plan?.graph) {
      throw new Error("Scene Graph can be updated only during an edit or review stage.");
    }
    validateSceneGraph(graph);
    const oldIds = scene.plan.graph.map((node) => node.id).sort();
    if (JSON.stringify(oldIds) !== JSON.stringify(graph.map((node) => node.id).sort())) {
      throw new Error("Scene Graph node IDs are frozen for this request.");
    }
    const semantics = (nodes: SceneNode[]) => JSON.stringify(nodes.map(({ id, kind, parentId, description, relations }) => ({ id, kind, parentId, description, relations })));
    if (semantics(scene.plan.graph) !== semantics(graph)) {
      if (scene.compositionApproved) throw new Error("Return to geometry or composition before changing approved spatial relationships.");
      if (scene.stage !== "edit") throw new Error("Review the current render before revising graph relationships.");
      delete scene.graphReview;
    }
    scene.plan.graph = graph;
    this.save(scene);
    return scene;
  }

  private enqueueReviewViews(scene: Scene): void {
    const views = ["review-main.png", "review-front.png", "review-side.png", "review-top.png", "review-perspective.png"];
    scene.reviewViews = views;
    for (const view of views) if (existsSync(this.path(scene, view))) unlinkSync(this.path(scene, view));
    const source = this.path(scene, "best.blend");
    const paths = views.map((name) => this.path(scene, name));
    this.enqueue(scene, "review_views", async () => {
      await this.blender.execute(`
import math
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=${py(source)})
scene = bpy.context.scene
meshes = [obj for obj in scene.objects if obj.type == "MESH" and not obj.hide_render]
focus = [obj for obj in meshes if not (any(word in obj.name.lower() for word in ('ground','floor','backdrop','background','wall','ceiling')) and min(obj.dimensions) <= max(obj.dimensions)*0.08)] or meshes
points = [obj.matrix_world @ Vector(corner) for obj in focus for corner in obj.bound_box]
center = (Vector(tuple(min(p[i] for p in points) for i in range(3))) + Vector(tuple(max(p[i] for p in points) for i in range(3)))) / 2 if points else Vector((0, 0, 0))
radius = max((point - center).length for point in points) if points else 2.0
radius = max(radius, 0.5)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'SINGLE'
scene.display.shading.single_color = (0.7, 0.7, 0.7)
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scale = 512 / max(scene.render.resolution_x, scene.render.resolution_y)
scene.render.resolution_x = max(1, round(scene.render.resolution_x * scale))
scene.render.resolution_y = max(1, round(scene.render.resolution_y * scale))
scene.render.filepath = ${py(paths[0])}
bpy.ops.render.render(write_still=True)
# Auxiliary structural views cut away the room envelope so an exterior camera
# cannot inspect only an opaque wall or ceiling. The main camera above retains it.
for obj in meshes:
    if any(word in obj.name.lower() for word in ('wall','ceiling','backdrop','background')) or ('window' in obj.name.lower() and 'glass' in obj.name.lower()): obj.hide_render = True
scene.render.resolution_x = 512
scene.render.resolution_y = 512
camera_data = bpy.data.cameras.new("Review camera")
camera = bpy.data.objects.new("Review camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
for direction, path in zip(((0,-1,0), (-1,0,0), (0,0,1), (1,-1,0.7)), ${py(paths.slice(1))}):
    vector = Vector(direction).normalized()
    camera.location = center + vector * radius * 3.2
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO" if direction != (1,-1,0.7) else "PERSP"
    camera_data.ortho_scale = radius * 2.8
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
result = {"reviewViews": 5}
`);
    });
  }

  reviewDecision(id: string, approved: boolean, feedback?: string, returnTo?: "geometry" | "composition"): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "awaiting_review" || !scene.plan?.workflow?.compositionApproval) {
      throw new Error("Scene is not awaiting composition approval.");
    }
    if (scene.job?.kind === "review_views" && scene.job.status !== "done" ||
      !scene.reviewViews?.every((view) => existsSync(this.path(scene, view)))) {
      throw new Error("Composition review views are not ready. Retry view generation first.");
    }
    if (approved) { scene.compositionApproved = true; this.advanceWorkflow(scene); }
    else {
      scene.compositionApproved = false;
      if (!feedback?.trim()) throw new Error("Describe the requested geometry or composition change.");
      const index = scene.plan.workflow.stages.findIndex((stage) => stage.name === (returnTo ?? "composition"));
      if (index < 0 || index > (scene.workflowIndex ?? 0)) throw new Error("Requested return stage is unavailable.");
      this.advanceWorkflow(scene, index);
      scene.reviewFeedback = feedback;
    }
    this.save(scene);
    return scene;
  }

  retryReviewViews(id: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "awaiting_review") throw new Error("Scene is not awaiting composition review.");
    this.enqueueReviewViews(scene);
    return scene;
  }

  continue(id: string, prompt: string, references?: Reference[]): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (!["completed", "best_effort"].includes(scene.stage)) throw new Error("Finish the current request before continuing.");
    const begin = () => {
      scene.prompt = prompt;
      scene.stage = "planning";
      scene.startIteration = scene.iteration;
      scene.noImprovement = 0;
      scene.extended = false;
      delete scene.plan;
      delete scene.graphReview;
      delete scene.assetStrategies;
      delete scene.inspection;
      delete scene.compositionApproved;
      delete scene.best;
      delete scene.workflowIndex;
      delete scene.reviewViews;
      delete scene.remainingGaps;
      delete scene.exportedIteration;
      delete scene.previewedIteration;
      delete scene.error;
      this.save(scene);
    };
    if (references) {
      this.validateReferences(references, this.referenceImages(scene));
      this.enqueue(scene, "references", async () => {
        await this.downloadReferences(scene, references);
        begin();
      });
    } else begin();
    return scene;
  }

  export(id: string, preview = false): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (!scene.best || (preview ? scene.stage !== "awaiting_review" : !["completed", "best_effort"].includes(scene.stage))) {
      throw new Error(preview ? "A composition checkpoint is required for a review preview." : "Complete scene review before exporting the best version.");
    }
    const marker = preview ? "previewedIteration" : "exportedIteration";
    if (scene[marker] === scene.best.iteration && scene.job?.status !== "failed") return scene;
    const iteration = scene.best.iteration;
    const directory = this.path(scene, `${preview ? "previews" : "artifacts"}/${iteration}`);
    mkdirSync(directory, { recursive: true });
    this.enqueue(scene, preview ? "preview" : "export", async () => {
      const template = await readFile(new URL("../blender/export.py", import.meta.url), "utf8");
      const code = template.replace("__SOURCE_BLEND__", py(this.path(scene, "best.blend")))
        .replace("__OUTPUT_DIRECTORY__", py(directory));
      await this.blender.execute(code);
      writeGraphExport(directory, iteration, scene.plan?.graph ?? [], scene.stage, scene.remainingGaps ?? []);
      scene[marker] = iteration;
    });
    return scene;
  }

  allowedFiles(scene: Scene): string[] {
    const files = [...this.referenceImages(scene).map((reference) => reference.assetName), scene.render,
      ...(scene.stage === "awaiting_review" ? scene.reviewViews ?? [] : []),
      scene.best && "best.blend", scene.best && "best.png"];
    const directory = scene.exportedIteration !== undefined && scene.exportedIteration === scene.best?.iteration ?
      `artifacts/${scene.exportedIteration}` : scene.stage === "awaiting_review" && scene.previewedIteration !== undefined &&
      scene.previewedIteration === scene.best?.iteration ? `previews/${scene.previewedIteration}` : undefined;
    if (directory) {
      for (const name of ["final.glb", "render-profile.json", "environment.exr", "scene-graph.json", "manifest.json"]) {
        const file = `${directory}/${name}`;
        if (existsSync(this.path(scene, file))) files.push(file);
      }
    }
    return files.filter((item): item is string => Boolean(item));
  }

  snapshot(scene: Scene, origin: string): Record<string, unknown> {
    const { token, reference: _, references: __, ...publicScene } = scene;
    const url = (file: string) => `${origin}/artifacts/${scene.id}/${file}?token=${token}`;
    const references = this.referenceImages(scene).map((image, index) => ({ ...image,
      role: index === 0 ? "primary" : "auxiliary", url: url(image.assetName), localPath: this.path(scene, image.assetName) }));
    return {
      ...publicScene,
      reference: references[0] ?? null,
      references,
      renderUrl: scene.render ? url(scene.render) : null,
      bestRenderUrl: scene.best ? url("best.png") : null,
      artifacts: this.allowedFiles(scene).filter((file) => ![...references.map((image) => image.assetName), scene.render].includes(file))
        .map((file) => ({ name: file.split("/").at(-1), url: url(file) })),
    };
  }
}

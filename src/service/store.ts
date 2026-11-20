import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { open, readFile, realpath } from "node:fs/promises";
import { BlenderClient, factorGuardCode, inspectObjectCode, referenceCamerasCode, referenceRendersCode, renderCode, sceneSummaryCode, structuralShadingCode } from "./blender.js";
import { appearancePreviewCode, comparisonFrameCode, tweakCode, type AppearanceCandidate } from "./appearance.js";
import { writeGraphExport } from "./graph-export.js";
import { checkRelations, relationsForScope, validateRelations, verifyRelationReviews, type SceneRelation, type RelationCheck, type RelationReview, type SpatialScore } from "./relations.js";
import { builtinSpatialSource, spatialEvaluationCode, spatialOptimizeCode, type SpatialLibrary, type SpatialRequest, type LayoutSearch } from "./spatial.js";
import { verifyAssetStrategy, verifyGraphReview, type AssetRequirement, type AssetStrategy, type GraphReview } from "./workflow-guards.js";
import { ExperienceLibrary, fileHash, type RetrospectiveInput, type Replay, type FixtureResult } from "./experience.js";
import { renderThreeRT, threeRTCapability } from "./threert.js";
import { ThreeRTLive } from "./threert-live.js";
import { lightingBakeRequests, prepareBake, type BakeResult, type LightingBake } from "./postprocess.js";

export type Criterion = { id: string; description: string; severity: "blocker" | "major" | "minor" };
export type ImageBox = [number, number, number, number];
export type ReferenceAnchor = { id: string; description: string; targetBox: ImageBox };
export type Plan = {
  summary: string; criteria: Criterion[]; steps: string[]; visualThreshold: number;
  referenceAnchors?: ReferenceAnchor[];
  graph?: SceneNode[];
  relations?: SceneRelation[];
  assets?: AssetRequirement[];
  workflow?: { stages: { name: StageName; criterionIds: string[]; budget: number }[]; compositionApproval?: boolean };
};
export type StageName = "geometry" | "composition" | "materials" | "lighting" | "final";
export type Presentation = {
  mode: "structural" | "appearance"; purpose: "work" | "confirmation" | "delivery";
  source: "current" | "checkpoint" | "best"; iteration: number;
  contentIteration?: number; revisionId?: string;
};
export type RevisionRequest = {
  targetPhase: "geometry" | "composition"; additionalBudget: number; feedback: string; scopeNodeIds: string[];
  expectedIteration: number; expectedPhase: StageName; expectedStatus: "edit" | "awaiting_review";
  expectedUpdatedAt: string; requestId: string;
};
type StageAllowance = { budget: number; spent: number | null; source: "tracked" | "legacy-window" | "unknown"; openedAtIteration?: number };
export type Revision = {
  id: string; requestId: string; request: RevisionRequest; createdAt: string;
  openedAtIteration: number; additionalBudget: number; spent: number;
  status: "active" | "closed"; baselineContentIteration: number;
  archive: string; checkpointHashes: Record<string, string>;
  prior: { phase: StageName; status: Scene["stage"]; startIteration: number; noImprovement: number; best?: Review;
    allowances: Partial<Record<StageName, StageAllowance>> };
  bestIteration?: number; remainingGaps?: string[];
};
export type SceneNode = { id: string; label: string; kind: "group" | "object" | "part"; parentId: string | null;
  blenderObjectNames: string[]; description: string; status?: "planned" | "built" | "hidden" | "unsupported";
  relations?: { targetId: string; description: string }[] };
export type Review = {
  relationReviews?: RelationReview[];
  spatialReport?: string;
  inspectionId?: string; phase?: StageName; revisionId?: string;
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
type AppearanceSearch = {
  id: string; phase: "materials" | "lighting"; iteration: number; sourceHash: string;
  candidates: { id: string; label: string; mode: "baseline" | AppearanceCandidate["mode"]; error?: string }[];
};
export type PreviewAppearance = {
  renderMode?: "pathtracing" | "raster";
  planarReflection?: string;
  reflectionProbe?: [number, number, number];
  exposureEV?: number; saturation?: number; whiteBalance?: number[]; contrast?: number; hazeScale?: number;
  dust?: { color: number[]; wind: number[]; volumes: { center: number[]; radius: number[]; density: number }[] };
};
export type Scene = {
  id: string; prompt: string; token: string; createdAt: string; updatedAt: string;
  stage: "planning" | "edit" | "review" | "awaiting_review" | "completed" | "best_effort";
  iteration: number; startIteration: number; noImprovement: number; extended: boolean;
  plan?: Plan; summary?: Record<string, unknown>; reviews: Review[]; best?: Review;
  reference?: { fileId: string; name: string; mime: string; label?: string };
  references?: StoredReference[];
  orderedReferenceCameras?: true; bestReferenceRender?: string;
  render?: string; exportedIteration?: number; previewedIteration?: number; job?: Job; error?: string;
  exportAlignment?: ReturnType<typeof writeGraphExport>;
  workflowIndex?: number; reviewViews?: string[]; reviewFeedback?: string; remainingGaps?: string[];
  graphReview?: GraphReview; assetStrategies?: AssetStrategy[];
  spatialLibrary?: SpatialLibrary;
  inspection?: { id: string; iteration: number; stage: string; summary: Record<string, unknown>; spatialReport?: string };
  compositionApproved?: boolean;
  pendingIteration?: number;
  renderMode?: Presentation["mode"]; bestRenderMode?: Presentation["mode"];
  reviewEvidence?: Pick<Presentation, "source" | "iteration" | "contentIteration" | "revisionId"> & { phase?: StageName | null };
  currentContentIteration?: number; bestContentIteration?: number;
  stageAllowances?: Partial<Record<StageName, StageAllowance>>;
  revisions?: Revision[]; activeRevisionId?: string; confirmationRevisionId?: string;
  compositionRevalidation?: boolean;
  assetStrategyHistory?: { revisionId?: string; strategy: AssetStrategy }[];
  pendingAttempt?: { revisionId?: string; phase?: StageName; previousContentIteration: number };
  appearanceSearch?: AppearanceSearch;
  exportLighting?: LightingBake[];
  bake?: BakeResult & { iteration: number };
  exportVersion?: string;
  exportPipelineHash?: string;
  exportAppearance?: PreviewAppearance;
  threeRTRender?: { status: "queued" | "running" | "done" | "failed"; iteration: number; exportVersion: string;
    directory: string; error?: string; warnings?: string[] };
  skillValidation?: { candidateId: string; validationId: string; passed: boolean };
};
export const REFERENCE_ASSETS = ["reference", "reference-2", "reference-3", "reference-4", "reference-5", "reference-6"] as const;
export type Reference = { download_url?: string; file_id?: string; local_path?: string; mime_type?: string; file_name?: string; label?: string; attachmentNumber?: number };
type ReferenceCamera = { reference: typeof REFERENCE_ASSETS[number]; cameraName: string };
type StoredReference = NonNullable<Scene["reference"]> & { assetName: typeof REFERENCE_ASSETS[number] };
const py = JSON.stringify;
function exportTemplate() {
  const template = readFileSync(new URL("../../runtime/blender/export.py", import.meta.url), "utf8");
  const vfx = readFileSync(new URL("../../runtime/blender/vfx.py", import.meta.url), "utf8");
  return template.replace("__VFX_EXPORT_SOURCE__", () => vfx);
}
const cameraRenderFile = (render: string, reference: ReferenceCamera["reference"]) => render.replace(/\.png$/, `-${reference}.png`);
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
  readonly live = new ThreeRTLive();
  // ponytail: one Blender process means one execution queue; use separate workers for throughput.
  private queue: Promise<void> = Promise.resolve();
  private recoveryRequired = false;
  readonly root: string;
  readonly library: ExperienceLibrary;

  constructor(root: string, readonly blender = new BlenderClient()) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.library = new ExperienceLibrary(this.root);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^scene_[a-f0-9-]+$/.test(entry.name)) continue;
      const scene = JSON.parse(readFileSync(resolve(this.root, entry.name, "run.json"), "utf8")) as Scene;
      this.scenes.set(scene.id, scene);
      if (scene.job && ["queued", "running"].includes(scene.job.status)) {
        scene.job.status = "failed";
        scene.job.error = scene.error = "Service restarted during an operation. Inspect the scene and retry.";
        if (scene.threeRTRender && ["queued", "running"].includes(scene.threeRTRender.status)) {
          scene.threeRTRender.status = "failed";
          scene.threeRTRender.error = scene.error;
        }
        const before = this.path(scene, "checkpoint.blend");
        if (scene.job.kind === "edit" && existsSync(before)) {
          copyFileSync(before, this.path(scene, "current.blend"));
          if (scene.pendingIteration === scene.iteration) scene.iteration--;
          if (scene.pendingAttempt) scene.currentContentIteration = scene.pendingAttempt.previousContentIteration;
          delete scene.pendingIteration;
          delete scene.pendingAttempt;
          delete scene.inspection;
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
  workflowState(scene: Scene): { phase: StageName | null; status: Scene["stage"]; compositionApproved: boolean; presentation: Presentation } {
    const phase = scene.plan?.workflow?.stages[scene.workflowIndex ?? 0]?.name ?? (scene.plan ? "final" : null);
    const pending = scene.stage === "awaiting_review", finished = ["completed", "best_effort"].includes(scene.stage);
    return {
      phase, status: scene.stage, compositionApproved: scene.compositionApproved === true,
      presentation: {
        mode: pending || phase === "geometry" || phase === "composition" ? "structural" : "appearance",
        purpose: pending ? "confirmation" : finished ? "delivery" : "work",
        source: pending ? "checkpoint" : finished ? "best" : "current",
        iteration: pending || finished ? scene.best?.iteration ?? scene.iteration : scene.iteration,
        ...(scene.currentContentIteration !== undefined ? { contentIteration: pending || finished ?
          scene.bestContentIteration ?? scene.best?.iteration ?? scene.currentContentIteration : scene.currentContentIteration } : {}),
        ...(scene.activeRevisionId || scene.confirmationRevisionId ? { revisionId: scene.activeRevisionId ?? scene.confirmationRevisionId } : {}),
      },
    };
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
      throw new Error("Scene operation is still running. Poll scene_get with images='none' before continuing.");
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

  private activeRevision(scene: Scene): Revision | undefined {
    return scene.revisions?.find((revision) => revision.id === scene.activeRevisionId && revision.status === "active");
  }

  private observedAllowances(scene: Scene): Partial<Record<StageName, StageAllowance>> {
    if (scene.stageAllowances) return structuredClone(scene.stageAllowances);
    const result: Partial<Record<StageName, StageAllowance>> = {};
    for (const [index, stage] of (scene.plan?.workflow?.stages ?? []).entries()) {
      // Old histories do not record phase boundaries; never infer earlier spend from criterion names.
      result[stage.name] = index === (scene.workflowIndex ?? 0) ? {
        budget: stage.budget, spent: Math.max(0, scene.iteration - scene.startIteration),
        source: "legacy-window", openedAtIteration: scene.startIteration,
      } : { budget: stage.budget, spent: null, source: "unknown" };
    }
    return result;
  }

  private attemptLimit(scene: Scene): { spent: number; limit: number } {
    const revision = this.activeRevision(scene);
    if (revision) return { spent: revision.spent, limit: revision.additionalBudget };
    if (scene.compositionRevalidation) return { spent: 0, limit: 0 };
    const phase = this.workflowState(scene).phase;
    if (scene.plan?.workflow && phase) {
      const allowance = scene.stageAllowances?.[phase];
      if (allowance) return { spent: allowance.spent ?? allowance.budget, limit: allowance.budget };
    }
    return { spent: scene.iteration - scene.startIteration,
      limit: scene.plan?.workflow?.stages[scene.workflowIndex ?? 0]?.budget ?? 8 };
  }

  private contentIteration(scene: Scene): number {
    if (scene.currentContentIteration !== undefined) return scene.currentContentIteration;
    const file = this.path(scene, "current.blend");
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    // Match a recorded source hash, not a filename or a stale inspection after best restoration.
    let matchedIteration: number | undefined;
    for (const directory of ["previews", "artifacts"]) {
      const path = this.path(scene, directory);
      if (!existsSync(path)) continue;
      for (const entry of readdirSync(path).sort().reverse()) {
        try {
          const manifest = JSON.parse(readFileSync(resolve(path, entry, "manifest.json"), "utf8"));
          if (manifest.sourceBlendSha256 === hash && Number.isSafeInteger(manifest.source?.contentIteration ?? manifest.iteration)) {
            const candidate = manifest.source?.contentIteration ?? manifest.iteration;
            matchedIteration = matchedIteration === undefined ? candidate : Math.min(matchedIteration, candidate);
          }
        } catch { /* An incomplete export is not content-version evidence. */ }
      }
    }
    return matchedIteration ?? scene.iteration;
  }

  private invalidateEvidence(scene: Scene): void {
    delete scene.inspection; delete scene.render; delete scene.renderMode;
    delete scene.reviewEvidence; delete scene.previewedIteration; delete scene.exportedIteration;
    delete scene.reviewViews;
  }

  revise(id: string, request: RevisionRequest): Scene {
    const scene = this.get(id);
    const priorRequest = scene.revisions?.find((revision) => revision.requestId === request.requestId);
    if (priorRequest) {
      if (JSON.stringify(priorRequest.request) !== JSON.stringify(request)) throw new Error("Revision requestId was already used with different parameters.");
      return scene;
    }
    this.idle(scene);
    const state = this.workflowState(scene);
    if (!scene.plan?.workflow || !scene.graphReview?.checks.every((check) => check.passed) ||
      !["geometry", "composition"].includes(state.phase ?? "") || !["edit", "awaiting_review"].includes(scene.stage)) {
      throw new Error("Revision requires idle, reviewed geometry/composition work or a structural confirmation checkpoint.");
    }
    if (this.activeRevision(scene)) throw new Error("Close the current revision before granting another finite allowance.");
    if (request.expectedIteration !== scene.iteration || request.expectedPhase !== state.phase ||
      request.expectedStatus !== scene.stage || request.expectedUpdatedAt !== scene.updatedAt) {
      throw new Error("Scene changed since revision authorization. Read scene_get with images='none' and authorize the current state.");
    }
    if (!Number.isSafeInteger(request.additionalBudget) || request.additionalBudget < 1 || request.additionalBudget > 8 ||
      !request.feedback.trim() || request.feedback.length > 4000 || !request.requestId.trim() || request.requestId.length > 100) {
      throw new Error("Revision needs feedback, a requestId and an explicit 1-8 additional round budget.");
    }
    const targetIndex = scene.plan.workflow.stages.findIndex((stage) => stage.name === request.targetPhase);
    if (targetIndex < 0 || targetIndex > (scene.workflowIndex ?? 0) || !["geometry", "composition"].includes(request.targetPhase)) {
      throw new Error("Requested revision phase is unavailable.");
    }
    const nodes = scene.plan.graph ?? [];
    if (!request.scopeNodeIds.length || new Set(request.scopeNodeIds).size !== request.scopeNodeIds.length ||
      request.scopeNodeIds.some((id) => !nodes.some((node) => node.id === id && node.kind !== "group"))) {
      throw new Error("Revision scope must name distinct existing non-group graph nodes.");
    }
    const allowances = this.observedAllowances(scene);
    const originalContent = this.contentIteration(scene);
    const revisionId = randomUUID(), archive = `revisions/${revisionId}`;
    mkdirSync(this.path(scene, "revisions"), { recursive: true });
    mkdirSync(this.path(scene, archive));
    const checkpointHashes: Record<string, string> = {};
    const previous = structuredClone(scene);
    // Snapshot the previous state and mutable operational aliases before any stage transition.
    writeFileSync(this.path(scene, `${archive}/state.json`), JSON.stringify(previous, null, 2), { flag: "wx" });
    for (const file of [...new Set(["current.blend", "checkpoint.blend", "best.blend", "current.blend1", "best.png",
      scene.render, ...(scene.reviewViews ?? [])].filter((file): file is string => Boolean(file)))]) {
      if (!existsSync(this.path(scene, file))) continue;
      const destination = `${archive}/${file}`;
      mkdirSync(resolve(this.path(scene, destination), ".."), { recursive: true });
      copyFileSync(this.path(scene, file), this.path(scene, destination));
      checkpointHashes[file] = createHash("sha256").update(readFileSync(this.path(scene, destination))).digest("hex");
    }
    if (!checkpointHashes["current.blend"]) throw new Error("Revision baseline is unavailable.");
    // Retain a same-phase baseline best so a degraded first repair cannot replace a better source.
    const targetStage = scene.plan.workflow.stages[targetIndex]!;
    const baselineReview = [...scene.reviews].reverse().find((review) => review.iteration === originalContent &&
      (review.phase === request.targetPhase || !review.phase && targetStage.criterionIds.length === review.criteria.length &&
        targetStage.criterionIds.every((id) => review.criteria.some((criterion) => criterion.id === id))));
    const baselineRender = this.path(scene, `renders/iteration-${originalContent}.png`);
    const revision: Revision = { id: revisionId, requestId: request.requestId, request: structuredClone(request),
      createdAt: new Date().toISOString(), openedAtIteration: scene.iteration,
      additionalBudget: request.additionalBudget, spent: 0, status: "active", baselineContentIteration: originalContent,
      archive, checkpointHashes, prior: { phase: state.phase!, status: scene.stage, startIteration: scene.startIteration,
        noImprovement: scene.noImprovement, ...(scene.best ? { best: structuredClone(scene.best) } : {}), allowances } };
    scene.revisions = [...(scene.revisions ?? []), revision];
    scene.stageAllowances = allowances;
    scene.activeRevisionId = revisionId;
    scene.currentContentIteration = originalContent;
    scene.workflowIndex = targetIndex;
    scene.compositionApproved = false;
    scene.noImprovement = 0;
    scene.extended = false;
    scene.reviewFeedback = request.feedback;
    delete scene.best; delete scene.bestRenderMode; delete scene.bestContentIteration;
    if (baselineReview && existsSync(baselineRender)) {
      copyFileSync(this.path(scene, "current.blend"), this.path(scene, "best.blend"));
      copyFileSync(baselineRender, this.path(scene, "best.png"));
      scene.best = structuredClone(baselineReview);
      scene.bestContentIteration = originalContent;
      scene.bestRenderMode = "structural";
    }
    delete scene.compositionRevalidation; delete scene.confirmationRevisionId;
    this.invalidateEvidence(scene);
    scene.stage = "edit";
    try { this.save(scene); } catch (error) {
      for (const alias of ["best.blend", "best.png"]) {
        const archived = this.path(scene, `${archive}/${alias}`);
        if (existsSync(archived)) copyFileSync(archived, this.path(scene, alias));
      }
      for (const key of Object.keys(scene)) delete (scene as unknown as Record<string, unknown>)[key];
      Object.assign(scene, previous);
      throw error;
    }
    return scene;
  }

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

  referenceCameras(scene: Scene): ReferenceCamera[] {
    const references = this.referenceImages(scene);
    return scene.orderedReferenceCameras && references.length > 1 ? references.map((image, index) => ({
      reference: image.assetName, cameraName: `Reference Camera ${index + 1}`,
    })) : [];
  }

  referenceCameraFiles(scene: Scene): { reference: ReferenceCamera["reference"]; file: string }[] {
    const target = this.workflowState(scene).presentation;
    const captures = target.source === "current" ?
      (scene.render && scene.renderMode === target.mode && (scene.compositionRevalidation || scene.render === `renders/iteration-${target.iteration}.png`) ? scene.render : undefined) :
      (scene.best && scene.bestRenderMode === target.mode ? scene.bestReferenceRender : undefined);
    if (!captures) return [];
    return this.referenceCameras(scene).flatMap(({ reference }, index) => {
      const file = index === 0 ? this.renderFile(scene) : cameraRenderFile(captures, reference);
      return file && existsSync(this.path(scene, file)) ? [{ reference, file }] : [];
    });
  }

  private referenceRenderCode(scene: Scene, render: string): string {
    return referenceRendersCode(this.referenceCameras(scene).slice(1).map(({ reference, cameraName }) => ({
      cameraName, image: this.path(scene, reference), output: this.path(scene, cameraRenderFile(render, reference)),
    })));
  }

  private validateReferences(references: Reference[], existing: StoredReference[] = []): Reference[] {
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
    if (!references.some(image => image.attachmentNumber !== undefined)) return references;
    const numbers = references.map(image => image.attachmentNumber);
    if (new Set(numbers).size !== references.length || references.some(({ attachmentNumber: n }) =>
      n === undefined || !Number.isInteger(n) || n < 1 || n > references.length)) {
      throw new Error("Supply distinct original attachment numbers from 1 through the size of this batch for every image.");
    }
    return [...references].sort((a, b) => a.attachmentNumber! - b.attachmentNumber!);
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
      stage: "planning", iteration: 0, startIteration: 0, noImprovement: 0, extended: false, reviews: [], orderedReferenceCameras: true,
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
    for (const reference of this.validateReferences(references, images)) {
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
    validateRelations(plan.graph, plan.criteria, plan.relations ?? []);
    const bindings: SpatialLibrary["bindings"] = [];
    for (const relation of plan.relations ?? []) {
      const candidate = relation.scorer ? this.library.spatialCandidate(relation.scorer.id, relation.scorer.hash, true) :
        relation.type !== "semantic" ? this.library.activeSpatial(`spatial-${relation.type}`) : undefined;
      if (candidate) bindings.push({ relationId: relation.id, id: candidate.id, hash: candidate.hash });
    }
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
    scene.spatialLibrary = { builtin: builtinSpatialSource(), bindings };
    delete scene.previewedIteration;
    delete scene.reviewEvidence;
    delete scene.graphReview;
    delete scene.inspection;
    scene.assetStrategies = [];
    scene.compositionApproved = false;
    scene.workflowIndex = plan.workflow ? 0 : undefined;
    scene.stageAllowances = plan.workflow ? Object.fromEntries(plan.workflow.stages.map((stage) =>
      [stage.name, { budget: stage.budget, spent: 0, source: "tracked" }])) : undefined;
    delete scene.revisions; delete scene.activeRevisionId; delete scene.confirmationRevisionId;
    delete scene.compositionRevalidation;
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
    const stage = this.workflowState(scene).phase;
    const previousStrategy = scene.assetStrategies?.find((asset) => asset.nodeId === strategy.nodeId);
    const refreshingFallback = previousStrategy && !previousStrategy.providers.length && !strategy.providers.length &&
      !previousStrategy.provider && !previousStrategy.taskId && !previousStrategy.artifactPath &&
      !strategy.provider && !strategy.taskId && !strategy.artifactPath;
    if (scene.plan.workflow && stage !== "geometry" && !refreshingFallback) throw new Error("Asset generation belongs to geometry.");
    const revision = this.activeRevision(scene);
    if (revision && !revision.request.scopeNodeIds.includes(strategy.nodeId)) throw new Error("Asset is outside the authorized revision scope.");
    const requirement = scene.plan.assets?.find((a) => a.nodeId === strategy.nodeId);
    if (!requirement) throw new Error("Unknown asset requirement.");
    if (!strategy.providers.length && scene.assetStrategies?.some((s) => s.nodeId === strategy.nodeId && s.providers.length)) {
      throw new Error("A discovered Provider remains unresolved; failure or pending approval cannot become a Blender fallback.");
    }
    const record = verifyAssetStrategy(this.path(scene, "."), requirement, strategy, true);
    if (previousStrategy) scene.assetStrategyHistory = [...(scene.assetStrategyHistory ?? []),
      { revisionId: revision?.id, strategy: structuredClone(previousStrategy) }];
    scene.assetStrategies = [...(scene.assetStrategies ?? []).filter((a) => a.nodeId !== strategy.nodeId), record];
    this.save(scene); return scene;
  }

  private spatialRequest(scene: Scene): SpatialRequest {
    const library = scene.spatialLibrary ?? { builtin: builtinSpatialSource(), bindings: [] };
    const skills = library.bindings.map(binding => {
      const candidate = this.library.spatialCandidate(binding.id, binding.hash);
      return { id: candidate.id, hash: candidate.hash, code: candidate.code! };
    });
    return { ...library, graph: scene.plan?.graph ?? [], relations: scene.plan?.relations ?? [], skills };
  }

  private recordSpatialInspection(scene: Scene): void {
    if (!scene.inspection || !scene.summary?.spatialEvaluation) return;
    const file = `measurements/${scene.inspection.id}.json`;
    mkdirSync(this.path(scene, "measurements"), { recursive: true });
    writeFileSync(this.path(scene, file), JSON.stringify({ inspectionId: scene.inspection.id, iteration: scene.iteration,
      phase: scene.inspection.stage, relationChecks: scene.summary.relationChecks,
      spatialEvaluation: scene.summary.spatialEvaluation, layoutOptimization: scene.summary.layoutOptimization }, null, 2));
    scene.inspection.spatialReport = file;
  }

  optimize(id: string, options: LayoutSearch): Scene {
    const scene = this.get(id); this.idle(scene);
    const phase = this.workflowState(scene).phase;
    if (!scene.plan || scene.stage !== "edit" || scene.plan.workflow && !["geometry", "composition"].includes(phase ?? "")) {
      throw new Error("Optimize layout only during an authorized geometry/composition edit.");
    }
    if (!options.movableNodeIds.length || options.movableNodeIds.length > 30 || new Set(options.movableNodeIds).size !== options.movableNodeIds.length ||
      options.movableNodeIds.some(id => !scene.plan!.graph?.some(node => node.id === id && node.kind !== "group")) ||
      !Number.isFinite(options.translationStep) || options.translationStep <= 0 || options.translationStep > 1000 ||
      !Number.isInteger(options.passes) || options.passes < 1 || options.passes > 8 ||
      !Number.isFinite(options.rotationStepDegrees) || options.rotationStepDegrees < 0 || options.rotationStepDegrees > 45) {
      throw new Error("Layout search needs 1-30 distinct non-group nodes, a positive step up to 1000 units, 1-8 passes and rotation step in [0, 45] degrees.");
    }
    const revision = this.activeRevision(scene);
    if (revision && options.movableNodeIds.some(id => !revision.request.scopeNodeIds.includes(id))) throw new Error("Layout search cannot expand the authorized revision scope.");
    const criterionIds = scene.plan.workflow?.stages[scene.workflowIndex ?? 0]?.criterionIds ?? scene.plan.criteria.map(c => c.id);
    const relationIds = (scene.plan.relations ?? []).filter(r => r.type !== "semantic" && r.criterionIds.some(id => criterionIds.includes(id))).map(r => r.id);
    if (!relationIds.length) throw new Error("No measurable relations are bound to this stage; semantic descriptions alone cannot drive numeric layout search.");
    const request = this.spatialRequest(scene);
    const overrides = options.scorerOverrides ?? [];
    if (new Set(overrides.map(binding => binding.relationId)).size !== overrides.length || overrides.some(binding => !relationIds.includes(binding.relationId))) {
      throw new Error("Candidate overrides must reference distinct active measured relations.");
    }
    for (const binding of overrides) {
      const candidate = this.library.spatialCandidate(binding.id, binding.hash);
      request.skills.push({ id: candidate.id, hash: candidate.hash, code: candidate.code! });
    }
    return this.edit(id, spatialOptimizeCode(request, { ...options, relationIds }));
  }

  private checkEdit(scene: Scene): StageName | undefined {
    this.idle(scene);
    if (scene.stage !== "edit" || !scene.plan) throw new Error("Plan and review must precede further edits.");
    if (!scene.graphReview?.checks.every((c) => c.passed)) throw new Error("A read-only Scene Graph review must pass before scene editing.");
    for (const asset of scene.plan.assets ?? []) if (asset.kind === "object") {
      const strategy = scene.assetStrategies?.find((s) => s.nodeId === asset.nodeId);
      if (!strategy) throw new Error(`Resolve provider discovery and asset strategy for ${asset.nodeId} before Blender mutation.`);
      verifyAssetStrategy(this.path(scene, "."), asset, strategy);
    }
    const activeStage = scene.plan.workflow ? this.workflowState(scene).phase ?? undefined : undefined;
    if (activeStage && ["materials", "lighting", "final"].includes(activeStage) &&
        scene.plan.workflow?.stages.some((s) => s.name === "composition") && !scene.compositionApproved) {
      throw new Error("User composition approval is required before downstream edits.");
    }
    const { spent, limit } = this.attemptLimit(scene);
    if (spent >= limit) throw new Error("Stage edit budget reached. An explicit scene_revise grant is required for additional rounds.");
    return activeStage;
  }

  private activeAppearanceSearch(scene: Scene): AppearanceSearch | undefined {
    const search = scene.appearanceSearch;
    if (scene.stage === "edit" && search?.iteration === scene.iteration && search.phase === this.workflowState(scene).phase) {
      return search;
    }
  }

  appearanceImages(scene: Scene): { id: string; label: string; file: string }[] {
    const search = this.activeAppearanceSearch(scene);
    return search?.candidates.filter(candidate => !candidate.error).map(({ id, label }) => ({
      id, label, file: `appearance/${search.id}/${id}.png`,
    })) ?? [];
  }

  searchAppearance(id: string, candidates: AppearanceCandidate[]): Scene {
    const scene = this.get(id);
    const phase = this.checkEdit(scene);
    if (phase !== "materials" && phase !== "lighting") throw new Error("Search appearance during the materials or lighting stage.");
    if (this.activeAppearanceSearch(scene)) throw new Error("An appearance search is ready. Select a candidate or make a regular edit.");
    const current = this.path(scene, "current.blend");
    const search: AppearanceSearch = { id: randomUUID(), phase, iteration: scene.iteration, sourceHash: fileHash(current),
      candidates: [{ id: "baseline", label: "Current scene", mode: "baseline" }] };
    const directory = this.path(scene, `appearance/${search.id}`);
    const loadSource = `bpy.ops.wm.open_mainfile(filepath=${py(current)})`;
    const [beforeGuard, afterGuard] = factorGuardCode(phase);
    this.enqueue(scene, "appearance_search", async () => {
      mkdirSync(directory, { recursive: true });
      try {
        await this.blender.execute(`${loadSource}\n${appearancePreviewCode(resolve(directory, "baseline.png"))}`);
        for (const [index, candidate] of candidates.entries()) {
          const entry: AppearanceSearch["candidates"][number] = {
            id: `candidate-${index + 1}`, label: candidate.label, mode: candidate.mode,
          };
          search.candidates.push(entry);
          const code = candidate.mode === "leap" ? candidate.code : tweakCode(candidate.tweaks);
          try {
            await this.blender.execute(`
${loadSource}
${beforeGuard}
${comparisonFrameCode()}
_source_frame = _appearance_frame()
${code}
${afterGuard}
if _appearance_frame() != _source_frame:
    raise RuntimeError('Appearance search must preserve the active camera, frame, crop and render settings')
bpy.ops.wm.save_as_mainfile(filepath=${py(resolve(directory, entry.id + ".blend"))}, copy=True)
${appearancePreviewCode(resolve(directory, entry.id + ".png"))}
`);
            writeFileSync(resolve(directory, entry.id + ".py"), code);
          } catch (error) {
            entry.error = error instanceof Error ? error.message : String(error);
          }
        }
      } finally {
        try {
          await this.blender.execute(loadSource);
        } catch {
          this.recoveryRequired = true;
          throw new Error("Blender recovery failed. Restart the dedicated bridge and service before continuing.");
        }
      }
      scene.appearanceSearch = search;
    });
    return scene;
  }

  selectAppearance(id: string, searchId: string, candidateId: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    const search = this.activeAppearanceSearch(scene);
    if (!search || search.id !== searchId || search.sourceHash !== fileHash(this.path(scene, "current.blend"))) {
      throw new Error("Appearance search does not match the current scene.");
    }
    if (!search.candidates.some(item => item.id === candidateId && !item.error)) {
      throw new Error("The selected appearance candidate is unavailable.");
    }
    const code = candidateId === "baseline" ? "# Keep the appearance search baseline." :
      `bpy.ops.wm.open_mainfile(filepath=${py(this.path(scene, `appearance/${search.id}/${candidateId}.blend`))})`;
    return this.edit(id, code);
  }

  edit(id: string, code: string): Scene {
    const scene = this.get(id);
    const activeStage = this.checkEdit(scene);
    const revision = this.activeRevision(scene);
    const scoring = scene.plan?.relations?.length ? this.spatialRequest(scene) : undefined;
    delete scene.previewedIteration;
    delete scene.reviewEvidence;
    this.enqueue(scene, "edit", async () => {
      const current = this.path(scene, "current.blend");
      const before = this.path(scene, "checkpoint.blend");
      copyFileSync(current, before);
      const previousContentIteration = this.contentIteration(scene);
      scene.iteration++;
      scene.pendingIteration = scene.iteration;
      scene.pendingAttempt = { revisionId: revision?.id, phase: activeStage as StageName | undefined, previousContentIteration };
      delete scene.inspection;
      this.save(scene);
      const render = `renders/iteration-${scene.iteration}.png`;
      const [beforeGuard, afterGuard] = factorGuardCode(activeStage, scene.compositionApproved, revision ? {
        nodeIds: revision.request.scopeNodeIds,
        graphObjects: (scene.plan?.graph ?? []).map((node) => ({ nodeId: node.id, names: node.blenderObjectNames })),
      } : undefined);
      try {
        scene.summary = await this.blender.execute(`
bpy.ops.wm.open_mainfile(filepath=${py(current)})
${beforeGuard}
${code}
${referenceCamerasCode(this.referenceCameras(scene).map(view => view.cameraName))}
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
${renderCode(this.path(scene, render), this.workflowState(scene).presentation.mode === "structural")}
${this.referenceRenderCode(scene, render)}
${sceneSummaryCode()}
${scoring ? spatialEvaluationCode(scoring) : ""}`);
        scene.render = render;
        scene.renderMode = this.workflowState(scene).presentation.mode;
        scene.summary.relationChecks = checkRelations(scene.plan?.relations ?? [], scene.summary.relationBounds,
          (scene.summary.spatialEvaluation as { results: SpatialScore[] } | undefined)?.results);
        scene.inspection = { id: randomUUID(), iteration: scene.iteration, stage: activeStage ?? "scene", summary: scene.summary };
        this.recordSpatialInspection(scene);
        scene.currentContentIteration = scene.iteration;
        mkdirSync(this.path(scene, "scripts"), { recursive: true });
        writeFileSync(this.path(scene, `scripts/iteration-${scene.iteration}.py`), code);
        if (revision) revision.spent++;
        else if (scene.stageAllowances && activeStage && scene.stageAllowances[activeStage as StageName]?.spent !== null) {
          scene.stageAllowances[activeStage as StageName]!.spent!++;
        }
        scene.stage = "review";
        delete scene.appearanceSearch;
        delete scene.pendingIteration;
        delete scene.pendingAttempt;
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
        scene.currentContentIteration = previousContentIteration;
        delete scene.pendingIteration;
        delete scene.pendingAttempt;
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
    if (!scene.inspection || input.inspectionId !== scene.inspection.id || scene.inspection.iteration !== input.iteration ||
      scene.inspection.stage !== (workflowStage?.name ?? "scene") ||
      scene.currentContentIteration !== undefined && scene.currentContentIteration !== input.iteration && !scene.compositionRevalidation) {
      throw new Error("Review must bind the current runtime inspectionId from scene_get.");
    }
    const expectedIds = workflowStage?.name === "final" || !workflowStage ? scene.plan.criteria.map((item) => item.id) : workflowStage.criterionIds;
    verifyRelationReviews(scene.plan.relations ?? [], expectedIds,
      (scene.inspection.summary.relationChecks ?? []) as RelationCheck[], input.relationReviews ?? []);
    for (const result of input.relationReviews ?? []) if (!result.passed) {
      const relation = scene.plan.relations!.find((relation) => relation.id === result.relationId)!;
      if (input.criteria.some((criterion) => criterion.passed && relation.criterionIds.includes(criterion.id))) {
        throw new Error("A criterion cannot pass while one of its active relations fails.");
      }
    }
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
    const revision = this.activeRevision(scene);
    const reviewed: Review = { ...input, spatialReport: scene.inspection.spatialReport,
      phase: workflowStage?.name, revisionId: revision?.id ?? scene.confirmationRevisionId,
      ...(anchors ? { alignmentMaxError } : {}) };
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
      scene.bestRenderMode = scene.renderMode;
      scene.bestReferenceRender = this.referenceCameras(scene).length ? scene.render : undefined;
      scene.bestContentIteration = scene.currentContentIteration ?? scene.iteration;
      if (revision) revision.bestIteration = scene.iteration;
      scene.noImprovement = 0;
      copyFileSync(this.path(scene, "current.blend"), this.path(scene, "best.blend"));
      copyFileSync(this.path(scene, scene.render!), this.path(scene, "best.png"));
    } else scene.noImprovement++;
    const accepted = alignmentMaxError <= MAX_ANCHOR_ERROR &&
      input.criteria.every((criterion) => criterion.passed) &&
      input.regressions.length === 0 && input.visualScore >= scene.plan.visualThreshold;
    const { spent: attempts, limit } = this.attemptLimit(scene);
    if (!workflowStage && attempts === 5 && better && input.repairable) scene.extended = true;
    const stop = scene.compositionRevalidation || scene.noImprovement >= 2 || attempts >= limit ||
      (!workflowStage && attempts >= 5 && !scene.extended);
    if (revision && (accepted || stop)) {
      this.finishRevision(scene, revision);
    } else if (workflowStage && (accepted || stop) && workflowStage.name !== "final") {
      copyFileSync(this.path(scene, "best.blend"), this.path(scene, "current.blend"));
      scene.currentContentIteration = scene.bestContentIteration ?? scene.best!.iteration;
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

  private finishRevision(scene: Scene, revision: Revision): void {
    revision.status = "closed";
    revision.remainingGaps = scene.best?.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id) ?? [];
    const checkpoint = revision.archive;
    if (scene.best) {
      copyFileSync(this.path(scene, "best.blend"), this.path(scene, "current.blend"));
      scene.currentContentIteration = scene.bestContentIteration ?? scene.best.iteration;
      copyFileSync(this.path(scene, "best.blend"), this.path(scene, `${checkpoint}/selected.blend`));
      copyFileSync(this.path(scene, "best.png"), this.path(scene, `${checkpoint}/selected.png`));
    } else {
      copyFileSync(this.path(scene, `${checkpoint}/current.blend`), this.path(scene, "current.blend"));
      scene.currentContentIteration = revision.baselineContentIteration;
    }
    const compositionIndex = scene.plan!.workflow!.stages.findIndex((stage) => stage.name === "composition");
    scene.workflowIndex = compositionIndex;
    delete scene.activeRevisionId;
    scene.confirmationRevisionId = revision.id;
    scene.compositionRevalidation = true;
    scene.compositionApproved = false;
    scene.remainingGaps = revision.remainingGaps;
    scene.noImprovement = 0;
    delete scene.best; delete scene.bestContentIteration; delete scene.bestRenderMode;
    this.invalidateEvidence(scene);
    // Read-only inspection supplies a fresh binding for composition review of the selected content.
    scene.stage = "edit";
    this.enqueueCompositionRevalidation(scene);
  }

  private enqueueCompositionRevalidation(scene: Scene): void {
    this.enqueue(scene, "revision_revalidation", async () => {
      const render = `renders/revision-${scene.confirmationRevisionId!}-composition.png`;
      scene.summary = await this.blender.execute(`
bpy.ops.wm.open_mainfile(filepath=${py(this.path(scene, "current.blend"))})
${renderCode(this.path(scene, render), true)}
${this.referenceRenderCode(scene, render)}
${sceneSummaryCode()}
${scene.plan?.relations?.length ? spatialEvaluationCode(this.spatialRequest(scene)) : ""}`);
      scene.render = render;
      scene.renderMode = "structural";
      scene.summary.relationChecks = checkRelations(scene.plan?.relations ?? [], scene.summary.relationBounds,
        (scene.summary.spatialEvaluation as { results: SpatialScore[] } | undefined)?.results);
      scene.inspection = { id: randomUUID(), iteration: scene.iteration, stage: "composition", summary: scene.summary };
      this.recordSpatialInspection(scene);
      scene.stage = "review";
    });
  }

  private advanceWorkflow(scene: Scene, targetIndex = (scene.workflowIndex ?? 0) + 1): void {
    if (!scene.stageAllowances && scene.plan?.workflow) scene.stageAllowances = this.observedAllowances(scene);
    scene.workflowIndex = targetIndex;
    scene.startIteration = scene.iteration;
    scene.noImprovement = 0;
    scene.extended = false;
    delete scene.best;
    delete scene.bestRenderMode;
    delete scene.renderMode;
    delete scene.render;
    delete scene.reviewEvidence;
    delete scene.previewedIteration;
    delete scene.reviewFeedback;
    delete scene.inspection;
    delete scene.compositionRevalidation;
    delete scene.confirmationRevisionId;
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
    const revision = this.activeRevision(scene);
    if (revision) {
      for (const node of graph) {
        const original = scene.plan.graph.find((candidate) => candidate.id === node.id)!;
        const { blenderObjectNames: oldNames, status: oldStatus, ...oldSemantics } = original;
        const { blenderObjectNames: newNames, status: newStatus, ...newSemantics } = node;
        if (JSON.stringify(oldSemantics) !== JSON.stringify(newSemantics) ||
          !revision.request.scopeNodeIds.includes(node.id) && JSON.stringify(original) !== JSON.stringify(node)) {
          throw new Error("Revision graph changes must preserve frozen semantics and unscoped mappings.");
        }
      }
    }
    const semantics = (nodes: SceneNode[]) => JSON.stringify(nodes.map(({ id, kind, parentId, description, relations }) => ({ id, kind, parentId, description, relations })));
    if (semantics(scene.plan.graph) !== semantics(graph)) {
      if (scene.compositionApproved) throw new Error("Return to geometry or composition before changing approved spatial relationships.");
      if (scene.stage !== "edit") throw new Error("Review the current render before revising graph relationships.");
      delete scene.graphReview;
    }
    scene.plan.graph = graph;
    delete scene.previewedIteration;
    this.save(scene);
    return scene;
  }

  private enqueueReviewViews(scene: Scene): void {
    const target = this.workflowState(scene).presentation;
    delete scene.previewedIteration;
    delete scene.reviewEvidence;
    this.enqueue(scene, "review_views", () => this.generateReviewViews(scene, target));
  }

  private async generateReviewViews(scene: Scene, target: Presentation): Promise<void> {
    delete scene.previewedIteration;
    delete scene.reviewEvidence;
    const views = ["review-main.png", "review-front.png", "review-side.png", "review-top.png", "review-perspective.png"];
    scene.reviewViews = views;
    for (const view of views) if (existsSync(this.path(scene, view))) unlinkSync(this.path(scene, view));
    const source = this.path(scene, target.source === "current" ? "current.blend" : "best.blend");
    const paths = views.map((name) => this.path(scene, name));
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
${structuralShadingCode()}
scene.render.image_settings.file_format = 'PNG'
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
camera_data.clip_end = max(1000.0, radius * 6)
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
    scene.reviewEvidence = { source: target.source, iteration: target.iteration,
      ...(target.contentIteration !== undefined ? { contentIteration: target.contentIteration } : {}),
      ...(target.revisionId ? { revisionId: target.revisionId } : {}), phase: this.workflowState(scene).phase };
  }

  reviewDecision(id: string, approved: boolean, feedback?: string, returnTo?: "geometry" | "composition"): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "awaiting_review" || !scene.plan?.workflow?.compositionApproval) {
      throw new Error("Scene is not awaiting composition approval.");
    }
    if (scene.job?.kind === "review_views" && scene.job.status !== "done" ||
      !this.reviewViewsReady(scene)) {
      throw new Error("Composition review views are not ready. Retry view generation first.");
    }
    if (approved) { scene.compositionApproved = true; this.advanceWorkflow(scene); }
    else {
      if (!feedback?.trim()) throw new Error("Describe the requested geometry or composition change.");
      const index = scene.plan.workflow.stages.findIndex((stage) => stage.name === (returnTo ?? "composition"));
      if (index < 0 || index > (scene.workflowIndex ?? 0)) throw new Error("Requested return stage is unavailable.");
      scene.compositionApproved = false;
      scene.reviewFeedback = `${feedback}\nAdditional edits require an explicitly authorized scene_revise grant; rejection does not refill a stage budget.`;
    }
    this.save(scene);
    return scene;
  }

  retryReviewViews(id: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.compositionRevalidation && scene.confirmationRevisionId && !scene.inspection &&
      scene.job?.kind === "revision_revalidation" && scene.job.status === "failed") {
      this.enqueueCompositionRevalidation(scene);
      return scene;
    }
    if (!this.canPreviewStructure(scene)) throw new Error("Structural views require a saved geometry/composition scene or a composition checkpoint.");
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
      delete scene.reviewEvidence;
      delete scene.renderMode;
      delete scene.bestRenderMode;
      delete scene.remainingGaps;
      delete scene.exportedIteration;
      delete scene.previewedIteration;
      delete scene.error;
      delete scene.stageAllowances; delete scene.revisions; delete scene.activeRevisionId;
      delete scene.confirmationRevisionId; delete scene.compositionRevalidation;
      delete scene.currentContentIteration; delete scene.bestContentIteration;
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

  private previewDirectory(scene: Scene, iteration: number): string {
    const revisionId = this.workflowState(scene).presentation.revisionId;
    return revisionId ? `revisions/${revisionId}/previews/${this.workflowState(scene).phase}/${iteration}` : `previews/${iteration}`;
  }

  bake(id: string, lightingBakes?: LightingBake[]): Scene {
    const scene = this.get(id);
    this.idle(scene);
    const target = this.workflowState(scene).presentation;
    if (!["completed", "best_effort"].includes(scene.stage) || target.mode !== "appearance" || !scene.best) {
      throw new Error("Complete scene review before baking the delivery checkpoint.");
    }
    const requests = lightingBakeRequests(lightingBakes?.map(bake => ({ ...bake, mode: bake.mode ?? "lightmap" })) ??
      scene.bake?.lightingBakes ?? scene.exportLighting ?? []);
    this.enqueue(scene, "bake", async () => {
      scene.bake = { ...await prepareBake(this.blender, this.path(scene, "best.blend"), this.path(scene, "."), requests),
        iteration: target.iteration };
    });
    return scene;
  }

  export(id: string, preview = false, lightingBakes?: LightingBake[], previewAppearance?: PreviewAppearance): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (preview ? !this.canPreviewStructure(scene) : !scene.best || !["completed", "best_effort"].includes(scene.stage)) {
      throw new Error(preview ? "A saved geometry/composition scene or composition checkpoint is required for a structural preview." : "Complete scene review before exporting the best version.");
    }
    const state = this.workflowState(scene), target = state.presentation;
    const bakes = lightingBakeRequests(lightingBakes ?? (preview ? [] : scene.bake?.lightingBakes ?? scene.exportLighting ?? []));
    if (preview && bakes.length) throw new Error("Lighting bakes require a final export.");
    const marker = preview ? "previewedIteration" : "exportedIteration";
    const appearance = structuredClone(preview ? {} : previewAppearance ?? scene.exportAppearance ?? {});
    if (appearance.renderMode !== undefined && !["pathtracing", "raster"].includes(appearance.renderMode) ||
        appearance.planarReflection !== undefined && (!appearance.planarReflection.trim() || appearance.planarReflection.length > 256)) {
      throw new Error("Choose a web render mode and a mesh name for the planar reflection.");
    }
    if (bakes.some(bake => bake.mode === "lightmap") || appearance.planarReflection || appearance.reflectionProbe) {
      if (appearance.renderMode === "pathtracing") throw new Error("Lightmaps and reflection captures require raster preview.");
      appearance.renderMode = "raster";
    }
    const vector = (v: number[], low: number, high: number) => v.length === 3 && v.every(n => Number.isFinite(n) && n >= low && n <= high);
    if (appearance.reflectionProbe && !vector(appearance.reflectionProbe, -10000, 10000)) throw new Error("Invalid reflection probe position.");
    if ((appearance.exposureEV !== undefined && (!Number.isFinite(appearance.exposureEV) || Math.abs(appearance.exposureEV) > 3)) ||
        (appearance.saturation !== undefined && (!Number.isFinite(appearance.saturation) || appearance.saturation < 0 || appearance.saturation > 2)) ||
        (appearance.whiteBalance !== undefined && !vector(appearance.whiteBalance, 0.25, 4)) ||
        (appearance.contrast !== undefined && (!Number.isFinite(appearance.contrast) || appearance.contrast < 0.5 || appearance.contrast > 2)) ||
        (appearance.hazeScale !== undefined && (!Number.isFinite(appearance.hazeScale) || appearance.hazeScale < 0 || appearance.hazeScale > 2)) ||
        (appearance.dust && (!vector(appearance.dust.color, 0, 10) || !vector(appearance.dust.wind, -10, 10) ||
          appearance.dust.volumes.length < 1 || appearance.dust.volumes.length > 6 || appearance.dust.volumes.some(v =>
            !vector(v.center, -10000, 10000) || !vector(v.radius, 0.05, 1000) || !Number.isFinite(v.density) || v.density < 0 || v.density > 2)))) {
      throw new Error("Invalid preview appearance: use finite exposure, saturation and up to six bounded dust volumes.");
    }
    const template = exportTemplate();
    const pipelineHash = createHash("sha256").update(template)
      .update(readFileSync(new URL("../../runtime/blender/postprocess/bake.py", import.meta.url))).digest("hex");
    const sameLighting = preview || (JSON.stringify(scene.exportLighting ?? []) === JSON.stringify(bakes) &&
      JSON.stringify(scene.exportAppearance ?? {}) === JSON.stringify(appearance));
    const sameSource = preview || scene.bake?.sourceBlendSha256 === fileHash(this.path(scene, "best.blend"));
    if (sameLighting && sameSource && (preview || scene.exportPipelineHash === pipelineHash) && scene[marker] === target.iteration && scene.job?.status !== "failed" && (!preview || this.hasStructuralPreview(scene))) return scene;
    const iteration = target.iteration;
    const directory = this.path(scene, preview ? this.previewDirectory(scene, iteration) : `artifacts/${iteration}`);
    mkdirSync(directory, { recursive: true });
    if (preview) delete scene.previewedIteration;
    this.enqueue(scene, preview ? "preview" : "export", async () => {
      if (preview && !this.reviewViewsReady(scene)) await this.generateReviewViews(scene, target);
      const blend = target.source === "current" ? "current.blend" : "best.blend";
      const bake = preview ? undefined : await prepareBake(this.blender, this.path(scene, blend), this.path(scene, "."), bakes);
      if (bake) {
        scene.bake = { ...bake, iteration };
        for (const map of bake.lightmaps) copyFileSync(this.path(scene, `${bake.directory}/${map.uri}`), `${directory}/${map.uri}`);
      }
      const code = template.replace("__SOURCE_BLEND__", py(this.path(scene, blend)))
        .replace("__OUTPUT_DIRECTORY__", py(directory))
        .replace("__PREPARED_BLEND__", bake ? py(this.path(scene, `${bake.directory}/prepared.blend`)) : "None")
        .replace("__BAKE_METADATA_JSON__", py(JSON.stringify(bake ?? {})))
        .replace("__PREVIEW_APPEARANCE__", py(appearance))
        .replace("__STRUCTURAL_PREVIEW__", preview ? "True" : "False")
        .replace("__REFERENCE_CAMERA_NAMES__", py(this.referenceCameras(scene).map(view => view.cameraName)));
      await this.blender.execute(code);
      const alignment = writeGraphExport(directory, iteration, scene.plan?.graph ?? [], scene.stage, scene.remainingGaps ?? [], {
        blend, render: preview ? "review-main.png" : "best.png", kind: target.source, purpose: target.purpose, phase: state.phase,
        revisionId: target.revisionId, contentIteration: target.contentIteration,
      }, this.path(scene, "."), scene.plan?.relations ?? []);
      scene[marker] = iteration;
      if (!preview) {
        scene.exportAlignment = alignment;
        scene.exportLighting = bakes; scene.exportAppearance = appearance; scene.exportVersion = randomUUID(); scene.exportPipelineHash = pipelineHash;
        this.captureExperience(scene);
      }
    });
    return scene;
  }

  renderHighQuality(id: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    const target = this.workflowState(scene).presentation;
    if (!["completed", "best_effort"].includes(scene.stage) || target.mode !== "appearance" ||
      !scene.exportVersion || scene.exportedIteration !== target.iteration) {
      throw new Error("请先完成场景审核与最终导出，再使用 ThreeRT 高质量渲染。");
    }
    const capability = threeRTCapability();
    if (!capability.available) throw new Error(capability.reason);
    const directory = `threert/${target.iteration}-${scene.exportVersion}`;
    const state: NonNullable<Scene["threeRTRender"]> = { status: "queued", iteration: target.iteration,
      exportVersion: scene.exportVersion, directory };
    scene.threeRTRender = state;
    this.enqueue(scene, "threert", async () => {
      state.status = "running"; this.save(scene);
      try {
        const output = this.path(scene, directory);
        mkdirSync(output, { recursive: true });
        // ThreeRT uses the materials-only copy, keeping baked illumination out of physical emitters.
        const bake = await prepareBake(this.blender, this.path(scene, "best.blend"), this.path(scene, "."), [], false);
        const template = exportTemplate();
        const code = template.replace("__SOURCE_BLEND__", py(this.path(scene, "best.blend")))
          .replace("__OUTPUT_DIRECTORY__", py(output))
          .replace("__PREPARED_BLEND__", py(this.path(scene, `${bake.directory}/prepared.blend`)))
          .replace("__BAKE_METADATA_JSON__", py(JSON.stringify(bake)))
          .replace("__PREVIEW_APPEARANCE__", py(scene.exportAppearance ?? {})).replace("__STRUCTURAL_PREVIEW__", "False")
          .replace("__REFERENCE_CAMERA_NAMES__", py(this.referenceCameras(scene).map(view => view.cameraName)));
        await this.blender.execute(code);
        state.warnings = await renderThreeRT(output, capability.binary);
        state.status = "done";
      } catch (error) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    return scene;
  }

  realtimeTarget(id: string) {
    const scene = this.get(id);
    this.idle(scene);
    const state = scene.threeRTRender, target = this.workflowState(scene).presentation;
    if (!["completed", "best_effort"].includes(scene.stage) || target.mode !== "appearance" ||
      !state || state.status !== "done" || state.exportVersion !== scene.exportVersion || state.iteration !== target.iteration) {
      throw new Error("请先准备当前版本的 ThreeRT 场景。");
    }
    const capability = threeRTCapability();
    if (!capability.available) throw new Error(capability.reason);
    return { version: state.exportVersion, directory: this.path(scene, state.directory), binary: capability.binary };
  }

  private captureExperience(scene: Scene) {
    const target = this.workflowState(scene).presentation;
    if (!["completed", "best_effort"].includes(scene.stage) || !scene.exportVersion || scene.exportedIteration !== target.iteration) {
      throw new Error("Experience capture requires the exported delivery checkpoint.");
    }
    const files = ["best.blend", "best.png", `artifacts/${target.iteration}/manifest.json`];
    return this.library.capture({ sceneId: scene.id, iteration: target.iteration, exportVersion: scene.exportVersion,
      outcome: scene.stage, target: scene.plan?.summary ?? scene.prompt,
      compositionApproved: scene.compositionApproved === true, remainingGaps: scene.remainingGaps ?? [],
      reviews: structuredClone(scene.reviews), sourceHashes: Object.fromEntries(files.map(f => [f, fileHash(this.path(scene, f))])) });
  }

  recordExperience(id: string, retrospective?: RetrospectiveInput) {
    const scene = this.get(id); this.idle(scene);
    const source = this.captureExperience(scene);
    return retrospective ? this.library.record(source, this.path(scene, "."), retrospective) : source;
  }

  validateExperienceSkill(id: string, candidateId: string, expectedHash: string, replays: Replay[]): Scene {
    const scene = this.get(id); this.idle(scene);
    const candidate = this.library.candidate(candidateId);
    if (candidate.hash !== expectedHash) throw new Error("Candidate hash changed.");
    const checked = this.library.checkReplays(candidate, replays);
    const regressionFixtures = this.library.regressionFixtures(candidate);
    const finish = (results: FixtureResult[], version?: string, error?: string, regressions: FixtureResult[] = []) => {
      const validation = this.library.validate(candidateId, expectedHash, checked, results, version, error, regressions);
      scene.skillValidation = { candidateId, validationId: validation.id, passed: validation.passed };
    };
    if (candidate.kind === "guidance") { finish([]); this.save(scene); return scene; }
    this.enqueue(scene, "skill-validation", async () => {
      const current = this.path(scene, "current.blend"), before = fileHash(current);
      const template = readFileSync(new URL("../../runtime/blender/validate_skill.py", import.meta.url), "utf8");
      let output: Record<string, unknown>;
      try {
        output = await this.blender.execute(template.replace("__SKILL_REQUEST__", py(JSON.stringify({ code: candidate.code, kind: candidate.kind,
          fixtures: [...candidate.fixtures, ...regressionFixtures] }))));
      } catch (error) {
        finish([], undefined, error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        try {
          await this.blender.execute(`bpy.ops.wm.open_mainfile(filepath=${py(current)})`);
          if (fileHash(current) !== before) throw new Error("Skill validation changed its source checkpoint.");
        } catch {
          this.recoveryRequired = true;
          finish([], undefined, "Blender recovery failed; restart the dedicated bridge and service.");
          throw new Error("Blender recovery failed; restart the dedicated bridge and service.");
        }
      }
      const reports = output.fixtures as FixtureResult[];
      finish(reports.filter(r => candidate.fixtures.some(f => f.name === r.name)), String(output.blenderVersion), undefined,
        reports.filter(r => regressionFixtures.some(f => f.name === r.name)));
    });
    return scene;
  }

  renderFile(scene: Scene): string | undefined {
    const { presentation } = this.workflowState(scene);
    if (presentation.mode === "structural") {
      if (this.reviewViewsReady(scene)) return "review-main.png";
      if (presentation.source === "current" && scene.renderMode === "structural" &&
          (scene.render?.match(/iteration-(\d+)\.png$/)?.[1] === String(presentation.iteration) ||
            scene.compositionRevalidation && scene.render?.startsWith("renders/revision-"))) return scene.render;
      return undefined;
    }
    if (presentation.source === "best") return scene.best && scene.bestRenderMode !== "structural" ? "best.png" : undefined;
    return scene.renderMode !== "structural" && scene.render?.match(/iteration-(\d+)\.png$/)?.[1] === String(presentation.iteration) ? scene.render : undefined;
  }

  private canPreviewStructure(scene: Scene): boolean {
    const { presentation } = this.workflowState(scene);
    return presentation.mode === "structural" && presentation.iteration > 0 &&
      ["edit", "review", "awaiting_review"].includes(scene.stage) &&
      existsSync(this.path(scene, presentation.source === "current" ? "current.blend" : "best.blend"));
  }

  private reviewViewsReady(scene: Scene): boolean {
    const target = this.workflowState(scene).presentation;
    return scene.reviewEvidence?.iteration === target.iteration && scene.reviewEvidence.source === target.source &&
      scene.reviewEvidence.revisionId === target.revisionId &&
      (scene.reviewEvidence.phase === undefined || scene.reviewEvidence.phase === this.workflowState(scene).phase) &&
      scene.reviewEvidence.contentIteration === target.contentIteration && scene.reviewViews?.length === 5 && scene.reviewViews.every((view) => existsSync(this.path(scene, view)));
  }

  private hasStructuralPreview(scene: Scene): boolean {
    const target = this.workflowState(scene).presentation;
    if (target.mode !== "structural" || scene.previewedIteration !== target.iteration) return false;
    try {
      const profile = JSON.parse(readFileSync(this.path(scene, `${this.previewDirectory(scene, scene.previewedIteration!)}/render-profile.json`), "utf8"));
      return profile.previewMode === "structural" && profile.iteration === target.iteration &&
        profile.source?.kind === target.source && profile.source?.purpose === target.purpose && profile.source?.phase === this.workflowState(scene).phase &&
        profile.source?.revisionId === target.revisionId && profile.source?.contentIteration === target.contentIteration;
    } catch { return false; }
  }

  allowedFiles(scene: Scene): string[] {
    const target = this.workflowState(scene).presentation;
    const workingRender = target.source === "current" && scene.renderMode === target.mode &&
      scene.render?.match(/iteration-(\d+)\.png$/)?.[1] === String(target.iteration) ? scene.render : undefined;
    const files = [...this.referenceImages(scene).map((reference) => reference.assetName), this.renderFile(scene),
      workingRender, ...this.referenceCameraFiles(scene).map(view => view.file), ...this.appearanceImages(scene).map(image => image.file),
      ...(this.reviewViewsReady(scene) ? scene.reviewViews ?? [] : []),
      scene.best && "best.blend", scene.best && "best.png"];
    const directory = scene.exportedIteration !== undefined && scene.exportedIteration === scene.best?.iteration ?
      `artifacts/${scene.exportedIteration}` : scene.previewedIteration !== undefined &&
      this.hasStructuralPreview(scene) ? this.previewDirectory(scene, scene.previewedIteration) : undefined;
    if (directory) {
      for (const name of ["final.glb", "render-profile.json", "environment.exr", "scene-graph.json", "manifest.json"]) {
        const file = `${directory}/${name}`;
        if (existsSync(this.path(scene, file))) files.push(file);
      }
      for (const name of readdirSync(this.path(scene, directory)).filter(name => /^lightmap-\d+\.png$/.test(name))) {
        files.push(`${directory}/${name}`);
      }
    }
    if (target.mode === "appearance" && target.purpose === "delivery" &&
      scene.threeRTRender?.status === "done" && scene.threeRTRender.exportVersion === scene.exportVersion &&
      scene.threeRTRender.iteration === target.iteration) {
      const file = `${scene.threeRTRender.directory}/threert.png`;
      if (existsSync(this.path(scene, file))) files.push(file);
    }
    return [...new Set(files.filter((item): item is string => Boolean(item)))];
  }

  snapshot(scene: Scene, origin: string): Record<string, unknown> {
    const { token, reference: _, references: __, spatialLibrary, bestReferenceRender: ___, ...publicScene } = scene;
    const workflowState = this.workflowState(scene);
    const url = (file: string) => `${origin}/artifacts/${scene.id}/${file}?token=${token}${file.startsWith("previews/") ? `&preview=structural&source=${workflowState.presentation.source}&phase=${workflowState.phase}` : ""}${file.startsWith("artifacts/") && scene.exportVersion ? `&v=${scene.exportVersion}` : ""}`;
    const references = this.referenceImages(scene).map((image, index) => ({ ...image,
      role: index === 0 ? "primary" : "auxiliary", url: url(image.assetName), localPath: this.path(scene, image.assetName) }));
    const render = this.renderFile(scene);
    const cameraFiles = this.referenceCameraFiles(scene);
    const referenceCameras = this.referenceCameras(scene).map(view => {
      const file = cameraFiles.find(item => item.reference === view.reference)?.file;
      return { ...view, default: view.reference === REFERENCE_ASSETS[0], renderUrl: file ? url(file) : null };
    });
    const { binary: _binary, ...threeRT } = { binary: undefined, ...threeRTCapability() };
    return {
      ...publicScene,
      exportAlignment: scene.exportVersion && scene.exportedIteration === scene.best?.iteration ? scene.exportAlignment : undefined,
      workflowState,
      spatialLibrary: spatialLibrary ? { builtin: { id: spatialLibrary.builtin.id, hash: spatialLibrary.builtin.hash }, bindings: spatialLibrary.bindings } : undefined,
      affectedRelations: relationsForScope(scene.plan?.graph ?? [], scene.plan?.relations ?? [], this.activeRevision(scene)?.request.scopeNodeIds ?? []),
      threeRT,
      realtimeUrl: scene.exportVersion ? `${origin}/realtime/${scene.id}?token=${token}&version=${encodeURIComponent(scene.exportVersion)}` : null,
      learning: this.library.context(scene.id, scene.plan?.summary ?? scene.prompt),
      reviewViews: this.reviewViewsReady(scene) ? scene.reviewViews : [],
      render,
      reference: references[0] ?? null,
      references,
      referenceCameras,
      renderUrl: render ? url(render) : null,
      bestRenderUrl: render ? url(render) : null,
      artifacts: this.allowedFiles(scene).filter((file) => ![...references.map((image) => image.assetName), ...cameraFiles.map(view => view.file), scene.render,
        ...(workflowState.presentation.mode === "structural" ? ["best.png", ...(workflowState.presentation.purpose === "work" ? ["best.blend"] : [])] : [])].includes(file))
        .map((file) => ({ name: file.split("/").at(-1), url: url(file) })),
    };
  }
}

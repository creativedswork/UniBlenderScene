import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { BlenderClient, inspectObjectCode, renderCode, sceneSummaryCode } from "./blender.js";

export type Criterion = { id: string; description: string; severity: "blocker" | "major" | "minor" };
export type Plan = { summary: string; criteria: Criterion[]; steps: string[]; visualThreshold: number };
export type Review = {
  iteration: number;
  criteria: { id: string; passed: boolean; evidence: string }[];
  visualScore: number;
  regressions: string[];
  repairable: boolean;
  nextAction: string;
};
type Job = { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; error?: string };
export type Scene = {
  id: string; prompt: string; token: string; createdAt: string; updatedAt: string;
  stage: "planning" | "edit" | "review" | "completed" | "best_effort";
  iteration: number; startIteration: number; noImprovement: number; extended: boolean;
  plan?: Plan; summary?: Record<string, unknown>; reviews: Review[]; best?: Review;
  reference?: { fileId: string; name: string; mime: string };
  render?: string; exportedIteration?: number; job?: Job; error?: string;
};
export type Reference = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
const py = JSON.stringify;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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
          scene.stage = "edit";
        }
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

  create(prompt: string, reference?: Reference): Scene {
    const scene: Scene = {
      id: `scene_${randomUUID()}`, prompt, token: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stage: "planning", iteration: 0, startIteration: 0, noImprovement: 0, extended: false, reviews: [],
    };
    mkdirSync(this.path(scene, "renders"), { recursive: true });
    mkdirSync(this.path(scene, "artifacts"), { recursive: true });
    this.scenes.set(scene.id, scene);
    this.enqueue(scene, "create", async () => {
      if (reference) await this.downloadReference(scene, reference);
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

  private async downloadReference(scene: Scene, reference: Reference): Promise<void> {
    const hosts = (process.env.FILE_DOWNLOAD_HOSTS ??
      "oaiusercontent.com,usercontent.openai.com").split(",").map((host) => host.trim()).filter(Boolean);
    let url = allowedDownloadURL(reference.download_url, hosts);
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
    writeFileSync(this.path(scene, "reference"), data);
    scene.reference = { fileId: reference.file_id, name: reference.file_name ?? "Reference image", mime };
  }

  plan(id: string, plan: Plan): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "planning") throw new Error("Plan is frozen. Use scene_continue for a new user request.");
    if (!existsSync(this.path(scene, "current.blend"))) throw new Error("Scene initialization failed; create a new scene.");
    if (new Set(plan.criteria.map((item) => item.id)).size !== plan.criteria.length) {
      throw new Error("Criterion IDs must be unique.");
    }
    scene.plan = plan;
    scene.stage = "edit";
    this.save(scene);
    return scene;
  }

  edit(id: string, code: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "edit" || !scene.plan) throw new Error("Plan and review must precede further edits.");
    if (scene.iteration - scene.startIteration >= 8) throw new Error("Hard limit of 8 edit attempts reached.");
    this.enqueue(scene, "edit", async () => {
      const current = this.path(scene, "current.blend");
      const before = this.path(scene, "checkpoint.blend");
      copyFileSync(current, before);
      scene.iteration++;
      this.save(scene);
      const render = `renders/iteration-${scene.iteration}.png`;
      try {
        scene.summary = await this.blender.execute(`
bpy.ops.wm.open_mainfile(filepath=${py(current)})
${code}
bpy.ops.wm.save_as_mainfile(filepath=${py(current)})
${renderCode(this.path(scene, render))}
${sceneSummaryCode()}`);
        scene.render = render;
        scene.stage = "review";
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
        if (scene.iteration - scene.startIteration >= 8 && scene.best) {
          scene.stage = "best_effort";
          copyFileSync(this.path(scene, "best.blend"), current);
        }
        throw error;
      }
    });
    return scene;
  }

  review(id: string, input: Omit<Review, "iteration"> & { iteration: number }): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (scene.stage !== "review" || !scene.plan || input.iteration !== scene.iteration) {
      throw new Error("Review must evaluate the latest rendered iteration.");
    }
    if (input.criteria.length !== scene.plan.criteria.length ||
      new Set(input.criteria.map((criterion) => criterion.id)).size !== input.criteria.length ||
      scene.plan.criteria.some((criterion) => !input.criteria.some((result) => result.id === criterion.id))) {
      throw new Error("Review must cover every frozen criterion exactly once.");
    }
    const quality = (review: Review): number[] => [
      ...(["blocker", "major"] as const).map((severity) => -scene.plan!.criteria.filter((criterion) =>
        criterion.severity === severity && !review.criteria.find((item) => item.id === criterion.id)!.passed).length),
      -review.regressions.length, review.visualScore,
    ];
    const better = !scene.best || (() => {
      const a = quality(input), b = quality(scene.best!);
      for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return a[index]! > b[index]!;
      }
      return false;
    })();
    scene.reviews.push(input);
    if (better) {
      scene.best = input;
      scene.noImprovement = 0;
      copyFileSync(this.path(scene, "current.blend"), this.path(scene, "best.blend"));
      copyFileSync(this.path(scene, scene.render!), this.path(scene, "best.png"));
    } else scene.noImprovement++;
    const accepted = input.criteria.every((criterion) => criterion.passed) &&
      input.regressions.length === 0 && input.visualScore >= scene.plan.visualThreshold;
    const attempts = scene.iteration - scene.startIteration;
    if (attempts === 5 && better && input.repairable) scene.extended = true;
    const stop = scene.noImprovement >= 2 || attempts >= 8 || (attempts >= 5 && !scene.extended);
    scene.stage = accepted ? "completed" : stop ? "best_effort" : "edit";
    if (accepted || stop) copyFileSync(this.path(scene, "best.blend"), this.path(scene, "current.blend"));
    this.save(scene);
    return scene;
  }

  continue(id: string, prompt: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (!["completed", "best_effort"].includes(scene.stage)) throw new Error("Finish the current request before continuing.");
    scene.prompt = prompt;
    scene.stage = "planning";
    scene.startIteration = scene.iteration;
    scene.noImprovement = 0;
    scene.extended = false;
    delete scene.plan;
    delete scene.best;
    delete scene.exportedIteration;
    delete scene.error;
    this.save(scene);
    return scene;
  }

  export(id: string): Scene {
    const scene = this.get(id);
    this.idle(scene);
    if (!scene.best || !["completed", "best_effort"].includes(scene.stage)) {
      throw new Error("Complete scene review before exporting the best version.");
    }
    if (scene.exportedIteration === scene.best.iteration && scene.job?.status !== "failed") return scene;
    const iteration = scene.best.iteration;
    const directory = this.path(scene, `artifacts/${iteration}`);
    mkdirSync(directory, { recursive: true });
    this.enqueue(scene, "export", async () => {
      const template = await readFile(new URL("../blender/export.py", import.meta.url), "utf8");
      const code = template.replace("__SOURCE_BLEND__", py(this.path(scene, "best.blend")))
        .replace("__OUTPUT_DIRECTORY__", py(directory));
      await this.blender.execute(code);
      scene.exportedIteration = iteration;
    });
    return scene;
  }

  allowedFiles(scene: Scene): string[] {
    const files = [scene.reference && "reference", scene.render,
      scene.best && "best.blend", scene.best && "best.png"];
    if (scene.exportedIteration === scene.best?.iteration && scene.exportedIteration !== undefined) {
      for (const name of ["final.glb", "render-profile.json", "environment.exr"]) {
        const file = `artifacts/${scene.exportedIteration}/${name}`;
        if (existsSync(this.path(scene, file))) files.push(file);
      }
    }
    return files.filter((item): item is string => Boolean(item));
  }

  snapshot(scene: Scene, origin: string): Record<string, unknown> {
    const { token, reference, ...publicScene } = scene;
    const url = (file: string) => `${origin}/artifacts/${scene.id}/${file}?token=${token}`;
    return {
      ...publicScene,
      reference: reference ? { ...reference, url: url("reference"), localPath: this.path(scene, "reference") } : null,
      renderUrl: scene.render ? url(scene.render) : null,
      bestRenderUrl: scene.best ? url("best.png") : null,
      artifacts: this.allowedFiles(scene).filter((file) => !["reference", scene.render].includes(file))
        .map((file) => ({ name: file.split("/").at(-1), url: url(file) })),
    };
  }
}

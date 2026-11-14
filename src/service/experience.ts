import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const tags = z.array(z.string().trim().min(1).max(80)).min(1).max(20);
export const retrospectiveSchema = z.object({
  requestId: z.string().trim().min(1).max(100), caseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedDifferences: z.array(text).max(20),
  lessons: z.array(z.object({
    title: z.string().trim().min(1).max(200), tags,
    status: z.enum(["verified", "observation", "preference"]),
    problem: text, cause: text, repair: text, verification: text,
    applicability: text, limitations: z.array(text).min(1).max(20),
    evidenceFiles: z.array(z.string().min(1).max(500)).min(1).max(10),
  })).min(1).max(10),
});
export const proposalSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/), kind: z.enum(["guidance", "blender_function", "check"]),
  title: z.string().trim().min(1).max(200), tags, applicability: text,
  limitations: z.array(text).min(1).max(20), instructions: text,
  sourceLessonIds: z.array(z.string().min(1)).min(1).max(20),
  code: z.string().trim().min(1).max(60000).optional(),
  fixtures: z.array(z.object({ name: z.string().trim().min(1).max(100),
    role: z.enum(["positive", "counterexample"]), code: z.string().trim().min(1).max(30000) })).max(10).default([]),
});
export const replaySchema = z.array(z.object({
  lessonId: z.string().min(1), applies: z.boolean(), passed: z.boolean(), evidence: text,
})).min(1).max(20);
export type RetrospectiveInput = z.input<typeof retrospectiveSchema>;
export type ProposalInput = z.input<typeof proposalSchema>;
export type Replay = z.infer<typeof replaySchema>[number];
export type CaseInput = {
  sceneId: string; iteration: number; exportVersion: string; outcome: string; target: string;
  compositionApproved: boolean; remainingGaps: string[];
  reviews: unknown[]; sourceHashes: Record<string, string>;
};
export type ExperienceCase = CaseInput & { id: string; fingerprint: string };
type Evidence = { original: string; file: string; sha256: string };
type Lesson = z.infer<typeof retrospectiveSchema>["lessons"][number] & { id: string; evidence: Evidence[] };
type Retrospective = { id: string; inputHash: string; requestId: string; source: ExperienceCase;
  acceptedDifferences: string[]; lessons: Lesson[] };
export type Candidate = z.infer<typeof proposalSchema> & { id: string; version: number; hash: string; createdAt: string };
export type FixtureResult = { name: string; testsRun: number; passed: boolean; errors: string[] };
type Validation = { id: string; candidateId: string; candidateHash: string; mode: "blender-tests" | "host-review";
  passed: boolean; replays: Replay[]; fixtures: FixtureResult[]; blenderVersion?: string; error?: string; createdAt: string };
type Library = { cases: Record<string, ExperienceCase>; retrospectives: Retrospective[]; candidates: Candidate[];
  validations: Validation[]; active: Record<string, string> };
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const fileHash = (file: string) => hash(readFileSync(file));

export class ExperienceLibrary {
  readonly directory: string;
  private data: Library;
  constructor(root: string) {
    this.directory = resolve(root, "experience-library");
    mkdirSync(this.directory, { recursive: true });
    const file = resolve(this.directory, "library.json");
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) :
      { cases: {}, retrospectives: [], candidates: [], validations: [], active: {} };
  }
  private save() {
    const file = resolve(this.directory, "library.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(this.data, null, 2)); renameSync(`${file}.tmp`, file);
  }
  capture(input: CaseInput): ExperienceCase {
    const entry = { ...structuredClone(input), id: `${input.sceneId}:${input.iteration}`, fingerprint: hash(JSON.stringify(input)) };
    if (this.data.cases[entry.id]?.fingerprint !== entry.fingerprint) {
      this.data.cases[entry.id] = entry; this.save();
    }
    return structuredClone(entry);
  }
  record(source: ExperienceCase, directory: string, raw: RetrospectiveInput): Retrospective {
    const input = retrospectiveSchema.parse(raw), inputHash = hash(JSON.stringify(input));
    if (source.fingerprint !== input.caseFingerprint) throw new Error("Case changed; reread the current learning.case before recording experience.");
    const previous = this.data.retrospectives.find(r => r.source.id === source.id && r.requestId === input.requestId);
    if (previous) {
      if (previous.inputHash !== inputHash) throw new Error("requestId already records different experience.");
      return structuredClone(previous);
    }
    const evidence = input.lessons.map(l => l.evidenceFiles.map(f => this.copyEvidence(directory, f)));
    const record: Retrospective = { id: `experience_${randomUUID()}`, inputHash, requestId: input.requestId,
      source: structuredClone(source), acceptedDifferences: input.acceptedDifferences,
      lessons: input.lessons.map((l, i) => ({ ...l, id: `lesson_${randomUUID()}`, evidence: evidence[i]! })) };
    this.data.retrospectives.push(record); this.save(); return structuredClone(record);
  }
  private copyEvidence(directory: string, file: string): Evidence {
    const path = resolve(directory, file), rel = relative(resolve(directory), path);
    if (isAbsolute(file) || !rel || rel.startsWith(`..${sep}`) || rel === ".." ||
      ![".png", ".jpg", ".webp", ".json", ".py"].includes(extname(file)) ||
      file.split(/[\\/]/).some(p => p.startsWith(".")) || file.split(/[\\/]/).at(-1) === "run.json") {
      throw new Error("Evidence must be a scene-local image, report or script; run.json and private configuration are excluded.");
    }
    const actual = relative(realpathSync(directory), realpathSync(path));
    if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error("Evidence escapes the scene directory.");
    if (!statSync(path).isFile() || statSync(path).size > 20 * 1024 * 1024) throw new Error("Evidence must be a file of at most 20 MB.");
    const sha256 = fileHash(path), target = `evidence/${sha256}${extname(file)}`;
    mkdirSync(resolve(this.directory, "evidence"), { recursive: true });
    copyFileSync(path, resolve(this.directory, target));
    return { original: file, file: target, sha256 };
  }
  private lesson(id: string): { record: Retrospective; lesson: Lesson } {
    for (const record of this.data.retrospectives) {
      const lesson = record.lessons.find(l => l.id === id);
      if (lesson) return { record, lesson };
    }
    throw new Error(`Unknown source lesson: ${id}`);
  }
  private verifySources(candidate: Candidate) {
    for (const id of candidate.sourceLessonIds) {
      const { lesson } = this.lesson(id);
      if (lesson.status !== "verified") throw new Error("Only verified lessons can become shared skills; preferences and observations stay as cases.");
      for (const e of lesson.evidence) if (!existsSync(resolve(this.directory, e.file)) || fileHash(resolve(this.directory, e.file)) !== e.sha256) {
        throw new Error("Source evidence is missing or changed.");
      }
    }
  }
  propose(raw: ProposalInput): Candidate {
    const input = proposalSchema.parse(raw);
    if (new Set(input.sourceLessonIds).size !== input.sourceLessonIds.length ||
      new Set(input.fixtures.map(f => f.name)).size !== input.fixtures.length) throw new Error("Source lessons and fixture names must be distinct.");
    if (input.kind === "guidance" ? input.code || input.fixtures.length : !input.code ||
      !input.fixtures.some(f => f.role === "positive") || !input.fixtures.some(f => f.role === "counterexample")) {
      throw new Error("Guidance uses host case review; executable skills require code and positive/counterexample unittest fixtures.");
    }
    // Repeating an identical proposal is idempotent; revisions always get a new immutable version.
    const digest = hash(JSON.stringify(input));
    const previous = this.data.candidates.find(c => c.hash === digest);
    if (previous) return structuredClone(previous);
    const version = Math.max(0, ...this.data.candidates.filter(c => c.key === input.key).map(c => c.version)) + 1;
    const entry: Candidate = { ...input, version, id: `${input.key}@${version}`, hash: digest, createdAt: new Date().toISOString() };
    this.verifySources(entry); this.data.candidates.push(entry); this.save(); return structuredClone(entry);
  }
  candidate(id: string): Candidate {
    const entry = this.data.candidates.find(c => c.id === id);
    if (!entry) throw new Error("Unknown skill candidate.");
    this.verifySources(entry); return structuredClone(entry);
  }
  checkReplays(candidate: Candidate, replays: Replay[]): Replay[] {
    const input = replaySchema.parse(replays);
    if (new Set(input.map(r => r.lessonId)).size !== input.length ||
      candidate.sourceLessonIds.some(id => !input.some(r => r.lessonId === id))) throw new Error("Review each source lesson exactly once.");
    for (const r of input) this.lesson(r.lessonId);
    if (candidate.kind === "guidance" &&
      (new Set(input.map(r => this.lesson(r.lessonId).record.source.sceneId)).size < 2 ||
        !input.some(r => r.applies) || !input.some(r => !r.applies))) {
      throw new Error("Guidance needs host review across distinct scenes, including an applicable case and a counterexample.");
    }
    return input;
  }
  validate(id: string, expectedHash: string, replays: Replay[], results: FixtureResult[], blenderVersion?: string, error?: string): Validation {
    const candidate = this.candidate(id);
    if (candidate.hash !== expectedHash) throw new Error("Candidate hash changed.");
    this.checkReplays(candidate, replays);
    results = z.array(z.object({ name: z.string(), testsRun: z.number().int().nonnegative(), passed: z.boolean(),
      errors: z.array(z.string()) })).parse(results);
    const fixturesPassed = candidate.kind === "guidance" || candidate.fixtures.length === results.length &&
      candidate.fixtures.every(f => results.some(r => r.name === f.name && r.passed && r.testsRun > 0));
    const validation: Validation = { id: `validation_${randomUUID()}`, candidateId: id, candidateHash: expectedHash,
      mode: candidate.kind === "guidance" ? "host-review" : "blender-tests",
      passed: !error && replays.every(r => r.passed) && fixturesPassed, replays, fixtures: results,
      ...(blenderVersion ? { blenderVersion } : {}), ...(error ? { error } : {}), createdAt: new Date().toISOString() };
    this.data.validations.push(validation);
    if (!validation.passed && this.data.active[candidate.key] === id) delete this.data.active[candidate.key];
    this.save(); return structuredClone(validation);
  }
  activate(id: string, validationId: string) {
    const candidate = this.candidate(id);
    const validation = this.data.validations.filter(v => v.candidateId === id).at(-1);
    if (!validation || validation.id !== validationId || validation.candidateHash !== candidate.hash || !validation.passed) {
      throw new Error("Activate only the latest passing validation of this exact candidate.");
    }
    this.data.active[candidate.key] = id; this.save(); return { candidate, validation };
  }
  retire(id: string) {
    const candidate = this.data.candidates.find(c => c.id === id);
    if (!candidate) throw new Error("Unknown skill candidate.");
    if (this.data.active[candidate.key] === id) delete this.data.active[candidate.key];
    this.save(); return { id, active: false };
  }
  search(query: string, includeCandidates = false) {
    const words = (query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 100);
    const terms = [...new Set(words.flatMap(w => /[\u3400-\u9fff]/.test(w) ? Array.from(w).slice(0, -1).map((c, i) => c + Array.from(w)[i + 1]) : [w]))];
    const score = (s: string) => terms.reduce((n, t) => n + Number(s.toLowerCase().includes(t)), 0);
    const skills = this.data.candidates.filter(c => includeCandidates || this.data.active[c.key] === c.id &&
      this.data.validations.filter(v => v.candidateId === c.id).at(-1)?.passed).filter(c => {
      try { this.verifySources(c); return true; } catch { return false; }
    }).map(c => ({ ...structuredClone(c), active: this.data.active[c.key] === c.id,
      validation: structuredClone(this.data.validations.filter(v => v.candidateId === c.id).at(-1)),
      score: score([c.title, ...c.tags, c.applicability].join(" ")) })).filter(c => !terms.length || c.score > 0)
      .sort((a, b) => b.score - a.score || b.version - a.version).slice(0, 10);
    const experiences = this.data.retrospectives.filter(r => !terms.length || r.lessons.some(l => score([l.title, ...l.tags, l.problem].join(" "))))
      .slice(-10).map(r => structuredClone(r));
    return { skills, experiences, pendingCases: this.pendingCases(),
      // ponytail: scan local records; add indexing only when the library outgrows this bounded response.
      batchDue: new Set(this.pendingLessons().map(l => l.sceneId)).size >= 3 };
  }
  private pendingLessons() {
    const used = new Set(this.data.candidates.filter(c => this.data.active[c.key] === c.id).flatMap(c => c.sourceLessonIds));
    return this.data.retrospectives.flatMap(r => r.lessons.filter(l => l.status === "verified" && !used.has(l.id))
      .map(l => ({ lessonId: l.id, sceneId: r.source.sceneId })));
  }
  private pendingCases() {
    return Object.values(this.data.cases).filter(c => !this.data.retrospectives.some(r => r.source.fingerprint === c.fingerprint))
      .map(c => ({ id: c.id, fingerprint: c.fingerprint, sceneId: c.sceneId, iteration: c.iteration })).slice(-10);
  }
  context(sceneId: string, query: string) {
    const found = this.search(query), source = Object.values(this.data.cases).filter(c => c.sceneId === sceneId).at(-1);
    const { reviews: _, ...brief } = source ?? { reviews: [] };
    return { case: source ? structuredClone(brief) : null,
      retrospectiveDue: !!source && !this.data.retrospectives.some(r => r.source.fingerprint === source.fingerprint),
      batchDue: found.batchDue, pendingCases: found.pendingCases,
      skills: found.skills.map(({ id, hash, title, kind, applicability }) => ({ id, hash, title, kind, applicability })) };
  }
}

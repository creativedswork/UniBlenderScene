import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceLibrary, type ProposalInput } from "../src/service/experience.js";
import { BlenderClient } from "../src/service/blender.js";
import { SceneStore } from "../src/service/store.js";
import { createMcpServer } from "../src/service/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "scene-learning-")), directory = join(root, "case-files");
  mkdirSync(directory); writeFileSync(join(directory, "proof.json"), '{"shadow":"restored"}');
  const library = new ExperienceLibrary(root);
  const source = library.capture({ sceneId: "scene_a", iteration: 3, exportVersion: "export-a", outcome: "best_effort",
    target: "Sun shadow", compositionApproved: true, remainingGaps: ["detail"], reviews: [], sourceHashes: { "best.blend": "abc" } });
  const input = { requestId: "review-a", caseFingerprint: source.fingerprint, acceptedDifferences: ["Simplified crowd"], lessons: [{
    title: "Sun direction", tags: ["sun", "lighting"], status: "verified" as const, problem: "Shadow missing",
    cause: "Default light offset", repair: "Reset offset", verification: "Direction and screenshot agree",
    applicability: "Directional light transforms", limitations: ["Does not prove photoreal appearance"], evidenceFiles: ["proof.json"],
  }] };
  return { root, directory, library, source, input };
}
function proposal(sourceLessonIds: string[]): ProposalInput {
  return { key: "sun-direction", kind: "check", title: "Check sun direction", tags: ["sun"], applicability: "Directional lights",
    limitations: ["Does not judge visual quality"], instructions: "Compare world-space directions", sourceLessonIds,
    code: "def direction(): return 55", fixtures: [{ name: "positive", role: "positive", code: "test" },
      { name: "counterexample", role: "counterexample", code: "test" }] };
}
const reports = [{ name: "positive", testsRun: 1, passed: true, errors: [] }, { name: "counterexample", testsRun: 1, passed: true, errors: [] }];

test("retrospectives bind current evidence, preserve accepted gaps and immutable files, and survive restart", () => {
  const { root, directory, library, source, input } = setup();
  assert.equal(library.context("scene_a", "sun").retrospectiveDue, true);
  assert.throws(() => library.record(source, directory, { ...input, caseFingerprint: "0".repeat(64) }), /Case changed/);
  const record = library.record(source, directory, input);
  assert.deepEqual(record.acceptedDifferences, ["Simplified crowd"]);
  assert.equal(record.source.outcome, "best_effort");
  assert.deepEqual(library.record(source, directory, input), record);
  assert.throws(() => library.record(source, directory, { ...input, acceptedDifferences: [] }), /requestId/);
  writeFileSync(join(directory, "proof.json"), "replaced after scene refinement");
  assert.equal(readFileSync(join(library.directory, record.lessons[0]!.evidence[0]!.file), "utf8"), '{"shadow":"restored"}');
  assert.equal(new ExperienceLibrary(root).context("scene_a", "sun").retrospectiveDue, false);
  const changed = library.capture({ ...source, exportVersion: "export-b" });
  assert.notEqual(changed.fingerprint, source.fingerprint);
  assert.equal(library.context("scene_a", "sun").retrospectiveDue, true);
});

test("evidence boundaries reject path escapes and private run state; preferences cannot become global skills", () => {
  const { root, directory, library, source, input } = setup();
  writeFileSync(join(root, "outside.json"), "outside"); writeFileSync(join(directory, "run.json"), "private");
  symlinkSync(join(root, "outside.json"), join(directory, "escape.json"));
  for (const f of ["../outside.json", "run.json", "escape.json", ".env", "/etc/passwd"]) {
    assert.throws(() => library.record(source, directory, { ...input, lessons: [{ ...input.lessons[0]!, evidenceFiles: [f] }] }));
  }
  const r = library.record(source, directory, { ...input, lessons: [{ ...input.lessons[0]!, status: "preference" }] });
  assert.throws(() => library.propose(proposal([r.lessons[0]!.id])), /Only verified/);
});

test("only passing exact versions enter retrieval; failed validations, revisions and retirement preserve rollback", () => {
  const { root, directory, library, source, input } = setup();
  const r = library.record(source, directory, input), lessonId = r.lessons[0]!.id;
  const p = library.propose(proposal([lessonId])), replays = [{ lessonId, applies: true, passed: true, evidence: "Rechecked source evidence" }];
  assert.deepEqual(library.propose(proposal([lessonId])), p);
  assert.equal(library.search("sun").skills.length, 0);
  assert.throws(() => library.activate(p.id, "fabricated"), /latest passing/);
  assert.throws(() => library.validate(p.id, "stale", replays, reports), /hash/);
  const empty = library.validate(p.id, p.hash, replays, reports.map(r => ({ ...r, testsRun: 0 })));
  assert.equal(empty.passed, false); assert.throws(() => library.activate(p.id, empty.id), /latest passing/);
  const passed = library.validate(p.id, p.hash, replays, reports, "5.1.1");
  library.activate(p.id, passed.id);
  assert.equal(new ExperienceLibrary(root).search("sun").skills[0]!.id, p.id);
  const v2 = library.propose({ ...proposal([lessonId]), code: "def direction(): return 80" });
  assert.equal(v2.version, 2); assert.equal(library.search("sun").skills[0]!.id, p.id);
  const failed = library.validate(p.id, p.hash, replays, [{ ...reports[0]!, passed: false }, reports[1]!]);
  assert.equal(failed.passed, false); assert.equal(library.search("sun").skills.length, 0);
  assert.throws(() => library.activate(p.id, passed.id), /latest passing/);
  const revalidated = library.validate(p.id, p.hash, replays, reports);
  library.activate(p.id, revalidated.id); library.retire(p.id); assert.equal(library.search("sun").skills.length, 0);
  library.activate(p.id, revalidated.id);
  writeFileSync(join(library.directory, r.lessons[0]!.evidence[0]!.file), "corrupted");
  assert.equal(library.search("sun").skills.length, 0);
  assert.throws(() => library.activate(p.id, revalidated.id), /evidence/);
  assert.doesNotThrow(() => library.retire(p.id));
});

test("guidance requires distinct-scene positive and counterexample reviews and stays labelled host-reviewed", () => {
  const { directory, library, source, input } = setup();
  const first = library.record(source, directory, input).lessons[0]!.id;
  const next = library.capture({ ...source, sceneId: "scene_b", exportVersion: "b" });
  const second = library.record(next, directory, { ...input, caseFingerprint: next.fingerprint }).lessons[0]!.id;
  const { code: _, fixtures: __, ...base } = proposal([first, second]);
  const p = library.propose({ ...base, key: "shadow-guidance", kind: "guidance" });
  assert.throws(() => library.validate(p.id, p.hash, [{ lessonId: first, applies: true, passed: true, evidence: "Only one scene" }], []), /each source/);
  const replays = [first, second].map(lessonId => ({ lessonId, applies: true, passed: true, evidence: "Reviewed case" }));
  assert.throws(() => library.validate(p.id, p.hash, replays, []), /counterexample/);
  replays[1]!.applies = false;
  const valid = library.validate(p.id, p.hash, replays, []);
  assert.equal(valid.mode, "host-review"); library.activate(p.id, valid.id);
  assert.equal(library.search("sun").skills.length, 1);
});

test("batch consolidation counts distinct scenes and stops counting activated source lessons", () => {
  const { directory, library, source, input } = setup();
  const ids: string[] = [];
  for (const sceneId of ["scene_a", "scene_a", "scene_b", "scene_c"]) {
    const c = library.capture({ ...source, sceneId, exportVersion: String(ids.length) });
    const record = library.record(c, directory, { ...input, requestId: String(ids.length), caseFingerprint: c.fingerprint });
    ids.push(record.lessons[0]!.id);
    assert.equal(library.context(sceneId, "sun").batchDue, sceneId === "scene_c");
  }
  const candidate = library.propose(proposal(ids));
  const validation = library.validate(candidate.id, candidate.hash,
    ids.map(lessonId => ({ lessonId, applies: true, passed: true, evidence: "Reviewed relevant source" })), reports);
  library.activate(candidate.id, validation.id);
  assert.equal(library.context("scene_c", "sun").batchDue, false);
});

class FixtureBlender extends BlenderClient {
  fail = false;
  override async execute(code: string) {
    if (code.includes("_request = json.loads")) {
      if (this.fail) throw new Error("Fixture exception");
      return { fixtures: reports, blenderVersion: "test double" };
    }
    return {};
  }
}
test("SceneStore validation preserves workflow and MCP exposes the full outer-loop tool sequence", async () => {
  const { root, directory, library, source, input } = setup();
  const r = library.record(source, directory, input), lessonId = r.lessons[0]!.id;
  const p = library.propose(proposal([lessonId]));
  const blender = new FixtureBlender(), store = new SceneStore(root, blender);
  const scene = store.create("Sun lighting"); await store.settled();
  // Minimal checkpoint fixture; runtime restoration itself is covered in the native integration.
  writeFileSync(store.path(scene, "current.blend"), "unchanged");
  const replays = [{ lessonId, applies: true, passed: true, evidence: "Reviewed" }];
  const before = { stage: scene.stage, iteration: scene.iteration, approval: scene.compositionApproved };
  store.validateExperienceSkill(scene.id, p.id, p.hash, replays); await store.settled();
  assert.equal(scene.skillValidation!.passed, true);
  assert.deepEqual({ stage: scene.stage, iteration: scene.iteration, approval: scene.compositionApproved }, before);
  blender.fail = true;
  store.validateExperienceSkill(scene.id, p.id, p.hash, replays); await store.settled();
  assert.equal(scene.job!.status, "failed"); assert.equal(scene.skillValidation!.passed, false);
  assert.equal(readFileSync(store.path(scene, "current.blend"), "utf8"), "unchanged");
  const server = createMcpServer(store, "http://localhost"), client = new Client({ name: "learning-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ["scene_experience", "scene_library_search", "scene_skill_propose", "scene_skill_validate", "scene_skill_activate"]) assert.ok(names.includes(name));
    const found = await client.callTool({ name: "scene_library_search", arguments: { query: "sun", includeCandidates: true } });
    assert.equal(found.isError, undefined);
    assert.equal((found.structuredContent as any).skills[0].id, p.id);
    const forbidden = await client.callTool({ name: "scene_skill_activate", arguments: { candidateId: p.id, action: "activate" } });
    assert.equal(forbidden.isError, true);
  } finally { await client.close(); await server.close(); }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Call = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
export async function testExperienceLibrary(call: Call, poll: (id: string) => Promise<Record<string, any>>,
  sceneId: string, root: string) {
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args); assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent as Record<string, any>;
  };
  const initial = await invoke("scene_get", { sceneId, images: "none" });
  assert.equal(initial.learning.retrospectiveDue, true, "Export automatically captures an outer-loop case");
  const source = initial.learning.case;
  const current = join(root, ".canova/runs", sceneId, "current.blend"), best = join(root, ".canova/runs", sceneId, "best.blend");
  const beforeCurrent = await readFile(current), beforeBest = await readFile(best);
  const recorded = await invoke("scene_experience", { sceneId, retrospective: {
    requestId: "native-library-fixture", caseFingerprint: source.fingerprint,
    acceptedDifferences: ["Synthetic integration case; no photoreal quality claim or user acceptance"],
    lessons: [{ title: "Directional light fixture", tags: ["sun", "direction"], status: "verified",
      problem: "A transformed light can point in an unintended direction", cause: "Local and world directions differ",
      repair: "Set explicit direction and compare normalized world vectors",
      verification: "Synthetic test lesson; executable generalization is checked by the following Blender fixtures",
      applicability: "Directional light transforms", limitations: ["Does not establish image fidelity"], evidenceFiles: ["best.png", "scripts/iteration-1.py"] }],
  } });
  const lessonId = recorded.lessons[0].id;
  const definition = JSON.parse(await readFile("tests/fixtures/learned-sun.json", "utf8"));
  const candidate = await invoke("scene_skill_propose", { ...definition, sourceLessonIds: [lessonId] });
  const replays = [{ lessonId, applies: true, passed: true, evidence: "Host reviewed the synthetic transform case and limited its scope" }];
  await invoke("scene_skill_validate", { sceneId, candidateId: candidate.id, expectedHash: candidate.hash, replays });
  const validated = await poll(sceneId);
  assert.equal(validated.skillValidation.passed, true);
  assert.equal(validated.stage, initial.stage); assert.equal(validated.iteration, initial.iteration);
  assert.deepEqual(validated.stageAllowances, initial.stageAllowances);
  assert.equal(validated.compositionApproved, initial.compositionApproved);
  assert.deepEqual(await readFile(current), beforeCurrent); assert.deepEqual(await readFile(best), beforeBest);
  assert.equal((await invoke("scene_get", { sceneId, objectName: "RedCube" })).inspectedObject.name, "RedCube");
  const inspected = await invoke("scene_library_search", { query: "sun", includeCandidates: true });
  const checked = inspected.skills.find((s: any) => s.id === candidate.id).validation;
  assert.equal(checked.mode, "blender-tests");
  assert.equal(checked.fixtures.reduce((n: number, f: any) => n + f.testsRun, 0), 4);
  await invoke("scene_skill_activate", { candidateId: candidate.id, action: "activate", validationId: validated.skillValidation.validationId });
  const nextScene = await invoke("scene_create", { prompt: "Sun direction lighting" }); await poll(nextScene.id);
  const next = await invoke("scene_get", { sceneId: nextScene.id, images: "none" });
  assert.equal(next.learning.skills[0].id, candidate.id, "A new task automatically sees the active learned skill");
  // A faulty generalization must not replace the working version.
  const broken = await invoke("scene_skill_propose", { ...definition, sourceLessonIds: [lessonId], code: definition.code.replace('elevation), math.radians(azimuth)', '10), math.radians(azimuth)') });
  assert.notEqual(broken.id, candidate.id);
  await invoke("scene_skill_validate", { sceneId, candidateId: broken.id, expectedHash: broken.hash, replays });
  const rejected = await poll(sceneId); assert.equal(rejected.skillValidation.passed, false);
  const activation = await call("scene_skill_activate", { candidateId: broken.id, action: "activate", validationId: rejected.skillValidation.validationId });
  assert.equal(activation.isError, true);
  assert.equal((await invoke("scene_library_search", { query: "sun" })).skills[0].id, candidate.id);
  // Empty unittest fixtures cannot manufacture validation success.
  const empty = await invoke("scene_skill_propose", { ...definition, sourceLessonIds: [lessonId],
    fixtures: definition.fixtures.map((f: any) => ({ ...f, code: "pass" })) });
  await invoke("scene_skill_validate", { sceneId, candidateId: empty.id, expectedHash: empty.hash, replays });
  assert.equal((await poll(sceneId)).skillValidation.passed, false);
  assert.deepEqual(await readFile(current), beforeCurrent); assert.deepEqual(await readFile(best), beforeBest);
  return { candidateId: candidate.id, blenderTests: 4, sourceRestored: true, faultyVersionRejected: true, emptySuiteRejected: true };
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Call = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export async function prepareSpatialTrial(call: Call, poll: (id: string) => Promise<Record<string, any>>, sceneId: string) {
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args); assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent as Record<string, any>;
  };
  const record = async (id: string) => {
    const scene = await invoke("scene_get", { sceneId: id, images: "none" });
    const recorded = await invoke("scene_experience", { sceneId: id, retrospective: {
      requestId: "spatial-library-synthetic-fixture", caseFingerprint: scene.learning.case.fingerprint, acceptedDifferences: [],
      lessons: [{ title: "World-space geometry and spatial reward fixture", tags: ["spatial", "spacing"], status: "verified",
        problem: "Local coordinates and abbreviated inventories can misrepresent inter-object distances",
        cause: "Parent transforms and inventory truncation", repair: "Use complete evaluated world-space geometry",
        verification: "Synthetic integration assertions cover runtime transforms; paired row fixture exercises score-driven correction. No scene-quality claim.",
        applicability: "World-space spatial measurements", limitations: ["AABB approximation; not visual acceptance"],
        evidenceFiles: ["best.png", "scripts/iteration-1.py"] }],
    } });
    return recorded.lessons[0].id as string;
  };
  const lessonId = await record(sceneId);
  const definition = { key: "spatial-spacing", kind: "spatial_score", title: "World-space spacing reward", tags: ["spatial", "spacing"],
    applicability: "Adjacent center spacing on a world axis", limitations: ["Not surface contact or appearance quality"],
    instructions: "Use score(layouts, relation); preserve world-unit tolerances and inspect renders independently",
    sourceLessonIds: [lessonId], code: await readFile("skills/blender-spatial/scripts/scores.py", "utf8"), fixtures: [
      { name: "uniform-row", role: "positive", code: `import unittest
class Uniform(unittest.TestCase):
    def test_uniform(self):
        layout = {str(i): {'min':[i*2,0,0], 'max':[i*2+1,1,1]} for i in range(3)}
        relation = {'type':'spacing','axis':'x','tolerance':.01,'spacing':2,'participants':[{'nodeId':str(i)} for i in range(3)]}
        self.assertEqual(skill.score(layout, relation), 1)
` },
      { name: "unequal-gaps", role: "counterexample", code: `import unittest
class Unequal(unittest.TestCase):
    def test_unequal(self):
        layout = {str(i): {'min':[x,0,0], 'max':[x+1,1,1]} for i,x in enumerate([0,2.5,4])}
        relation = {'type':'spacing','axis':'x','tolerance':.01,'spacing':2,'participants':[{'nodeId':str(i)} for i in range(3)]}
        self.assertLess(skill.score(layout, relation), .5)
` },
    ] };
  const candidate = await invoke("scene_skill_propose", definition);
  const firstReplay = { lessonId, applies: true, passed: true, evidence: "Reviewed synthetic world-transform evidence and scope" };
  await invoke("scene_skill_validate", { sceneId, candidateId: candidate.id, expectedHash: candidate.hash, replays: [firstReplay] });
  const checked = await poll(sceneId); assert.equal(checked.skillValidation.passed, true);
  const early = await call("scene_skill_activate", { candidateId: candidate.id, action: "activate", validationId: checked.skillValidation.validationId });
  assert.equal(early.isError, true, "One-scene scoring candidates are local trials only");

  return { candidate, async consolidate(secondSceneId: string) {
    const second = await record(secondSceneId);
    const replays = [firstReplay, { ...firstReplay, lessonId: second, evidence: "Reviewed measured row error and score-driven correction" }];
    const shared = await invoke("scene_skill_propose", { ...definition, sourceLessonIds: [lessonId, second] });
    await invoke("scene_skill_validate", { sceneId: secondSceneId, candidateId: shared.id, expectedHash: shared.hash, replays });
    const validated = await poll(secondSceneId); assert.equal(validated.skillValidation.passed, true);
    await invoke("scene_skill_activate", { candidateId: shared.id, action: "activate", validationId: validated.skillValidation.validationId });
    const bad = await invoke("scene_skill_propose", { ...definition, sourceLessonIds: [lessonId, second], code: "def score(layouts, relation): return 1.0",
      fixtures: definition.fixtures.map(f => ({ ...f, code: "import unittest\nclass Weak(unittest.TestCase):\n    def test_weak(self): self.assertEqual(skill.score({}, {}), 1)" })) });
    await invoke("scene_skill_validate", { sceneId: secondSceneId, candidateId: bad.id, expectedHash: bad.hash, replays });
    const rejected = await poll(secondSceneId); assert.equal(rejected.skillValidation.passed, false);
    const found = await invoke("scene_library_search", { query: "spatial", includeCandidates: true });
    const report = found.skills.find((s: any) => s.id === bad.id).validation;
    assert.ok(report.fixtures.every((r: any) => r.passed), "Candidate weakened its own tests");
    assert.ok(report.regressions.some((r: any) => !r.passed), "Inherited counterexamples detect reward gaming");
    const activation = await call("scene_skill_activate", { candidateId: bad.id, action: "activate", validationId: rejected.skillValidation.validationId });
    assert.equal(activation.isError, true);
    assert.equal((await invoke("scene_library_search", { query: "spatial" })).skills[0].id, shared.id);
    const facing = await invoke("scene_skill_propose", { ...definition, key: "spatial-facing", title: "Planar facing reward", tags: ["spatial", "facing"],
      applicability: "Coherent object frames and a target direction in world XY", limitations: ["No pitch/roll evaluation or visual-quality claim"], sourceLessonIds: [lessonId, second],
      code: `import math
def score(layouts, relation):
    roles = {p['role']: layouts[p['nodeId']] for p in relation['participants']}
    subject, target = roles['subject'], roles['target']
    delta = [(target['min'][i]+target['max'][i]-subject['min'][i]-subject['max'][i])/2 for i in range(2)]
    axis = int(relation['parameters']['forwardAxis'])
    forward = [subject['matrixWorld'][i][axis] for i in range(2)]
    denominator = math.hypot(*delta) * math.hypot(*forward)
    if not denominator: raise ValueError('Undefined planar facing direction')
    cosine = sum(a*b for a,b in zip(delta, forward)) / denominator
    return (max(-1, min(1, cosine))+1)/2
`, fixtures: [
        { name: "faces-target", role: "positive", code: `import unittest
class Facing(unittest.TestCase):
    def test_front(self):
        layout = {'subject':{'min':[0,0,0],'max':[1,1,1],'matrixWorld':[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]},'target':{'min':[0,3,0],'max':[1,4,1]}}
        relation = {'participants':[{'nodeId':'subject','role':'subject'},{'nodeId':'target','role':'target'}],'parameters':{'forwardAxis':1}}
        self.assertEqual(skill.score(layout, relation), 1)
` },
        { name: "faces-away", role: "counterexample", code: `import unittest
class Away(unittest.TestCase):
    def test_back(self):
        layout = {'subject':{'min':[0,0,0],'max':[1,1,1],'matrixWorld':[[1,0,0,0],[0,-1,0,0],[0,0,1,0],[0,0,0,1]]},'target':{'min':[0,3,0],'max':[1,4,1]}}
        relation = {'participants':[{'nodeId':'subject','role':'subject'},{'nodeId':'target','role':'target'}],'parameters':{'forwardAxis':1}}
        self.assertEqual(skill.score(layout, relation), 0)
` },
      ] });
    await invoke("scene_skill_validate", { sceneId: secondSceneId, candidateId: facing.id, expectedHash: facing.hash, replays });
    const facingValidated = await poll(secondSceneId); assert.equal(facingValidated.skillValidation.passed, true);
    await invoke("scene_skill_activate", { candidateId: facing.id, action: "activate", validationId: facingValidated.skillValidation.validationId });
    return { shared, facing };
  } };
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { checkRelations, validateRelations, type SceneRelation } from "../src/service/relations.js";

test("bundled Python rewards distinguish positive, near-miss and counterexample geometry", () => {
  const result = spawnSync("python3", ["-B", "tests/spatial_scores_test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /Ran 4 tests/);
});

test("learned relation validation and review require pinned finite scores", () => {
  const relation: SceneRelation = { id: "facing", type: "skill", description: "Subject faces its target",
    participants: [{ nodeId: "a", role: "subject" }, { nodeId: "b", role: "target" }], criterionIds: ["layout"],
    scorer: { id: "facing@1", hash: "a".repeat(64) }, minScore: .9, parameters: { forwardAxis: 1 } };
  const nodes = ["a", "b"].map(id => ({ id, parentId: null }));
  validateRelations(nodes, [{ id: "layout" }], [relation]);
  for (const patch of [{ scorer: undefined }, { minScore: undefined }, { minScore: 1.1 }, { parameters: { bad: NaN } }, { axis: "x" as const }]) {
    assert.throws(() => validateRelations(nodes, [{ id: "layout" }], [{ ...relation, ...patch }]));
  }
  assert.equal(checkRelations([relation], {})[0]!.status, "unmeasurable");
  assert.equal(checkRelations([relation], {}, [{ relationId: "facing", score: NaN, status: "passed" }])[0]!.status, "unmeasurable");
  const provenance = { scorerId: "facing@1", scorerHash: "a".repeat(64) };
  assert.equal(checkRelations([relation], {}, [{ relationId: "facing", score: .95, status: "passed", ...provenance }])[0]!.status, "passed");
  assert.equal(checkRelations([relation], {}, [{ relationId: "facing", score: .5, status: "failed", ...provenance }])[0]!.status, "failed");
  assert.equal(checkRelations([relation], {}, [{ relationId: "facing", score: 1, status: "passed", ...provenance, scorerHash: "0".repeat(64) }])[0]!.status, "unmeasurable");
});

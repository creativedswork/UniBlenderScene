import test from "node:test";
import assert from "node:assert/strict";
import { checkRelations, relationsForScope, validateRelations, verifyRelationReviews, type SceneRelation } from "../src/service/relations.js";

const nodes = ["vase", "table", "chair"].map((id) => ({ id, parentId: null }));
const criteria = [{ id: "layout" }];
const support: SceneRelation = { id: "vase-on-table", type: "support", description: "Vase rests on table",
  participants: [{ nodeId: "vase", role: "subject" }, { nodeId: "table", role: "support" }],
  criterionIds: ["layout"], axis: "z", tolerance: 0.01 };
const bounds = { vase: { min: [-0.1, -0.1, 1], max: [0.1, 0.1, 1.4] }, table: { min: [-1, -1, 0], max: [1, 1, 1] },
  chair: { min: [1.9, -0.1, 0], max: [2.1, 0.1, 1] } };

test("relation nodes validate participants, roles, criterion bindings and measurement parameters", () => {
  validateRelations(nodes, criteria, [support]);
  const invalid: Partial<SceneRelation>[] = [
    { id: "table" }, { id: " " }, { criterionIds: ["unknown"] }, { tolerance: NaN }, { tolerance: -1 },
    { participants: [{ nodeId: "vase", role: "subject" }, { nodeId: "missing", role: "support" }] },
    { participants: [{ nodeId: "vase", role: "subject" }, { nodeId: "vase", role: "support" }] },
    { participants: [{ nodeId: "vase", role: "member" }, { nodeId: "table", role: "member" }] },
    { axis: "x" }, { spacing: 1 }, { type: "semantic" },
  ];
  for (const patch of invalid) assert.throws(() => validateRelations(nodes, criteria, [{ ...support, ...patch }]));
  assert.throws(() => validateRelations(nodes, criteria, [support, support]), /IDs/);
});

test("support detects floating, penetration, missing bounds and placement beyond the support footprint", () => {
  assert.equal(checkRelations([support], bounds)[0]!.status, "passed");
  for (const vase of [
    { min: [-0.1, -0.1, 1.2], max: [0.1, 0.1, 1.6] },
    { min: [-0.1, -0.1, 0.8], max: [0.1, 0.1, 1.2] },
    { min: [3, 3, 1], max: [3.2, 3.2, 1.4] },
  ]) assert.equal(checkRelations([support], { ...bounds, vase })[0]!.status, "failed");
  assert.equal(checkRelations([support], {})[0]!.status, "unmeasurable");
  assert.equal(checkRelations([support], { ...bounds, vase: { min: [0, 0, NaN], max: [1, 1, 2] } })[0]!.status, "unmeasurable");
});

test("alignment and spacing measure multiple objects along the explicitly chosen world axis", () => {
  const relation: SceneRelation = { ...support, id: "row", type: "alignment", axis: "y",
    participants: nodes.map((node) => ({ nodeId: node.id, role: "member" })) };
  validateRelations(nodes, criteria, [relation]);
  assert.equal(checkRelations([relation], bounds)[0]!.status, "passed");
  assert.equal(checkRelations([{ ...relation, axis: "x" }], bounds)[0]!.status, "failed");
  const spacing: SceneRelation = { ...relation, type: "spacing", axis: "x", spacing: 1 };
  const row = { ...bounds, vase: { min: [-1.1, -0.1, 0], max: [-0.9, 0.1, 1] },
    chair: { min: [0.9, -0.1, 0], max: [1.1, 0.1, 1] } };
  validateRelations(nodes, criteria, [spacing]);
  assert.equal(checkRelations([spacing], row)[0]!.status, "passed");
  assert.equal(checkRelations([spacing], bounds)[0]!.status, "failed");
});

test("active relation reviews cannot omit, duplicate, invent, or override failed measurements", () => {
  const review = { relationId: support.id, passed: true, evidence: "Render and measured bounds agree" };
  const checks = checkRelations([support], bounds);
  verifyRelationReviews([support], ["layout"], checks, [review]);
  verifyRelationReviews([support], ["materials"], checks, []);
  assert.throws(() => verifyRelationReviews([support], ["layout"], checks, []), /exactly once/);
  assert.throws(() => verifyRelationReviews([support], ["layout"], checks, [review, review]), /exactly once/);
  assert.throws(() => verifyRelationReviews([support], ["layout"], checks, [{ ...review, relationId: "unknown" }]), /exactly once/);
  assert.throws(() => verifyRelationReviews([support], ["layout"], checkRelations([support], {}), [review]), /cannot pass/);
  assert.throws(() => verifyRelationReviews([support], ["layout"], [{ ...checks[0]!, status: "failed" }], [review]), /cannot pass/);
  assert.throws(() => verifyRelationReviews([support], ["layout"], checks, [{ ...review, passed: false }]), /correction/);
  verifyRelationReviews([support], ["layout"], checks, [{ ...review, passed: false, correction: "Fix visible surface penetration" }]);
  const semantic: SceneRelation = { id: "occlusion", type: "semantic", description: "Chair visible beside table in primary view",
    participants: support.participants, criterionIds: ["layout"] };
  validateRelations(nodes, criteria, [semantic]);
  verifyRelationReviews([semantic], ["layout"], checkRelations([semantic], {}), [{ ...review, relationId: semantic.id }]);
});

test("scoped revision dependencies include parent/child relations without changing the authorized scope", () => {
  const hierarchy = [...nodes, { id: "vase-rim", parentId: "vase" }];
  const scope = ["vase-rim"];
  assert.deepEqual(relationsForScope(hierarchy, [support], scope), [support]);
  assert.deepEqual(relationsForScope(hierarchy, [support], ["chair"]), []);
  assert.deepEqual(relationsForScope(hierarchy, [support], []), []);
  const childRelation = { ...support, participants: [{ nodeId: "vase-rim", role: "subject" }, { nodeId: "table", role: "support" }] };
  assert.deepEqual(relationsForScope(hierarchy, [childRelation], ["vase"]), [childRelation]);
  assert.deepEqual(scope, ["vase-rim"]);
});

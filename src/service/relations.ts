export type RelationNode = { id: string; parentId: string | null };
export type SceneRelation = {
  id: string;
  type: "support" | "alignment" | "spacing" | "semantic";
  description: string;
  participants: { nodeId: string; role: string }[];
  criterionIds: string[];
  axis?: "x" | "y" | "z";
  tolerance?: number;
  spacing?: number;
};
export type RelationReview = { relationId: string; passed: boolean; evidence: string; correction?: string };
export type RelationCheck = {
  relationId: string; status: "passed" | "failed" | "unmeasurable" | "visual";
  evidence: string; error?: number; tolerance?: number;
};
type Bounds = { min: number[]; max: number[] };

export function relationsForScope(nodes: RelationNode[], relations: SceneRelation[], scope: string[]): SceneRelation[] {
  if (!scope.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Map(nodes.map((node) => {
    const ids = new Set<string>();
    let id: string | null = node.id;
    while (id && !ids.has(id)) { ids.add(id); id = byId.get(id)?.parentId ?? null; }
    return [node.id, ids] as const;
  }));
  return relations.filter((relation) => relation.participants.some((participant) => scope.some((id) =>
    ancestors.get(participant.nodeId)?.has(id) || ancestors.get(id)?.has(participant.nodeId))));
}

export function validateRelations(nodes: RelationNode[], criteria: { id: string }[], relations: SceneRelation[]): void {
  if (relations.length > 500) throw new Error("Plan supports at most 500 relation nodes.");
  const nodeIds = new Set(nodes.map((node) => node.id)), ids = new Set<string>();
  for (const relation of relations) {
    if (!relation.id.trim() || ids.has(relation.id) || nodeIds.has(relation.id)) {
      throw new Error("Relation IDs must be unique, nonempty and distinct from object node IDs.");
    }
    ids.add(relation.id);
    const participants = relation.participants;
    if (!relation.description.trim() || participants.length < 2 || participants.length > 100 ||
      new Set(participants.map((p) => p.nodeId)).size !== participants.length ||
      participants.some((p) => !nodeIds.has(p.nodeId) || !p.role.trim())) {
      throw new Error("Relations need a description and 2-100 distinct known participants with explicit roles.");
    }
    if (!relation.criterionIds.length || new Set(relation.criterionIds).size !== relation.criterionIds.length ||
      relation.criterionIds.some((id) => !criteria.some((criterion) => criterion.id === id))) {
      throw new Error("Relation criterionIds must reference distinct frozen criteria.");
    }
    if (!["support", "alignment", "spacing", "semantic"].includes(relation.type)) throw new Error("Unknown relation type.");
    if (relation.type === "semantic") {
      if (relation.axis !== undefined || relation.tolerance !== undefined || relation.spacing !== undefined) {
        throw new Error("Semantic relations use visual evidence, without numeric measurement parameters.");
      }
      continue;
    }
    if (!Number.isFinite(relation.tolerance) || relation.tolerance! < 0 ||
      !["x", "y", "z"].includes(relation.axis ?? "")) {
      throw new Error("Measured relations need an explicit world axis and finite nonnegative tolerance in Blender units.");
    }
    if (relation.type === "support" && (relation.axis !== "z" || participants.length !== 2 ||
      participants.filter((p) => p.role === "subject").length !== 1 || participants.filter((p) => p.role === "support").length !== 1)) {
      throw new Error("Support needs subject/support roles and world Z; use semantic for other surface orientations.");
    }
    if (relation.type === "spacing" ? !Number.isFinite(relation.spacing) || relation.spacing! <= 0 : relation.spacing !== undefined) {
      throw new Error("Only spacing relations take a finite positive spacing in Blender units.");
    }
  }
}

// These are world-space bounding-box checks, not surface contact or collision tests.
export function checkRelations(relations: SceneRelation[], rawBounds: unknown): RelationCheck[] {
  const bounds = (rawBounds ?? {}) as Record<string, Bounds>;
  const valid = (box: Bounds | undefined): box is Bounds => !!box && Array.isArray(box.min) && Array.isArray(box.max) &&
    box.min.length === 3 && box.max.length === 3 && box.min.every((v, i) => Number.isFinite(v) && Number.isFinite(box.max[i]) && v <= box.max[i]!);
  return relations.map((relation) => {
    if (relation.type === "semantic") return { relationId: relation.id, status: "visual", evidence: "Requires host review of render and runtime evidence." };
    const boxes = relation.participants.map((p) => bounds[p.nodeId]);
    if (!boxes.every(valid)) return { relationId: relation.id, status: "unmeasurable", evidence: "Visible mapped mesh bounds are missing or invalid; do not infer a pass." };
    const axis = { x: 0, y: 1, z: 2 }[relation.axis!];
    const centers = boxes.map((box) => (box.min[axis]! + box.max[axis]!) / 2).sort((a, b) => a - b);
    let error: number;
    if (relation.type === "support") {
      const subject = boxes[relation.participants.findIndex((p) => p.role === "subject")]!;
      const surface = boxes[relation.participants.findIndex((p) => p.role === "support")]!;
      error = Math.max(Math.abs(subject.min[2]! - surface.max[2]!), ...[0, 1].map((i) => {
        const center = (subject.min[i]! + subject.max[i]!) / 2;
        return Math.max(surface.min[i]! - center, center - surface.max[i]!, 0);
      }));
    } else if (relation.type === "alignment") error = centers.at(-1)! - centers[0]!;
    else error = Math.max(...centers.slice(1).map((value, i) => Math.abs(value - centers[i]! - relation.spacing!)));
    return { relationId: relation.id, status: error <= relation.tolerance! ? "passed" : "failed", error, tolerance: relation.tolerance,
      evidence: `World AABB ${relation.type}, ${relation.axis} axis: error=${error}, tolerance=${relation.tolerance} Blender units. Visual verification still required.` };
  });
}

export function verifyRelationReviews(relations: SceneRelation[], criterionIds: string[], checks: RelationCheck[], reviews: RelationReview[]): void {
  const active = relations.filter((relation) => relation.criterionIds.some((id) => criterionIds.includes(id)));
  if (reviews.length !== active.length || new Set(reviews.map((review) => review.relationId)).size !== active.length ||
    reviews.some((review) => !active.some((relation) => relation.id === review.relationId) || !review.evidence.trim() || !review.passed && !review.correction?.trim())) {
    throw new Error("Review every active relation exactly once with evidence and a correction for failures.");
  }
  for (const review of reviews) {
    const check = checks.find((check) => check.relationId === review.relationId);
    if (!check || review.passed && !["passed", "visual"].includes(check.status)) {
      throw new Error(`Relation ${review.relationId} cannot pass without a current successful measurement or semantic visual review.`);
    }
  }
}

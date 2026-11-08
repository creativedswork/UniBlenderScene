import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type AssetRequirement = { nodeId: string; kind: "object" | "structure" | "existing"; reason: string };
export type AssetStrategy = { nodeId: string; providers: string[]; evidence: string;
  provider?: string; taskId?: string; artifactPath?: string; sha256?: string };
export type GraphReview = { checks: { id: string; passed: boolean; evidence: string }[];
  referenceEvidence: { reference: string; observation: string }[] };
export const GRAPH_CHECKS = ["coverage", "hierarchy", "spatial", "stage_checklists"];

export function verifyGraphReview(review: GraphReview, references: string[]): void {
  if (review.checks.length !== GRAPH_CHECKS.length || new Set(review.checks.map((c) => c.id)).size !== GRAPH_CHECKS.length ||
      GRAPH_CHECKS.some((id) => !review.checks.some((c) => c.id === id && c.evidence.trim()))) {
    throw new Error("Graph review must cover coverage, hierarchy, spatial and stage_checklists exactly once.");
  }
  if (review.referenceEvidence.length !== references.length ||
      new Set(review.referenceEvidence.map((r) => r.reference)).size !== references.length ||
      references.some((name) => !review.referenceEvidence.some((r) => r.reference === name && r.observation.trim()))) {
    throw new Error("Graph review needs a spatial observation for every supplied reference asset.");
  }
}

export function verifyAssetStrategy(root: string, requirement: AssetRequirement, strategy: AssetStrategy, allowPending = false): AssetStrategy {
  if (!strategy.evidence.trim() || new Set(strategy.providers).size !== strategy.providers.length ||
      strategy.providers.some((p) => !p.trim())) throw new Error("Record provider discovery evidence and distinct tool IDs.");
  if (requirement.kind !== "object") throw new Error("Only standalone objects require a provider strategy.");
  if (!strategy.providers.length) {
    if (strategy.provider || strategy.artifactPath || strategy.taskId) throw new Error("Blender fallback requires no applicable provider.");
    return { nodeId: strategy.nodeId, providers: [], evidence: strategy.evidence };
  }
  if (allowPending && !strategy.artifactPath) {
    if (strategy.provider && !strategy.providers.includes(strategy.provider)) throw new Error("Select a discovered provider.");
    return { ...strategy, sha256: undefined };
  }
  if (!strategy.provider || !strategy.providers.includes(strategy.provider) || !strategy.taskId?.trim() || !strategy.artifactPath) {
    throw new Error("An available provider requires its task ID and downloaded local GLB; activation or failure is not a Blender fallback.");
  }
  const path = realpathSync(resolve(strategy.artifactPath)), rel = relative(realpathSync(root), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(path).isFile()) {
    throw new Error("Provider GLB must be inside the task scene workspace.");
  }
  const bytes = readFileSync(path);
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error("Provider artifact must be a nonempty valid GLB 2 container.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!allowPending && strategy.sha256 && strategy.sha256 !== sha256) throw new Error("Recorded provider artifact changed; record the new result before importing.");
  return { ...strategy, artifactPath: path, sha256 };
}

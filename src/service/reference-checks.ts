import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PNG } from "pngjs";
import type { SceneNode } from "./store.js";

export type ImagePoint = [number, number];
type CheckTarget = { id: string; reference: string; nodeId: string; tolerance: number };
export type ReferenceCheck = CheckTarget & (
  { kind: "point"; landmarkId: string; target: ImagePoint } |
  { kind: "edge"; side: "left" | "right"; target: ImagePoint[] }
);
type Sample = { point: ImagePoint; objectName: string };
export type ReferenceCapture = { id: string; camera?: string; samples: (Sample | null)[]; reason?: string };
export type ReferenceMeasurement = CheckTarget & {
  kind: ReferenceCheck["kind"]; camera?: string; target: ImagePoint[]; samples: (Sample | null)[];
  status: "passed" | "failed" | "unmeasurable"; maxError?: number; reason?: string;
};
type View = { reference: string; image: string; render: string; camera?: string };
const points = (check: ReferenceCheck): ImagePoint[] => check.kind === "point" ? [check.target] : check.target;

export function freezeReferenceChecks(
  frozen: ReferenceCheck[], proposed: ReferenceCheck[], references: string[], graph: SceneNode[],
): ReferenceCheck[] {
  const checks = new Map(frozen.map(check => [check.id, check]));
  const ids = new Set<string>();
  for (const check of proposed) {
    if (ids.has(check.id)) throw new Error("Reference check IDs must be unique.");
    ids.add(check.id);
    const existing = checks.get(check.id);
    if (existing && !isDeepStrictEqual(existing, check)) {
      throw new Error(`Frozen reference check ${check.id} cannot change during a refinement.`);
    }
    checks.set(check.id, check);
  }
  const checksToValidate = [...checks.values()];
  if (checksToValidate.length > 48) throw new Error("Use at most 48 reference checks.");
  const nodeIds = new Set(graph.map(node => node.id));
  for (const check of checksToValidate) {
    const target = points(check);
    if (!check.id.trim() || !references.includes(check.reference) || !nodeIds.has(check.nodeId) ||
        !(check.tolerance > 0 && check.tolerance <= 1) ||
        target.some(point => point.length !== 2 || point.some(value => !Number.isFinite(value) || value < 0 || value > 1))) {
      throw new Error(`Reference check ${check.id} needs a paired reference, graph node, tolerance and normalized image coordinates.`);
    }
    if (check.kind === "edge" && (target.length < 2 || target.length > 16 ||
        target.some((point, index) => point[1] <= 0 || point[1] >= 1 || index > 0 && point[1] <= target[index - 1]![1]))) {
      throw new Error(`Reference edge ${check.id} needs 2-16 samples with strictly increasing interior y coordinates.`);
    }
    if (check.kind === "point" && !check.landmarkId.trim()) throw new Error(`Reference point ${check.id} needs a landmarkId.`);
  }
  return checksToValidate;
}

export function referenceChecksCode(checks: ReferenceCheck[], views: View[], graph: SceneNode[], checkpoint: string): string {
  if (!checks.length) return "";
  const runtime = readFileSync(new URL("../../runtime/blender/reference_checks.py", import.meta.url), "utf8");
  const request = JSON.stringify({ checks, views, graph, checkpoint });
  return `
import json as _reference_json, types as _reference_types
_reference_checks = _reference_types.ModuleType('scene_reference_checks')
exec(compile(${JSON.stringify(runtime)}, '<scene-reference-checks>', 'exec'), _reference_checks.__dict__)
result["referenceCaptures"] = _reference_checks.capture(_reference_json.loads(${JSON.stringify(request)}))
`;
}

export function measureReferenceChecks(checks: ReferenceCheck[], captures: ReferenceCapture[] = []): ReferenceMeasurement[] {
  return checks.map(check => {
    const capture = captures.find(item => item.id === check.id);
    const target = points(check);
    const samples = capture?.samples ?? [];
    const common = { id: check.id, kind: check.kind, reference: check.reference, nodeId: check.nodeId,
      tolerance: check.tolerance, camera: capture?.camera, target, samples };
    if (capture?.reason || samples.length !== target.length || samples.some(sample => !sample)) {
      return { ...common, status: "unmeasurable", reason: capture?.reason ?? "Missing visible samples from the current checkpoint." };
    }
    const maxError = Math.max(...target.map(([x, y], index) => {
      const [actualX, actualY] = samples[index]!.point;
      return check.kind === "edge" ? Math.abs(actualX - x) : Math.hypot(actualX - x, actualY - y);
    }));
    return { ...common, status: maxError <= check.tolerance ? "passed" : "failed", maxError };
  });
}

export function referenceOverlay(bytes: Buffer, measurements: ReferenceMeasurement[]): Buffer {
  const image = PNG.sync.read(bytes);
  const pixel = ([x, y]: ImagePoint) => [Math.round(x * (image.width - 1)), Math.round(y * (image.height - 1))] as const;
  const stroke = (from: ImagePoint, to: ImagePoint, color: number[]) => {
    const [x, y] = pixel(from), [endX, endY] = pixel(to);
    const steps = Math.max(Math.abs(endX - x), Math.abs(endY - y), 1);
    for (let step = 0; step <= steps; step++) {
      const col = Math.round(x + (endX - x) * step / steps), row = Math.round(y + (endY - y) * step / steps);
      for (let offset = -1; offset <= 1; offset++) {
        if (col + offset >= 0 && col + offset < image.width) image.data.set(color, (row * image.width + col + offset) * 4);
        if (row + offset >= 0 && row + offset < image.height) image.data.set(color, ((row + offset) * image.width + col) * 4);
      }
    }
  };
  const draw = (positions: (ImagePoint | null)[], color: number[]) => {
    for (const [index, point] of positions.entries()) {
      if (!point) continue;
      const previous = positions[index - 1];
      if (previous) stroke(previous, point, color);
      const [x, y] = point;
      const dx = 5 / image.width, dy = 5 / image.height;
      stroke([Math.max(0, x - dx), y], [Math.min(1, x + dx), y], color);
      stroke([x, Math.max(0, y - dy)], [x, Math.min(1, y + dy)], color);
    }
  };
  for (const measurement of measurements) {
    draw(measurement.target, [42, 225, 255, 255]);
    draw(measurement.samples.map(sample => sample?.point ?? null), [255, 176, 41, 255]);
  }
  return PNG.sync.write(image);
}

import { readFileSync } from "node:fs";
import { hash } from "./experience.js";
import type { SceneNode } from "./store.js";
import type { SceneRelation } from "./relations.js";

export type SpatialBinding = { relationId: string; id: string; hash: string };
export type SpatialSource = { id: string; hash: string; code: string };
export type SpatialLibrary = { builtin: SpatialSource; bindings: SpatialBinding[] };
export type SpatialRequest = SpatialLibrary & { graph: SceneNode[]; relations: SceneRelation[]; skills: SpatialSource[] };
export type LayoutSearch = {
  movableNodeIds: string[]; translationStep: number; passes: number; rotationStepDegrees: number;
  scorerOverrides?: SpatialBinding[];
};

export function builtinSpatialSource(): SpatialSource {
  const code = readFileSync(new URL("../../skills/blender-spatial/scripts/scores.py", import.meta.url), "utf8");
  return { id: "builtin-spatial", hash: hash(code), code };
}

function bootstrap(request: SpatialRequest): string {
  const runtime = readFileSync(new URL("../../runtime/blender/spatial.py", import.meta.url), "utf8");
  return `
import json as _spatial_json, types as _spatial_types
_spatial_runtime = _spatial_types.ModuleType('scene_spatial_runtime')
exec(compile(${JSON.stringify(runtime)}, '<scene-spatial-runtime>', 'exec'), _spatial_runtime.__dict__)
_spatial_request = _spatial_json.loads(${JSON.stringify(JSON.stringify(request))})
_scene_layout = _spatial_runtime.SpatialLayout(_spatial_request)
`;
}

export function spatialEvaluationCode(request: SpatialRequest): string {
  return `${bootstrap(request)}
result.update(_scene_layout.snapshot())
if '_layout_optimization' in locals(): result['layoutOptimization'] = _layout_optimization
`;
}

export function spatialOptimizeCode(request: SpatialRequest, options: LayoutSearch & { relationIds: string[] }): string {
  return `${bootstrap(request)}
_layout_options = _spatial_json.loads(${JSON.stringify(JSON.stringify({ ...options, overrides: options.scorerOverrides ?? [] }))})
_layout_optimization = _scene_layout.optimize(_layout_options)
`;
}

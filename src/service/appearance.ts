import { z } from "zod";
import { renderCode } from "./blender.js";

const name = z.string().min(1).max(256);
const value = z.union([z.number(), z.array(z.number()).min(2).max(4)]);
const socket = { node: name, socket: name, value };
const tweakSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("materialInput"), material: name, ...socket }),
  z.object({ target: z.literal("worldInput"), ...socket }),
  z.object({ target: z.literal("light"), object: name, value,
    property: z.enum(["energy", "color", "size", "size_y", "shadow_soft_size", "angle", "spot_size", "spot_blend"]) }),
  z.object({ target: z.literal("exposure"), value: z.number() }),
  z.object({ target: z.literal("objectTransform"), object: name, value: z.array(z.number()).length(3),
    property: z.enum(["location", "rotation_euler", "scale"]) }),
]);
export const tweaksSchema = z.array(tweakSchema).min(1).max(30);
export const leapCodeSchema = z.string().min(1).max(120000);
export const appearanceCandidateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("leap"), label: name, code: leapCodeSchema }),
  z.object({ mode: z.literal("tweak"), label: name, tweaks: tweaksSchema }),
]);
export type AppearanceCandidate = z.infer<typeof appearanceCandidateSchema>;
type Tweak = z.infer<typeof tweakSchema>;

export function tweakCode(tweaks: Tweak[]): string {
  return `
def _apply_tweak(change):
    kind = change['target']
    scene = bpy.context.scene
    if kind in ('materialInput', 'worldInput'):
        owner = bpy.data.materials.get(change['material']) if kind == 'materialInput' else scene.world
        node = owner.node_tree.nodes.get(change['node']) if owner and owner.node_tree else None
        inputs = [s for s in node.inputs if s.identifier == change['socket']] if node else []
        if not inputs and node:
            inputs = [s for s in node.inputs if s.name == change['socket']]
        if len(inputs) != 1 or inputs[0].is_linked:
            raise ValueError('Tweak needs one existing unlinked input: ' + change['node'] + ' / ' + change['socket'])
        target, prop = inputs[0], 'default_value'
    elif kind == 'exposure':
        target, prop = scene.view_settings, 'exposure'
    else:
        obj = scene.objects.get(change['object'])
        if obj is None or (kind == 'light' and obj.type != 'LIGHT'):
            raise ValueError('Tweak target is missing or has the wrong type: ' + change['object'])
        target, prop = (obj.data if kind == 'light' else obj), change['property']
        if prop == 'rotation_euler' and obj.rotation_mode in {'QUATERNION', 'AXIS_ANGLE'}:
            raise ValueError('Tweak rotation_euler requires an existing Euler rotation mode')
    spec = target.bl_rna.properties.get(prop)
    value = change['value']
    if not spec or spec.is_readonly or spec.type not in {'FLOAT', 'INT'}:
        raise ValueError('Tweak needs a writable numeric property: ' + prop)
    values = value if isinstance(value, list) else [value]
    if spec.is_array != isinstance(value, list) or (spec.is_array and spec.array_length != len(values)):
        raise ValueError('Tweak value must match the property dimensions: ' + prop)
    if any(v < spec.hard_min or v > spec.hard_max or (spec.type == 'INT' and int(v) != v) for v in values):
        raise ValueError('Tweak value is outside the property range: ' + prop)
    if spec.type == 'INT':
        value = [int(v) for v in values] if spec.is_array else int(value)
    setattr(target, prop, value)

for _change in ${JSON.stringify(tweaks)}:
    _apply_tweak(_change)
`;
}

export function comparisonFrameCode(): string {
  return `
def _appearance_frame():
    s = bpy.context.scene
    r = s.render
    return (s.name, s.frame_current, s.frame_subframe, s.camera.name if s.camera else None,
            r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage,
            r.pixel_aspect_x, r.pixel_aspect_y, r.use_border, r.use_crop_to_border,
            r.border_min_x, r.border_min_y, r.border_max_x, r.border_max_y,
            s.cycles.samples, s.cycles.seed)
`;
}

export function appearancePreviewCode(path: string): string {
  return `
_r = bpy.context.scene.render
_scale = min(_r.resolution_percentage / 100, 512 / max(_r.resolution_x, _r.resolution_y))
_r.resolution_x = max(4, int(_r.resolution_x * _scale))
_r.resolution_y = max(4, int(_r.resolution_y * _scale))
_r.resolution_percentage = 100
bpy.context.scene.cycles.samples = min(bpy.context.scene.cycles.samples, 8)
${renderCode(path)}
`;
}

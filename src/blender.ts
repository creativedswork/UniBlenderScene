import { connect } from "node:net";

export class BlenderClient {
  constructor(
    private readonly host = process.env.BLENDER_MCP_HOST ?? "127.0.0.1",
    private readonly port = Number(process.env.BLENDER_MCP_PORT ?? "9877"),
    private readonly timeout = Number(process.env.BLENDER_TIMEOUT_MS ?? "300000"),
  ) {}

  execute(code: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let size = 0;
      socket.setTimeout(this.timeout);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ type: "execute", code, strict_json: true })}\0`),
      );
      socket.on("data", (chunk: Buffer) => {
        const end = chunk.indexOf(0);
        chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
        size += chunk.length;
        if (size > 16 * 1024 * 1024) return fail(new Error("Blender response is too large."));
        if (end < 0) return;
        socket.destroy();
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.status !== "ok") {
            throw new Error(String(response.message ?? "Blender execution failed."));
          }
          resolve(response.result ?? {});
        } catch (error) {
          reject(error);
        }
      });
      socket.once("timeout", () => fail(new Error("Blender operation timed out.")));
      socket.once("error", fail);
      socket.once("end", () => reject(new Error("Blender disconnected before returning a result.")));
    });
  }
}

export function sceneSummaryCode(): string {
  return `
bpy.context.view_layer.update()
result = {
    "blenderVersion": bpy.app.version_string,
    "objectCount": len(bpy.context.scene.objects),
    "inventoryTruncated": len(bpy.context.scene.objects) > 300,
    "objects": [{"name": obj.name, "type": obj.type,
                 "sceneNodeId": obj.get("scene_node_id"), "parent": obj.parent.name if obj.parent else None,
                 "location": list(obj.location), "dimensions": list(obj.dimensions),
                 "matrixWorld": [list(row) for row in obj.matrix_world],
                 "materials": [slot.material.name if slot.material else None for slot in obj.material_slots]}
                for obj in bpy.context.scene.objects][:300],
    "camera": bpy.context.scene.camera.name if bpy.context.scene.camera else None,
    "world": bpy.context.scene.world.name if bpy.context.scene.world else None,
    "lights": [{"name": o.name, "type": o.data.type, "energy": o.data.energy, "color": list(o.data.color)} for o in bpy.context.scene.objects if o.type == 'LIGHT'],
    "exposure": bpy.context.scene.view_settings.exposure,
    "viewTransform": bpy.context.scene.view_settings.view_transform,
    "resolution": [bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y]
}`;
}

// Keep the stage contract in the bridge transaction: a violation throws before
// saving and SceneStore restores its checkpoint. This is not a visual verifier.
export function factorGuardCode(stage?: string, approved = false): [string, string] {
  const frozen = stage === "composition" ? ["geometry", "materials", "lighting"] :
    stage === "materials" ? ["geometry", "placement", "lighting"] :
    stage === "lighting" ? ["geometry", "placement", "materials"] :
    stage === "final" && approved ? ["geometry", "placement"] : [];
  if (!frozen.length) return ["", ""];
  return [`
import hashlib as _codex_hashlib, json as _codex_json
def _codex_factors():
    def values(rna):
        result = {}
        for prop in rna.bl_rna.properties:
            if prop.identifier == 'rna_type' or prop.is_readonly or prop.type not in {'BOOLEAN','INT','FLOAT','STRING','ENUM'}: continue
            try:
                value = getattr(rna, prop.identifier)
                result[prop.identifier] = list(value) if prop.is_array else value
            except (TypeError, AttributeError): pass
        return result
    def tree(nt):
        if nt is None: return None
        return {'nodes': [(n.name,n.bl_idname,values(n),[(s.name,repr(s.default_value[:]) if hasattr(s.default_value,'__len__') and not isinstance(s.default_value,str) else str(s.default_value)) for s in n.inputs if hasattr(s,'default_value')], getattr(getattr(n,'image',None),'filepath',None), getattr(getattr(n,'node_tree',None),'name',None)) for n in nt.nodes], 'links': sorted((l.from_node.name,l.from_socket.name,l.to_node.name,l.to_socket.name) for l in nt.links)}
    obs = sorted(bpy.context.scene.objects, key=lambda o:o.name)
    geometry=[]; placement=[]; materials=[]; lighting=[]
    for o in obs:
        if o.type not in {'LIGHT','CAMERA'}:
            data = o.data
            shape = ([(tuple(v.co)) for v in data.vertices], [tuple(p.vertices) for p in data.polygons]) if o.type=='MESH' else str(getattr(data,'name',None))
            geometry.append((o.name,o.type,shape,[(m.name,m.type,values(m)) for m in o.modifiers]))
            materials.append((o.name,[s.material.name if s.material else None for s in o.material_slots]))
        if o.type != 'LIGHT': placement.append((o.name,[list(r) for r in o.matrix_world],o.hide_render,values(o.data) if o.type=='CAMERA' else None))
        if o.type=='LIGHT': lighting.append((o.name,[list(r) for r in o.matrix_world],values(o.data),tree(o.data.node_tree)))
    materials.extend((m.name,values(m),tree(m.node_tree)) for m in sorted(bpy.data.materials,key=lambda m:m.name) if m.users)
    w=bpy.context.scene.world
    lighting.append((values(w),tree(w.node_tree)) if w else None)
    lighting.append((values(bpy.context.scene.view_settings),values(bpy.context.scene.display_settings)))
    return {k:_codex_hashlib.sha256(_codex_json.dumps(v,sort_keys=True,default=str).encode()).hexdigest() for k,v in {'geometry':geometry,'placement':placement,'materials':materials,'lighting':lighting}.items()}
bpy.context.view_layer.update()
_codex_before = _codex_factors()
`, `
bpy.context.view_layer.update()
_codex_after = _codex_factors()
for _factor in ${JSON.stringify(frozen)}:
    if _codex_before[_factor] != _codex_after[_factor]:
        raise RuntimeError('Stage scope violation: ${stage} changed frozen ' + _factor)
`];
}

export function inspectObjectCode(path: string, name: string): string {
  return `
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path)})
obj = bpy.data.objects.get(${JSON.stringify(name)})
if obj is None:
    raise RuntimeError("Object not found: " + ${JSON.stringify(name)})
result = {
    "name": obj.name, "type": obj.type,
    "parent": obj.parent.name if obj.parent else None,
    "location": list(obj.location), "dimensions": list(obj.dimensions),
    "scale": list(obj.scale), "rotationMode": obj.rotation_mode,
    "rotationEuler": list(obj.rotation_euler),
    "rotationQuaternion": list(obj.rotation_quaternion),
    "matrixWorld": [list(row) for row in obj.matrix_world],
    "polygonCount": len(obj.data.polygons) if obj.type == "MESH" else None,
    "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
}
`;
}

export function renderCode(path: string): string {
  return `
if bpy.context.scene.camera is None:
    raise RuntimeError("Set an active camera before rendering.")
bpy.context.scene.render.image_settings.file_format = "PNG"
bpy.context.scene.render.filepath = ${JSON.stringify(path)}
bpy.ops.render.render(write_still=True)
`;
}

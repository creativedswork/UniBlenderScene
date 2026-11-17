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

export function sceneSummaryCode(graph?: { id: string; parentId: string | null; blenderObjectNames: string[] }[]): string {
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
}
${graph ? relationBoundsCode(graph) : ""}`;
}

function relationBoundsCode(graph: { id: string; parentId: string | null; blenderObjectNames: string[] }[]): string {
  return `
from mathutils import Vector as _relation_vector
import math as _relation_math, json as _relation_json
_relation_graph = {n['id']: n for n in _relation_json.loads(${JSON.stringify(JSON.stringify(graph))})}
_relation_names = {name: n['id'] for n in _relation_graph.values() for name in n['blenderObjectNames']}
_relation_bounds = {}
_relation_depsgraph = bpy.context.evaluated_depsgraph_get()
for _obj in bpy.context.scene.objects:
    if _obj.type != 'MESH' or _obj.hide_render: continue
    _owner, _node_id = _obj, None
    while _owner:
        _node_id = _owner.get('scene_node_id') or _relation_names.get(_owner.name)
        if _node_id: break
        _owner = _owner.parent
    if _node_id not in _relation_graph: continue
    _evaluated = _obj.evaluated_get(_relation_depsgraph)
    if not len(_evaluated.data.vertices): continue
    _corners = [_evaluated.matrix_world @ _relation_vector(c) for c in _evaluated.bound_box]
    _min = [min(c[i] for c in _corners) for i in range(3)]
    _max = [max(c[i] for c in _corners) for i in range(3)]
    if not all(_relation_math.isfinite(v) for v in _min + _max): continue
    while _node_id in _relation_graph:
        _box = _relation_bounds.setdefault(_node_id, {'min': _min[:], 'max': _max[:]})
        _box['min'] = [min(a,b) for a,b in zip(_box['min'], _min)]
        _box['max'] = [max(a,b) for a,b in zip(_box['max'], _max)]
        _node_id = _relation_graph[_node_id]['parentId']
result['relationBounds'] = _relation_bounds
`;
}

// Keep the stage contract in the bridge transaction: a violation throws before
// saving and SceneStore restores its checkpoint. This is not a visual verifier.
export interface RevisionScope {
  nodeIds: string[];
  graphObjects: { nodeId: string; names: string[] }[];
}

export function factorGuardCode(stage?: string, approved = false, revisionScope?: RevisionScope): [string, string] {
  const frozen = revisionScope ? (stage === "composition" ? ["geometry"] : []) :
    stage === "composition" ? ["geometry", "materials", "lighting"] :
    stage === "materials" ? ["geometry", "placement", "lighting"] :
    stage === "lighting" ? ["geometry", "placement", "materials"] :
    stage === "final" && approved ? ["geometry", "placement"] : [];
  if (!frozen.length && !revisionScope) return ["", ""];
  const [revisionBefore, revisionAfter] = revisionScope ? boundedRevisionGuardCode(revisionScope) : ["", ""];
  return [`
import hashlib as _scene_hashlib, json as _scene_json
from array import array as _scene_array
def _scene_digest(value):
    return _scene_hashlib.sha256(_scene_json.dumps(value,sort_keys=True,default=str).encode()).hexdigest()
def _scene_buffer(items, name, kind, width=1):
    data = _scene_array(kind, [0]) * (len(items) * width)
    items.foreach_get(name, data)
    return _scene_digest([name,kind,len(items),width,_scene_hashlib.sha256(memoryview(data)).hexdigest()])
def _scene_topology(mesh):
    return [_scene_buffer(mesh.vertices,'co','f',3),
        _scene_buffer(mesh.edges,'vertices','i',2),
        _scene_buffer(mesh.loops,'vertex_index','i'),_scene_buffer(mesh.loops,'edge_index','i'),
        _scene_buffer(mesh.polygons,'loop_start','i'),_scene_buffer(mesh.polygons,'loop_total','i')]
def _scene_values(rna):
    result = {}
    for prop in rna.bl_rna.properties:
        if prop.identifier == 'rna_type' or prop.is_readonly or prop.type not in {'BOOLEAN','INT','FLOAT','STRING','ENUM'}: continue
        try:
            value = getattr(rna, prop.identifier)
            result[prop.identifier] = list(value) if prop.is_array else value
        except (TypeError, AttributeError): pass
    return result
def _scene_tree(nt):
    if nt is None: return None
    return {'nodes': [(n.name,n.bl_idname,_scene_values(n),[(s.name,repr(s.default_value[:]) if hasattr(s.default_value,'__len__') and not isinstance(s.default_value,str) else str(s.default_value)) for s in n.inputs if hasattr(s,'default_value')], getattr(getattr(n,'image',None),'filepath',None), getattr(getattr(n,'node_tree',None),'name',None)) for n in nt.nodes], 'links': sorted((l.from_node.name,l.from_socket.name,l.to_node.name,l.to_socket.name) for l in nt.links)}
def _scene_factors(requested):
    if not requested: return {}
    values = _scene_values; tree = _scene_tree
    obs = sorted(bpy.context.scene.objects, key=lambda o:o.name)
    factors = {name:[] for name in requested}
    meshes = {}
    for o in obs:
        if o.type not in {'LIGHT','CAMERA'}:
            if 'geometry' in factors:
                data = o.data
                if o.type=='MESH':
                    key=data.as_pointer()
                    if key not in meshes: meshes[key]=_scene_topology(data)
                    shape=meshes[key]
                else: shape=str(getattr(data,'name',None))
                factors['geometry'].append((o.name,o.type,shape,[(m.name,m.type,values(m)) for m in o.modifiers]))
            if 'materials' in factors: factors['materials'].append((o.name,[s.material.name if s.material else None for s in o.material_slots]))
        if 'placement' in factors and o.type != 'LIGHT': factors['placement'].append((o.name,[list(r) for r in o.matrix_world],o.hide_render,values(o.data) if o.type=='CAMERA' else None))
        if 'lighting' in factors and o.type=='LIGHT': factors['lighting'].append((o.name,[list(r) for r in o.matrix_world],values(o.data),tree(o.data.node_tree)))
    if 'materials' in factors: factors['materials'].extend((m.name,values(m),tree(m.node_tree)) for m in sorted(bpy.data.materials,key=lambda m:m.name) if m.users)
    if 'lighting' in factors:
        w=bpy.context.scene.world
        factors['lighting'].append((values(w),tree(w.node_tree)) if w else None)
        factors['lighting'].append((values(bpy.context.scene.view_settings),values(bpy.context.scene.display_settings)))
    return {k:_scene_digest(v) for k,v in factors.items()}
bpy.context.view_layer.update()
_scene_frozen = ${JSON.stringify(frozen)}
_scene_before = _scene_factors(_scene_frozen)
${revisionBefore}
`, `
bpy.context.view_layer.update()
${revisionAfter}
_scene_after = _scene_factors(_scene_frozen)
for _factor in _scene_frozen:
    if _scene_before[_factor] != _scene_after[_factor]:
        raise RuntimeError('Stage scope violation: ${stage} changed frozen ' + _factor)
`];
}

// These snapshots supplement (rather than relax) the normal composition geometry
// freeze. Authorization is resolved once, before user code, from trusted graph
// names and baseline tags/ancestors. Post-edit tags cannot expand that set.
function boundedRevisionGuardCode(scope: RevisionScope): [string, string] {
  return [`
_scene_revision_scope = ${JSON.stringify(scope)}
def _scene_pointer(value):
    return value.as_pointer() if value is not None else None
_scene_data_cache = {}
def _scene_custom(value):
    try: return dict(value.items())
    except TypeError: return {}
_scene_transient = {'rna_type','users','is_updated','is_updated_data','is_updated_geometry','is_updated_shading','is_updated_transform','is_embedded_data','is_evaluated','original'}
def _scene_stream(items, read):
    digest=_scene_hashlib.sha256()
    for item in items:
        payload=_scene_json.dumps(read(item),sort_keys=True,default=str).encode()
        digest.update(len(payload).to_bytes(8,'little'));digest.update(payload)
    return [len(items),digest.hexdigest()]
def _scene_collection(items, depth, ignore_selection=False):
    if not len(items): return [0]
    sample=items[0]
    # Nodes, modifiers and sockets are heterogeneous RNA collections. Their
    # per-element types must not be inferred from only the first member.
    identifier=sample.bl_rna.identifier
    bulk_type=identifier.startswith('Mesh') or identifier.endswith('AttributeValue') or identifier in {'ShapeKeyPoint','VertexGroupElement','VertexGroup'}
    if not hasattr(items,'foreach_get') or not bulk_type:
        return _scene_stream(items,lambda v:_scene_rna(v,depth))
    state={}
    for prop in sample.bl_rna.properties:
        name=prop.identifier
        if name in _scene_transient or ignore_selection and name=='select': continue
        # Variable-length face vertices are represented exactly by the source
        # loop indices and polygon ranges, without a per-face JSON fallback.
        if isinstance(sample,bpy.types.MeshPolygon) and name=='vertices': continue
        if prop.type in {'BOOLEAN','INT','FLOAT'}:
            kind={'BOOLEAN':'b','INT':'i','FLOAT':'f'}[prop.type]
            width=prop.array_length if prop.is_array else 1
            try: state[name]=_scene_buffer(items,name,kind,width)
            except (TypeError,AttributeError,ValueError,RuntimeError):
                state[name]=_scene_stream(items,lambda v:list(getattr(v,name)) if prop.is_array else getattr(v,name))
        elif prop.type in {'STRING','ENUM'}:
            state[name]=_scene_stream(items,lambda v:getattr(v,name))
        elif prop.type=='POINTER':
            state[name]=_scene_stream(items,lambda v:_scene_pointer(getattr(v,name)))
        elif prop.type=='COLLECTION' and depth>0:
            if isinstance(sample,bpy.types.MeshUVLoopLayer):
                # UV/pin/selection payloads are already captured by mesh
                # attributes. UV collection aliases can allocate missing layers.
                continue
            state[name]=_scene_stream(items,lambda v:_scene_collection(getattr(v,name),depth-1))
    return [sample.bl_rna.identifier,len(items),state]
def _scene_rna(value, depth=2):
    if value is None: return None
    state = {}
    for prop in value.bl_rna.properties:
        name = prop.identifier
        if name in _scene_transient: continue
        # Reading attribute data can materialize SINGLE storage into ARRAY without
        # changing its domain, type or payload, all of which remain protected.
        if isinstance(value,bpy.types.Attribute) and name=='storage_type': continue
        if prop.type=='COLLECTION' and (depth<=0 or isinstance(value,bpy.types.MeshUVLoopLayer)): continue
        if prop.type not in {'BOOLEAN','INT','FLOAT','STRING','ENUM','POINTER','COLLECTION'}: continue
        item = getattr(value,name)
        if prop.type in {'BOOLEAN','INT','FLOAT','STRING','ENUM'}:
            state[name] = list(item) if getattr(prop,'is_array',False) else item
        elif prop.type == 'POINTER': state[name] = _scene_pointer(item)
        elif prop.type == 'COLLECTION' and depth > 0:
            if isinstance(value,bpy.types.Mesh) and name in {'attributes','color_attributes'}:
                layers=[]
                for layer in item:
                    # These backing attributes are the same UI selection excluded
                    # from vertices/edges/polygons, not arbitrary boolean data.
                    if layer.name in {'.select_vert','.select_edge','.select_poly'}: continue
                    layers.append([_scene_rna(layer,0),_scene_collection(layer.data,1)])
                state[name]=layers
            else:
                state[name] = _scene_collection(item,depth-1,isinstance(value,bpy.types.Mesh) and name in {'vertices','edges','polygons'})
    return state
def _scene_animation(value):
    animation = getattr(value,'animation_data',None)
    if not animation: return None
    action = animation.action
    return [_scene_rna(animation),_scene_rna(action,4) if action else None,
        [_scene_rna(curve,3) for curve in animation.drivers]]
def _scene_geometry(o):
    data = o.data
    key=_scene_pointer(data)
    if data is not None and key not in _scene_data_cache:
        source={'rna':_scene_rna(data),
            'shape_keys':_scene_rna(data.shape_keys,3) if getattr(data,'shape_keys',None) else None}
        _scene_data_cache[key]=(source,_scene_digest(source))
    cached=_scene_data_cache.get(key,(None,None))
    state = {'data_identity':key,'source':cached[0],'source_digest':cached[1],
             'modifiers':[(_scene_rna(m),_scene_custom(m)) for m in o.modifiers],
             'constraints':[_scene_rna(c) for c in o.constraints]}
    if o.type in {'MESH','CURVE','SURFACE','FONT','META'}:
        evaluated = o.evaluated_get(_scene_depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True,depsgraph=_scene_depsgraph)
        try:
            if mesh: state['evaluated_topology']=_scene_topology(mesh)
        finally: evaluated.to_mesh_clear()
    return state
def _scene_object_state(o):
    return {'identity':[o.name,o.type,o.get('scene_node_id')],'geometry':_scene_geometry(o),
        'matrix_world':[list(r) for r in o.matrix_world],'values':_scene_values(o),
        'parent':[_scene_pointer(o.parent),o.parent_type,o.parent_bone],
        'matrix_parent_inverse':[list(r) for r in o.matrix_parent_inverse],
        'collections':sorted(_scene_pointer(c) for c in o.users_collection),
        'material_slots':[(s.link,_scene_pointer(s.material)) for s in o.material_slots],
        'visibility':[(v.name,o.hide_get(view_layer=v)) for v in bpy.context.scene.view_layers],
        'vertex_groups':_scene_collection(o.vertex_groups,1),
        'animation':[_scene_animation(o),_scene_animation(o.data)]}
def _scene_object_digest(snapshot):
    # Keep the raw source only for diagnostics; reuse its digest for linked meshes.
    geometry={k:v for k,v in snapshot['geometry'].items() if k!='source'}
    return _scene_digest({**snapshot,'geometry':geometry})
def _scene_difference(before, after, path='object'):
    if type(before) is not type(after): return path
    if isinstance(before,dict):
        if before.keys()!=after.keys(): return path+'.keys'
        for key in before:
            difference=_scene_difference(before[key],after[key],path+'.'+str(key))
            if difference: return difference
    elif isinstance(before,(list,tuple)):
        if len(before)!=len(after): return path+'.length'
        for index,(a,b) in enumerate(zip(before,after)):
            difference=_scene_difference(a,b,path+'['+str(index)+']')
            if difference: return difference
    elif before!=after and _scene_digest(before)!=_scene_digest(after): return path
    return None
def _scene_resource_state(resource):
    nt = getattr(resource,'node_tree',None)
    if nt is None and isinstance(resource,bpy.types.NodeTree): nt=resource
    return _scene_digest([resource.name,_scene_rna(resource),_scene_tree(nt),
        [(n.name,_scene_rna(n,3)) for n in nt.nodes] if nt else None,
        _scene_animation(resource),_scene_animation(nt)])
def _scene_layers():
    def walk(layer):
        state = [(_scene_pointer(layer.collection),_scene_values(layer))]
        for child in layer.children: state.extend(walk(child))
        return state
    return [(v.name,_scene_values(v),sorted((p,s) for p,s in walk(v.layer_collection)
        if p in _scene_old_collections)) for v in bpy.context.scene.view_layers]
_scene_depsgraph = bpy.context.evaluated_depsgraph_get()
_scene_original_objects = {_scene_pointer(o):o for o in bpy.data.objects}
_scene_scope_ids = set(_scene_revision_scope['nodeIds'])
_scene_scope_names = {}
for _entry in _scene_revision_scope['graphObjects']:
    if _entry['nodeId'] in _scene_scope_ids:
        for _name in _entry['names']: _scene_scope_names[_name] = _entry['nodeId']
def _scene_is_scoped(o):
    tag = o.get('scene_node_id')
    seen = set()
    parent = o
    while parent and _scene_pointer(parent) not in seen:
        seen.add(_scene_pointer(parent))
        parent_tag = parent.get('scene_node_id')
        if parent.name in _scene_scope_names:
            if parent_tag and parent_tag != _scene_scope_names[parent.name]:
                raise RuntimeError('Revision scope violation: conflicting baseline node tag on ' + parent.name)
            return not tag or tag in _scene_scope_ids
        if parent_tag: return parent_tag in _scene_scope_ids
        parent = parent.parent
    return False
_scene_allowed_objects = {p for p,o in _scene_original_objects.items()
    if _scene_is_scoped(o) and o.type not in {'LIGHT','CAMERA'}}
_scene_protected_objects = {p:_scene_object_state(o) for p,o in _scene_original_objects.items()
    if p not in _scene_allowed_objects}
_scene_baseline_tags = {p:o.get('scene_node_id') for p,o in _scene_original_objects.items()}
_scene_baseline_slots = {p:[(s.link,_scene_pointer(s.material)) for s in o.material_slots]
    for p,o in _scene_original_objects.items() if p in _scene_allowed_objects}
_scene_old_materials = {_scene_pointer(m):_scene_resource_state(m) for m in bpy.data.materials}
_scene_old_lights = {_scene_pointer(l):_scene_resource_state(l) for l in bpy.data.lights}
_scene_old_worlds = {_scene_pointer(w):_scene_resource_state(w) for w in bpy.data.worlds}
_scene_old_groups = {_scene_pointer(g):_scene_resource_state(g) for g in bpy.data.node_groups}
_scene_old_collections = {_scene_pointer(c):_scene_digest([c.name,_scene_values(c),
    sorted(_scene_pointer(child) for child in c.children)]) for c in bpy.data.collections}
_scene_layer_before = _scene_digest(_scene_layers())
_scene_scene_pointer = _scene_pointer(bpy.context.scene)
_scene_scene_before = _scene_digest([_scene_pointer(bpy.context.scene.camera),
    _scene_pointer(bpy.context.scene.world),_scene_rna(bpy.context.scene.render),
    _scene_rna(bpy.context.scene.view_settings),_scene_rna(bpy.context.scene.display_settings),
    _scene_tree(getattr(bpy.context.scene,'node_tree',None)),getattr(bpy.context.scene,'use_nodes',False),
    _scene_pointer(getattr(bpy.context.scene,'compositing_node_group',None))])
`, `
def _scene_revision_fail(detail):
    raise RuntimeError('Revision scope violation: ' + detail)
_scene_data_cache.clear()
_scene_depsgraph = bpy.context.evaluated_depsgraph_get()
_scene_current_objects = {_scene_pointer(o):o for o in bpy.data.objects}
for _pointer,_snapshot in _scene_protected_objects.items():
    if _pointer not in _scene_current_objects:
        _scene_revision_fail('unrelated object removed: '+_snapshot['identity'][0])
    _current_snapshot=_scene_object_state(_scene_current_objects[_pointer])
    if _scene_object_digest(_snapshot)!=_scene_object_digest(_current_snapshot):
        _difference=_scene_difference(_snapshot,_current_snapshot) or 'object'
        _scene_revision_fail('unrelated object changed: '+_snapshot['identity'][0]+' ('+_difference+')')
for _pointer,_tag in _scene_baseline_tags.items():
    if _pointer in _scene_current_objects and _scene_current_objects[_pointer].get('scene_node_id') != _tag:
        _scene_revision_fail('baseline object retagged')
for _pointer,_slots in _scene_baseline_slots.items():
    if _pointer in _scene_current_objects:
        _obj = _scene_current_objects[_pointer]
        if [(s.link,_scene_pointer(s.material)) for s in _obj.material_slots] != _slots:
            _scene_revision_fail('baseline material assignment changed')
_scene_new_objects = {p:o for p,o in _scene_current_objects.items() if p not in _scene_original_objects}
for _obj in _scene_new_objects.values():
    if _obj.type not in {'MESH','EMPTY','CURVE','SURFACE','FONT','META'} or _obj.get('scene_node_id') not in _scene_scope_ids:
        _scene_revision_fail('new object must own an authorized node tag')
for _resources,_before,_label in [(bpy.data.materials,_scene_old_materials,'material'),
        (bpy.data.lights,_scene_old_lights,'light'),(bpy.data.worlds,_scene_old_worlds,'world'),
        (bpy.data.node_groups,_scene_old_groups,'node group')]:
    _after = {_scene_pointer(r):_scene_resource_state(r) for r in _resources}
    if any(p not in _after or _after[p] != s for p,s in _before.items()):
        _scene_revision_fail('source ' + _label + ' changed or removed')
    if _label in {'light','world'} and set(_after) != set(_before):
        _scene_revision_fail('new ' + _label + ' is not a geometry revision')
for _collection in bpy.data.collections:
    _pointer = _scene_pointer(_collection)
    if _pointer in _scene_old_collections:
        _state = _scene_digest([_collection.name,_scene_values(_collection),
            sorted(_scene_pointer(c) for c in _collection.children if _scene_pointer(c) in _scene_old_collections)])
        if _state != _scene_old_collections[_pointer]: _scene_revision_fail('baseline collection changed')
    elif any(_scene_pointer(o) not in _scene_allowed_objects and _scene_pointer(o) not in _scene_new_objects for o in _collection.all_objects):
        _scene_revision_fail('new collection contains unrelated objects')
if not set(_scene_old_collections).issubset({_scene_pointer(c) for c in bpy.data.collections}):
    _scene_revision_fail('baseline collection removed')
if _scene_digest(_scene_layers()) != _scene_layer_before: _scene_revision_fail('view layer visibility changed')
if _scene_pointer(bpy.context.scene) != _scene_scene_pointer or _scene_digest([
        _scene_pointer(bpy.context.scene.camera),_scene_pointer(bpy.context.scene.world),
        _scene_rna(bpy.context.scene.render),_scene_rna(bpy.context.scene.view_settings),
        _scene_rna(bpy.context.scene.display_settings),_scene_tree(getattr(bpy.context.scene,'node_tree',None)),
        getattr(bpy.context.scene,'use_nodes',False),_scene_pointer(getattr(bpy.context.scene,'compositing_node_group',None))]) != _scene_scene_before:
    _scene_revision_fail('main camera, crop or scene appearance changed')
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

export function structuralShadingCode(): string {
  return `
for obj in bpy.context.scene.objects:
    materials = [slot.material for slot in obj.material_slots] if obj.type == 'MESH' else []
    if materials and all(m and m.use_nodes and any(n.type=='OUTPUT_MATERIAL' and n.is_active_output and n.inputs['Volume'].is_linked and not n.inputs['Surface'].is_linked for n in m.node_tree.nodes) for m in materials):
        obj.hide_render = True
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'SINGLE'
scene.display.shading.single_color = (0.7, 0.7, 0.7)
scene.display.shading.background_type = 'VIEWPORT'
scene.display.shading.background_color = (0.08, 0.08, 0.08)
scene.display.shading.show_xray = False
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.film_transparent = False
scene.render.image_settings.color_mode = 'BW'
scene.use_nodes = False
`;
}

export function renderCode(path: string, structural = false): string {
  return `
if bpy.context.scene.camera is None:
    raise RuntimeError("Set an active camera before rendering.")
${structural ? structuralShadingCode() : ""}
bpy.context.scene.render.image_settings.file_format = "PNG"
bpy.context.scene.render.filepath = ${JSON.stringify(path)}
bpy.ops.render.render(write_still=True)
`;
}

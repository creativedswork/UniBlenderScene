import assert from "node:assert/strict";
import { join } from "node:path";
import { BlenderClient, factorGuardCode, type RevisionScope } from "../src/service/blender.js";

// Only run on the integration suite's dedicated bridge, after its scene tests.
// This fixture is never connected to an interactive or production Blender.
export async function testBoundedRevisionGuard(client: BlenderClient, directory: string): Promise<number> {
  const scope: RevisionScope = { nodeIds: ["subject"], graphObjects: [{ nodeId: "subject", names: ["Subject"] }] };
  const cases: { name: string; code: string; denied?: boolean; stage?: string; setup?: string; cold?: boolean; diagnostic?: string }[] = [
    { name: "cold attribute storage materialization", cold: true,
      setup: "bpy.ops.mesh.primitive_cube_add()\no=bpy.context.object\no.name='ColdProtected'\no['scene_node_id']='other'\no.modifiers.new('Bevel','BEVEL').width=.002",
      code: "bpy.data.objects['Subject'].data.vertices[0].co.x += .2\nbpy.data.objects['Subject'].location.x += .3" },
    { name: "cold attribute payload remains protected", cold: true,
      setup: "bpy.ops.mesh.primitive_cube_add()\no=bpy.context.object\no.name='ColdProtected'\no['scene_node_id']='other'\no.data.attributes.new('Payload','FLOAT','POINT')",
      code: "bpy.data.objects['ColdProtected'].data.attributes['Payload'].data[0].value=.25", denied: true, diagnostic: "ColdProtected" },
    { name: "cold protected camera diagnostic", cold: true,
      code: "bpy.context.scene.camera.data.lens += 1", denied: true, diagnostic: "MainCamera" },
    { name: "protected removal diagnostic", code: "bpy.data.objects.remove(bpy.data.objects['Other'],do_unlink=True)", denied: true, diagnostic: "unrelated object removed: Other" },
    { name: "scoped geometry and placement", code: "bpy.data.objects['Subject'].data.vertices[0].co.x += .2\nbpy.data.objects['Subject'].location.x += .3" },
    { name: "scoped replacement with imported white material", code: "bpy.data.objects.remove(bpy.data.objects['Subject'],do_unlink=True)\nbpy.ops.mesh.primitive_cube_add()\no=bpy.context.object\no['scene_node_id']='subject'\nm=bpy.data.materials.new('Imported white')\nm.use_nodes=True\no.data.materials.append(m)" },
    { name: "new scoped mesh uses existing material without changing source", code: "bpy.ops.mesh.primitive_cube_add()\no=bpy.context.object\no['scene_node_id']='subject'\no.data.materials.append(bpy.data.materials['Source'])" },
    { name: "scoped descendant geometry", code: "bpy.data.objects['Child'].data.vertices[0].co.x += .2" },
    { name: "geometry copy breaks sharing safely", setup: "bpy.data.objects['Other'].data=bpy.data.objects['Subject'].data", code: "o=bpy.data.objects['Subject']\no.data=o.data.copy()\no.data.vertices[0].co.x += .2" },
    { name: "UI mesh selection is not geometry", code: "bpy.data.objects['Other'].data.vertices[0].select=True" },
    { name: "source node links are protected", code: "shape=bpy.data.node_groups['Shape']\nshape.links.remove(next(iter(shape.links)))", denied: true },
    { name: "new collection of new scoped objects", code: "c=bpy.data.collections.new('Imported')\nbpy.context.scene.collection.children.link(c)\nbpy.ops.mesh.primitive_cube_add()\no=bpy.context.object\no['scene_node_id']='subject'\nfor old in list(o.users_collection): old.objects.unlink(o)\nc.objects.link(o)" },
    { name: "composition allows scoped placement", stage: "composition", code: "bpy.data.objects['Subject'].location.x += .3" },
    { name: "composition freezes scope geometry", stage: "composition", code: "bpy.data.objects['Subject'].data.vertices[0].co.x += .2", denied: true },
    { name: "unrelated mesh", code: "bpy.data.objects['Other'].data.vertices[0].co.x += .2", denied: true },
    { name: "shared source mesh", setup: "bpy.data.objects['Other'].data=bpy.data.objects['Subject'].data", code: "bpy.data.objects['Subject'].data.vertices[0].co.x += .2", denied: true },
    { name: "shared geometry nodes", code: "bpy.data.node_groups['Shape'].nodes['Transform Geometry'].inputs['Translation'].default_value.x += .2", denied: true },
    { name: "mixed polygon topology protected", setup: "m=bpy.data.meshes.new('Mixed')\nm.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(2,0,0),(2,1,0)],[],[(0,1,2),(1,4,5,2)])\nbpy.data.objects['Other'].data=m", code: "bpy.data.objects['Other'].data.polygons[1].flip()", denied: true },
    { name: "unrelated integer attribute", setup: "bpy.data.objects['Other'].data.attributes.new('Integer','INT','POINT')", code: "bpy.data.objects['Other'].data.attributes['Integer'].data[0].value=7", denied: true },
    { name: "unrelated string attribute fallback", setup: "bpy.data.objects['Other'].data.attributes.new('Text','STRING','POINT')", code: "bpy.data.objects['Other'].data.attributes['Text'].data[0].value=b'changed'", denied: true },
    { name: "unrelated topology same counts", code: "bpy.data.objects['Other'].data.loops[0].vertex_index=1", denied: true },
    { name: "unrelated face winding", code: "bpy.data.objects['Other'].data.polygons[0].flip()", denied: true },
    { name: "unrelated face material index", code: "bpy.data.objects['Other'].data.polygons[0].material_index=1", denied: true },
    { name: "unrelated UV coordinate", setup: "bpy.data.objects['Other'].data.uv_layers.new(name='UV')", code: "bpy.data.objects['Other'].data.uv_layers['UV'].data[0].uv.x=.5", denied: true },
    { name: "UV inspection does not allocate optional layers", setup: "bpy.data.objects['Other'].data.uv_layers.new(name='UV')", code: "assert not any(a.name.startswith(('.vs.','.es.','.pn.')) for a in bpy.data.objects['Other'].data.attributes)" },
    { name: "existing UV pin attribute protected", setup: "m=bpy.data.objects['Other'].data\nm.uv_layers.new(name='UV')\nm.attributes.new('.pn.UV','BOOLEAN','CORNER')", code: "bpy.data.objects['Other'].data.attributes['.pn.UV'].data[0].value=True", denied: true },
    { name: "unrelated float attribute", setup: "bpy.data.objects['Other'].data.attributes.new('Weight','FLOAT','POINT')", code: "bpy.data.objects['Other'].data.attributes['Weight'].data[0].value=.25", denied: true },
    { name: "unrelated shape key influence", setup: "o=bpy.data.objects['Other']\no.shape_key_add(name='Basis')\no.shape_key_add(name='Shape')", code: "bpy.data.objects['Other'].data.shape_keys.key_blocks['Shape'].value=.5", denied: true },
    { name: "shared mesh object-specific evaluation", setup: "o=bpy.data.objects['Other'].copy()\no.name='Shared'\nbpy.context.scene.collection.objects.link(o)\no.modifiers.new('Offset','SOLIDIFY')", code: "bpy.data.objects['Shared'].modifiers['Offset'].thickness=.5", denied: true },
    { name: "unrelated bool attribute", setup: "bpy.data.objects['Other'].data.attributes.new('Flag','BOOLEAN','FACE')", code: "bpy.data.objects['Other'].data.attributes['Flag'].data[0].value=True", denied: true },
    { name: "unrelated vector attribute", setup: "bpy.data.objects['Other'].data.attributes.new('Vector','FLOAT_VECTOR','POINT')", code: "bpy.data.objects['Other'].data.attributes['Vector'].data[0].vector.x=.25", denied: true },
    { name: "unrelated color attribute", setup: "bpy.data.objects['Other'].data.color_attributes.new(name='Color',type='BYTE_COLOR',domain='CORNER')", code: "bpy.data.objects['Other'].data.color_attributes['Color'].data[0].color=(1,0,0,1)", denied: true },
    { name: "unrelated zero-weight shape key", setup: "o=bpy.data.objects['Other']\no.shape_key_add(name='Basis')\no.shape_key_add(name='Hidden')", code: "bpy.data.objects['Other'].data.shape_keys.key_blocks['Hidden'].data[0].co.x=.25", denied: true },
    { name: "unrelated vertex group weight", setup: "g=bpy.data.objects['Other'].vertex_groups.new(name='Weights')\ng.add([0],.5,'REPLACE')", code: "bpy.data.objects['Other'].vertex_groups['Weights'].add([0],.75,'REPLACE')", denied: true },
    { name: "unrelated vertex group definition", setup: "bpy.data.objects['Other'].vertex_groups.new(name='Unused')", code: "bpy.data.objects['Other'].vertex_groups['Unused'].name='Changed'", denied: true },
    { name: "unrelated modifier parameter", setup: "bpy.data.objects['Other'].modifiers.new('Bevel','BEVEL')", code: "bpy.data.objects['Other'].modifiers['Bevel'].width=.2", denied: true },
    { name: "heterogeneous driver modifiers preserved", setup: "f=bpy.data.objects['Other'].driver_add('location',0)\nf.driver.expression='0'\nf.modifiers.new('CYCLES')\nf.modifiers.new('NOISE')", code: "bpy.data.objects['Subject'].location.x += .1" },
    { name: "scoped UV allowed", setup: "bpy.data.objects['Subject'].data.uv_layers.new(name='UV')", code: "bpy.data.objects['Subject'].data.uv_layers['UV'].data[0].uv.x=.5" },
    { name: "unrelated transform", code: "bpy.data.objects['Other'].location.x += 1", denied: true },
    { name: "main camera transform", code: "bpy.context.scene.camera.location.x += 1", denied: true },
    { name: "main camera optics", code: "bpy.context.scene.camera.data.lens += 1", denied: true },
    { name: "main camera replacement", code: "bpy.context.scene.camera=None", denied: true },
    { name: "render crop", code: "bpy.context.scene.render.border_min_x=.2", denied: true },
    { name: "render aspect", code: "bpy.context.scene.render.pixel_aspect_x=2", denied: true },
    { name: "unrelated render visibility", code: "bpy.data.objects['Other'].hide_render=True", denied: true },
    { name: "unrelated viewport visibility", code: "bpy.data.objects['Other'].hide_set(True)", denied: true },
    { name: "unrelated parent identity with same transform", code: "o=bpy.data.objects['Other']\nm=o.matrix_world.copy()\no.parent=bpy.data.objects['Subject']\no.matrix_world=m", denied: true },
    { name: "original retag cannot expand authorization", code: "o=bpy.data.objects['Other']\no['scene_node_id']='subject'\no.hide_render=True", denied: true },
    { name: "scoped tag cannot change", code: "bpy.data.objects['Subject']['scene_node_id']='other'", denied: true },
    { name: "new untagged object", code: "bpy.ops.mesh.primitive_cube_add()", denied: true },
    { name: "new object wrong tag", code: "bpy.ops.mesh.primitive_cube_add()\nbpy.context.object['scene_node_id']='other'", denied: true },
    { name: "new scoped tag cannot hide original", code: "bpy.ops.mesh.primitive_cube_add()\nbpy.context.object['scene_node_id']='subject'\nbpy.data.objects['Other'].hide_render=True", denied: true },
    { name: "remove unrelated object", code: "bpy.data.objects.remove(bpy.data.objects['Other'],do_unlink=True)", denied: true },
    { name: "replace unrelated original with same name and tag", code: "bpy.data.objects.remove(bpy.data.objects['Other'],do_unlink=True)\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name='Other'\nbpy.context.object['scene_node_id']='other'", denied: true },
    { name: "source material graph", code: "bpy.data.materials['Source'].node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.1", denied: true },
    { name: "unused baseline material graph", code: "bpy.data.materials['Unused'].node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.1", denied: true },
    { name: "source shader output socket", code: "bpy.data.materials['Source'].node_tree.nodes['Value'].outputs[0].default_value=.25", denied: true },
    { name: "source nested shader graph", code: "bpy.data.node_groups['Shader'].nodes['Value'].outputs[0].default_value=.1", denied: true },
    { name: "scoped existing material slots", code: "bpy.data.objects['Subject'].data.materials.clear()", denied: true },
    { name: "white new import cannot hide source material mutation", code: "bpy.ops.mesh.primitive_cube_add()\nbpy.context.object['scene_node_id']='subject'\nbpy.context.object.data.materials.append(bpy.data.materials.new('White'))\nbpy.data.materials['Source'].diffuse_color=(1,1,1,1)", denied: true },
    { name: "light settings", code: "bpy.data.lights['Key'].energy += 1", denied: true },
    { name: "light placement", code: "bpy.data.objects['Key'].location.x += 1", denied: true },
    { name: "new scoped light is forbidden", code: "bpy.ops.object.light_add(type='AREA')\nbpy.context.object['scene_node_id']='subject'", denied: true },
    { name: "world shader", code: "bpy.context.scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.2", denied: true },
    { name: "collection hides unrelated original", code: "bpy.data.collections['Fixture'].hide_render=True", denied: true },
    { name: "view layer exclusion", code: "bpy.context.view_layer.layer_collection.children['Fixture'].exclude=True", denied: true },
    { name: "new collection hides unrelated original", code: "c=bpy.data.collections.new('Hidden')\nbpy.context.scene.collection.children.link(c)\nc.objects.link(bpy.data.objects['Other'])\nc.hide_render=True", denied: true },
    { name: "conflicting graph name cannot authorize", setup: "bpy.data.objects['Subject']['scene_node_id']='other'", code: "pass", denied: true },
    { name: "explicit unrelated child tag wins", setup: "bpy.data.objects['Child']['scene_node_id']='other'", code: "bpy.data.objects['Child'].data.vertices[0].co.x += .2", denied: true },
    { name: "unrelated ancestor is not authorized", setup: "bpy.data.objects['Subject'].parent=bpy.data.objects['Other']", code: "bpy.data.objects['Other'].location.x += .2", denied: true },
  ];
  const fixture = `
bpy.ops.wm.read_factory_settings(use_empty=True)
collection=bpy.data.collections.new('Fixture')
bpy.context.scene.collection.children.link(collection)
for name in ['Subject','Other','Child']:
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([(0,0,0),(1,0,0),(0,1,0)],[],[(0,1,2)])
    obj=bpy.data.objects.new(name,mesh)
    collection.objects.link(obj)
bpy.data.objects['Subject']['scene_node_id']='subject'
bpy.data.objects['Other']['scene_node_id']='other'
bpy.data.objects['Child'].parent=bpy.data.objects['Subject']
material=bpy.data.materials.new('Source');material.use_nodes=True
material.node_tree.nodes.new('ShaderNodeValue')
bpy.data.objects['Subject'].data.materials.append(material)
bpy.data.objects['Other'].data.materials.append(material)
unused=bpy.data.materials.new('Unused');unused.use_nodes=True
shader=bpy.data.node_groups.new('Shader','ShaderNodeTree')
shader.nodes.new('ShaderNodeValue')
material.node_tree.nodes.new('ShaderNodeGroup').node_tree=shader
shape=bpy.data.node_groups.new('Shape','GeometryNodeTree')
shape.interface.new_socket(name='Geometry',in_out='INPUT',socket_type='NodeSocketGeometry')
shape.interface.new_socket(name='Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
i=shape.nodes.new('NodeGroupInput');o=shape.nodes.new('NodeGroupOutput')
t=shape.nodes.new('GeometryNodeTransform')
shape.links.new(i.outputs['Geometry'],t.inputs['Geometry']);shape.links.new(t.outputs['Geometry'],o.inputs['Geometry'])
for name in ['Subject','Other']:
    bpy.data.objects[name].modifiers.new('Shape','NODES').node_group=shape
camera=bpy.data.objects.new('MainCamera',bpy.data.cameras.new('MainCamera'))
collection.objects.link(camera);bpy.context.scene.camera=camera
light=bpy.data.objects.new('Key',bpy.data.lights.new('Key','AREA'))
collection.objects.link(light)
world=bpy.data.worlds.new('World');world.use_nodes=True;bpy.context.scene.world=world
bpy.context.view_layer.update()
`;
  const checkpoint = join(directory, "revision-guard-checkpoint.blend");
  const output = await client.execute(`
import json
_cases=json.loads(${JSON.stringify(JSON.stringify(cases.map((c) => ({ ...c, denied: Boolean(c.denied), guard: factorGuardCode(c.stage ?? "geometry", true, scope).join(`\n${c.code}\n`) }))))})
_passed=[]
for _case in _cases:
    exec(${JSON.stringify(fixture)}, {'bpy':bpy})
    if _case.get('setup'): exec(_case['setup'], {'bpy':bpy})
    bpy.context.view_layer.update()
    _baseline=[(o.name,list(o.location),o.hide_render,o.get('scene_node_id'),[tuple(v.co) for v in o.data.vertices] if o.type=='MESH' else None) for o in bpy.data.objects]
    bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(checkpoint)},check_existing=False)
    if _case.get('cold'): bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(checkpoint)})
    _error=None
    try: exec(_case['guard'], {'bpy':bpy})
    except RuntimeError as error: _error=str(error)
    if _case['denied']:
        assert _error and ('Revision scope violation' in _error or 'Stage scope violation' in _error), (_case['name'],_error)
        if _case.get('diagnostic'): assert _case['diagnostic'] in _error, (_case['name'],_error)
        bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(checkpoint)})
        _restored=[(o.name,list(o.location),o.hide_render,o.get('scene_node_id'),[tuple(v.co) for v in o.data.vertices] if o.type=='MESH' else None) for o in bpy.data.objects]
        assert _restored==_baseline, ('rollback',_case['name'])
    else: assert _error is None, (_case['name'],_error)
    _passed.append(_case['name'])
result={'passed':_passed}
`);
  assert.deepEqual(output.passed, cases.map((c) => c.name));
  return cases.length;
}

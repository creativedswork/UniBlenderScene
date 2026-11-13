import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlenderClient, factorGuardCode } from "../src/service/blender.js";

// Synthetic geometry only, on the integration suite's dedicated bridge.
export async function testGuardPerformance(client: BlenderClient, directory: string) {
  const triangles = 2700000;
  await client.execute(`
import numpy as np
bpy.ops.wm.read_factory_settings(use_empty=True)
n=${triangles}
mesh=bpy.data.meshes.new('Dense')
mesh.vertices.add(n*3);mesh.loops.add(n*3);mesh.polygons.add(n)
coords=np.zeros((n*3,3),dtype=np.float32)
coords[1::3,0]=1;coords[2::3,1]=1
mesh.vertices.foreach_set('co',coords.ravel())
indices=np.arange(n*3,dtype=np.int32)
mesh.loops.foreach_set('vertex_index',indices)
mesh.polygons.foreach_set('loop_start',np.arange(0,n*3,3,dtype=np.int32))
mesh.polygons.foreach_set('loop_total',np.full(n,3,dtype=np.int32))
mesh.update()
o=bpy.data.objects.new('Protected',mesh);bpy.context.scene.collection.objects.link(o)
o['scene_node_id']='protected'
copy=bpy.data.objects.new('Shared',mesh);bpy.context.scene.collection.objects.link(copy)
copy['scene_node_id']='protected'
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.name='Subject';bpy.context.object['scene_node_id']='subject'
bpy.context.view_layer.update()
del coords,indices
result={'triangles':len(mesh.polygons)}
`);
  const scope = { nodeIds: ["subject"], graphObjects: [{ nodeId: "subject", names: ["Subject"] }] };
  const [before, after] = factorGuardCode("geometry", false, scope);
  const timing = await client.execute(`
import time
start=time.perf_counter()
${before}
before_seconds=time.perf_counter()-start
bpy.data.objects['Subject'].location.x += .1
edit_seconds=time.perf_counter()-start-before_seconds
${after}
after_seconds=time.perf_counter()-start-before_seconds-edit_seconds
result={'triangles':${triangles},'beforeSeconds':before_seconds,'editSeconds':edit_seconds,'afterSeconds':after_seconds,'version':bpy.app.version_string}
`);
  // The default 300-second bridge timeout is the practical regression boundary.
  assert.ok(Number(timing.beforeSeconds) + Number(timing.afterSeconds) < 300);
  await assert.rejects(client.execute(`${before}
bpy.data.objects['Protected'].data.vertices[0].co.z=.1
${after}`), /Revision scope violation/);
  await writeFile(join(directory, "guard-performance.json"), JSON.stringify(timing, null, 2));
  return timing;
}

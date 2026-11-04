import bpy
from mathutils import Vector

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.object
cube.name = "RedCube"
bevel = cube.modifiers.new("Soft edges", "BEVEL")
bevel.width = 0.08
bevel.segments = 3
material = bpy.data.materials.new("Red")
material.use_nodes = True
shader = material.node_tree.nodes.get("Principled BSDF")
shader.inputs["Base Color"].default_value = (0.55, 0.035, 0.025, 1)
shader.inputs["Roughness"].default_value = 0.38
cube.data.materials.append(material)

bpy.ops.mesh.primitive_plane_add(size=200)
floor = bpy.context.object
floor.name = "Floor"
floor_material = bpy.data.materials.new("Warm floor")
floor_material.use_nodes = True
floor_shader = floor_material.node_tree.nodes.get("Principled BSDF")
floor_shader.inputs["Base Color"].default_value = (0.32, 0.29, 0.24, 1)
floor_shader.inputs["Roughness"].default_value = 0.8
floor.data.materials.append(floor_material)

bpy.ops.object.camera_add(location=(6, -7, 5))
camera = bpy.context.object
camera.name = "Camera"
camera.rotation_euler = (Vector((0, 0, 0.9)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.lens = 48
bpy.context.scene.camera = camera

bpy.ops.object.light_add(type="AREA", location=(2, -3, 7))
light = bpy.context.object
light.name = "Key"
light.data.energy = 1500
light.data.shape = "DISK"
light.data.size = 4
light.rotation_euler = (Vector((0, 0, 1)) - light.location).to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("Studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.15, 0.18, 0.22, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
bpy.context.scene.world = world
bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.samples = 16
bpy.context.scene.render.resolution_x = 512
bpy.context.scene.render.resolution_y = 512
bpy.context.scene.view_settings.view_transform = "AgX"

import bpy
from mathutils import Vector

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.object
cube.name = "RedCube"
cube["scene_node_id"] = "cube"
bevel = cube.modifiers.new("Soft edges", "BEVEL")
bevel.width = 0.08
bevel.segments = 3
material = bpy.data.materials.new("Red")
material.use_nodes = True
shader = material.node_tree.nodes.get("Principled BSDF")
shader.inputs["Base Color"].default_value = (0.55, 0.035, 0.025, 1)
shader.inputs["Roughness"].default_value = 0.38
cube.data.materials.append(material)
for uv in cube.data.uv_layers.active.data:
    uv.uv *= 4  # Lighting export must create a separate, non-overlapping atlas.

bpy.ops.mesh.primitive_plane_add(size=200)
floor = bpy.context.object
floor.name = "Floor"
floor_material = bpy.data.materials.new("Warm floor")
floor_material.use_nodes = True
floor_shader = floor_material.node_tree.nodes.get("Principled BSDF")
floor_shader.inputs["Base Color"].default_value = (0.32, 0.29, 0.24, 1)
floor_shader.inputs["Roughness"].default_value = 0.8
floor.data.materials.append(floor_material)
floor["codex_bake_lighting"] = 128
floor["codex_preview_emissive_tint"] = [1.0, 1.0, 1.0]

# Keep the legacy baked floor while placing a diffuse receiver over its center.
# The latter must show the area light's actual contact shadow in the web preview.
bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0.002))
receiver = bpy.context.object
receiver.name = "ShadowReceiver"
receiver.data.materials.append(floor_material)

# A portable tiled normal map must retain its original resolution and UVs.
normal_image = bpy.data.images.new("Portable tiled normal", width=64, height=64)
normal_image.colorspace_settings.name = "Non-Color"
normal_image.generated_color = (0.5, 0.5, 1, 1)
normal_image.pack()
normal_texture = floor_material.node_tree.nodes.new("ShaderNodeTexImage")
normal_texture.image = normal_image
normal_uv = floor_material.node_tree.nodes.new("ShaderNodeUVMap")
normal_uv.uv_map = receiver.data.uv_layers.active.name
normal_map = floor_material.node_tree.nodes.new("ShaderNodeNormalMap")
floor_material.node_tree.links.new(normal_uv.outputs["UV"], normal_texture.inputs["Vector"])
floor_material.node_tree.links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
floor_material.node_tree.links.new(normal_map.outputs["Normal"], floor_shader.inputs["Normal"])
for uv in receiver.data.uv_layers.active.data:
    uv.uv *= 3

# Export must bake procedural PBR inputs without baking scene lighting into them.
bpy.ops.mesh.primitive_cube_add(size=0.35, location=(1.8, 0, 0.175))
swatch = bpy.context.object
swatch.name = "ProceduralSwatch"
swatch_material = bpy.data.materials.new("Procedural swatch")
swatch_material.use_nodes = True
swatch_shader = swatch_material.node_tree.nodes.get("Principled BSDF")
noise = swatch_material.node_tree.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 4
ramp = swatch_material.node_tree.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.12, 0.05, 0.03, 1)
ramp.color_ramp.elements[1].color = (0.35, 0.18, 0.08, 1)
swatch_material.node_tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
swatch_material.node_tree.links.new(ramp.outputs["Color"], swatch_shader.inputs["Base Color"])
# A linked emission-strength mask must not turn the entire mesh into a light.
swatch_shader.inputs["Emission Color"].default_value = (1, 0.4, 0.1, 1)
uv = swatch_material.node_tree.nodes.new("ShaderNodeTexCoord")
separate_uv = swatch_material.node_tree.nodes.new("ShaderNodeSeparateXYZ")
mask = swatch_material.node_tree.nodes.new("ShaderNodeMath")
mask.operation = "GREATER_THAN"
mask.inputs[1].default_value = 0.5
power = swatch_material.node_tree.nodes.new("ShaderNodeMath")
power.operation = "MULTIPLY"
power.inputs[1].default_value = 4
swatch_material.node_tree.links.new(uv.outputs["UV"], separate_uv.inputs[0])
swatch_material.node_tree.links.new(separate_uv.outputs["X"], mask.inputs[0])
swatch_material.node_tree.links.new(mask.outputs[0], power.inputs[0])
swatch_material.node_tree.links.new(power.outputs[0], swatch_shader.inputs["Emission Strength"])
swatch.data.materials.append(swatch_material)

packed_image = bpy.data.images.new("Portable packed roughness metallic", width=64, height=64)
packed_image.colorspace_settings.name = "Non-Color"
packed_image.generated_color = (1, 0.6, 0.2, 1)
packed_image.pack()
packed_material = bpy.data.materials.new("Portable packed PBR")
packed_material.use_nodes = True
packed_tree = packed_material.node_tree
packed_shader = packed_tree.nodes.get("Principled BSDF")
packed_shader.inputs["Base Color"].default_value = (0.2, 0.3, 0.4, 1)
packed_texture = packed_tree.nodes.new("ShaderNodeTexImage")
packed_texture.image = packed_image
packed_channels = packed_tree.nodes.new("ShaderNodeSeparateColor")
packed_channels.mode = "RGB"
packed_tree.links.new(packed_texture.outputs["Color"], packed_channels.inputs["Color"])
packed_tree.links.new(packed_channels.outputs["Green"], packed_shader.inputs["Roughness"])
packed_tree.links.new(packed_channels.outputs["Blue"], packed_shader.inputs["Metallic"])
bpy.ops.mesh.primitive_cube_add(size=0.3, location=(1.8, -0.5, 0.15))
packed_swatch = bpy.context.object
packed_swatch.name = "PackedPBRSwatch"
packed_swatch.data.materials.append(packed_material)
packed_instance = packed_swatch.copy()
packed_instance.data = packed_swatch.data
packed_instance.name = "PackedPBRInstance"
packed_instance.location = (2.1, 0.4, 0.15)
bpy.context.scene.collection.objects.link(packed_instance)

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

bpy.ops.object.light_add(type="SUN", location=(8, -10, 12))
sun = bpy.context.object
sun.name = "Soft sun"
sun.data.energy = 0.2
sun.rotation_euler = (Vector((0, 0, 0)) - sun.location).to_track_quat("-Z", "Y").to_euler()

# Exercise linked world export and the supported Blender compositor effects.
nodes = world.node_tree.nodes
coordinates = nodes.new("ShaderNodeTexCoord")
separate = nodes.new("ShaderNodeSeparateXYZ")
ramp = nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.12, 0.15, 0.2, 1)
ramp.color_ramp.elements[1].color = (0.2, 0.18, 0.14, 1)
world.node_tree.links.new(coordinates.outputs["Normal"], separate.inputs["Vector"])
world.node_tree.links.new(separate.outputs["Z"], ramp.inputs["Fac"])
world.node_tree.links.new(ramp.outputs["Color"], nodes["Background"].inputs["Color"])
# A linked atmosphere must not suppress the exported sky or get baked into it.
position = nodes.new("ShaderNodeNewGeometry")
radius = nodes.new("ShaderNodeVectorMath")
radius.operation = "LENGTH"
world.node_tree.links.new(position.outputs["Position"], radius.inputs[0])
bound = nodes.new("ShaderNodeMath")
bound.operation = "LESS_THAN"
bound.inputs[1].default_value = 2
world.node_tree.links.new(radius.outputs["Value"], bound.inputs[0])
density = nodes.new("ShaderNodeMath")
density.operation = "MULTIPLY"
density.inputs[1].default_value = 0.02
world.node_tree.links.new(bound.outputs[0], density.inputs[0])
volume = nodes.new("ShaderNodeVolumeScatter")
world.node_tree.links.new(density.outputs[0], volume.inputs["Density"])
world.node_tree.links.new(volume.outputs["Volume"], nodes["World Output"].inputs["Volume"])
proxy_material = bpy.data.materials.new("Pure atmosphere")
proxy_material.use_nodes = True
proxy_material.node_tree.nodes.remove(proxy_material.node_tree.nodes.get("Principled BSDF"))
proxy_scatter = proxy_material.node_tree.nodes.new("ShaderNodeVolumeScatter")
proxy_scatter.inputs["Density"].default_value = 0.01
proxy_material.node_tree.links.new(proxy_scatter.outputs["Volume"], proxy_material.node_tree.nodes["Material Output"].inputs["Volume"])
bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 1))
proxy = bpy.context.object
proxy.name = "PureVolumeProxy"
proxy.data.materials.append(proxy_material)
scene = bpy.context.scene
scene.view_layers[0].use_pass_mist = True
world.mist_settings.start = 5
world.mist_settings.depth = 50
world.mist_settings.falloff = "QUADRATIC"
scene.render.use_compositing = True
group = bpy.data.node_groups.new("Preview effects", "CompositorNodeTree")
group.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
scene.compositing_node_group = group
layers = group.nodes.new("CompositorNodeRLayers")
bloom = group.nodes.new("CompositorNodeGlare")
bloom.inputs["Type"].default_value = "Fog Glow"
bloom.inputs["Strength"].default_value = 0.1
multiply = group.nodes.new("ShaderNodeMath")
multiply.operation = "MULTIPLY"
multiply.inputs[1].default_value = 0.03
mix = group.nodes.new("ShaderNodeMix")
mix.data_type = "RGBA"
mix.inputs[7].default_value = (0.3, 0.25, 0.2, 1)
output = group.nodes.new("NodeGroupOutput")
group.links.new(layers.outputs["Image"], bloom.inputs["Image"])
group.links.new(layers.outputs["Mist"], multiply.inputs[0])
group.links.new(multiply.outputs[0], mix.inputs[0])
group.links.new(bloom.outputs["Image"], mix.inputs[6])
group.links.new(mix.outputs[2], output.inputs["Image"])

# A second named volume has its own color and a linked, height-dependent density.
bpy.ops.mesh.primitive_cube_add(size=2, location=(1, 0, 0.8))
low = bpy.context.object
low.name = "Low colored haze"
material = proxy_material.copy()
tree = material.node_tree
scatter = next(node for node in tree.nodes if node.type == "VOLUME_SCATTER")
scatter.inputs["Color"].default_value = (0.2, 0.5, 0.8, 1)
scatter.inputs["Anisotropy"].default_value = 0.35
coordinates = tree.nodes.new("ShaderNodeTexCoord")
height = tree.nodes.new("ShaderNodeSeparateXYZ")
fade = tree.nodes.new("ShaderNodeMapRange")
fade.inputs["To Min"].default_value = 0.08
fade.inputs["To Max"].default_value = 0.01
tree.links.new(coordinates.outputs["Generated"], height.inputs[0])
tree.links.new(height.outputs["Z"], fade.inputs["Value"])
noise = tree.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 0.7
tree.links.new(coordinates.outputs["Object"], noise.inputs["Vector"])
multiply = tree.nodes.new("ShaderNodeMath")
multiply.operation = "MULTIPLY"
tree.links.new(noise.outputs["Fac"], multiply.inputs[0])
tree.links.new(fade.outputs["Result"], multiply.inputs[1])
tree.links.new(multiply.outputs[0], scatter.inputs["Density"])
low.data.materials.append(material)

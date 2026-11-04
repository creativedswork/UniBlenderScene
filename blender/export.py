"""Export a copy of the reviewed scene; preserve the source .blend."""
import json
import math
import os

import bpy
from mathutils import Matrix

source = __SOURCE_BLEND__
directory = __OUTPUT_DIRECTORY__
bpy.ops.wm.open_mainfile(filepath=source)
scene = bpy.context.scene


def upstream(socket, kind, seen=None):
    seen = set() if seen is None else seen
    if socket is None:
        return None
    for link in socket.links:
        node = link.from_node
        if node in seen:
            continue
        seen.add(node)
        if node.type == kind:
            return node
        for input_socket in node.inputs:
            found = upstream(input_socket, kind, seen)
            if found:
                return found
    return None


def bake_static_lighting(scene):
    """Bake opted-in opaque meshes on the export copy into emissive glTF textures."""
    candidates = [obj for obj in scene.objects if obj.type == "MESH" and obj.get("codex_bake_lighting")]
    if not candidates:
        return []
    scene.render.engine = "CYCLES"
    scene.cycles.samples = min(scene.cycles.samples, 32)
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    baked = []
    for obj in candidates:
        resolution = int(obj["codex_bake_lighting"])
        if resolution < 64 or resolution > 1024:
            raise ValueError(f"Invalid light bake resolution on {obj.name}: {resolution}")
        if not obj.data.uv_layers:
            obj.data.uv_layers.new(name="BakedLighting")
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(island_margin=0.03)
            bpy.ops.object.mode_set(mode="OBJECT")
        image = bpy.data.images.new(f"{obj.name} baked lighting", width=resolution, height=resolution, alpha=False)
        image.generated_color = (0, 0, 0, 1)
        materials = []
        for slot in obj.material_slots:
            if slot.material is None:
                slot.material = bpy.data.materials.new(f"{obj.name} material")
            material = slot.material.copy()
            material.use_nodes = True
            slot.material = material
            nodes = material.node_tree.nodes
            for node in nodes:
                node.select = False
            target = nodes.new("ShaderNodeTexImage")
            target.image = image
            target.select = True
            nodes.active = target
            materials.append(material)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="COMBINED", pass_filter={"DIFFUSE", "DIRECT", "INDIRECT"})
        image.pack()
        for material in materials:
            nodes = material.node_tree.nodes
            nodes.clear()
            output = nodes.new("ShaderNodeOutputMaterial")
            shader = nodes.new("ShaderNodeBsdfPrincipled")
            shader.inputs["Base Color"].default_value = (0, 0, 0, 1)
            shader.inputs["Roughness"].default_value = 1
            shader.inputs["Emission Strength"].default_value = 1
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = image
            material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Emission Color"])
            material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
        baked.append(obj.name)
    return baked


try:
    world = scene.world
    background = None
    if world and world.use_nodes:
        output = next((node for node in world.node_tree.nodes if node.type == "OUTPUT_WORLD" and node.is_active_output), None)
        background = upstream(output.inputs.get("Surface"), "BACKGROUND") if output else None
    color = list(background.inputs["Color"].default_value)[:3] if background else list(world.color) if world else [0, 0, 0]
    strength = float(background.inputs["Strength"].default_value) if background else 1.0
    environment = upstream(background.inputs.get("Color"), "TEX_ENVIRONMENT") if background else None
    mapping = upstream(environment.inputs.get("Vector"), "MAPPING") if environment else None
    environment_uri = None
    if environment and environment.image:
        settings = scene.render.image_settings
        original = (settings.file_format, settings.color_mode, settings.color_depth)
        try:
            settings.file_format, settings.color_mode, settings.color_depth = "OPEN_EXR", "RGB", "32"
            environment.image.save_render(filepath=os.path.join(directory, "environment.exr"), scene=scene)
            environment_uri = "environment.exr"
        finally:
            settings.file_format, settings.color_mode, settings.color_depth = original
    camera = scene.camera
    if camera:
        camera.name = "__CodexBlenderActiveCamera"
    baked_objects = bake_static_lighting(scene)
    baked_tints = {
        name: list(scene.objects[name]["codex_preview_emissive_tint"])
        for name in baked_objects if "codex_preview_emissive_tint" in scene.objects[name]
    }
    profile = {
        "version": 1,
        "colorManagement": {
            "viewTransform": scene.view_settings.view_transform,
            "look": scene.view_settings.look,
            "exposure": float(scene.view_settings.exposure),
            "gamma": float(scene.view_settings.gamma),
        },
        "render": {
            "resolutionX": scene.render.resolution_x,
            "resolutionY": scene.render.resolution_y,
            "filmTransparent": scene.render.film_transparent,
        },
        "camera": {"name": camera.name, "type": camera.data.type} if camera else None,
        "world": {
            "color": color, "strength": strength, "environmentUri": environment_uri,
            "environmentRotationY": -float(mapping.inputs["Rotation"].default_value[2]) if mapping else 0.0,
        },
        "lightMapping": {"intensityScale": 0.1, "maxShadowLights": 3, "shadowPowerRatio": 0.35},
        "bakedObjects": baked_objects,
        "bakedTints": baked_tints,
        "lights": [],
        "warnings": [
            "WebGL preview approximates Blender lighting. Use the rendered image for visual review.",
            "Procedural shaders, volumes, and compositor effects may require baking for glTF.",
        ],
    }
    for obj in scene.objects:
        if obj.type != "LIGHT":
            continue
        light = obj.data
        world_matrix = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1))) @ obj.matrix_world
        profile["lights"].append({
            "name": obj.name, "type": light.type, "color": list(light.color),
            "energy": float(light.energy), "webPower": float(light.energy) * 683.0 * 0.012,
            "useShadow": bool(light.use_shadow),
            "shape": getattr(light, "shape", ""), "size": float(getattr(light, "size", 0.0)),
            "sizeY": float(getattr(light, "size_y", getattr(light, "size", 0.0))),
            "spotSize": float(getattr(light, "spot_size", math.pi / 2)),
            "spotBlend": float(getattr(light, "spot_blend", 0.0)),
            "worldMatrix": [float(world_matrix[row][column]) for column in range(4) for row in range(4)],
        })
        if light.type == "AREA":
            light.type = "POINT"
        light.animation_data_clear()
        light.energy *= 0.012
        if light.node_tree:
            for node in light.node_tree.nodes:
                if node.type == "EMISSION":
                    node.inputs["Color"].default_value = (*light.color, 1.0)
    with open(os.path.join(directory, "render-profile.json"), "w", encoding="utf8") as file:
        json.dump(profile, file, indent=2)
    for obj in scene.objects:
        if obj.type == "CAMERA":
            obj.hide_set(obj != camera)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(directory, "final.glb"),
        export_format="GLB", use_active_scene=True, use_visible=True,
        export_apply=True, export_cameras=True, export_lights=True,
    )
    result = {"objects": len(scene.objects)}
finally:
    bpy.ops.wm.open_mainfile(filepath=source)

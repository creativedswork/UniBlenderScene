"""Export a copy of the reviewed scene; preserve the source .blend."""
import json
import math
import os
import base64
import tempfile
from array import array

import bpy
from mathutils import Matrix, Vector

source = __SOURCE_BLEND__
directory = __OUTPUT_DIRECTORY__
structural_preview = __STRUCTURAL_PREVIEW__
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


def bake_procedural_materials(scene):
    """Bake linked shader inputs on the export copy, keeping lighting live."""
    channels = ("Base Color", "Roughness", "Metallic", "Normal", "Emission Color")

    def needs_bake(socket):
        if not socket or not socket.is_linked:
            return False
        source = socket.links[0].from_node
        if source.type != "TEX_IMAGE":
            return True
        vector = source.inputs.get("Vector")
        if vector and vector.is_linked:
            link = vector.links[0]
            return not (link.from_node.type == "UVMAP" or
                        (link.from_node.type == "TEX_COORD" and link.from_socket.name == "UV"))
        return False

    report = {"objects": 0, "textures": 0}
    candidates = []
    for obj in scene.objects:
        if obj.type != "MESH" or obj.hide_get() or obj.hide_render or obj.get("codex_bake_lighting"):
            continue
        if any(material and material.use_nodes and any(
            node.type == "BSDF_PRINCIPLED" and any(needs_bake(node.inputs.get(name)) for name in channels)
            for node in material.node_tree.nodes)
            for material in (slot.material for slot in obj.material_slots)):
            candidates.append(obj)
    if not candidates:
        return report

    original_engine, original_samples, original_device = scene.render.engine, scene.cycles.samples, scene.cycles.device
    try:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 1
        scene.render.bake.margin = 8
        for obj in candidates:
            obj.data = obj.data.copy()
            for slot in obj.material_slots:
                if slot.material:
                    slot.material = slot.material.copy()
            if not obj.data.uv_layers:
                bpy.ops.object.select_all(action="DESELECT")
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.uv.smart_project(island_margin=0.02)
                bpy.ops.object.mode_set(mode="OBJECT")
            report["objects"] += 1
            for channel in channels:
                records = []
                if not any(slot.material and slot.material.use_nodes and any(
                    node.type == "BSDF_PRINCIPLED" and needs_bake(node.inputs.get(channel))
                    for node in slot.material.node_tree.nodes)
                    for slot in obj.material_slots):
                    continue
                dimensions = sorted(obj.dimensions, reverse=True)
                resolution = 1024 if dimensions[0] * dimensions[1] > 1.0 else 512
                image = bpy.data.images.new(f"{obj.name} {channel} preview", width=resolution,
                                            height=resolution, alpha=False, float_buffer=channel == "Emission Color")
                image.colorspace_settings.name = "sRGB" if channel in ("Base Color", "Emission Color") else "Non-Color"
                for slot in obj.material_slots:
                    material = slot.material
                    if not material or not material.use_nodes:
                        continue
                    tree = material.node_tree
                    node = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
                    socket = node.inputs.get(channel) if node else None
                    output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output), None)
                    if not output:
                        continue
                    target = tree.nodes.new("ShaderNodeTexImage")
                    target.image = image
                    for existing in tree.nodes:
                        existing.select = False
                    target.select = True
                    tree.nodes.active = target
                    if socket and needs_bake(socket):
                        surface = output.inputs["Surface"]
                        sources = [link.from_socket for link in surface.links]
                        emission = None
                        if channel != "Normal":
                            emission = tree.nodes.new("ShaderNodeEmission")
                            tree.links.new(socket.links[0].from_socket, emission.inputs["Color"])
                            tree.links.new(emission.outputs[0], surface)
                        records.append((tree, socket, target, surface, sources, emission))
                bpy.ops.object.select_all(action="DESELECT")
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.bake(type="NORMAL" if channel == "Normal" else "EMIT", use_clear=True, margin=8)
                for tree, socket, target, surface, sources, emission in records:
                    if emission:
                        tree.nodes.remove(emission)
                        for source in sources:
                            tree.links.new(source, surface)
                    for link in list(socket.links):
                        tree.links.remove(link)
                    if channel == "Normal":
                        normal = tree.nodes.new("ShaderNodeNormalMap")
                        tree.links.new(target.outputs["Color"], normal.inputs["Color"])
                        tree.links.new(normal.outputs["Normal"], socket)
                    else:
                        tree.links.new(target.outputs["Color"], socket)
                    target.image.pack()
                report["textures"] += 1
    finally:
        scene.render.engine, scene.cycles.samples, scene.cycles.device = original_engine, original_samples, original_device
    return report


def display_lut(scene):
    """Sample Blender's view transform, look, exposure and gamma for the web preview."""
    size, maximum = 48, 32.0
    image = bpy.data.images.new("__CodexDisplayLUT", width=size * size, height=size,
                                alpha=False, float_buffer=True)
    pixels = array("f")
    for green in range(size):
        for blue in range(size):
            for red in range(size):
                pixels.extend((maximum * (red / (size - 1)) ** 3,
                               maximum * (green / (size - 1)) ** 3,
                               maximum * (blue / (size - 1)) ** 3, 1.0))
    image.pixels.foreach_set(pixels)
    settings = scene.render.image_settings
    original = (settings.file_format, settings.color_mode, settings.color_depth)
    temporary = None
    try:
        settings.file_format, settings.color_mode, settings.color_depth = "PNG", "RGB", "8"
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as file:
            temporary = file.name
        image.save_render(temporary, scene=scene)
        with open(temporary, "rb") as file:
            return {"size": size, "maxLinear": maximum,
                    "uri": "data:image/png;base64," + base64.b64encode(file.read()).decode("ascii")}
    finally:
        settings.file_format, settings.color_mode, settings.color_depth = original
        if temporary:
            os.unlink(temporary)
        bpy.data.images.remove(image)


def prepare_structural_preview(scene):
    material = bpy.data.materials.new("Structural gray")
    material.use_nodes = True
    material.diffuse_color = (0.7, 0.7, 0.7, 1)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.7, 0.7, 0.7, 1)
    shader.inputs["Roughness"].default_value = 0.8
    for obj in list(scene.objects):
        if obj.type == "LIGHT":
            obj.data = obj.data.copy()
            obj.data.energy = 0
            obj.data.color = (1, 1, 1)
        elif hasattr(obj.data, "materials"):
            obj.data = obj.data.copy()
            obj.data.materials.clear()
            obj.data.materials.append(material)
            for slot in obj.material_slots:
                slot.link = "DATA"
                slot.material = material
            if obj.type == "MESH":
                for polygon in obj.data.polygons:
                    polygon.material_index = 0
                for attribute in list(obj.data.color_attributes):
                    obj.data.color_attributes.remove(attribute)
    world = bpy.data.worlds.new("Structural studio")
    world.use_nodes = True
    world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.12, 0.12, 0.12, 1)
    world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.6
    scene.world = world
    meshes = [obj for obj in scene.objects if obj.type == "MESH" and not obj.hide_render]
    focus = [obj for obj in meshes if min(obj.dimensions) > max(obj.dimensions) * 0.001] or meshes
    points = [obj.matrix_world @ Vector(corner) for obj in focus for corner in obj.bound_box]
    center = (Vector(tuple(min(p[i] for p in points) for i in range(3))) + Vector(tuple(max(p[i] for p in points) for i in range(3)))) / 2 if points else Vector((0, 0, 0))
    radius = max(0.5, max(((point - center).length for point in points), default=1))
    light = bpy.data.lights.new("Structural key", "AREA")
    light.energy = 100 * radius * radius
    light.size = radius * 2
    key = bpy.data.objects.new("Structural key", light)
    scene.collection.objects.link(key)
    key.location = center + Vector((2, -3, 4)) * radius
    key.rotation_euler = (center - key.location).to_track_quat("-Z", "Y").to_euler()
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.film_transparent = False
    scene.use_nodes = False
    if scene.camera:
        scene.camera.data = scene.camera.data.copy()
        scene.camera.data.dof.use_dof = False


try:
    if structural_preview:
        environment_path = os.path.join(directory, "environment.exr")
        if os.path.exists(environment_path):
            os.unlink(environment_path)
        prepare_structural_preview(scene)
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
    camera_projection = camera.calc_matrix_camera(
        bpy.context.evaluated_depsgraph_get(), x=scene.render.resolution_x,
        y=scene.render.resolution_y, scale_x=scene.render.pixel_aspect_x,
        scale_y=scene.render.pixel_aspect_y) if camera else None
    if camera:
        camera.name = "__CodexBlenderActiveCamera"
    baked_objects = [] if structural_preview else bake_static_lighting(scene)
    material_bakes = {"objects": 0, "textures": 0} if structural_preview else bake_procedural_materials(scene)
    baked_tints = {
        name: list(scene.objects[name]["codex_preview_emissive_tint"])
        for name in baked_objects if "codex_preview_emissive_tint" in scene.objects[name]
    }
    profile = {
        "version": 1,
        "previewMode": "structural" if structural_preview else "final",
        "colorManagement": {
            "viewTransform": scene.view_settings.view_transform,
            "look": scene.view_settings.look,
            "exposure": float(scene.view_settings.exposure),
            "gamma": float(scene.view_settings.gamma),
            "displayLut": display_lut(scene),
        },
        "render": {
            "resolutionX": scene.render.resolution_x,
            "resolutionY": scene.render.resolution_y,
            "filmTransparent": scene.render.film_transparent,
        },
        "camera": {
            "name": camera.name, "type": camera.data.type, "lens": float(camera.data.lens),
            "projectionMatrix": [float(camera_projection[row][column]) for column in range(4) for row in range(4)],
            "dof": {
                "enabled": bool(camera.data.dof.use_dof),
                "focusDistance": float((camera.matrix_world.translation - camera.data.dof.focus_object.matrix_world.translation).length)
                    if camera.data.dof.focus_object else float(camera.data.dof.focus_distance),
                "fStop": float(camera.data.dof.aperture_fstop),
                "blades": int(camera.data.dof.aperture_blades),
                "rotation": float(camera.data.dof.aperture_rotation),
                "ratio": float(camera.data.dof.aperture_ratio),
            },
        } if camera else None,
        "world": {
            "color": color, "strength": strength, "environmentUri": environment_uri,
            "environmentRotationY": -float(mapping.inputs["Rotation"].default_value[2]) if mapping else 0.0,
        },
        "bakedObjects": baked_objects,
        "bakedTints": baked_tints,
        "materials": material_bakes,
        "lights": [],
        "warnings": [
            "WebGL path tracing approximates Cycles lighting. Use the Blender render for visual review.",
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
        export_apply=True, export_cameras=True, export_lights=True, export_extras=True,
    )
    result = {"objects": len(scene.objects)}
finally:
    bpy.ops.wm.open_mainfile(filepath=source)

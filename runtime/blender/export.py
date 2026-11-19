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
reference_camera_names = __REFERENCE_CAMERA_NAMES__
prepared = __PREPARED_BLEND__
bake_metadata = json.loads(__BAKE_METADATA_JSON__)
preview_appearance = __PREVIEW_APPEARANCE__
bpy.ops.wm.open_mainfile(filepath=prepared or source)
scene = bpy.context.scene


def volume_only(obj):
    materials = [slot.material for slot in obj.material_slots] if obj.type == "MESH" else []
    return bool(materials) and all(material and material.use_nodes and any(
        node.type == "OUTPUT_MATERIAL" and node.is_active_output and
        node.inputs["Volume"].is_linked and not node.inputs["Surface"].is_linked
        for node in material.node_tree.nodes) for material in materials)


__VFX_EXPORT_SOURCE__


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


def compositor_profile(scene, warnings):
    tree = getattr(scene, "compositing_node_group", None) or getattr(scene, "node_tree", None)
    if not tree or not scene.render.use_compositing:
        return {}
    output = next((n for n in tree.nodes if n.type in {"GROUP_OUTPUT", "COMPOSITE"} and getattr(n, "is_active_output", True)), None)
    if not output or not output.inputs.get("Image"):
        return {}
    result = {}
    glare = upstream(output.inputs["Image"], "GLARE")
    glare_type = (glare.inputs["Type"].default_value if glare.inputs.get("Type")
                  else getattr(glare, "glare_type", "")) if glare else ""
    mode = glare_type.upper().replace(" ", "_")
    if mode in {"BLOOM", "FOG_GLOW"}:
        result["bloom"] = {key: float(glare.inputs[name].default_value) for key, name in
                           [("strength", "Strength"), ("threshold", "Threshold"), ("radius", "Size")]
                           if glare.inputs.get(name)}
        if not result["bloom"] and hasattr(glare, "threshold"):
            result["bloom"]["threshold"] = float(glare.threshold)
        if mode == "FOG_GLOW":
            warnings.append("Compositor Fog Glow is approximated with Bloom.")
    elif glare:
        warnings.append(f"Compositor Glare mode {glare_type} is unsupported.")
    source = output.inputs["Image"].links[0].from_node if output.inputs["Image"].is_linked else None
    if source and source.bl_idname == "ShaderNodeMix" and source.data_type == "RGBA" and source.inputs[0].is_linked:
        amount = source.inputs[0].links[0].from_node
        if amount.type == "MATH" and amount.operation == "MULTIPLY" and amount.inputs[0].is_linked:
            link = amount.inputs[0].links[0]
            if link.from_node.type == "R_LAYERS" and link.from_socket.name == "Mist" and not source.inputs[7].is_linked:
                mist = scene.world.mist_settings
                if mist.falloff in {"LINEAR", "QUADRATIC"}:
                    result["haze"] = {"start": float(mist.start), "depth": float(mist.depth),
                                      "falloff": mist.falloff, "strength": float(amount.inputs[1].default_value),
                                      "color": list(source.inputs[7].default_value)[:3]}
    return result


def bake_world_backgrounds(scene, world_output, ambient):
    surface = world_output.inputs["Surface"]
    original_surface = surface.links[0].from_socket
    volume = world_output.inputs["Volume"]
    volume_sources = [link.from_socket for link in volume.links]
    original_camera = scene.camera
    visibility = [(obj, obj.hide_render) for obj in scene.objects]
    render = scene.render
    settings = render.image_settings
    saved = (render.resolution_x, render.resolution_y, render.resolution_percentage, render.filepath,
             render.engine, render.film_transparent, render.use_compositing,
             settings.file_format, settings.color_mode, settings.color_depth, scene.cycles.samples)
    data = bpy.data.cameras.new("World export panorama")
    camera = bpy.data.objects.new("World export panorama", data)
    scene.collection.objects.link(camera)
    data.type = "PANO"
    if hasattr(data, "panorama_type"):
        data.panorama_type = "EQUIRECTANGULAR"
    else:
        data.cycles.panorama_type = "EQUIRECTANGULAR"
    camera.rotation_euler = (math.pi / 2, 0, 0)
    try:
        # Atmosphere is rendered separately in the viewer; keep its extinction and
        # scattering out of the environment light and background panorama.
        for link in list(volume.links):
            scene.world.node_tree.links.remove(link)
        for obj, _ in visibility:
            obj.hide_render = True
        scene.camera = camera
        render.resolution_x, render.resolution_y, render.resolution_percentage = 512, 256, 100
        render.engine, render.film_transparent, render.use_compositing = "CYCLES", False, False
        settings.file_format, settings.color_mode, settings.color_depth = "OPEN_EXR", "RGB", "32"
        scene.cycles.samples = 1
        scene.world.node_tree.links.new(ambient.outputs[0], surface)
        render.filepath = os.path.join(directory, "environment.exr")
        bpy.ops.render.render(write_still=True)
        scene.world.node_tree.links.new(original_surface, surface)
        render.filepath = os.path.join(directory, "background.exr")
        bpy.ops.render.render(write_still=True)
        with open(render.filepath, "rb") as file:
            background = "data:application/octet-stream;base64," + base64.b64encode(file.read()).decode("ascii")
        os.unlink(render.filepath)
        return background
    finally:
        scene.world.node_tree.links.new(original_surface, surface)
        for socket in volume_sources:
            scene.world.node_tree.links.new(socket, volume)
        scene.camera = original_camera
        for obj, hidden in visibility:
            obj.hide_render = hidden
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.cameras.remove(data)
        (render.resolution_x, render.resolution_y, render.resolution_percentage, render.filepath,
         render.engine, render.film_transparent, render.use_compositing,
         settings.file_format, settings.color_mode, settings.color_depth, scene.cycles.samples) = saved


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
    for obj in scene.objects:
        if volume_only(obj):
            obj.hide_render = True
            obj.hide_set(True)
    material = bpy.data.materials.new("Structural gray")
    material.use_nodes = True
    material.diffuse_color = (0.7, 0.7, 0.7, 1)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.7, 0.7, 0.7, 1)
    shader.inputs["Roughness"].default_value = 0.8
    structural_data_copies = {}
    for obj in list(scene.objects):
        if obj.type == "LIGHT":
            obj.data = obj.data.copy()
            obj.data.energy = 0
            obj.data.color = (1, 1, 1)
        elif hasattr(obj.data, "materials"):
            source_data = obj.data.as_pointer()
            if source_data not in structural_data_copies:
                structural_data_copies[source_data] = obj.data.copy()
            obj.data = structural_data_copies[source_data]
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
    output = None
    if world and world.use_nodes:
        output = next((node for node in world.node_tree.nodes if node.type == "OUTPUT_WORLD" and node.is_active_output), None)
        background = upstream(output.inputs.get("Surface"), "BACKGROUND") if output else None
    color = list(background.inputs["Color"].default_value)[:3] if background else list(world.color) if world else [0, 0, 0]
    strength = float(background.inputs["Strength"].default_value) if background else 1.0
    environment = upstream(background.inputs.get("Color"), "TEX_ENVIRONMENT") if background else None
    mapping = upstream(environment.inputs.get("Vector"), "MAPPING") if environment else None
    environment_uri = None
    background_uri = None
    if environment and environment.image:
        settings = scene.render.image_settings
        original = (settings.file_format, settings.color_mode, settings.color_depth)
        try:
            settings.file_format, settings.color_mode, settings.color_depth = "OPEN_EXR", "RGB", "32"
            environment.image.save_render(filepath=os.path.join(directory, "environment.exr"), scene=scene)
            environment_uri = "environment.exr"
        finally:
            settings.file_format, settings.color_mode, settings.color_depth = original
    elif not structural_preview and background and background.inputs["Color"].is_linked:
        background_uri = bake_world_backgrounds(scene, output, background)
        environment_uri = "environment.exr"
        strength = 1.0
    camera = scene.camera
    camera_projection = camera.calc_matrix_camera(
        bpy.context.evaluated_depsgraph_get(), x=scene.render.resolution_x,
        y=scene.render.resolution_y, scale_x=scene.render.pixel_aspect_x,
        scale_y=scene.render.pixel_aspect_y) if camera else None
    if camera and not reference_camera_names:
        camera.name = "__CodexBlenderActiveCamera"
    baked_objects = bake_metadata.get("bakedObjects", [])
    lightmaps = bake_metadata.get("lightmaps", [])
    material_bakes = bake_metadata.get("materials", {"objects": 0, "textures": 0})
    baked_tints = bake_metadata.get("bakedTints", {})
    warnings = []
    excluded = set()
    vfx = {} if structural_preview else vfx_profile(scene, excluded, warnings)
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
            "backgroundEnvironmentUri": background_uri,
        },
        "postprocessing": {} if structural_preview else compositor_profile(scene, warnings),
        "vfx": vfx,
        "previewAppearance": {} if structural_preview else {
            **preview_appearance,
            **({"renderMode": "raster"} if lightmaps or preview_appearance.get("planarReflection") or preview_appearance.get("reflectionProbe") else {}),
        },
        "bakedObjects": baked_objects,
        "bake": {key: bake_metadata[key] for key in ("id", "sourceBlendSha256", "pipelineHash") if key in bake_metadata},
        "lightmaps": lightmaps,
        "bakedTints": baked_tints,
        "materials": material_bakes,
        "lights": [],
        "warnings": [
            "WebGL path tracing approximates Cycles lighting. Use the Blender render for visual review.",
            *warnings,
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
            obj.hide_set(obj != camera and obj.name not in reference_camera_names)
        elif volume_only(obj) or obj.name in excluded:
            obj.hide_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(directory, "final.glb"),
        export_format="GLB", use_active_scene=True, use_visible=True,
        export_apply=True, export_cameras=True, export_lights=True, export_extras=True,
    )
    result = {"objects": len(scene.objects)}
finally:
    bpy.ops.wm.open_mainfile(filepath=source)

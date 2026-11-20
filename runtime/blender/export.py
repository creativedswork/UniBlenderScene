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


def socket_default(socket):
    if socket.is_linked:
        socket = socket.links[0].from_socket
        if socket.node.type not in {"VALUE", "RGB"}:
            raise ValueError("an input is driven by an unsupported node")
    return socket.default_value


def world_vector(vector):
    return [float(vector[0]), float(vector[2]), -float(vector[1])]


def fog_density(socket):
    try:
        return max(0.0, float(socket_default(socket))), []
    except ValueError:
        pass
    node = socket.links[0].from_node
    if node.type == "MATH" and node.operation == "MULTIPLY":
        left, ramps_left = fog_density(node.inputs[0])
        right, ramps_right = fog_density(node.inputs[1])
        ramps = ramps_left + ramps_right
        if len(ramps) <= 2:
            return left * right, ramps
    if node.type == "MAP_RANGE" and node.data_type == "FLOAT" and node.interpolation_type == "LINEAR" and node.clamp:
        axis_links = node.inputs["Value"].links
        split = axis_links[0].from_node if axis_links else None
        position = split.inputs[0].links if split and split.type == "SEPXYZ" else []
        if position and position[0].from_node.type == "NEW_GEOMETRY" and position[0].from_socket.name == "Position":
            axis = axis_links[0].from_socket.name
            start, end, low, high = (float(socket_default(node.inputs[key])) for key in ("From Min", "From Max", "To Min", "To Max"))
            if end > start and min(low, high) >= 0 and axis in {"X", "Y", "Z"}:
                selector = {"X": 0, "Y": 2, "Z": 1}[axis]
                if axis == "Y":
                    start, end, low, high = -end, -start, high, low
                return 1.0, [{"axis": selector, "range": [start, end], "density": [low, high]}]
    raise ValueError("the density graph uses unsupported inputs")


def fog_volume(obj, shader, density, emission):
    # The portable representation supports rectangular volumes aligned with the world axes.
    if obj.modifiers or len(obj.data.vertices) != 8 or len(obj.data.polygons) != 6:
        raise ValueError("the fog container is not a rectangular box")
    points = [world_vector(obj.matrix_world @ vertex.co) for vertex in obj.data.vertices]
    lo = [min(axis) for axis in zip(*points)]
    hi = [max(axis) for axis in zip(*points)]
    if any(a >= b for a, b in zip(lo, hi)) or len({tuple(round(x, 5) for x in p) for p in points}) != 8 or any(
            min(abs(p[i] - lo[i]), abs(p[i] - hi[i])) > 1e-5 for p in points for i in range(3)):
        raise ValueError("the fog box is not axis-aligned")
    value, ramps = fog_density(density)
    return {"name": obj.name, "min": lo, "max": hi, "density": value, "ramps": ramps, "emission": emission,
            "albedo": list(socket_default(shader.inputs["Color"]))[:3],
            "anisotropy": float(socket_default(shader.inputs["Anisotropy"]))}


def shaft_parameters(tree, node):
    if node.type == "GROUP":
        return (Vector(socket_default(node.inputs["Start"])), Vector(socket_default(node.inputs["End"])),
                float(socket_default(node.inputs["Start Radius"])), float(socket_default(node.inputs["End Radius"])),
                float(socket_default(node.inputs["Emission Strength"])))

    # Earlier scenes built the same axial envelope out of primitive math nodes.
    children = {child.label: child for child in tree.nodes if child.parent == node}
    origin = children["Position from the branch opening"]
    axis = children["Distance along the shaft"]
    width = children["Widen gently into the clearing"]
    gain = children["Volumetric contribution"]
    if (origin.type, origin.operation, axis.type, axis.operation, width.type, gain.type, gain.operation) != (
            "VECT_MATH", "SUBTRACT", "VECT_MATH", "DOT_PRODUCT", "MAP_RANGE", "MATH", "MULTIPLY"):
        raise ValueError("unrecognized legacy light shaft")
    start = Vector(socket_default(origin.inputs[1]))
    end = start + Vector(socket_default(axis.inputs[1])) * float(socket_default(width.inputs["From Max"]))
    return (start, end, float(socket_default(width.inputs["To Min"])),
            float(socket_default(width.inputs["To Max"])), float(socket_default(gain.inputs[1])))


def effect_profile(scene, world_output, visible_disk=None):
    effects = {"version": 1, "shafts": [], "fog": [], "issues": []}
    suns = [obj for obj in scene.objects if obj.type == "LIGHT" and obj.data.type == "SUN"
            and not obj.hide_render and obj.visible_get()]
    sun = next((obj for obj in suns if obj.get("codex_sun_disc")), None)
    if visible_disk and sun is None:
        axis = visible_disk.inputs["Value"].links
        if axis and axis[0].from_node.type == "VECT_MATH" and axis[0].from_node.operation == "DOT_PRODUCT":
            direction = Vector(axis[0].from_node.inputs[1].default_value).normalized()
            sun = next((obj for obj in suns if direction.dot(obj.matrix_world.to_quaternion() @ Vector((0, 0, 1))) > 0.999),
                       suns[0] if len(suns) == 1 else None)
    direction = sun.matrix_world.to_quaternion() @ Vector((0, 0, 1)) if sun else None
    if sun:
        radius = (math.acos(max(-1.0, min(1.0, visible_disk.inputs["From Min"].default_value)))
                  if visible_disk else max(0.0001, sun.data.angle * 0.5))
        effects["sun"] = {"name": sun.name, "direction": world_vector(direction), "angularRadius": radius,
                          "radiance": [float(value) * float(sun.data.energy) for value in sun.data.color],
                          "inBackground": visible_disk is not None}
        effects["issues"].append({"object": sun.name, "effect": "sun disk", "status": "approximate",
                                  "target": "threeRT", "reason": "ThreeRT draws the disk as distant unlit geometry."})
    if world_output and world_output.inputs["Volume"].is_linked:
        effects["issues"].append({"object": scene.world.name, "effect": "world volume", "status": "missing",
                                  "reason": "The world volume graph has no interactive representation."})
    for obj in scene.objects:
        if obj.hide_render or not obj.visible_get():
            continue
        if obj.type == "VOLUME":
            effects["issues"].append({"object": obj.name, "effect": "volume grid", "status": "missing",
                                      "reason": "Volume grids are not exported to the interactive viewers."})
        if not volume_only(obj):
            continue
        materials = {slot.material for slot in obj.material_slots}
        tree = next(iter(materials)).node_tree if len(materials) == 1 else None
        output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output), None) if tree else None
        shader = output.inputs["Volume"].links[0].from_node if output else None
        nodes = [node for node in tree.nodes if
                 (node.type == "GROUP" and node.node_tree and node.node_tree.get("codex_effect") == "sun_shaft_v1") or
                 (node.type == "FRAME" and node.name.startswith("Sun shaft "))] if tree else []
        legacy = any(node.type == "FRAME" for node in nodes)
        if shader and shader.type in {"VOLUME_SCATTER", "PRINCIPLED_VOLUME"} and (not nodes or legacy):
            try:
                density = shader.inputs["Density"]
                emission = [0.0, 0.0, 0.0]
                if legacy:
                    source = density.links[0].from_node if density.links else None
                    if not source or source.type != "MATH" or source.operation != "ADD" or source.label != "Base forest mist and illuminated areas":
                        raise ValueError("the base mist could not be separated from the shafts")
                    density = source.inputs[0]
                elif shader.type == "PRINCIPLED_VOLUME":
                    color = socket_default(shader.inputs["Emission Color"])
                    emission = [c * float(socket_default(shader.inputs["Emission Strength"])) for c in color[:3]]
                    if any(socket_default(shader.inputs["Absorption Color"])[:3]) or socket_default(shader.inputs["Blackbody Intensity"]) > 0:
                        raise ValueError("colored absorption or blackbody emission is unsupported")
                if len(effects["fog"]) == 8:
                    raise ValueError("the preview supports up to eight local fog boxes")
                effects["fog"].append(fog_volume(obj, shader, density, emission))
                effects["issues"].append({"object": obj.name, "effect": "fog", "status": "approximate", "target": "threejs",
                                          "reason": "Three.js reconstructs the local fog with single scattering."})
                if not nodes:
                    continue
            except (KeyError, TypeError, ValueError) as error:
                effects["issues"].append({"object": obj.name, "effect": "fog", "status": "missing", "reason": str(error)})
                if not nodes:
                    continue
        if not nodes or not direction or not shader or shader.type != "PRINCIPLED_VOLUME":
            effects["issues"].append({"object": obj.name, "effect": "volume material", "status": "missing",
                                      "reason": "The volume graph has no supported light shaft with a visible sun."})
            continue
        for node in nodes:
            try:
                start, end, r0, r1, emission = shaft_parameters(tree, node)
                length = (start - end).length
                if not all(math.isfinite(value) for value in (*start, *end, r0, r1, emission)) or min(length, r0, r1) <= 1e-6 or emission < 0:
                    raise ValueError("invalid shaft dimensions or emission")
                if node.type == "GROUP":
                    extinction = float(socket_default(node.inputs["Density"]))
                else:
                    scattering = next(n for n in tree.nodes if n.type == "MATH" and n.operation == "MULTIPLY" and n.label == "Local increase in scattering")
                    extinction = float(socket_default(scattering.inputs[1]))
                if not math.isfinite(extinction) or extinction < 0:
                    raise ValueError("invalid shaft density")
                if len(effects["shafts"]) == 8:
                    raise ValueError("the preview supports up to eight simultaneous shafts")
                effects["shafts"].append({"name": node.label or node.name, "start": world_vector(end + direction * length),
                                           "end": world_vector(end), "radii": [r0, r1], "density": extinction,
                                           "albedo": list(socket_default(shader.inputs["Color"]))[:3],
                                           "emission": [float(c) * emission for c in socket_default(shader.inputs["Emission Color"])[:3]],
                                           "anisotropy": float(socket_default(shader.inputs["Anisotropy"]))})
            except (KeyError, TypeError, ValueError, StopIteration) as error:
                effects["issues"].append({"object": obj.name, "effect": node.label or node.name, "status": "missing",
                                          "reason": str(error)})
        effects["issues"].append({"object": obj.name, "effect": "volume material", "status": "approximate",
                                  "reason": "The preview uses solar-aligned shafts with a simplified density profile."})
    return effects


def solar_disk_socket(disk):
    if disk:
        return next((link.to_socket for link in disk.outputs[0].links if link.to_node.bl_idname == "ShaderNodeMixRGB"
                     and link.to_node.blend_type == "ADD" and link.to_socket == link.to_node.inputs[0]), None)
    return None


def planar_reflection_receiver(scene):
    marked, water = [], []
    for obj in scene.objects:
        if obj.type != "MESH" or obj.hide_render or not obj.visible_get() or volume_only(obj):
            continue
        if obj.get("codex_planar_reflection"):
            marked.append(obj.name)
            continue
        bounds = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        x, y, z = [max(point[i] for point in bounds) - min(point[i] for point in bounds) for i in range(3)]
        if min(x, y) <= 0.1 or z > min(x, y) * 0.02:
            continue
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            output = next((n for n in material.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
            pbr = upstream(output.inputs["Surface"], "BSDF_PRINCIPLED") if output else None
            if pbr and not pbr.inputs["IOR"].is_linked and not pbr.inputs["Transmission Weight"].is_linked and (
                    abs(pbr.inputs["IOR"].default_value - 1.333) < 0.01 and pbr.inputs["Transmission Weight"].default_value > 0.3):
                water.append(obj.name)
                break
    receivers = marked or water
    return receivers[0] if len(receivers) == 1 else None, receivers


def compositor_profile(scene):
    tree = getattr(scene, "compositing_node_group", None) or getattr(scene, "node_tree", None)
    if not tree or not scene.render.use_compositing:
        return {}
    output = next((n for n in tree.nodes if n.type in {"GROUP_OUTPUT", "COMPOSITE"} and getattr(n, "is_active_output", True)), None)
    if not output or not output.inputs.get("Image"):
        return {}
    result = {}
    glare = upstream(output.inputs["Image"], "GLARE")
    if glare and glare.inputs.get("Type") and glare.inputs["Type"].default_value in {"Bloom", "Fog Glow"}:
        result["bloom"] = {key: float(glare.inputs[name].default_value) for key, name in
                           [("strength", "Strength"), ("threshold", "Threshold"), ("radius", "Size")]
                           if glare.inputs.get(name)}
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


def bake_world_backgrounds(scene, world_output, ambient, disk_socket=None):
    surface = world_output.inputs["Surface"]
    original_surface = surface.links[0].from_socket
    volume = world_output.inputs["Volume"]
    volume_sources = [link.from_socket for link in volume.links]
    disk_source = disk_socket.links[0].from_socket if disk_socket else None
    disk_value = disk_socket.default_value if disk_socket else None
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
        if disk_source is not None:
            scene.world.node_tree.links.remove(disk_socket.links[0])
            disk_socket.default_value = 0.0
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
        if disk_source is not None:
            disk_socket.default_value = disk_value
            scene.world.node_tree.links.new(disk_source, disk_socket)
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
    baked_panorama = False
    visible_disk = next((node for node in output.id_data.nodes
                         if node.type == "MAP_RANGE" and node.label == "Apparent solar disc"), None) if output else None
    effects = {} if structural_preview else effect_profile(scene, output, visible_disk)
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
        solar = effects.get("sun")
        disk_socket = solar_disk_socket(visible_disk) if solar else None
        if disk_socket is not None:
            visible = next((node for node in output.id_data.nodes if node.type == "BACKGROUND" and node.label == "Visible sky"), None)
            gain = float(visible.inputs["Strength"].default_value) if visible else 1.0
            solar["radiance"] = [float(channel) * gain for channel in disk_socket.node.inputs[2].default_value[:3]]
            solar["inBackground"] = False
        background_uri = bake_world_backgrounds(scene, output, background, disk_socket)
        environment_uri = "environment.exr"
        strength = 1.0
        baked_panorama = True
    if not environment_uri and os.path.exists(os.path.join(directory, "environment.exr")):
        os.unlink(os.path.join(directory, "environment.exr"))
    appearance = {} if structural_preview else dict(preview_appearance)
    postprocessing = {} if structural_preview else compositor_profile(scene)
    if not structural_preview and scene.render.use_compositing:
        compositor = getattr(scene, "compositing_node_group", None) or getattr(scene, "node_tree", None)
        final = next((n for n in compositor.nodes if n.type in {"GROUP_OUTPUT", "COMPOSITE"} and getattr(n, "is_active_output", True)), None) if compositor else None
        image = final.inputs.get("Image") if final else None
        if image and image.is_linked and image.links[0].from_node.type != "R_LAYERS":
            effects["issues"].append({"object": compositor.name, "effect": "compositor", "target": "threejs",
                                      "status": "approximate" if postprocessing else "missing",
                                      "reason": "The viewer approximates the compositor's glare and mist."
                                      if postprocessing else "The compositor graph has no supported interactive effect."})
    if not structural_preview and not appearance.get("planarReflection") and appearance.get("renderMode") != "pathtracing":
        receiver, candidates = planar_reflection_receiver(scene)
        if receiver:
            appearance["planarReflection"] = receiver
        elif len(candidates) > 1:
            effects["issues"].append({"object": ", ".join(candidates), "effect": "planar reflection", "status": "approximate",
                                      "target": "threejs", "reason": "Multiple receivers use environment reflection."})
    if appearance.get("planarReflection"):
        effects["issues"].append({"object": appearance["planarReflection"], "effect": "planar reflection", "status": "approximate",
                                  "target": "threejs", "reason": "Three.js uses a planar reflection capture."})
    camera = scene.camera
    camera_projection = camera.calc_matrix_camera(
        bpy.context.evaluated_depsgraph_get(), x=scene.render.resolution_x,
        y=scene.render.resolution_y, scale_x=scene.render.pixel_aspect_x,
        scale_y=scene.render.pixel_aspect_y) if camera else None
    if camera:
        camera.name = "__CodexBlenderActiveCamera"
    baked_objects = bake_metadata.get("bakedObjects", [])
    lightmaps = bake_metadata.get("lightmaps", [])
    material_bakes = bake_metadata.get("materials", {"objects": 0, "textures": 0})
    if effects:
        for shared in material_bakes.get("sharedMeshes", []):
            effects["issues"].append({"object": shared["name"], "effect": "shared material bake", "status": "approximate",
                                      "reason": "Mesh-local textures are shared. Bump detail can vary from Blender on differently scaled instances."})
    baked_tints = bake_metadata.get("bakedTints", {})
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
            # Cycles' rendered panorama has its longitude origin a quarter turn from Three.js.
            "environmentRotationY": math.pi / 2 if baked_panorama else -float(mapping.inputs["Rotation"].default_value[2]) if mapping else 0.0,
            "backgroundEnvironmentUri": background_uri,
        },
        "postprocessing": postprocessing,
        "previewAppearance": {
            **appearance,
            **({"renderMode": "raster"} if lightmaps or appearance.get("planarReflection") or appearance.get("reflectionProbe") else {}),
        },
        **({"effects": effects} if effects else {}),
        "bakedObjects": baked_objects,
        "bake": {key: bake_metadata[key] for key in ("id", "sourceBlendSha256", "pipelineHash") if key in bake_metadata},
        "lightmaps": lightmaps,
        "bakedTints": baked_tints,
        "materials": material_bakes,
        "lights": [],
        "warnings": [
            "WebGL path tracing approximates Cycles lighting. Use the Blender render for visual review.",
            "Procedural shaders, volumes, and compositor effects may require baking for glTF.",
        ],
    }
    for obj in scene.objects:
        if obj.type != "LIGHT" or obj.hide_render or not obj.visible_get():
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
        elif obj.hide_render or volume_only(obj):
            obj.hide_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(directory, "final.glb"),
        export_format="GLB", use_active_scene=True, use_visible=True,
        export_apply=True, export_cameras=True, export_lights=True, export_extras=True,
    )
    result = {"objects": len(scene.objects)}
finally:
    bpy.ops.wm.open_mainfile(filepath=source)

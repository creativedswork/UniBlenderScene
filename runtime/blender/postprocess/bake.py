"""Bake a reviewed scene copy. SceneStore owns execution and the source checkpoint."""
import json
import math
import os
from array import array

import bpy

source = __SOURCE_BLEND__
directory = __OUTPUT_DIRECTORY__
lighting_bakes = __LIGHTING_BAKES__
lighting_enabled = __LIGHTING_ENABLED__
bake_info = json.loads(__BAKE_INFO_JSON__)


def bake_static_lighting(scene):
    """Bake diffuse lighting on the export copy, optionally preserving PBR shaders."""
    candidates = [obj for obj in scene.objects if obj.type == "MESH" and obj.get("codex_bake_lighting")]
    if not candidates:
        return [], []
    scene.render.engine = "CYCLES"
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    baked = []
    results = []
    lightmaps = []
    for obj in candidates:
        resolution = int(obj["codex_bake_lighting"])
        mode = obj.get("codex_bake_mode", "appearance")
        scene.cycles.samples = int(obj.get("codex_bake_samples", 128 if mode == "lightmap" else 16))
        if resolution < 64 or resolution > 4096:
            raise ValueError(f"Invalid light bake resolution on {obj.name}: {resolution}")
        depsgraph = bpy.context.evaluated_depsgraph_get()
        obj.data = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph),
                                                  preserve_all_data_layers=True, depsgraph=depsgraph)
        obj.modifiers.clear()
        source_uv = obj.data.uv_layers.active
        source_uv_name = source_uv.name if source_uv else None
        if mode == "lightmap" and source_uv_name is None:
            raise ValueError("Lightmap baking requires source material UVs: " + obj.name)
        if mode == "lightmap" and len(obj.data.uv_layers) >= 4:
            raise ValueError("Lightmap baking needs a free UV channel below 4: " + obj.name)
        uv = obj.data.uv_layers.new(name="BakedLighting")
        obj.data.uv_layers.active = uv
        uv_name = uv.name
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(island_margin=0.01)
        bpy.ops.object.mode_set(mode="OBJECT")
        image = bpy.data.images.new(f"{obj.name} baked lighting", width=resolution, height=resolution, alpha=False, float_buffer=True)
        image.generated_color = (0, 0, 0, 1)
        materials = []
        targets = []
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
            targets.append((nodes, target))
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="DIFFUSE" if mode == "lightmap" else "COMBINED",
                            pass_filter={"DIRECT", "INDIRECT"} if mode == "lightmap" else {"COLOR", "DIFFUSE", "DIRECT", "INDIRECT"},
                            uv_layer=uv_name)
        pixels = array("f", [0]) * (resolution * resolution * 4)
        image.pixels.foreach_get(pixels)
        peak = max(1.0, max(value for i, value in enumerate(pixels) if i % 4 != 3 and math.isfinite(value)))
        for i in range(len(pixels)):
            if i % 4 != 3:
                value = max(0.0, pixels[i]) / peak
                pixels[i] = 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1.0 / 2.4) - 0.055
        # Float bake buffers contain linear radiance. glTF's PNG emissive map
        # must contain sRGB bytes; packing a float buffer directly stays linear.
        raw_image = image
        for nodes, target in targets:
            nodes.remove(target)
        baked_image = bpy.data.images.new(f"{obj.name} lighting sRGB", width=resolution, height=resolution, alpha=False)
        baked_image.colorspace_settings.name = "sRGB"
        image = baked_image
        image.pixels.foreach_set(pixels)
        image.pack()
        bpy.data.images.remove(raw_image)
        if mode == "lightmap":
            uri = f"lightmap-{len(lightmaps)}.png"
            image.filepath_raw = os.path.join(directory, uri)
            image.file_format = "PNG"
            image.save()
            lightmaps.append({"objectName": obj.name, "uri": uri,
                              "uvChannel": obj.data.uv_layers.find(uv_name), "scale": peak,
                              "samples": scene.cycles.samples, "resolution": resolution})
            # Adding a UV layer can invalidate Blender's RNA reference to the original layer.
            obj.data.uv_layers.active = obj.data.uv_layers[source_uv_name]
            bpy.data.images.remove(image)
            continue
        results.append((obj, materials, image, uv_name, peak))
        baked.append(obj.name)
    # Keep every source shader intact until all objects have sampled the lighting.
    for obj, materials, image, uv_name, peak in results:
        # Baked shaders use only this atlas. Export it as TEXCOORD_0 so renderers
        # with one UV channel (including our path tracer) sample it correctly.
        for layer in list(obj.data.uv_layers):
            if layer.name != uv_name:
                obj.data.uv_layers.remove(layer)
        obj.data.update()
        for material in materials:
            nodes = material.node_tree.nodes
            nodes.clear()
            output = nodes.new("ShaderNodeOutputMaterial")
            shader = nodes.new("ShaderNodeBsdfPrincipled")
            shader.inputs["Base Color"].default_value = (0, 0, 0, 1)
            shader.inputs["Roughness"].default_value = 1
            shader.inputs["Emission Strength"].default_value = peak
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = image
            coordinates = nodes.new("ShaderNodeUVMap")
            coordinates.uv_map = uv_name
            material.node_tree.links.new(coordinates.outputs["UV"], texture.inputs["Vector"])
            material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Emission Color"])
            material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return baked, lightmaps


def bake_procedural_materials(scene, lighting_enabled=True):
    """Bake linked shader inputs on the export copy, keeping lighting live."""
    channels = ("Base Color", "Roughness", "Metallic", "Normal", "Emission Color", "Coat Weight", "Coat Roughness")

    def needs_bake(socket):
        if not socket or not socket.is_linked:
            return False
        link = socket.links[0]
        source = link.from_node
        if source.type == "NORMAL_MAP" and socket.name == "Normal":
            return needs_bake(source.inputs.get("Color"))
        # Blender's glTF exporter reads packed roughness and metallic from
        # the green and blue channels of an RGB Separate Color node.
        packed_channel = {"Roughness": "Green", "Metallic": "Blue"}.get(socket.name)
        if source.type == "SEPARATE_COLOR" and source.mode == "RGB" and link.from_socket.name == packed_channel:
            color = source.inputs["Color"]
            if color.is_linked:
                image_link = color.links[0]
                texture = image_link.from_node
                if (texture.type == "TEX_IMAGE" and image_link.from_socket.name == "Color" and
                        texture.image and texture.image.colorspace_settings.is_data):
                    return needs_bake(color)
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
        if obj.type != "MESH" or obj.hide_get() or obj.hide_render or (lighting_enabled and obj.get("codex_bake_lighting") and obj.get("codex_bake_mode", "appearance") != "lightmap"):
            continue
        if any(material and material.use_nodes and any(
            node.type == "BSDF_PRINCIPLED" and (node.inputs["Emission Strength"].is_linked or
                any(needs_bake(node.inputs.get(name)) for name in channels))
            for node in material.node_tree.nodes)
            for material in (slot.material for slot in obj.material_slots)):
            candidates.append(obj)
    if not candidates:
        return report

    # These material nodes evaluate from the receiving surface. Other geometry
    # need not be in the Cycles scene for their emission or tangent-space bake.
    local_nodes = {"OUTPUT_MATERIAL", "BSDF_PRINCIPLED", "TEX_IMAGE", "TEX_COORD", "UVMAP", "TEX_NOISE",
                   "MATH", "VECT_MATH", "VALTORGB", "BUMP", "NORMAL_MAP", "MAP_RANGE", "MAPPING",
                   "RGB", "VALUE", "SEPXYZ", "SEPARATE_COLOR", "COMBXYZ"}
    local_modifiers = {"BEVEL", "WEIGHTED_NORMAL", "TRIANGULATE", "SUBSURF", "SOLIDIFY", "EDGE_SPLIT"}
    geometry = [obj for obj in scene.objects if not obj.hide_render and obj.type in {"MESH", "CURVE", "SURFACE", "FONT", "VOLUME", "CURVES", "POINTCLOUD"}]
    isolated = False

    def surface_local(obj):
        return all(modifier.type in local_modifiers for modifier in obj.modifiers) and all(
            node.type in local_nodes and (node.type != "TEX_COORD" or node.object is None)
            for slot in obj.material_slots if slot.material and slot.material.use_nodes for node in slot.material.node_tree.nodes)

    def shareable_mesh(obj):
        return not obj.modifiers and not obj.data.shape_keys and all(slot.link == "DATA" for slot in obj.material_slots) and all(
            link.from_node.type != "TEX_COORD" or link.from_socket.name in {"UV", "Object", "Generated"}
            for slot in obj.material_slots if slot.material and slot.material.use_nodes for link in slot.material.node_tree.links)

    # Group before any receiver swaps its data. Objects with independent material
    # slots or camera-dependent coordinates still bake separately.
    shared_keys = {obj.name: obj.data for obj in candidates if obj.data.users > 1 and surface_local(obj) and shareable_mesh(obj)}
    shared_meshes = {}
    reused = {}
    original_engine, original_samples, original_device = scene.render.engine, scene.cycles.samples, scene.cycles.device
    try:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 1
        scene.render.bake.margin = 8
        for obj in candidates:
            shared_source = shared_keys.get(obj.name)
            if shared_source in shared_meshes:
                obj.data = shared_meshes[shared_source]
                reused[shared_source.name] = reused.get(shared_source.name, 0) + 1
                continue
            if surface_local(obj):
                if not isolated:
                    for other in geometry:
                        other.hide_render = other != obj
                else:
                    isolated.hide_render = True
                    obj.hide_render = False
                isolated = obj
            elif isolated:
                for other in geometry:
                    other.hide_render = False
                isolated = False
            obj.data = obj.data.copy()
            for slot in obj.material_slots:
                if slot.material:
                    slot.material = slot.material.copy()
                    tree = slot.material.node_tree
                    if tree:
                        for shader in list(tree.nodes):
                            if shader.type != "BSDF_PRINCIPLED":
                                continue
                            strength = shader.inputs.get("Emission Strength")
                            if not strength or not strength.is_linked:
                                continue
                            # glTF has a constant emissiveStrength, not a strength texture.
                            # Bake color * strength together, including black outside the mask.
                            color = shader.inputs["Emission Color"]
                            product = tree.nodes.new("ShaderNodeVectorMath")
                            product.operation = "SCALE"
                            if color.is_linked:
                                tree.links.new(color.links[0].from_socket, product.inputs[0])
                            else:
                                product.inputs[0].default_value = color.default_value[:3]
                            tree.links.new(strength.links[0].from_socket, product.inputs[3])
                            tree.links.new(product.outputs[0], color)
                            for link in list(strength.links):
                                tree.links.remove(link)
                            strength.default_value = 1
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
                peak = 1.0
                if channel == "Emission Color":
                    pixels = array("f", [0]) * (resolution * resolution * 4)
                    image.pixels.foreach_get(pixels)
                    peak = max(1.0, max(value for i, value in enumerate(pixels) if i % 4 != 3 and math.isfinite(value)))
                    for i in range(len(pixels)):
                        if i % 4 != 3:
                            value = max(0.0, pixels[i]) / peak
                            pixels[i] = 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1.0 / 2.4) - 0.055
                    # A packed float image otherwise writes linear samples into an sRGB PNG.
                    # Use an encoded byte image, as for static appearance/lightmap bakes.
                    encoded = bpy.data.images.new(f"{obj.name} emission sRGB", width=resolution, height=resolution, alpha=False)
                    encoded.colorspace_settings.name = "sRGB"
                    encoded.pixels.foreach_set(pixels)
                    for slot in obj.material_slots:
                        if slot.material and slot.material.use_nodes:
                            for target in slot.material.node_tree.nodes:
                                if target.type == "TEX_IMAGE" and target.image == image:
                                    target.image = encoded
                    bpy.data.images.remove(image)
                    image = encoded
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
                    if channel == "Emission Color":
                        socket.node.inputs["Emission Strength"].default_value *= peak
                    target.image.pack()
                report["textures"] += 1
            if shared_source is not None:
                shared_meshes[shared_source] = obj.data
    finally:
        if isolated:
            for obj in geometry:
                obj.hide_render = False
        scene.render.engine, scene.cycles.samples, scene.cycles.device = original_engine, original_samples, original_device
    if reused:
        report["sharedMeshes"] = [{"name": name, "reusedObjects": count} for name, count in reused.items()]
    return report


try:
    bpy.ops.wm.open_mainfile(filepath=source)
    scene = bpy.context.scene
    for request in lighting_bakes:
        obj = scene.objects.get(request["objectName"])
        if obj is None or obj.type != "MESH" or obj.hide_render:
            raise ValueError("Lighting bake requires a visible mesh: " + request["objectName"])
        obj["codex_bake_lighting"] = request["resolution"]
        obj["codex_bake_mode"] = request.get("mode", "appearance")
        obj["codex_bake_samples"] = request.get("samples", 128 if request.get("mode") == "lightmap" else 16)
    baked_objects, lightmaps = bake_static_lighting(scene) if lighting_enabled else ([], [])
    material_bakes = bake_procedural_materials(scene, lighting_enabled)
    baked_tints = {name: list(scene.objects[name]["codex_preview_emissive_tint"])
                   for name in baked_objects if "codex_preview_emissive_tint" in scene.objects[name]}
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(directory, "prepared.blend"))
    bake_info.update(bakedObjects=baked_objects, lightmaps=lightmaps, bakedTints=baked_tints, materials=material_bakes)
    with open(os.path.join(directory, "bake.json"), "w", encoding="utf8") as file:
        json.dump(bake_info, file, indent=2)
    result = bake_info
finally:
    bpy.ops.wm.open_mainfile(filepath=source)

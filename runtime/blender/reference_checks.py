from array import array
from pathlib import Path
from tempfile import TemporaryDirectory

import bpy
from bpy_extras.object_utils import world_to_camera_view


def _image_size(path):
    image = bpy.data.images.load(path, check_existing=False)
    try:
        return tuple(image.size)
    finally:
        bpy.data.images.remove(image)


def _belongs(obj, node_ids, graph):
    while obj is not None:
        node = obj.get("scene_node_id")
        if node in graph:
            while node is not None:
                if node in node_ids:
                    return True
                node = graph[node]
            return False
        obj = obj.parent
    return False


def _volume_only(obj):
    materials = [slot.material for slot in obj.material_slots]
    return materials and all(
        mat and mat.use_nodes and any(
            node.type == "OUTPUT_MATERIAL" and node.is_active_output
            and node.inputs["Volume"].is_linked and not node.inputs["Surface"].is_linked
            for node in mat.node_tree.nodes
        )
        for mat in materials
    )


def _prepare_mask(scene, node_ids, graph):
    palette = {}
    for obj in scene.objects:
        if obj.type == "MESH" and _volume_only(obj):
            obj.hide_render = True
        if not obj.hide_render and obj.type in {"MESH", "CURVE", "SURFACE", "FONT", "META"} and _belongs(obj, node_ids, graph):
            index = len(palette) + 1
            if index >= 4095:
                raise ValueError("Too many mapped objects for the visibility mask.")
            palette[index] = obj
        else:
            index = 4095
        obj.color = ((index >> 8) / 15, ((index >> 4) & 15) / 15, (index & 15) / 15, 1)

    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Raw"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.display.render_aa = "OFF"
    shading = scene.display.shading
    shading.light = "FLAT"
    shading.color_type = "OBJECT"
    shading.show_xray = False
    shading.show_shadows = False
    shading.show_cavity = False
    shading.show_object_outline = False
    return palette


def _mask_pixels(scene, path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        image.colorspace_settings.name = "Non-Color"
        width, height = image.size
        pixels = array("f", [0]) * (width * height * 4)
        image.pixels.foreach_get(pixels)
        return width, height, pixels
    finally:
        bpy.data.images.remove(image)


def _measure_view(scene, camera, checks, palette, graph, path):
    width, height, pixels = _mask_pixels(scene, path)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated_camera = camera.evaluated_get(depsgraph)

    def owner(column, row):
        offset = ((height - 1 - row) * width + column) * 4
        if pixels[offset + 3] < 0.5:
            return None
        red, green, blue = (round(pixels[offset + channel] * 15) for channel in range(3))
        return palette.get(red * 256 + green * 16 + blue)

    for check in checks:
        node_ids = {check["nodeId"]}
        allowed = {obj.name for obj in palette.values() if _belongs(obj, node_ids, graph)}
        entry = {"id": check["id"], "camera": camera.name, "samples": []}
        if check["kind"] == "point":
            markers = [obj for obj in bpy.context.view_layer.objects if obj.type == "EMPTY"
                       and obj.get("scene_landmark_id") == check["landmarkId"] and _belongs(obj, node_ids, graph)]
            if len(markers) != 1:
                yield {**entry, "reason": "Expected one mapped Blender Empty with the frozen scene_landmark_id."}
                continue
            location = markers[0].evaluated_get(depsgraph).matrix_world.translation
            x, bottom_y, depth = world_to_camera_view(scene, evaluated_camera, location)
            y = 1 - bottom_y
            if 0 <= x < 1 and 0 <= y < 1 and camera.data.clip_start <= depth <= camera.data.clip_end:
                obj = owner(int(x * width), int(y * height))
                if obj and obj.name in allowed:
                    entry["samples"] = [{"point": [x, y], "objectName": obj.name}]
            if not entry["samples"]:
                entry.update(samples=[None], reason="Landmark is outside the frame or its mapped surface is not visible at the projected point.")
        else:
            right = check["side"] == "right"
            columns = range(width - 1, -1, -1) if right else range(width)
            for _, y in check["target"]:
                row = int(y * height)
                sample = None
                for column in columns:
                    obj = owner(column, row)
                    if obj and obj.name in allowed:
                        if column != (width - 1 if right else 0):
                            sample = {"point": [(column + int(right)) / width, y], "objectName": obj.name}
                        break
                entry["samples"].append(sample)
            if any(sample is None for sample in entry["samples"]):
                entry["reason"] = "The mapped edge is absent or clipped at one or more reference scanlines."
        yield entry


def capture(request):
    scene = bpy.context.scene
    primary_camera = scene.camera
    graph = {node["id"]: node["parentId"] for node in request["graph"]}
    results = []
    try:
        palette = _prepare_mask(scene, {check["nodeId"] for check in request["checks"]}, graph)
        with TemporaryDirectory(dir=Path(request["checkpoint"]).parent) as directory:
            path = Path(directory) / "visibility.png"
            for view in request["views"]:
                checks = [check for check in request["checks"] if check["reference"] == view["reference"]]
                camera = scene.objects.get(view["camera"]) if view.get("camera") else primary_camera
                try:
                    if not camera or camera.type != "CAMERA" or camera.data.type not in {"PERSP", "ORTHO"}:
                        raise ValueError("The paired perspective or orthographic camera is unavailable.")
                    if scene.render.use_border:
                        raise ValueError("Reference checks need full-frame renders with render borders disabled.")
                    if view["reference"] == "reference" and scene.render.pixel_aspect_x != scene.render.pixel_aspect_y:
                        raise ValueError("Reference checks need square pixels.")
                    reference_width, reference_height = _image_size(view["image"])
                    width, height = _image_size(view["render"])
                    if abs(width * reference_height - height * reference_width) > max(reference_width, reference_height):
                        raise ValueError("The paired render and reference have different aspect ratios.")
                    scene.camera = camera
                    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
                    scene.render.resolution_percentage = 100
                    scale = min(1, 1024 / max(width, height))
                    scene.render.resolution_x = max(4, round(width * scale))
                    scene.render.resolution_y = max(4, round(height * scale))
                    results.extend(_measure_view(scene, camera, checks, palette, graph, path))
                except (RuntimeError, ValueError) as error:
                    results.extend({"id": check["id"], "camera": camera.name if camera else None,
                                    "samples": [], "reason": str(error)} for check in checks)
    except (RuntimeError, ValueError) as error:
        return [{"id": check["id"], "samples": [], "reason": str(error)} for check in request["checks"]]
    finally:
        bpy.ops.wm.open_mainfile(filepath=request["checkpoint"])
    return results

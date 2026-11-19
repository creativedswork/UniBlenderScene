"""Extract cross-renderer effects before glTF removes or freezes Blender data."""

def input_link(socket):
    return socket.links[0] if socket is not None and socket.is_linked else None


def socket_value(socket, default=0.0):
    if socket is None:
        return default
    link = input_link(socket)
    if not link:
        return socket.default_value
    if link.from_node.type in {"VALUE", "RGB"}:
        return link.from_socket.default_value
    raise ValueError("linked shader input")


def scalar_node(socket, kind, operation=None):
    link = input_link(socket)
    node = link.from_node if link else None
    if node and node.type == kind and (operation is None or node.operation == operation):
        return node
    return None


def density_profile(socket, result):
    """Translate constant extinction and the supported height/noise patterns."""
    if not input_link(socket) or scalar_node(socket, "VALUE"):
        result["density"] = max(0, float(socket_value(socket)))
        return
    multiply = scalar_node(socket, "MATH", "MULTIPLY")
    if multiply:
        for index in (0, 1):
            a, b = multiply.inputs[index], multiply.inputs[1 - index]
            noise = scalar_node(a, "TEX_NOISE")
            exponent = scalar_node(a, "MATH", "EXPONENT")
            if noise and noise.noise_dimensions == "3D":
                coords = input_link(noise.inputs["Vector"])
                if coords and (coords.from_node.type, coords.from_socket.name) != ("TEX_COORD", "Object"):
                    continue
                result["noiseScale"] = max(0, float(socket_value(noise.inputs["Scale"])))
                density_profile(b, result)
                return
            if exponent:
                divide = scalar_node(exponent.inputs[0], "MATH", "DIVIDE")
                floor = scalar_node(divide.inputs[0], "MATH", "MAXIMUM") if divide else None
                offset = scalar_node(floor.inputs[0], "MATH", "SUBTRACT") if floor else None
                sep = scalar_node(offset.inputs[0], "SEPXYZ") if offset else None
                geo = input_link(sep.inputs[0]) if sep else None
                if (geo and geo.from_node.type == "NEW_GEOMETRY" and geo.from_socket.name == "Position"
                        and input_link(offset.inputs[0]).from_socket.name == "Z" and socket_value(floor.inputs[1]) == 0):
                    falloff = -float(socket_value(divide.inputs[1]))
                    if falloff > 0:
                        result["height"] = {"mode": "exponential", "start": float(socket_value(offset.inputs[1])), "depth": falloff}
                        result["density"] = max(0, float(socket_value(b)))
                        return
    gradient = scalar_node(socket, "MAP_RANGE")
    if gradient and gradient.data_type == "FLOAT" and gradient.interpolation_type == "LINEAR" and gradient.clamp:
        sep = scalar_node(gradient.inputs["Value"], "SEPXYZ")
        coords = input_link(sep.inputs[0]) if sep else None
        if (coords and coords.from_node.type == "TEX_COORD" and coords.from_socket.name == "Generated"
                and input_link(gradient.inputs["Value"]).from_socket.name == "Z" and "min" in result):
            start, end = (float(socket_value(gradient.inputs[n])) for n in ("From Min", "From Max"))
            bottom, top = (max(0, float(socket_value(gradient.inputs[n]))) for n in ("To Min", "To Max"))
            lo, hi = result["min"][1], result["max"][1]
            if end > start and hi > lo:
                result["height"] = {"mode": "linear", "start": lo + start * (hi - lo), "depth": (end - start) * (hi - lo),
                                    "top": top}
                result["density"] = bottom
                return
    raise ValueError("unsupported density graph")


def y_up(vector):
    return [float(vector[0]), float(vector[2]), -float(vector[1])]


def volume_profile(socket, name, obj=None):
    link = input_link(socket)
    if link.from_node.type not in {"VOLUME_SCATTER", "PRINCIPLED_VOLUME", "VOLUME_ABSORPTION"}:
        raise ValueError("unsupported volume shader")
    node = link.from_node
    result = {"name": name}
    if obj:
        bounds = [y_up(obj.matrix_world @ Vector(corner)) for corner in obj.bound_box]
        result["min"] = [min(p) for p in zip(*bounds)]
        result["max"] = [max(p) for p in zip(*bounds)]
        if any(a >= b for a, b in zip(result["min"], result["max"])):
            raise ValueError("empty volume bounds")
    colors = list(socket_value(node.inputs.get("Color")))[:3]
    result["color"] = colors
    if node.type == "VOLUME_ABSORPTION":
        raise ValueError("volume absorption shader")
    if node.type == "PRINCIPLED_VOLUME":
        absorption = socket_value(node.inputs.get("Absorption Color"), (0, 0, 0, 1))
        if any(abs(c) > 1e-6 for c in list(absorption)[:3]):
            raise ValueError("colored absorption")
        emission = float(socket_value(node.inputs.get("Emission Strength")))
        result["emission"] = [emission * c for c in list(socket_value(node.inputs.get("Emission Color"), (0, 0, 0, 1)))[:3]]
        for name in ("Density Attribute", "Color Attribute", "Temperature Attribute"):
            if node.inputs.get(name) and input_link(node.inputs[name]):
                raise ValueError("linked volume attribute")
        if float(socket_value(node.inputs.get("Blackbody Intensity"))) > 0:
            raise ValueError("blackbody emission")
    result["anisotropy"] = max(-0.95, min(0.95, float(socket_value(node.inputs.get("Anisotropy")))))
    density_profile(node.inputs["Density"], result)
    return result


def active_output(tree, kind):
    return next((n for n in tree.nodes if n.type == kind and n.is_active_output), None) if tree else None


def modifier_value(modifier, item):
    inputs = getattr(getattr(modifier, "properties", None), "inputs", None)
    prop = getattr(inputs, item.identifier, None)
    return prop.value if prop is not None else modifier.get(item.identifier, item.default_value)


def precipitation_profile(obj, modifier):
    group = modifier.node_group
    if not group:
        return None
    inputs = {item.name: item for item in group.interface.items_tree if getattr(item, "in_out", None) == "INPUT"}
    required = {"Count", "Size", "Speed", "Wind", "Gravity Sign", "Loop Frames", "FPS", "Lives", "Particle Size",
                "Streak Length", "Sway", "Seed", "Material", "Ground", "Splash", "Splash Time", "Near Clear"}
    if not required.issubset(inputs) or not any(n.type == "RAYCAST" for n in group.nodes):
        return None

    def value(name):
        return modifier_value(modifier, inputs[name])

    material, grounds = value("Material"), value("Ground")
    shader = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if material and material.use_nodes else None
    color = list(shader.inputs["Base Color"].default_value)[:3] if shader else [0.7, 0.75, 0.8]
    emissive = ([c * shader.inputs["Emission Strength"].default_value for c in shader.inputs["Emission Color"].default_value][:3]
                if shader else [0, 0, 0])
    size = Vector(value("Size"))
    matrix = obj.matrix_world
    corners = [y_up(matrix @ Vector((x, y, z))) for x in (-size.x / 2, size.x / 2)
               for y in (-size.y / 2, size.y / 2) for z in (0, size.z)]
    extents = [max(axis) - min(axis) for axis in zip(*corners)]
    speed = float(value("Speed")) * float(value("Gravity Sign"))
    lives = max(1, int(value("Lives")))
    kind = group.get("scene_vfx_precipitation")
    if not kind:
        # The weather graph distinguishes streaks, flat ash and rising particles structurally.
        node_types = {node.type for node in group.nodes}
        kind = "rain" if "MESH_PRIMITIVE_CONE" in node_types else "ash" if "MESH_PRIMITIVE_GRID" in node_types else "embers" if speed > 0 else "flakes"
    return {"name": obj.name, "kind": kind, "count": max(0, int(value("Count"))),
            "center": y_up(matrix @ Vector((0, 0, size.z / 2))),
            "size": extents,
            "velocity": y_up(matrix.to_3x3() @ (Vector(value("Wind")) + Vector((0, 0, speed)))),
            "period": max(1, int(value("Loop Frames"))) / max(0.001, float(value("FPS"))),
            "lives": lives, "seed": int(value("Seed")), "radius": float(value("Particle Size")),
            "streak": float(value("Streak Length")), "sway": float(value("Sway")), "near": float(value("Near Clear")),
            "splash": float(value("Splash Time")) if value("Splash") else 0,
            "ground": [ground.name for ground in grounds.all_objects] if grounds else [],
            "color": color, "emission": emissive}


def has_animation(owner):
    animation = owner.animation_data if owner else None
    return bool(animation and (animation.action or animation.drivers or animation.nla_tracks))


def weather_animation(scene):
    # Sample Blender's evaluated values, including drivers and modern action slots.
    # glTF handles ordinary transform animation. These animated properties are not glTF tracks.
    channels = []
    for obj in scene.objects:
        if obj.hide_render or not obj.visible_get():
            continue
        if obj.type == "LIGHT" and has_animation(obj.data):
            channels.append(({"kind": "light", "name": obj.name}, lambda data=obj.data: [data.energy, *data.color]))
        if obj.type not in {"MESH", "CURVE", "FONT", "SURFACE"}:
            continue
        for material in {slot.material for slot in obj.material_slots}:
            if not material or not material.use_nodes or not has_animation(material.node_tree):
                continue
            output = active_output(material.node_tree, "OUTPUT_MATERIAL")
            link = input_link(output.inputs["Surface"]) if output else None
            if link and link.from_node.type in {"EMISSION", "BSDF_PRINCIPLED"}:
                node = link.from_node
                prefix = "" if node.type == "EMISSION" else "Emission "
                color, strength = node.inputs.get(prefix + "Color"), node.inputs.get(prefix + "Strength")
                if color and strength and not (color.is_linked or strength.is_linked):
                    channels.append(({"kind": "emission", "name": obj.name, "material": material.name},
                                     lambda c=color, s=strength: [s.default_value, *c.default_value[:3]]))
    world = scene.world
    if world and world.use_nodes and has_animation(world.node_tree):
        output = active_output(world.node_tree, "OUTPUT_WORLD")
        link = input_link(output.inputs["Surface"]) if output else None
        if link and link.from_node.type == "BACKGROUND" and not link.from_node.inputs["Strength"].is_linked:
            channels.append(({"kind": "environment"}, lambda s=link.from_node.inputs["Strength"]: [s.default_value]))
    if not channels:
        return None
    fps = scene.render.fps / scene.render.fps_base
    start, end = scene.frame_start, scene.frame_end
    stride = max(1, math.ceil((end - start) / 1200))
    frames = list(range(start, end + 1, stride))
    if frames[-1] != end:
        frames.append(end)
    current, subframe = scene.frame_current, scene.frame_subframe
    initial = [[float(v) for v in sample()] for _, sample in channels]
    samples = [[] for _ in channels]
    try:
        for frame in frames:
            scene.frame_set(frame)
            for series, (_, sample) in zip(samples, channels):
                series.append([float(v) for v in sample()])
    finally:
        scene.frame_set(current, subframe=subframe)
    tracks = [{**track, "initial": base, "values": series} for (track, _), base, series in zip(channels, initial, samples)
              if any(values != series[0] for values in series[1:])]
    if tracks:
        return {"times": [(f - start) / fps for f in frames], "time": (current + subframe - start) / fps, "tracks": tracks}


def vfx_profile(scene, excluded, warnings):
    result = {"volumes": [], "precipitation": [], "ripples": []}
    if scene.world and scene.world.use_nodes:
        output = active_output(scene.world.node_tree, "OUTPUT_WORLD")
        if output and output.inputs["Volume"].is_linked:
            try:
                result["volumes"].append(volume_profile(output.inputs["Volume"], scene.world.name))
            except ValueError as error:
                warnings.append(f"World volume {scene.world.name}: {error}.")
    for obj in scene.objects:
        if obj.hide_render or not obj.visible_get():
            continue
        if obj.type == "VOLUME":
            warnings.append(f"Volume {obj.name}: grid or simulation volumes are Blender-only.")
        if volume_only(obj):
            try:
                materials = {slot.material for slot in obj.material_slots}
                if len(materials) != 1:
                    raise ValueError("multiple volume materials")
                output = active_output(next(iter(materials)).node_tree, "OUTPUT_MATERIAL")
                result["volumes"].append(volume_profile(output.inputs["Volume"], obj.name, obj))
            except ValueError as error:
                warnings.append(f"Volume {obj.name}: {error}.")
        for modifier in obj.modifiers:
            if modifier.type == "NODES" and modifier.show_render:
                weather = precipitation_profile(obj, modifier)
                if weather:
                    if obj.type == "MESH" and not obj.data.vertices and len(obj.modifiers) == 1:
                        result["precipitation"].append(weather)
                        excluded.add(obj.name)
                    else:
                        warnings.append(f"Precipitation {obj.name}: combined geometry is exported at the saved frame.")
                    break
        for material in {slot.material for slot in obj.material_slots}:
            if not material or not material.use_nodes:
                continue
            for group in material.node_tree.nodes:
                if group.type != "GROUP" or not all(group.inputs.get(name) for name in ("Puddles", "Ripples", "Scale", "Snow")):
                    continue
                if not any(socket.is_linked for socket in group.outputs):
                    continue
                strength = group.inputs["Ripples"].default_value
                puddles = group.inputs["Puddles"].default_value
                if strength > 0 and puddles > 0:
                    result["ripples"].append({"name": obj.name, "material": material.name, "strength": strength, "coverage": puddles,
                                              "scale": group.inputs["Scale"].default_value})
                    break
    animation = weather_animation(scene)
    if animation:
        result["animation"] = animation
    if len(result["volumes"]) > 8:
        warnings.append("Three.js previews the first eight atmosphere volumes.")
    if any(volume.get("noiseScale") for volume in result["volumes"]):
        warnings.append("Three.js approximates Blender volume noise.")
    if any(effect["count"] > 4000 for effect in result["precipitation"]):
        warnings.append("Three.js limits each precipitation emitter to 4000 particles.")
    return result

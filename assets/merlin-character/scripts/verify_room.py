"""Validate the landscape room, casual actions, contacts and portable GLB.

Run from the repository root after building the room:
  blender --background --factory-startup assets/merlin-character/merlin-room.blend \
    --python-exit-code 1 --python assets/merlin-character/scripts/verify_room.py

This checks saved assets without saving any scene changes. Numerical checks
complement visual review; they do not establish artistic quality or live-device
performance. The report records tolerances and the frames actually sampled.
"""

import datetime
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import wave

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


ASSET_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ASSET_DIR / "scripts"))
from verify_character import (EXPECTED_BONES, finite, material_images, parse_glb,
                              scalar_floats)


REPORT_PATH = ASSET_DIR / "previews" / "room-validation.json"
ACTION_LENGTHS = {"WalkWhistle": 192, "WallToss": 240, "Nap": 192,
                  "CasualShowcase": 624}
ORIGINAL_ACTIONS = {"Idle", "Wave", "Jump", "Showcase"}
FLOOR_Z = 0.024
WALL_LEFT = -4.5
WALL_RIGHT = 4.5
WALL_BACK = 4.20
BALL_RADIUS = 0.13
BALL_NAME = "Prop • cyan play ball"
SURFACE_TOLERANCE = 0.008
CONTACT_TOLERANCE = 0.035
FRAME_TOLERANCE = 0.005
TOSS_EVENTS = ((40, 58, 70, 86), (148, 166, 178, 194))
REST_CATCH_CENTER = Vector((0.95, -0.18, 1.18))
report = {
    "schema_version": 1,
    "checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "blender_version": bpy.app.version_string,
    "blend_file": Path(bpy.data.filepath).name if bpy.data.filepath else None,
    "glb_file": "merlin-room.glb",
    "checks": [],
    "counts": {},
    "measurements": {},
    "tolerances": {"surface_units": SURFACE_TOLERANCE,
                   "contact_units": CONTACT_TOLERANCE,
                   "frame_fraction": FRAME_TOLERANCE},
}


def check(name, passed, **details):
    report["checks"].append({"name": name, "passed": bool(passed), **details})


def positions(obj, depsgraph):
    """Yield evaluated world-space vertex positions, including skin/morphs."""
    evaluated = obj.evaluated_get(depsgraph)
    matrix = evaluated.matrix_world
    for vertex in evaluated.data.vertices:
        yield matrix @ vertex.co


def bounds(points):
    low = [math.inf] * 3
    high = [-math.inf] * 3
    for point in points:
        for index in range(3):
            low[index] = min(low[index], point[index])
            high[index] = max(high[index], point[index])
    return low, high


def visible(obj):
    return not obj.hide_render and max(abs(value) for value in obj.scale) > 0.001


def frame_geometry(scene, objects):
    """Use conservative boxes, refining potentially invalid boxes to vertices.

    The fast path is sufficient to prove clearance. A rotated box extending
    below the floor is not treated as penetration without inspecting the mesh.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lowest = {"z": math.inf, "object": None}
    wall_extent = [math.inf, -math.inf]
    projected = [math.inf, math.inf, -math.inf, -math.inf]
    behind_camera = []
    for obj in objects:
        if not visible(obj):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        world = evaluated.matrix_world
        corners = [world @ Vector(corner) for corner in evaluated.bound_box]
        low, high = bounds(corners)
        projected_corners = [world_to_camera_view(scene, scene.camera, p) for p in corners]
        near_surface = (low[2] < FLOOR_Z + SURFACE_TOLERANCE
                        or low[0] < WALL_LEFT + SURFACE_TOLERANCE
                        or high[0] > WALL_RIGHT - SURFACE_TOLERANCE)
        near_frame = any(p.x < 0 or p.x > 1 or p.y < 0 or p.y > 1 or p.z <= 0
                         for p in projected_corners)
        if near_surface or near_frame:
            vertices = list(positions(obj, depsgraph))
            low, high = bounds(vertices)
            if near_frame:
                projected_corners = [world_to_camera_view(scene, scene.camera, p) for p in vertices]
        if low[2] < lowest["z"]:
            lowest = {"z": low[2], "object": obj.name}
        wall_extent[0] = min(wall_extent[0], low[0])
        wall_extent[1] = max(wall_extent[1], high[0])
        for point in projected_corners:
            projected[0] = min(projected[0], point.x)
            projected[1] = min(projected[1], point.y)
            projected[2] = max(projected[2], point.x)
            projected[3] = max(projected[3], point.y)
            if point.z <= 0 and obj.name not in behind_camera:
                behind_camera.append(obj.name)
    return lowest, wall_extent, projected, behind_camera


def character_meshes():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"
            and any(mod.type == "ARMATURE" and mod.object
                    and mod.object.name == "MERLIN_Rig" for mod in obj.modifiers)]


def validate_structure():
    scene = bpy.context.scene
    aspect = (scene.render.resolution_x * scene.render.pixel_aspect_x
              / (scene.render.resolution_y * scene.render.pixel_aspect_y))
    check("landscape_four_by_three", abs(aspect - 4 / 3) < 1e-6,
          resolution=[scene.render.resolution_x, scene.render.resolution_y],
          pixel_aspect=[scene.render.pixel_aspect_x, scene.render.pixel_aspect_y],
          display_aspect=aspect)
    check("camera_exists", scene.camera is not None and scene.camera.type == "CAMERA")
    room = json.loads(scene.get("room_bounds", "{}"))
    check("room_bounds_metadata", room == {"left": WALL_LEFT, "right": WALL_RIGHT,
                                          "floor": FLOOR_Z, "back": WALL_BACK}, actual=room)
    if scene.camera:
        anchors = [Vector((x, y, FLOOR_Z)) for x in (WALL_LEFT, WALL_RIGHT) for y in (0, WALL_BACK)]
        projected = [world_to_camera_view(scene, scene.camera, anchor) for anchor in anchors]
        check("room_floor_anchors_visible", all(0 <= p.x <= 1 and 0 <= p.y <= 1 and p.z > 0 for p in projected),
              projected_anchors=[list(p) for p in projected])
    check("twenty_four_fps", scene.render.fps / scene.render.fps_base == 24)
    background = scene.world.node_tree.nodes.get("Background") if scene.world and scene.world.use_nodes else None
    expected_world = (0.022, 0.031, 0.058)
    actual_world = list(background.inputs["Color"].default_value[:3]) if background else []
    strength = float(background.inputs["Strength"].default_value) if background else None
    lights = [obj.name for obj in scene.objects if obj.type == "LIGHT"]
    check("original_lighting_settings_restored", bool(background)
          and all(abs(a - b) < 1e-6 for a, b in zip(actual_world, expected_world))
          and abs(strength - 0.18) < 1e-6 and abs(scene.view_settings.exposure - 0.35) < 1e-6
          and len(lights) == 6, world_color=actual_world, world_strength=strength,
          exposure=float(scene.view_settings.exposure), lights=lights)
    rig = bpy.data.objects.get("MERLIN_Rig")
    check("original_rig_retained", rig is not None and rig.type == "ARMATURE")
    if rig and rig.type == "ARMATURE":
        check("original_bones_retained", set(EXPECTED_BONES).issubset(rig.data.bones.keys()),
              bone_count=len(rig.data.bones))
        check("original_rig_proportions_restored", all(abs(value - 1) < 1e-6 for value in rig.scale),
              rig_scale=list(rig.scale))
    missing = (ORIGINAL_ACTIONS | set(ACTION_LENGTHS)) - set(bpy.data.actions.keys())
    check("original_and_casual_actions_present", not missing, missing=sorted(missing))
    bad_ranges = {}
    for name, length in ACTION_LENGTHS.items():
        action = bpy.data.actions.get(name)
        if action is not None:
            actual = [float(value) for value in action.frame_range]
            if actual != [1.0, float(length)]:
                bad_ranges[name] = actual
    check("casual_action_ranges", not bad_ranges, unexpected_ranges=bad_ranges,
          expected_lengths=ACTION_LENGTHS)
    meshes = character_meshes()
    check("rigged_character_geometry_present", bool(meshes)
          and all(len(obj.data.vertices) and len(obj.data.polygons) for obj in meshes))
    check("play_ball_present", BALL_NAME in bpy.data.objects)
    report["counts"]["character_mesh_objects"] = len(meshes)
    report["counts"]["character_vertices"] = sum(len(obj.data.vertices) for obj in meshes)
    for filename in ("merlin.blend", "merlin.glb"):
        path = ASSET_DIR / filename
        check("original_" + filename.replace(".", "_") + "_retained", path.is_file())
        if path.is_file():
            report.setdefault("original_artifacts", {})[filename] = {
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }


def validate_resources():
    images = {}
    for mat in bpy.data.materials:
        for image in material_images(mat.node_tree):
            images[image.name] = image
    unpacked = [image.name for image in images.values()
                if image.source in {"FILE", "TILED", "MOVIE", "SEQUENCE"}
                and not image.packed_file and not getattr(image, "packed_files", [])]
    check("material_images_packed_or_generated", not unpacked, images=len(images), unpacked=unpacked)
    check("no_external_blend_libraries", not bpy.data.libraries, count=len(bpy.data.libraries))
    missing = []
    for collection in (bpy.data.sounds, bpy.data.fonts, bpy.data.movieclips):
        for item in collection:
            path = getattr(item, "filepath", "")
            if path and path != "<builtin>" and not getattr(item, "packed_file", None):
                if not Path(bpy.path.abspath(path)).is_file():
                    missing.append(item.name)
    check("other_assets_resolve", not missing, missing=missing)
    audio_path = ASSET_DIR / "audio" / "merlin-whistle.wav"
    check("whistle_audio_present", audio_path.is_file())
    if audio_path.is_file():
        with wave.open(str(audio_path), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
            check("whistle_audio_eight_seconds", abs(duration - 8) < 1 / audio.getframerate(),
                  duration_seconds=duration, channels=audio.getnchannels(), sample_rate=audio.getframerate())


def validate_expressions():
    eyes = [obj for obj in character_meshes() if obj.name.startswith("Eye")]
    smiles = [obj for obj in character_meshes() if "smile" in obj.name.lower()]
    required = [(obj, ("Blink", "Sleep", "Sleepy")) for obj in eyes]
    required += [(obj, ("Whistle",)) for obj in smiles]
    failures = []
    differences = {}
    for obj, names in required:
        keys = obj.data.shape_keys
        for name in names:
            if keys is None or name not in keys.key_blocks:
                failures.append(obj.name + ": missing " + name)
                continue
            basis = keys.key_blocks[0]
            key = keys.key_blocks[name]
            maximum = max((a.co - b.co).length for a, b in zip(basis.data, key.data))
            differences[obj.name + ": " + name] = maximum
            if maximum < 1e-4:
                failures.append(obj.name + ": unchanged " + name)
    check("face_expression_shapes_present", len(eyes) == 2 and bool(smiles) and not failures,
          errors=failures, maximum_vertex_displacement=differences)


def expression_values():
    return {obj.name + ": " + key.name: float(key.value)
            for obj in character_meshes() if obj.data.shape_keys
            for key in obj.data.shape_keys.key_blocks if key.name != "Basis"}


def validate_activities():
    from room_support import apply_activity
    scene = bpy.context.scene
    rig = bpy.data.objects["MERLIN_Rig"]
    ball = bpy.data.objects[BALL_NAME]
    objects = character_meshes() + [ball]
    summaries = {}
    poses = {}
    for name, length in ACTION_LENGTHS.items():
        frames = (list(range(1, length + 1)) if name != "CasualShowcase"
                  else sorted({1, 192, 193, 432, 433, 624, *range(1, length + 1, 8),
                               *(192 + f for event in TOSS_EVENTS for f in event)}))
        summary = {"sampled_frames": frames, "minimum_surface_z": math.inf,
                   "minimum_surface_object": None, "minimum_surface_frame": None,
                   "x_extent": [math.inf, -math.inf],
                   "camera_extent": [math.inf, math.inf, -math.inf, -math.inf],
                   "camera_violations": [], "expression_ranges": {}}
        root_positions = []
        thigh_rotations = []
        for frame in frames:
            apply_activity(scene, name, frame)
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            low, walls, projected, behind = frame_geometry(scene, objects)
            if low["z"] < summary["minimum_surface_z"]:
                summary["minimum_surface_z"] = low["z"]
                summary["minimum_surface_object"] = low["object"]
                summary["minimum_surface_frame"] = frame
            summary["x_extent"][0] = min(summary["x_extent"][0], walls[0])
            summary["x_extent"][1] = max(summary["x_extent"][1], walls[1])
            for i in range(4):
                operation = min if i < 2 else max
                summary["camera_extent"][i] = operation(summary["camera_extent"][i], projected[i])
            if (projected[0] < -FRAME_TOLERANCE or projected[1] < -FRAME_TOLERANCE
                    or projected[2] > 1 + FRAME_TOLERANCE or projected[3] > 1 + FRAME_TOLERANCE or behind):
                summary["camera_violations"].append(frame)
            for key, value in expression_values().items():
                limits = summary["expression_ranges"].setdefault(key, [value, value])
                limits[0] = min(limits[0], value)
                limits[1] = max(limits[1], value)
            evaluated = rig.evaluated_get(bpy.context.evaluated_depsgraph_get())
            root_positions.append(list(evaluated.matrix_world @ evaluated.pose.bones["root"].head))
            thigh_rotations.append(evaluated.pose.bones["thigh.L"].matrix.to_quaternion().copy())
            if frame in (1, length, 96):
                poses[name + ":" + str(frame)] = {
                    "root": root_positions[-1],
                    "head": list(evaluated.matrix_world @ evaluated.pose.bones["head"].head),
                    "hand.L": list(evaluated.matrix_world @ evaluated.pose.bones["hand.L"].head),
                    "hand.R": list(evaluated.matrix_world @ evaluated.pose.bones["hand.R"].head),
                }
        summary["root_start"] = root_positions[0]
        summary["root_end"] = root_positions[-1]
        summary["maximum_thigh_rotation_degrees"] = math.degrees(max(
            thigh_rotations[0].rotation_difference(rotation).angle for rotation in thigh_rotations))
        summaries[name] = summary
        check(name + "_floor_clearance", summary["minimum_surface_z"] >= FLOOR_Z - SURFACE_TOLERANCE,
              minimum_z=summary["minimum_surface_z"], object=summary["minimum_surface_object"],
              frame=summary["minimum_surface_frame"], floor_z=FLOOR_Z)
        check(name + "_within_side_walls",
              summary["x_extent"][0] >= WALL_LEFT - SURFACE_TOLERANCE
              and summary["x_extent"][1] <= WALL_RIGHT + SURFACE_TOLERANCE,
              extent=summary["x_extent"])
        check(name + "_inside_camera", not summary["camera_violations"],
              violating_frames=summary["camera_violations"], projected_extent=summary["camera_extent"])
    report["measurements"]["activities"] = summaries
    report["measurements"]["representative_bone_positions"] = poses
    walk = summaries["WalkWhistle"]
    distance = walk["root_end"][0] - walk["root_start"][0]
    check("walk_travels_left_to_right", distance > 4 and walk["root_start"][0] < 0 < walk["root_end"][0],
          distance=distance)
    check("walk_leg_swing", walk["maximum_thigh_rotation_degrees"] > 10,
          maximum_degrees=walk["maximum_thigh_rotation_degrees"])
    whistle = [v[1] for key, v in walk["expression_ranges"].items() if key.endswith(": Whistle")]
    nap = summaries["Nap"]
    sleep = [v[1] for key, v in nap["expression_ranges"].items()
             if key.endswith(": Sleep")]
    check("walk_whistle_expression_active", bool(whistle) and max(whistle) > 0.5)
    check("nap_closed_or_sleepy_eyes", bool(sleep) and max(sleep) > 0.5)
    wall = summaries["WallToss"]
    check("wall_lean_at_left_side", 0 <= wall["x_extent"][0] - WALL_LEFT <= 0.15,
          closest_left_wall_gap=wall["x_extent"][0] - WALL_LEFT)
    apply_activity(scene, "Nap", 96)
    evaluated = rig.evaluated_get(bpy.context.evaluated_depsgraph_get())
    body_transform = (evaluated.matrix_world @ evaluated.pose.bones["body"].matrix
                      @ rig.data.bones["body"].matrix_local.inverted())
    body_up = (body_transform.to_3x3() @ Vector((0, 0, 1))).normalized()
    check("nap_body_reclines", abs(body_up.z) < 0.5, body_up_world=list(body_up))
    head_transform = (evaluated.matrix_world @ evaluated.pose.bones["head"].matrix
                      @ rig.data.bones["head"].matrix_local.inverted())
    palms = {}
    for side, sign in (("L", 1), ("R", -1)):
        palm = (evaluated.matrix_world @ evaluated.pose.bones["hand." + side].matrix
                @ rig.data.bones["hand." + side].matrix_local.inverted()
                @ Vector((sign * 0.94, -0.035, 1.20)))
        palms[side] = list(head_transform.inverted() @ palm)
    check("nap_hands_behind_head", all(point[1] > 0.1 and abs(point[0]) < 1.2
                                      and abs(point[2] - 2.98) < 0.9 for point in palms.values()),
          palm_centers_in_head_rest_space=palms)


def validate_ball_path():
    from room_support import apply_activity
    scene = bpy.context.scene
    ball = bpy.data.objects[BALL_NAME]
    rig = bpy.data.objects["MERLIN_Rig"]
    records = []
    failures = []
    for release, wall, floor, catch in TOSS_EVENTS:
        frames = sorted({release, wall - 1, wall, wall + 1, floor - 1, floor,
                         floor + 1, catch})
        points = {}
        catch_error = None
        for frame in frames:
            apply_activity(scene, "WallToss", frame)
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            depsgraph = bpy.context.evaluated_depsgraph_get()
            points[frame] = ball.evaluated_get(depsgraph).matrix_world.translation.copy()
            if frame == catch:
                evaluated = rig.evaluated_get(depsgraph)
                target = (evaluated.matrix_world @ evaluated.pose.bones["hand.L"].matrix
                          @ rig.data.bones["hand.L"].matrix_local.inverted() @ REST_CATCH_CENTER)
                catch_error = (points[frame] - target).length
        wall_error = abs(points[wall].x + BALL_RADIUS - WALL_RIGHT)
        floor_error = abs(points[floor].z - BALL_RADIUS - FLOOR_Z)
        wall_rebound = points[wall - 1].x < points[wall].x > points[wall + 1].x
        floor_rebound = points[floor - 1].z > points[floor].z < points[floor + 1].z
        if not (release < wall < floor < catch and wall_error <= CONTACT_TOLERANCE
                and floor_error <= CONTACT_TOLERANCE and catch_error <= CONTACT_TOLERANCE
                and wall_rebound and floor_rebound):
            failures.append([release, wall, floor, catch])
        records.append({"frames": {"release": release, "wall": wall, "floor": floor, "catch": catch},
                        "wall_surface_error": wall_error, "floor_surface_error": floor_error,
                        "catch_center_error": catch_error, "wall_rebound": wall_rebound,
                        "floor_rebound": floor_rebound,
                        "sampled_centers": {str(frame): list(point) for frame, point in points.items()}})
    report["measurements"]["ball_tosses"] = records
    check("ball_wall_floor_catch_sequence", not failures, failing_sequences=failures)


def vector_floats(document, binary, index, width=3):
    """Read packed or interleaved animation output vectors from the GLB."""
    accessor = document["accessors"][index]
    if accessor["componentType"] != 5126 or accessor["type"] != "VEC" + str(width):
        raise ValueError("Animation output must be a float vector")
    if "sparse" in accessor or "bufferView" not in accessor:
        raise ValueError("Sparse or absent animation output data is unsupported")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("Animation output must use the embedded buffer")
    relative = accessor.get("byteOffset", 0)
    start = view.get("byteOffset", 0) + relative
    count = accessor["count"]
    stride = view.get("byteStride", width * 4)
    needed = relative + (count - 1) * stride + width * 4
    if count < 1 or stride < width * 4 or needed > view["byteLength"]:
        raise ValueError("Animation vector output exceeds its buffer view")
    return [list(struct.unpack_from("<" + "f" * width, binary, start + i * stride))
            for i in range(count)]


def validate_exported_prop_and_expressions(document, binary):
    """Check effective isolated-clip values, including node/mesh defaults.

    Constant channels may be optimized away. Presence of an animation does
    not imply that the ball becomes visible or the correct eyelids are used.
    """
    nodes = document.get("nodes", [])
    animations = {item.get("name", ""): item for item in document.get("animations", [])}
    ball_ids = [i for i, node in enumerate(nodes) if node.get("name") == BALL_NAME]
    visibility_errors = []
    visibility = {}
    if len(ball_ids) != 1:
        visibility_errors.append("Expected exactly one play-ball node")
    else:
        node_id = ball_ids[0]
        node = nodes[node_id]
        baseline = node.get("scale", [1, 1, 1])
        if "matrix" in node:
            matrix = node["matrix"]
            baseline = [math.sqrt(sum(matrix[column * 4 + row] ** 2 for row in range(3)))
                        for column in range(3)]
        for name in ("WalkWhistle", "WallToss", "Nap"):
            animation = animations.get(name, {})
            scales = [baseline]
            source = "node baseline"
            for channel in animation.get("channels", []):
                target = channel.get("target", {})
                if target.get("node") == node_id and target.get("path") == "scale":
                    sampler = animation["samplers"][channel["sampler"]]
                    scales = vector_floats(document, binary, sampler["output"])
                    if sampler.get("interpolation") == "CUBICSPLINE":
                        scales = scales[1::3]
                    source = "animation scale channel"
            expected = 1 if name == "WallToss" else 0
            values = [value for scale in scales for value in scale]
            if not values or not finite(values) or any(abs(value - expected) > 1e-6 for value in values):
                visibility_errors.append(name + ": effective ball scale does not equal " + str(expected))
            visibility[name] = {"source": source, "baseline_scale": baseline,
                                "sample_count": len(scales), "expected_scale": expected,
                                "effective_minimum": min(values, default=None),
                                "effective_maximum": max(values, default=None)}
    check("glb_ball_visibility_per_clip", not visibility_errors, errors=visibility_errors, clips=visibility)

    def weight_series(animation_name, node_id):
        node = nodes[node_id]
        mesh = document["meshes"][node["mesh"]]
        names = mesh.get("extras", {}).get("targetNames", [])
        baseline = node.get("weights", mesh.get("weights", [0] * len(names)))
        samples = [list(baseline)]
        animation = animations.get(animation_name, {})
        for channel in animation.get("channels", []):
            target = channel.get("target", {})
            if target.get("node") == node_id and target.get("path") == "weights":
                sampler = animation["samplers"][channel["sampler"]]
                values = scalar_floats(document, binary, sampler["output"])
                if not names or len(values) % len(names):
                    raise ValueError("Morph output does not match named targets")
                samples = [values[i:i + len(names)] for i in range(0, len(values), len(names))]
                if sampler.get("interpolation") == "CUBICSPLINE":
                    samples = samples[1::3]
        return {name: [sample[index] for sample in samples] for index, name in enumerate(names)}

    expression_errors = []
    expression_values = {}
    for object_name, required in (("Eye • L", "Sleep"), ("Eye • R", "Sleep"),
                                  ("Face • luminous smile", "SleepSmile")):
        matches = [i for i, node in enumerate(nodes) if node.get("name") == object_name]
        values = weight_series("Nap", matches[0]).get(required, []) if len(matches) == 1 else []
        if not values or not finite(values) or any(abs(value - 1) > 1e-6 for value in values):
            expression_errors.append(object_name + ": Nap " + required + " must stay active")
        expression_values[object_name + ": " + required] = {
            "sample_count": len(values), "minimum": min(values, default=None),
            "maximum": max(values, default=None)}
    check("glb_nap_preserves_constant_sleep_expressions", not expression_errors,
          errors=expression_errors, expressions=expression_values)


def validate_glb():
    path = ASSET_DIR / "merlin-room.glb"
    check("room_glb_exists", path.is_file())
    if not path.is_file():
        return
    document, binary, size = parse_glb(path)
    animations = document.get("animations", [])
    meshes = document.get("meshes", [])
    names = [item.get("name", "") for item in animations]
    check("room_glb_casual_clips", {"WalkWhistle", "WallToss", "Nap"}.issubset(names), actual=names)
    check("room_glb_geometry_and_materials", bool(meshes) and bool(document.get("materials")))
    uri_assets = [item["uri"] for kind in ("images", "buffers") for item in document.get(kind, [])
                  if item.get("uri") and not item["uri"].startswith("data:")]
    check("room_glb_self_contained", not uri_assets, external_uris=uri_assets)
    accessors = document.get("accessors", [])
    invalid = [i for i, accessor in enumerate(accessors)
               if not finite(accessor.get("min", []) + accessor.get("max", []))]
    check("room_glb_finite_bounds", not invalid, invalid_accessors=invalid)
    errors = []
    details = []
    for animation in animations:
        durations = []
        name = animation.get("name", "<unnamed>")
        channels = animation.get("channels", [])
        if not channels or not animation.get("samplers"):
            errors.append(name + ": missing channels/samplers")
        for index in sorted({sampler["input"] for sampler in animation.get("samplers", [])}):
            times = scalar_floats(document, binary, index)
            if not finite(times) or abs(times[0]) > 1e-6 or any(a >= b for a, b in zip(times, times[1:])):
                errors.append(name + ": nonfinite, nonzero-start, or unordered times")
            durations.append(times[-1])
        details.append({"name": name, "duration_seconds": max(durations, default=0),
                        "channels": len(channels),
                        "morph_channels": sum(c.get("target", {}).get("path") == "weights" for c in channels)})
        if name in {"WalkWhistle", "WallToss", "Nap"}:
            weights = []
            for channel in channels:
                if channel.get("target", {}).get("path") == "weights":
                    sampler = animation["samplers"][channel["sampler"]]
                    weights.extend(scalar_floats(document, binary, sampler["output"]))
            details[-1]["morph_weight_range"] = [min(weights), max(weights)] if weights else []
            check(name + "_exports_active_expression_weights",
                  bool(weights) and finite(weights) and max(weights) > 0.5)
    check("room_glb_animation_times", not errors, errors=errors)
    report["exported_animations"] = details
    for name in ("WalkWhistle", "WallToss", "Nap"):
        matches = [detail for detail in details if detail["name"] == name]
        check(name + "_exports_expression_channels", bool(matches) and matches[0]["morph_channels"] > 0)
    original, _, _ = parse_glb(ASSET_DIR / "merlin.glb")
    original_meshes = {mesh.get("name", ""): mesh for mesh in original.get("meshes", [])}
    room_meshes = {mesh.get("name", ""): mesh for mesh in meshes}
    missing = sorted(set(original_meshes) - set(room_meshes))
    check("original_mesh_names_retained_in_room_glb", not missing, missing=missing)
    topology_changes = []
    for name in set(original_meshes) & set(room_meshes):
        old_counts = sorted(original["accessors"][p["attributes"]["POSITION"]]["count"]
                            for p in original_meshes[name]["primitives"])
        new_counts = sorted(accessors[p["attributes"]["POSITION"]]["count"]
                            for p in room_meshes[name]["primitives"])
        if old_counts != new_counts:
            topology_changes.append({"mesh": name, "original_position_counts": old_counts,
                                     "room_position_counts": new_counts})
    check("original_mesh_position_counts_retained", not topology_changes, changes=topology_changes)
    report["counts"].update({"room_glb_bytes": size, "room_glb_meshes": len(meshes),
                              "room_glb_materials": len(document.get("materials", [])),
                              "room_glb_animations": len(animations)})
    validate_exported_prop_and_expressions(document, binary)


def main():
    original_frame = bpy.context.scene.frame_current
    for validation in (validate_structure, validate_resources, validate_expressions,
                       validate_activities, validate_ball_path, validate_glb):
        try:
            validation()
        except Exception as error:
            check(validation.__name__ + "_completed", False,
                  error=type(error).__name__ + ": " + str(error))
    bpy.context.scene.frame_set(original_frame)
    failures = [item["name"] for item in report["checks"] if not item["passed"]]
    report["passed"] = not failures
    report["failed_checks"] = failures
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(report["checks"]),
                      "report": str(REPORT_PATH), "failed_checks": failures}))
    if failures:
        raise RuntimeError("MERLIN room validation failed: " + ", ".join(failures))


if __name__ == "__main__":
    main()

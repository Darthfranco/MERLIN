"""Numerically inspect the delivered interaction clips and interrupt helper.

Run against merlin-transitions.blend with Blender's --python-exit-code 1.
No scene is saved. The report distinguishes all-frame delivered-clip checks
from sampled generated interruptions; visual review remains necessary.
"""

import datetime
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
ASSET_DIR = HERE.parent
sys.path.insert(0, str(HERE))
from verify_character import EXPECTED_BONES, finite, parse_glb, scalar_floats
from verify_room import (BALL_NAME, FLOOR_Z, FRAME_TOLERANCE, SURFACE_TOLERANCE,
                         WALL_LEFT, WALL_RIGHT, character_meshes,
                         expression_values, frame_geometry)

NEW_CLIPS = ("ReadyIdle", "ReadyToNap", "NapToReady", "ReadyToWallToss",
             "WallTossToReady", "ReadyToWalkWhistle", "WalkWhistleToReady")
ACTIVITY_CLIPS = ("Idle", "Wave", "Jump", "WalkWhistle", "WallToss", "Nap")
RETURNS = ("NapToReady", "WallTossToReady", "WalkWhistleToReady")
MATRIX_TOLERANCE = 3e-5
VALUE_TOLERANCE = 3e-5
REPORT_PATH = ASSET_DIR / "previews" / "transition-validation.json"
report = {
    "schema_version": 1,
    "checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "blender_version": bpy.app.version_string,
    "blend_file": Path(bpy.data.filepath).name,
    "glb_file": "merlin-transitions.glb",
    "checks": [], "measurements": {},
    "tolerances": {"matrix_element": MATRIX_TOLERANCE,
                   "expression_and_scale": VALUE_TOLERANCE,
                   "surface_units": SURFACE_TOLERANCE,
                   "camera_fraction": FRAME_TOLERANCE},
    "limitations": ["Numerical checks complement, rather than replace, visual review.",
                    "Interruptions are sampled cases, not an exhaustive proof for every source time.",
                    "No live application integration or device-performance benchmark is claimed."],
}


def check(name, passed, **details):
    report["checks"].append({"name": name, "passed": bool(passed), **details})


def select(name, frame=1):
    from transition_support import apply_activity
    whole = math.floor(frame)
    apply_activity(bpy.context.scene, name, whole)
    if frame != whole:
        bpy.context.scene.frame_set(whole, subframe=frame-whole)
    bpy.context.view_layer.update()


def frames_for(name):
    first, last = bpy.data.actions[name].frame_range
    return list(range(math.ceil(first), math.floor(last) + 1))


def snapshot(name, frame):
    select(name, frame)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    rig = bpy.data.objects["MERLIN_Rig"].evaluated_get(depsgraph)
    ball = bpy.data.objects[BALL_NAME].evaluated_get(depsgraph)
    return {
        "bones": {bone.name: [float(value) for row in rig.matrix_world @ bone.matrix for value in row]
                  for bone in rig.pose.bones},
        "face": expression_values(),
        "ball_position": list(ball.matrix_world.translation),
        "ball_scale": list(ball.matrix_world.to_scale()),
    }


def state_difference(first, second):
    matrices = {name: max(abs(a - b) for a, b in zip(first["bones"][name], second["bones"][name]))
                for name in first["bones"]}
    face = {name: abs(first["face"][name] - second["face"][name]) for name in first["face"]}
    scale = max(abs(a - b) for a, b in zip(first["ball_scale"], second["ball_scale"]))
    # Position of a fully hidden prop has no visible endpoint significance.
    visible = max(abs(value) for value in first["ball_scale"] + second["ball_scale"]) > .001
    prop = (Vector(first["ball_position"]) - Vector(second["ball_position"])).length if visible else 0
    return {"maximum_bone_matrix_error": max(matrices.values(), default=0),
            "worst_bone": max(matrices, key=matrices.get) if matrices else None,
            "maximum_face_error": max(face.values(), default=0),
            "ball_scale_error": scale, "visible_ball_position_error": prop}


def states_match(details):
    return (details["maximum_bone_matrix_error"] <= MATRIX_TOLERANCE
            and details["maximum_face_error"] <= VALUE_TOLERANCE
            and details["ball_scale_error"] <= VALUE_TOLERANCE
            and details["visible_ball_position_error"] <= MATRIX_TOLERANCE)


def transition_endpoints(name):
    action = bpy.data.actions[name]
    if name.startswith("ReadyTo"):
        defaults = ("ReadyIdle", 1, name[len("ReadyTo"):], 1)
    else:
        source = name[:-len("ToReady")]
        defaults = (source, int(bpy.data.actions[source].frame_range[1]), "ReadyIdle", 1)
    return (str(action.get("source_activity", defaults[0])),
            float(action.get("source_frame", defaults[1])),
            str(action.get("target_activity", defaults[2])),
            float(action.get("target_frame", defaults[3])))


def validate_structure():
    scene = bpy.context.scene
    missing = set(NEW_CLIPS + ACTIVITY_CLIPS + ("Showcase", "CasualShowcase", "InteractionShowcase")) - set(bpy.data.actions.keys())
    check("original_and_interaction_actions_present", not missing, missing=sorted(missing))
    rig = bpy.data.objects.get("MERLIN_Rig")
    check("original_fifteen_bone_rig", bool(rig) and set(rig.data.bones.keys()) == set(EXPECTED_BONES))
    check("original_proportions", bool(rig) and all(abs(value - 1) < 1e-6 for value in rig.scale),
          scale=list(rig.scale) if rig else None)
    aspect = scene.render.resolution_x * scene.render.pixel_aspect_x / (scene.render.resolution_y * scene.render.pixel_aspect_y)
    check("landscape_four_by_three", abs(aspect - 4 / 3) < 1e-6, aspect=aspect)
    check("twenty_four_fps", scene.render.fps / scene.render.fps_base == 24)
    background = scene.world.node_tree.nodes.get("Background") if scene.world else None
    check("original_brightness", bool(background)
          and max(abs(a-b) for a,b in zip(background.inputs[0].default_value[:3], (.022,.031,.058))) < 1e-6
          and abs(background.inputs[1].default_value - .18) < 1e-6
          and abs(scene.view_settings.exposure - .35) < 1e-6
          and sum(obj.type == "LIGHT" for obj in scene.objects) == 6)
    companions = [f"{name} • {suffix}" for name in NEW_CLIPS
                  for suffix in ("Eye • L", "Eye • R", "Face • luminous smile", "Ball")]
    missing = sorted(set(companions) - set(bpy.data.actions.keys()))
    check("synchronized_face_and_prop_actions", not missing, missing=missing)
    check("original_room_files_retained", all((ASSET_DIR / name).is_file()
          for name in ("merlin-room.blend", "merlin-room.glb")))


def validate_endpoints():
    records = {}
    for name in NEW_CLIPS:
        frames = frames_for(name)
        if name == "ReadyIdle":
            differences = state_difference(snapshot(name, frames[0]), snapshot(name, frames[-1]))
            check("ReadyIdle_seamless_loop", states_match(differences), **differences)
            continue
        source, source_frame, target, target_frame = transition_endpoints(name)
        start = state_difference(snapshot(source, source_frame), snapshot(name, frames[0]))
        finish = state_difference(snapshot(target, target_frame), snapshot(name, frames[-1]))
        check(name + "_source_continuity", states_match(start), source=[source, source_frame], **start)
        check(name + "_target_continuity", states_match(finish), target=[target, target_frame], **finish)
        records[name] = {"source": [source, source_frame], "target": [target, target_frame]}
    report["measurements"]["transition_endpoints"] = records
    select("ReadyIdle", 1)
    rig = bpy.data.objects["MERLIN_Rig"]
    root = rig.matrix_world @ rig.pose.bones["root"].head
    facing = {}
    for name in ("body", "head"):
        matrix = rig.matrix_world @ rig.pose.bones[name].matrix @ rig.data.bones[name].matrix_local.inverted()
        facing[name] = list((matrix.to_3x3() @ Vector((0, -1, 0))).normalized())
    check("ReadyIdle_centered_and_facing_forward", abs(root.x) < .035
          and all(vector[1] < -.98 for vector in facing.values()), root=list(root), forward_vectors=facing)
    values = expression_values()
    check("ReadyIdle_alert_open_eyes", all(abs(value) < 1e-5 for key, value in values.items()
          if key.endswith((": Sleep", ": Sleepy", ": Whistle", ": Blink"))), values=values)


def inspect_frames(name, frames):
    scene = bpy.context.scene
    meshes = character_meshes()
    objects = meshes + [bpy.data.objects[BALL_NAME]]
    summary = {"sampled_frames": frames, "minimum_z": math.inf, "minimum_frame": None,
               "minimum_object": None, "maximum_floor_clearance": -math.inf,
               "x_extent": [math.inf, -math.inf], "camera_violations": [],
               "root_x_extent": [math.inf, -math.inf], "maximum_root_step": 0,
               "maximum_lateral_step": 0, "root_samples": {},
               "maximum_thigh_rotation_degrees": 0, "maximum_bone_scale_error": 0}
    initial_thigh = previous_root = None
    for frame in frames:
        select(name, frame)
        low, walls, projected, behind = frame_geometry(scene, objects)
        if low["z"] < summary["minimum_z"]:
            summary.update(minimum_z=low["z"], minimum_frame=frame, minimum_object=low["object"])
        summary["maximum_floor_clearance"] = max(summary["maximum_floor_clearance"], low["z"] - FLOOR_Z)
        summary["x_extent"][0] = min(summary["x_extent"][0], walls[0])
        summary["x_extent"][1] = max(summary["x_extent"][1], walls[1])
        if (projected[0] < -FRAME_TOLERANCE or projected[1] < -FRAME_TOLERANCE
                or projected[2] > 1 + FRAME_TOLERANCE or projected[3] > 1 + FRAME_TOLERANCE or behind):
            summary["camera_violations"].append(frame)
        rig = bpy.data.objects["MERLIN_Rig"]
        summary["maximum_bone_scale_error"] = max(summary["maximum_bone_scale_error"],
            max(abs(value - 1) for bone in rig.pose.bones for value in bone.matrix.to_scale()))
        root = rig.matrix_world @ rig.pose.bones["root"].head
        if frame in (frames[0], frames[-1], 16, 30, 40, 48, 60, 64):
            summary["root_samples"][str(frame)] = list(root)
        summary["root_x_extent"][0] = min(summary["root_x_extent"][0], root.x)
        summary["root_x_extent"][1] = max(summary["root_x_extent"][1], root.x)
        if previous_root is not None:
            summary["maximum_root_step"] = max(summary["maximum_root_step"], (root - previous_root).length)
            summary["maximum_lateral_step"] = max(summary["maximum_lateral_step"], abs(root.x - previous_root.x))
        previous_root = root.copy()
        thigh = rig.pose.bones["thigh.L"].matrix.to_quaternion()
        if initial_thigh is None:
            initial_thigh = thigh.copy()
        summary["maximum_thigh_rotation_degrees"] = max(summary["maximum_thigh_rotation_degrees"],
            math.degrees(initial_thigh.rotation_difference(thigh).angle))
    return summary


def check_geometry(name, summary):
    check(name + "_floor_clearance", summary["minimum_z"] >= FLOOR_Z - SURFACE_TOLERANCE,
          minimum_z=summary["minimum_z"], frame=summary["minimum_frame"], object=summary["minimum_object"])
    check(name + "_within_side_walls", summary["x_extent"][0] >= WALL_LEFT - SURFACE_TOLERANCE
          and summary["x_extent"][1] <= WALL_RIGHT + SURFACE_TOLERANCE, x_extent=summary["x_extent"])
    check(name + "_camera_coverage", not summary["camera_violations"], violating_frames=summary["camera_violations"])
    check(name + "_no_bone_stretch", summary["maximum_bone_scale_error"] < 2e-5,
          maximum_bone_scale_error=summary["maximum_bone_scale_error"])


def inspect_wave(name):
    action = bpy.data.actions[name]
    end = int(action.frame_range[1])
    start = int(action.get("wave_start", .55 * end))
    finish = int(action.get("wave_end", .93 * end))
    center_errors, heights, wrists = [], [], []
    for frame in range(start, finish + 1):
        select(name, frame)
        rig = bpy.data.objects["MERLIN_Rig"]
        center_errors.append(abs((rig.matrix_world @ rig.pose.bones["root"].head).x))
        heights.append((rig.matrix_world @ rig.pose.bones["hand.L"].head).z)
        wrists.append(rig.pose.bones["hand.L"].matrix.to_quaternion())
    angular_range = max(math.degrees(a.rotation_difference(b).angle) for a in wrists for b in wrists)
    select("ReadyIdle", 1)
    rest = bpy.data.objects["MERLIN_Rig"].pose.bones["hand.L"].head.z
    return {"sampled_wave_frames": [start, finish], "maximum_center_error": max(center_errors),
            "hand_height_above_ready": max(heights) - rest, "wrist_rotation_range_degrees": angular_range}


def validate_motion():
    summaries = {}
    for name in NEW_CLIPS:
        summary = inspect_frames(name, frames_for(name))
        summaries[name] = summary
        check_geometry(name, summary)
    for name in RETURNS:
        details = inspect_wave(name)
        check(name + "_waves_at_center", details["maximum_center_error"] < .08
              and details["hand_height_above_ready"] > .4
              and details["wrist_rotation_range_degrees"] > 8, **details)
    nap = summaries["NapToReady"]
    check("NapToReady_has_airborne_hop", nap["maximum_floor_clearance"] > .10,
          maximum_floor_clearance=nap["maximum_floor_clearance"])
    for name in ("WallTossToReady", "WalkWhistleToReady"):
        summary = summaries[name]
        distance = summary["root_x_extent"][1] - summary["root_x_extent"][0]
        check(name + "_travels_with_leg_motion", distance > 2
              and summary["maximum_thigh_rotation_degrees"] > 15,
              lateral_travel=distance, thigh_rotation_degrees=summary["maximum_thigh_rotation_degrees"])
    for name in ("ReadyToWallToss", "ReadyToWalkWhistle", "WallTossToReady", "WalkWhistleToReady"):
        summary = summaries[name]
        samples = summary["root_samples"]
        first, last = frames_for(name)[0], frames_for(name)[-1]
        start, finish = samples[str(first)][0], samples[str(last)][0]
        midpoint_frame = 40 if name.startswith("ReadyTo") else 30
        progress = (samples[str(midpoint_frame)][0] - start) / (finish - start)
        check(name + "_continuous_interior_travel", .25 < progress < .75
              and summary["maximum_lateral_step"] < .22 and summary["maximum_root_step"] < .30,
              interior_frame=midpoint_frame, progress_fraction=progress,
              maximum_lateral_step=summary["maximum_lateral_step"], maximum_root_step=summary["maximum_root_step"])
    report["measurements"]["delivered_clips"] = summaries


def accessor_values(document, binary, index):
    accessor = document["accessors"][index]
    widths = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    width = widths[accessor["type"]]
    if accessor["componentType"] != 5126 or "sparse" in accessor:
        raise ValueError("Expected dense floating-point animation accessor")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("Animation references an external buffer")
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", width * 4)
    return [list(struct.unpack_from("<" + "f" * width, binary, offset + index * stride))
            for index in range(accessor["count"])]


def glb_state(document, binary, animation, final):
    values = {}
    for index, node in enumerate(document["nodes"]):
        for path, default in (("translation", [0,0,0]), ("rotation", [0,0,0,1]), ("scale", [1,1,1])):
            values[index, path] = node.get(path, default)
        if "mesh" in node:
            mesh = document["meshes"][node["mesh"]]
            count = len(mesh.get("extras", {}).get("targetNames", []))
            if count:
                values[index, "weights"] = node.get("weights", mesh.get("weights", [0] * count))
    for channel in animation["channels"]:
        target = channel["target"]
        sampler = animation["samplers"][channel["sampler"]]
        series = accessor_values(document, binary, sampler["output"])
        if target["path"] == "weights":
            count = len(values[target["node"], "weights"])
            flattened = [value for row in series for value in row]
            series = [flattened[i:i+count] for i in range(0, len(flattened), count)]
        if sampler.get("interpolation") == "CUBICSPLINE":
            series = series[1::3]
        values[target["node"], target["path"]] = series[-1 if final else 0]
    return values


def validate_glb():
    path = ASSET_DIR / "merlin-transitions.glb"
    check("transition_glb_exists", path.is_file())
    if not path.is_file():
        return
    document, binary, size = parse_glb(path)
    animations = {animation["name"]: animation for animation in document.get("animations", [])}
    expected = set(NEW_CLIPS + ACTIVITY_CLIPS)
    check("glb_thirteen_individual_clips", set(animations) == expected,
          missing=sorted(expected-set(animations)), unexpected=sorted(set(animations)-expected))
    external = [item["uri"] for kind in ("images", "buffers") for item in document.get(kind, [])
                if item.get("uri") and not item["uri"].startswith("data:")]
    check("glb_embedded_resources", not external, external_uris=external)
    errors, durations, channel_counts = [], {}, {}
    bone_channel_errors = []
    for name, animation in animations.items():
        ends = []
        for sampler in animation.get("samplers", []):
            times = scalar_floats(document, binary, sampler["input"])
            if not finite(times) or abs(times[0]) > 1e-6 or any(a >= b for a,b in zip(times,times[1:])):
                errors.append(name + ": invalid animation times")
            ends.append(times[-1])
        durations[name] = max(ends, default=0)
        channel_counts[name] = len(animation.get("channels", []))
        paths = [(document["nodes"][channel["target"]["node"]].get("name"), channel["target"]["path"])
                 for channel in animation.get("channels", [])]
        for bone in EXPECTED_BONES:
            for path_name in ("translation", "rotation", "scale"):
                if (bone, path_name) not in paths:
                    bone_channel_errors.append(name + ": missing " + bone + " " + path_name)
        if name in NEW_CLIPS:
            length = bpy.data.actions[name].frame_range[1] - bpy.data.actions[name].frame_range[0]
            if abs(durations[name] - length/24) > 1e-5:
                errors.append(name + ": exported duration differs from Blender")
            for obj in ("Eye • L", "Eye • R", "Face • luminous smile"):
                if (obj, "weights") not in paths:
                    errors.append(name + ": missing expression channels for " + obj)
            if (BALL_NAME, "scale") not in paths:
                errors.append(name + ": missing effective ball visibility channel")
    check("glb_animation_channels_and_durations", not errors, errors=errors, durations_seconds=durations,
          channels=channel_counts)
    check("glb_all_fifteen_bones_have_transform_channels", not bone_channel_errors, errors=bone_channel_errors)
    # Compare shared exported node values across boundaries, including constant
    # defaults. This catches optimized-away face/prop channels independently of bpy.
    endpoint_errors = []
    max_error = 0
    ball_index = next(i for i,node in enumerate(document["nodes"]) if node.get("name") == BALL_NAME)
    for name in NEW_CLIPS[1:]:
        source, source_frame, target, target_frame = transition_endpoints(name)
        for other, frame, own_final in ((source, source_frame, False), (target, target_frame, True)):
            if other not in animations:
                endpoint_errors.append(name + ": missing adjacent clip " + other)
                continue
            other_range = bpy.data.actions[other].frame_range
            if frame not in (other_range[0], other_range[1]):
                continue  # Interior arbitrary sources are checked in Blender below.
            a = glb_state(document, binary, animations[name], own_final)
            b = glb_state(document, binary, animations[other], frame == other_range[1])
            for key in set(a) | set(b):
                if key[0] == ball_index and key[1] in ("translation", "rotation"):
                    if max(abs(v) for v in a[ball_index,"scale"]+b[ball_index,"scale"]) < .001:
                        continue
                if key[1] == "rotation":
                    error = min(max(abs(x-y) for x,y in zip(a[key],b[key])), max(abs(x+y) for x,y in zip(a[key],b[key])))
                else:
                    error = max(abs(x-y) for x,y in zip(a[key],b[key]))
                max_error = max(max_error, error)
                if error > MATRIX_TOLERANCE:
                    endpoint_errors.append(f"{name} {'end' if own_final else 'start'} / {other}: {document['nodes'][key[0]].get('name')} {key[1]} error {error}")
    check("glb_endpoint_continuity", not endpoint_errors, maximum_channel_error=max_error, errors=endpoint_errors)
    report["measurements"]["glb"] = {"bytes": size, "meshes": len(document.get("meshes", [])),
                                      "materials": len(document.get("materials", [])), "animations": len(animations)}


def validate_interruptions():
    from transition_support import build_return_from_activity
    cases = (("Nap",96), ("WallToss",58), ("WalkWhistle",96),
             ("Idle",25), ("Wave",42), ("Jump",38), ("Showcase",158))
    summaries = {}
    ready = snapshot("ReadyIdle", 1)
    for source, frame in cases:
        start = snapshot(source, frame)
        name = build_return_from_activity(source, frame, name=f"QA_Return_{source}_{frame}")
        if not isinstance(name, str):
            raise TypeError("build_return_from_activity must return a synchronized clip name")
        frames = frames_for(name)
        first = state_difference(start, snapshot(name, frames[0]))
        last = state_difference(ready, snapshot(name, frames[-1]))
        check(source + "_interrupt_source_continuity", states_match(first), source_frame=frame, **first)
        check(source + "_interrupt_ready_continuity", states_match(last), **last)
        sampled = sorted({frames[0], frames[-1], *frames[::3]})
        summary = inspect_frames(name, sampled)
        check_geometry(source + "_interrupt_sample", summary)
        wave = inspect_wave(name)
        check(source + "_interrupt_waves_at_center", wave["maximum_center_error"] < .08
              and wave["hand_height_above_ready"] > .4
              and wave["wrist_rotation_range_degrees"] > 8, **wave)
        if source == "WallToss":
            catch = int(bpy.data.actions[name].get("catch_before_return", frame))
            worst = 0
            errors = []
            for source_time in range(frame, catch + 1):
                difference = state_difference(snapshot(source, source_time), snapshot(name, source_time-frame+1))
                worst = max(worst, difference["maximum_bone_matrix_error"],
                            difference["maximum_face_error"], difference["ball_scale_error"],
                            difference["visible_ball_position_error"])
                if not states_match(difference):
                    errors.append(source_time)
            check("WallToss_interrupt_preserves_flight_until_catch", catch > frame and not errors,
                  source_frame=frame, catch_frame=catch, failing_source_frames=errors,
                  maximum_state_error=worst)
        summaries[source] = {"source_frame": frame, "generated_frames": len(frames), **summary}
    report["measurements"]["generated_interruptions"] = summaries


def validate_repeated_return():
    """Reauthoring a currently playing return must retain its live prop state."""
    from transition_support import build_return_from_activity
    name = build_return_from_activity("WallToss", 30, name="QA_RepeatReturn")
    source = snapshot(name, 10)
    name = build_return_from_activity(name, 10, name=name)
    first = state_difference(source, snapshot(name, 1))
    last = state_difference(snapshot("ReadyIdle", 1), snapshot(name, frames_for(name)[-1]))
    check("repeated_return_preserves_live_source_state", states_match(first), **first)
    check("repeated_return_finishes_ready", states_match(last), **last)
    report["measurements"]["repeated_return"] = {
        "initial_activity": "WallToss", "initial_frame": 30, "interrupted_return_frame": 10,
        "visible_ball_scale_at_interruption": source["ball_scale"],
    }


def main():
    for validation in (validate_structure, validate_endpoints, validate_motion,
                       validate_glb, validate_interruptions, validate_repeated_return):
        print("Transition validation: " + validation.__name__, flush=True)
        try:
            validation()
        except Exception as error:
            check(validation.__name__ + "_completed", False,
                  error=type(error).__name__ + ": " + str(error))
    failures = [item["name"] for item in report["checks"] if not item["passed"]]
    report["passed"] = not failures
    report["failed_checks"] = failures
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"passed": not failures, "checks": len(report["checks"]),
                      "report": str(REPORT_PATH), "failed_checks": failures}))
    if failures:
        raise RuntimeError("MERLIN transition validation failed: " + ", ".join(failures))


if __name__ == "__main__":
    main()

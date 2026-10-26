"""Validate the editable MERLIN character and its portable animation export.

Run against the saved scene, without saving changes made during inspection:
  blender --background assets/merlin-character/merlin.blend \
    --python-exit-code 1 --python assets/merlin-character/scripts/verify_character.py

The JSON report is always written to previews/validation.json. A failed check
raises an exception so Blender can return a nonzero status with the flag above.
"""

import datetime
import json
import math
from pathlib import Path
import re
import struct
import traceback

import bpy


ASSET_DIR = Path(__file__).resolve().parents[1]
REPORT_PATH = ASSET_DIR / "previews" / "validation.json"
EXPECTED_ACTIONS = ("Idle", "Wave", "Jump", "Showcase")
EXPECTED_EXPORT_ACTIONS = ("Idle", "Wave", "Jump")
EXPECTED_BONES = ("root", "body", "head") + tuple(
    f"{part}.{side}"
    for side in ("L", "R")
    for part in ("upper_arm", "forearm", "hand", "thigh", "shin", "foot")
)
ARM_BONES = tuple(
    f"{part}.{side}"
    for side in ("L", "R")
    for part in ("upper_arm", "forearm", "hand")
)
STAGE_NAME = re.compile(
    r"(?:^|[ ._\-])(?:stage|floor|ground|backdrop|cyclorama|plinth|platform)(?:$|[ ._\-])",
    re.IGNORECASE,
)

report = {
    "schema_version": 1,
    "checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "blender_version": bpy.app.version_string,
    "blend_file": Path(bpy.data.filepath).name if bpy.data.filepath else None,
    "glb_file": "merlin.glb",
    "checks": [],
    "counts": {},
    "animation_measurements": {},
}


def check(name, passed, **details):
    """Accumulate failures rather than hiding later independent results."""
    report["checks"].append({"name": name, "passed": bool(passed), **details})


def finite(values):
    return all(isinstance(value, (int, float)) and math.isfinite(value) for value in values)


def material_images(node_tree, visited=None):
    """Include image textures nested inside material node groups."""
    visited = set() if visited is None else visited
    if node_tree is None or node_tree.as_pointer() in visited:
        return []
    visited.add(node_tree.as_pointer())
    images = []
    for node in node_tree.nodes:
        image = getattr(node, "image", None)
        if image is not None:
            images.append(image)
        nested = getattr(node, "node_tree", None)
        if nested is not None:
            images.extend(material_images(nested, visited))
    return images


def validate_blend():
    rig = bpy.data.objects.get("MERLIN_Rig")
    check("rig_exists", rig is not None and rig.type == "ARMATURE")
    if rig is not None and rig.type == "ARMATURE":
        names = set(rig.data.bones.keys())
        check("required_bones", set(EXPECTED_BONES).issubset(names),
              missing=sorted(set(EXPECTED_BONES) - names), actual=sorted(names))

    actions = {action.name: action for action in bpy.data.actions}
    check("required_blender_actions", set(EXPECTED_ACTIONS).issubset(actions),
          missing=sorted(set(EXPECTED_ACTIONS) - set(actions)), actual=sorted(actions))
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    empty = [obj.name for obj in meshes if not obj.data.vertices or not obj.data.polygons]
    report["counts"].update({
        "blend_mesh_objects": len(meshes),
        "blend_vertices": sum(len(obj.data.vertices) for obj in meshes),
        "blend_polygons": sum(len(obj.data.polygons) for obj in meshes),
        "blend_materials": len(bpy.data.materials),
        "blend_actions": len(actions),
    })
    check("blend_meshes_nonempty", bool(meshes) and not empty, empty_objects=empty)

    material_dependencies = {}
    for material in bpy.data.materials:
        for image in material_images(material.node_tree):
            if image.source in {"FILE", "TILED", "MOVIE", "SEQUENCE"}:
                material_dependencies[image.name] = image
    unpacked = []
    missing = []
    for image in material_dependencies.values():
        packed = bool(image.packed_file) or bool(getattr(image, "packed_files", []))
        if not packed:
            unpacked.append(image.name)
            if not image.filepath or not Path(bpy.path.abspath(image.filepath)).is_file():
                missing.append(image.name)
    check("material_images_absent_or_packed", not unpacked,
          image_count=len(material_dependencies), unpacked_images=unpacked)
    check("material_images_not_missing", not missing, missing_images=missing)
    # Linked libraries are external dependencies even when their paths resolve here.
    libraries = [library.name for library in bpy.data.libraries]
    check("no_external_blend_libraries", not libraries, libraries=libraries)
    other_missing = []
    for collection in (bpy.data.sounds, bpy.data.fonts, bpy.data.movieclips):
        for block in collection:
            path = getattr(block, "filepath", "")
            if path and path != "<builtin>" and not getattr(block, "packed_file", None):
                if not Path(bpy.path.abspath(path)).exists():
                    other_missing.append(block.name)
    check("other_external_assets_not_missing", not other_missing, missing_assets=other_missing)

    if rig is not None and rig.type == "ARMATURE" and set(EXPECTED_BONES).issubset(rig.data.bones.keys()):
        if "Wave" in actions and "Jump" in actions:
            validate_motion(rig, actions)


def assign_action(rig, action):
    rig.animation_data.action = action
    slots = getattr(action, "slots", None)
    if slots:
        compatible = [slot for slot in slots if slot.target_id_type == "OBJECT"]
        if compatible:
            rig.animation_data.action_slot = compatible[0]


def sampled_pose(rig, action, names):
    """Sample every keyframe interval as well as fractional action endpoints."""
    assign_action(rig, action)
    start, end = map(float, action.frame_range)
    frames = sorted({start, end, *range(math.ceil(start), math.floor(end) + 1)})
    poses = []
    for frame in frames:
        whole = math.floor(frame)
        bpy.context.scene.frame_set(whole, subframe=frame - whole)
        bpy.context.view_layer.update()
        evaluated = rig.evaluated_get(bpy.context.evaluated_depsgraph_get())
        poses.append({name: evaluated.pose.bones[name].matrix.copy() for name in names})
    return frames, poses


def validate_motion(rig, actions):
    rig.animation_data_create()
    animation = rig.animation_data
    previous_action = animation.action
    previous_slot = getattr(animation, "action_slot", None)
    previous_nla = animation.use_nla
    previous_frame = bpy.context.scene.frame_current
    previous_subframe = bpy.context.scene.frame_subframe
    try:
        animation.use_nla = False
        wave_frames, wave_poses = sampled_pose(rig, actions["Wave"], ARM_BONES)
        rotation_changes = {}
        position_changes = {}
        for name in ARM_BONES:
            initial = wave_poses[0][name]
            rotation_changes[name] = max(
                initial.to_quaternion().rotation_difference(pose[name].to_quaternion()).angle
                for pose in wave_poses
            )
            position_changes[name] = max(
                (pose[name].translation - initial.translation).length for pose in wave_poses
            )
        wave_ok = max(rotation_changes.values()) > math.radians(5)
        report["animation_measurements"]["Wave"] = {
            "frame_range": [wave_frames[0], wave_frames[-1]],
            "samples": len(wave_frames),
            "max_rotation_change_degrees": {
                name: round(math.degrees(angle), 6) for name, angle in rotation_changes.items()
            },
            "max_position_change": position_changes,
        }
        check("wave_moves_arm_bones", wave_ok,
              maximum_rotation_degrees=math.degrees(max(rotation_changes.values())))

        jump_frames, jump_poses = sampled_pose(rig, actions["Jump"], ["root"])
        heights = [pose["root"].translation.z for pose in jump_poses]
        rise = max(heights) - heights[0]
        baseline_error = abs(heights[-1] - heights[0])
        report["animation_measurements"]["Jump"] = {
            "frame_range": [jump_frames[0], jump_frames[-1]],
            "samples": len(jump_frames),
            "start_height": heights[0],
            "minimum_height": min(heights),
            "maximum_height": max(heights),
            "end_height": heights[-1],
            "rise_from_start": rise,
            "baseline_return_error": baseline_error,
        }
        check("jump_root_rises", finite(heights) and rise > 0.4,
              rise_from_start=rise, required_rise_greater_than=0.4)
        check("jump_returns_to_baseline", baseline_error <= 0.02,
              baseline_return_error=baseline_error, tolerance=0.02)
    finally:
        animation.action = previous_action
        if previous_slot is not None:
            animation.action_slot = previous_slot
        animation.use_nla = previous_nla
        bpy.context.scene.frame_set(previous_frame, subframe=previous_subframe)


def parse_glb(path):
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError("GLB header is truncated")
    magic, version, declared_length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or declared_length != len(data):
        raise ValueError("Invalid GLB magic, version, or declared length")
    offset = 12
    document = None
    binary = b""
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("GLB chunk header is truncated")
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if offset + length > len(data) or length % 4:
            raise ValueError("GLB chunk has invalid size or alignment")
        chunk = data[offset:offset + length]
        if kind == 0x4E4F534A:
            document = json.loads(chunk.decode("utf-8"))
        elif kind == 0x004E4942:
            binary = chunk
        offset += length
    if document is None:
        raise ValueError("GLB has no JSON chunk")
    return document, binary, len(data)


def scalar_floats(document, binary, index):
    accessor = document["accessors"][index]
    if accessor["type"] != "SCALAR" or accessor["componentType"] != 5126:
        raise ValueError(f"Animation input accessor {index} is not float SCALAR")
    if "sparse" in accessor or "bufferView" not in accessor:
        raise ValueError(f"Animation input accessor {index} has unsupported sparse/missing data")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("Animation input references a non-embedded buffer")
    relative_offset = accessor.get("byteOffset", 0)
    start = view.get("byteOffset", 0) + relative_offset
    stride = view.get("byteStride", 4)
    count = accessor["count"]
    if count <= 0 or stride < 4:
        raise ValueError("Animation input has invalid count or stride")
    required = relative_offset + (count - 1) * stride + 4
    if required > view["byteLength"] or start + (count - 1) * stride + 4 > len(binary):
        raise ValueError("Animation input exceeds its buffer view")
    return [struct.unpack_from("<f", binary, start + i * stride)[0] for i in range(count)]


def validate_glb():
    path = ASSET_DIR / "merlin.glb"
    check("glb_exists", path.is_file())
    if not path.is_file():
        return
    try:
        document, binary, size = parse_glb(path)
    except (ValueError, KeyError, IndexError, struct.error, UnicodeError) as error:
        check("glb_structure", False, error=str(error))
        return
    check("glb_structure", True, bytes=size)
    meshes = document.get("meshes", [])
    materials = document.get("materials", [])
    animations = document.get("animations", [])
    nodes = document.get("nodes", [])
    accessors = document.get("accessors", [])
    report["counts"].update({
        "glb_bytes": size,
        "glb_meshes": len(meshes),
        "glb_materials": len(materials),
        "glb_nodes": len(nodes),
        "glb_animations": len(animations),
        "glb_skins": len(document.get("skins", [])),
    })
    check("glb_contains_meshes_and_materials", bool(meshes) and bool(materials))
    empty_meshes = []
    position_errors = []
    for index, mesh in enumerate(meshes):
        primitives = mesh.get("primitives", [])
        if not primitives:
            empty_meshes.append(mesh.get("name", str(index)))
        for primitive in primitives:
            position_index = primitive.get("attributes", {}).get("POSITION")
            if position_index is None or not 0 <= position_index < len(accessors):
                position_errors.append(f"Mesh {index}: missing POSITION accessor")
                continue
            accessor = accessors[position_index]
            low, high = accessor.get("min", []), accessor.get("max", [])
            if accessor.get("count", 0) <= 0 or accessor.get("type") != "VEC3":
                position_errors.append(f"Mesh {index}: empty or invalid POSITION data")
            if (len(low) != 3 or len(high) != 3 or not finite(low + high)
                    or any(a > b for a, b in zip(low, high))):
                position_errors.append(f"Mesh {index}: missing, nonfinite, or inverted bounds")
    check("glb_meshes_nonempty_with_finite_bounds", not empty_meshes and not position_errors,
          empty_meshes=empty_meshes, errors=position_errors)
    invalid_bounds = []
    for index, accessor in enumerate(accessors):
        low, high = accessor.get("min", []), accessor.get("max", [])
        if not finite(low + high) or (low and high and any(a > b for a, b in zip(low, high))):
            invalid_bounds.append(index)
    check("glb_accessor_bounds_finite", not invalid_bounds, invalid_accessors=invalid_bounds)

    stage_names = [obj.get("name", "") for obj in [*nodes, *meshes]
                   if STAGE_NAME.search(obj.get("name", ""))]
    lights = document.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])
    light_nodes = [node.get("name", str(index)) for index, node in enumerate(nodes)
                   if "KHR_lights_punctual" in node.get("extensions", {})]
    camera_nodes = [node.get("name", str(index)) for index, node in enumerate(nodes) if "camera" in node]
    check("glb_excludes_stage_cameras_and_lights",
          not stage_names and not lights and not light_nodes and not document.get("cameras") and not camera_nodes,
          stage_names=stage_names, light_count=len(lights), light_nodes=light_nodes, camera_nodes=camera_nodes)
    external_uris = [item["uri"] for kind in ("images", "buffers")
                     for item in document.get(kind, []) if item.get("uri") and not item["uri"].startswith("data:")]
    check("glb_has_no_external_assets", not external_uris, external_uris=external_uris)

    animation_names = [animation.get("name", "") for animation in animations]
    check("glb_required_animations", set(EXPECTED_EXPORT_ACTIONS).issubset(animation_names),
          actual=animation_names, missing=sorted(set(EXPECTED_EXPORT_ACTIONS) - set(animation_names)))
    timing_errors = []
    animation_details = []
    for animation in animations:
        name = animation.get("name", "<unnamed>")
        samplers = animation.get("samplers", [])
        channels = animation.get("channels", [])
        inputs = sorted({sampler["input"] for sampler in samplers})
        durations = []
        if not samplers or not channels:
            timing_errors.append(f"{name}: no samplers or channels")
        for index in inputs:
            try:
                times = scalar_floats(document, binary, index)
                if not finite(times):
                    timing_errors.append(f"{name}, input {index}: nonfinite times")
                elif abs(times[0]) > 1e-6:
                    timing_errors.append(f"{name}, input {index}: begins at {times[0]}, expected zero")
                if any(a >= b for a, b in zip(times, times[1:])):
                    timing_errors.append(f"{name}, input {index}: times are not strictly increasing")
                durations.append(times[-1])
            except (ValueError, KeyError, IndexError, struct.error) as error:
                timing_errors.append(f"{name}, input {index}: {error}")
        animation_details.append({"name": name, "channels": len(channels),
                                  "samplers": len(samplers), "duration_seconds": max(durations, default=0)})
    report["exported_animations"] = animation_details
    check("glb_animation_times_finite_normalized_and_increasing", not timing_errors, errors=timing_errors)


def main():
    for validation in (validate_blend, validate_glb):
        try:
            validation()
        except Exception as error:
            check(validation.__name__ + "_completed", False,
                  error=str(error), traceback=traceback.format_exc())
    failures = [item["name"] for item in report["checks"] if not item["passed"]]
    report["passed"] = not failures
    report["failed_checks"] = failures
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(report["checks"]),
                      "report": str(REPORT_PATH), "failed_checks": failures}))
    if failures:
        raise RuntimeError("MERLIN character validation failed: " + ", ".join(failures))


if __name__ == "__main__":
    main()

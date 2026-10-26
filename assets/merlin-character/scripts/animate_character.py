"""Soft, loopable character actions for MERLIN's rigid-part Blender rig.

``build_actions(rig)`` creates four 24 fps actions and returns them by short
name. Rotations below are authored in the model's rest-space axes (+Z up,
-Y forward), then converted to each bone's actual local axes. Every frame is
baked for predictable Blender and glTF playback; no constraints are required.
"""

from math import pi, radians, sin
import json

import bpy
from mathutils import Euler, Vector


BONE_NAMES = (
    "root", "body", "head",
    "upper_arm.L", "forearm.L", "hand.L",
    "upper_arm.R", "forearm.R", "hand.R",
    "thigh.L", "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R",
)

ACTION_GUIDE = {
    "Idle": {
        "frames": 96,
        "description": "Quiet breathing, a gentle head drift, and relaxed hands.",
        "poses": {1: "Rest", 25: "Inhale", 49: "Rest", 73: "Exhale", 96: "Loop"},
    },
    "Wave": {
        "frames": 96,
        "description": "A friendly side wave with three soft wrist swings and a head tilt.",
        "poses": {1: "Rest", 28: "Hello", 42: "Wave", 60: "Wave", 91: "Settle"},
    },
    "Jump": {
        "frames": 72,
        "description": "Anticipation, a buoyant hop, cushioned landing, and recovery.",
        "poses": {1: "Rest", 22: "Anticipate", 27: "Takeoff", 38: "Apex", 49: "Contact", 54: "Cushion", 72: "Settle"},
    },
    "Showcase": {
        "frames": 192,
        "description": "Eight-second presentation: breathing, hello wave, happy jump, and settle.",
        "poses": {1: "Idle", 44: "Hello", 58: "Wave", 112: "Rest", 142: "Anticipate", 158: "Apex", 169: "Contact", 192: "Loop"},
    },
}


def _smooth(value):
    """Quintic easing has zero velocity and acceleration at each endpoint."""
    value = max(0.0, min(1.0, value))
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0)


def _ramp(frame, start, end):
    return _smooth((frame - start) / (end - start))


def _track(frame, points):
    if frame <= points[0][0]:
        return points[0][1]
    for (start, first), (end, last) in zip(points, points[1:]):
        if frame <= end:
            return first + (last - first) * _ramp(frame, start, end)
    return points[-1][1]


def _idle(phase):
    """Return independent rest-space rotation/translation channels."""
    breath = sin(2.0 * pi * phase)
    drift = sin(2.0 * pi * phase + 0.4) - sin(0.4)
    rotations = {name: [0.0, 0.0, 0.0] for name in BONE_NAMES}
    rotations["body"] = [0.45 * breath, 0.30 * drift, 0.35 * breath]
    rotations["head"] = [-0.65 * breath, 0.90 * drift, -0.55 * breath]
    for side, sign in (("L", -1.0), ("R", 1.0)):
        rotations[f"upper_arm.{side}"] = [-2.0, sign * (5.0 + 0.6 * breath), 0.0]
        rotations[f"forearm.{side}"] = [-6.0 + 0.7 * breath, 0.0, 0.0]
        rotations[f"hand.{side}"] = [2.0, -sign * 2.0, 0.0]
    return {
        "rotations": rotations,
        "body_z": 0.007 * breath,
        "air_height": 0.0,
    }


def _wave(pose, frame):
    """Keep the waving mitten outside the oversized face shell."""
    envelope = _ramp(frame, 8, 28) * (1.0 - _ramp(frame, 70, 91))
    wrist_envelope = _ramp(frame, 26, 32) * (1.0 - _ramp(frame, 66, 74))
    wrist_swing = sin(2.0 * pi * (frame - 28.0) / 18.0) * wrist_envelope
    rot = pose["rotations"]
    rot["upper_arm.L"][0] += -2.0 * envelope
    rot["upper_arm.L"][1] += -67.0 * envelope
    rot["forearm.L"][0] += -2.0 * envelope
    rot["forearm.L"][1] += -64.0 * envelope
    rot["hand.L"][1] += -4.0 * envelope + 17.0 * wrist_swing
    rot["hand.L"][2] += 3.0 * wrist_swing
    rot["upper_arm.R"][1] += 2.5 * envelope
    rot["forearm.R"][0] += -4.0 * envelope
    rot["body"][1] += -1.7 * envelope
    rot["head"][0] += -1.4 * envelope
    rot["head"][1] += 4.2 * envelope
    rot["head"][2] += 3.0 * envelope
    return pose


def _jump(pose, frame):
    """A springy, physically readable hop; soles stay level on contact."""
    bend = _track(frame, (
        (1, 0.0), (8, 0.0), (19, 40.0), (22, 43.0), (27, 3.0),
        (35, 23.0), (40, 28.0), (46, 8.0), (49, 3.0),
        (54, 39.0), (61, 6.0), (66, 0.0), (72, 0.0),
    ))
    arm_open = _track(frame, (
        (1, 0.0), (8, 0.0), (22, 8.0), (29, 49.0),
        (39, 49.0), (49, 19.0), (54, 25.0), (65, 0.0), (72, 0.0),
    ))
    arm_swing = _track(frame, (
        (1, 0.0), (8, 0.0), (22, 18.0), (30, -10.0),
        (40, -8.0), (49, 0.0), (54, -7.0), (65, 0.0), (72, 0.0),
    ))
    lean = _track(frame, (
        (1, 0.0), (8, 0.0), (22, 6.0), (30, -2.0), (41, -1.0),
        (49, 0.0), (54, 4.5), (62, -1.0), (70, 0.0), (72, 0.0),
    ))
    airborne = 27.0 < frame < 49.0
    pose["air_height"] = 0.68 * (1.0 - ((frame - 38.0) / 11.0) ** 2) if airborne else 0.0
    rot = pose["rotations"]
    for side, sign in (("L", -1.0), ("R", 1.0)):
        rot[f"thigh.{side}"][0] = -bend
        rot[f"shin.{side}"][0] = 2.0 * bend
        rot[f"foot.{side}"][0] = -bend
        rot[f"upper_arm.{side}"][0] += arm_swing
        rot[f"upper_arm.{side}"][1] += sign * arm_open
        rot[f"forearm.{side}"][0] += -0.18 * arm_open
        rot[f"forearm.{side}"][1] += sign * 0.18 * arm_open
        rot[f"hand.{side}"][1] += -sign * 0.09 * arm_open
    rot["body"][0] += lean
    rot["head"][0] += -0.65 * lean
    pose["body_z"] += _track(frame, (
        (1, 0.0), (22, -0.009), (30, 0.006), (49, 0.0),
        (54, -0.012), (63, 0.008), (72, 0.0),
    ))
    return pose


def _pose_at(name, frame):
    length = ACTION_GUIDE[name]["frames"]
    phase = (frame - 1.0) / (length - 1.0)
    pose = _idle(phase * (2.0 if name == "Showcase" else 1.0))
    if name == "Wave":
        return _wave(pose, frame)
    if name == "Jump":
        return _jump(pose, frame)
    if name == "Showcase":
        if 17 <= frame <= 112:
            _wave(pose, frame - 16)
        if 121 <= frame <= 192:
            _jump(pose, frame - 120)
    return pose


def build_actions(rig):
    """Create Idle, Wave, Jump and Showcase; leave Showcase active at frame 1.

    The rig must have the 15 named bones in ``BONE_NAMES``. Root translations
    are corrected from evaluated foot positions before each key, preserving
    the original sole plane through crouches and landing. Action metadata and
    pose markers record representative frames for preview rendering.
    """
    if rig.type != "ARMATURE":
        raise TypeError("MERLIN animation requires an armature object.")
    missing = set(BONE_NAMES) - set(rig.pose.bones.keys())
    if missing:
        raise ValueError(f"MERLIN rig is missing bones: {sorted(missing)}")

    scene = bpy.context.scene
    scene.render.fps = 24
    rig.animation_data_create()
    bases = {name: rig.data.bones[name].matrix_local.to_3x3().normalized() for name in BONE_NAMES}
    inverse_bases = {name: basis.inverted() for name, basis in bases.items()}
    foot_names = ("foot.L", "foot.R")
    foot_rest_z = {name: rig.data.bones[name].head_local.z for name in foot_names}
    actions = {}

    for name, guide in ACTION_GUIDE.items():
        action = bpy.data.actions.new(name=name)
        action.use_fake_user = True
        action["display_name"] = name
        action["description"] = guide["description"]
        action["fps"] = 24
        action["loop"] = True
        action["preview_frames"] = json.dumps(guide["poses"])
        rig.animation_data.action = action
        previous_eulers = {bone: Euler((0.0, 0.0, 0.0), "XYZ") for bone in BONE_NAMES}
        for bone_name in BONE_NAMES:
            bone = rig.pose.bones[bone_name]
            bone.rotation_mode = "XYZ"
            bone.location = (0.0, 0.0, 0.0)
            bone.rotation_euler = (0.0, 0.0, 0.0)
            bone.scale = (1.0, 1.0, 1.0)

        for frame in range(1, guide["frames"] + 1):
            scene.frame_set(frame)
            pose = _pose_at(name, frame)
            for bone_name in BONE_NAMES:
                bone = rig.pose.bones[bone_name]
                desired = Euler(tuple(radians(v) for v in pose["rotations"][bone_name]), "XYZ").to_matrix()
                local = inverse_bases[bone_name] @ desired @ bases[bone_name]
                bone.rotation_euler = local.to_euler("XYZ", previous_eulers[bone_name])
                previous_eulers[bone_name] = bone.rotation_euler.copy()
                offset = (0.0, 0.0, pose["body_z"]) if bone_name == "body" else (0.0, 0.0, 0.0)
                bone.location = inverse_bases[bone_name] @ Vector(offset)
            bpy.context.view_layer.update()
            ground_correction = max(foot_rest_z[foot] - rig.pose.bones[foot].head.z for foot in foot_names)
            root = rig.pose.bones["root"]
            root.location = inverse_bases["root"] @ Vector((0.0, 0.0, ground_correction + pose["air_height"]))
            for bone_name in BONE_NAMES:
                bone = rig.pose.bones[bone_name]
                bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone_name)
                bone.keyframe_insert(data_path="location", frame=frame, group=bone_name)

        # Sampled curves use linear interpolation: eased poses are already baked.
        for curve in action.fcurves:
            curve.extrapolation = "CONSTANT"
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"
        for frame, label in guide["poses"].items():
            marker = action.pose_markers.new(label)
            marker.frame = frame
        actions[name] = action

    rig.animation_data.action = actions["Showcase"]
    rig["animation_notes"] = "24 fps. Idle 1–96; Wave 1–96; Jump 1–72; Showcase 1–192. All return to a shared resting pose."
    scene.frame_start = 1
    scene.frame_end = ACTION_GUIDE["Showcase"]["frames"]
    scene.frame_set(1)
    return actions

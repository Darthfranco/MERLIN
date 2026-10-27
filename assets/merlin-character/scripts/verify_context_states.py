"""Checks for context animations, callable after building or reopening a scene.

The caller supplies the authored context clip names and decides where to save
the returned JSON-compatible checks. This module never modifies geometry or
files, and it does not replace rendered visual review or GLB roundtrip tests.
"""
import math

import bpy
import numpy as np
import screen_state_support as support
from interaction_support import action_name

_ACTIONS = {}


def _action(name, owner):
    return _ACTIONS.get(action_name(name, owner))


def _values(name, owner, frame):
    action = _action(name, owner)
    if action is None:
        raise ValueError('Missing companion ' + name + ', ' + owner)
    return {(curve.data_path, curve.array_index): float(curve.evaluate(frame))
            for curve in action.fcurves}


def _coordinates(curve):
    values = np.empty(len(curve.keyframe_points) * 2, dtype=np.float32)
    curve.keyframe_points.foreach_get('co', values)
    return values.reshape((-1, 2))


def verify_context_states(names, tolerance=3e-5):
    global _ACTIONS
    _ACTIONS = {action.name: action for action in bpy.data.actions}
    owners = support.owners()
    expected_channels = sum(len(_action('ReadyIdle', owner).fcurves) for owner, _ in owners)
    panel_owners = {owner for owner, data in owners
                    if data.get('merlin_panel_owner') or data.get('merlin_left_panel_owner')}
    checks = []

    def check(name, passed, **details):
        checks.append({'name': name, 'passed': bool(passed), **details})

    check('context_owner_inventory', len(owners) == 98 and len(set(o for o, _ in owners)) == 98,
          count=len(owners))
    for name in names:
        action = _ACTIONS[name]
        length = round(action.frame_range[1])
        source = action['source_activity']; source_frame = action['source_frame']
        target = action['target_activity']; target_frame = action['target_frame']
        missing = []; nonfinite = []; maximum = 0.; channel_count = 0; helper_leaks = []
        for owner, _ in owners:
            companion = _action(name, owner)
            if companion is None:
                missing.append(owner); continue
            channel_count += len(companion.fcurves)
            for curve in companion.fcurves:
                if not np.isfinite(_coordinates(curve)).all():
                    nonfinite.append(owner + ':' + curve.data_path)
            if not owner.startswith('Display'):
                source_values = _values(source, owner, source_frame)
                target_values = _values(target, owner, target_frame)
                for i in range(3):
                    channel = ('scale', i)
                    if (channel in source_values and abs(source_values[channel]) < tolerance
                            and abs(target_values[channel]) < tolerance):
                        curve = companion.fcurves.find('scale', index=i)
                        if curve and float(np.abs(_coordinates(curve)[:, 1]).max()) > tolerance:
                            helper_leaks.append(owner + ':scale' + str(i))
            for frame, endpoint, endpoint_frame in [(1, source, source_frame), (length, target, target_frame)]:
                values = _values(name, owner, frame)
                expected = _values(endpoint, owner, endpoint_frame)
                if set(values) != set(expected):
                    missing.append(owner + ':channel mismatch'); continue
                maximum = max(maximum, max((abs(v - expected[key]) for key, v in values.items()), default=0.))
        check(name + '_complete_finite_tracks', not missing and not nonfinite and channel_count == expected_channels,
              scalar_channels=channel_count, expected_scalar_channels=expected_channels,
              missing=missing, nonfinite=nonfinite)
        check(name + '_exact_endpoints', maximum <= tolerance, maximum_error=maximum)
        check(name + '_no_unrelated_prop_leaks', not helper_leaks, leaks=helper_leaks)

        if name.endswith('Thinking'):
            # These are pose-relative thoughts, not new locomotion. Panel
            # placement and the complete lower body remain literally planted.
            first = _values(name, 'rig', 1)
            lower_paths = [key for key in first if any(('"' + bone + '"') in key[0]
                           for bone in ('root', 'body', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R'))]
            maximum_lower = 0.; maximum_panels = 0.
            for curve in _action(name, 'rig').fcurves:
                channel = (curve.data_path, curve.array_index)
                if channel in lower_paths:
                    maximum_lower = max(maximum_lower, float(np.abs(_coordinates(curve)[:, 1] - first[channel]).max()))
            for owner in panel_owners:
                base = _values(name, owner, 1)
                for curve in _action(name, owner).fcurves:
                    channel = (curve.data_path, curve.array_index)
                    maximum_panels = max(maximum_panels, float(np.abs(_coordinates(curve)[:, 1] - base[channel]).max()))
            check(name + '_planted_body_and_unchanged_panels', max(maximum_lower, maximum_panels) <= tolerance,
                  lower_body_error=maximum_lower, panel_error=maximum_panels)

        if name.endswith('ToFace'):
            maximum_panel = 0.; minimum_scale = 1.
            for owner, _ in owners:
                if owner in panel_owners:
                    expected = _values(source, owner, source_frame)
                    for frame in range(1, 32):
                        row = _values(name, owner, frame)
                        maximum_panel = max(maximum_panel, max(abs(row[key] - value) for key, value in expected.items()))
                companion = _action(name, owner)
                for curve in companion.fcurves:
                    if curve.data_path == 'scale':
                        minimum_scale = min(minimum_scale, float(_coordinates(curve)[:, 1].min()))
            check(name + '_panels_retained_until_covered', maximum_panel <= tolerance,
                  maximum_panel_error=maximum_panel, covered_frame=31)
            check(name + '_nonnegative_helper_scale', minimum_scale >= -tolerance,
                  minimum_scale=minimum_scale)
    return {'passed': all(row['passed'] for row in checks), 'clips': len(names), 'checks': checks}


def verify_context_geometry(names, stride=1):
    """Measure visible thinking poses against the original shell geometry.

    Every frame is checked by default. Expanded-face routes keep the original
    pose until covered, so only thought/hand transitions need new clearance
    measurements here. Panel/root continuity is checked separately above.
    """
    import numpy as np
    from mathutils import Euler, Matrix, Vector
    from animate_casual import _rig_points
    rig = bpy.data.objects['MERLIN_Rig']
    clouds = _rig_points(rig)
    bones = list(rig.data.bones)
    curve_cache = {}
    def sampled_matrices(action, frame):
        curves = curve_cache.get(action.name)
        if curves is None:
            curves = {(curve.data_path, curve.array_index): curve for curve in action.fcurves}
            curve_cache[action.name] = curves
        matrices = {}
        for bone in bones:
            channels = []
            for path, default in [('location', 0.), ('rotation_euler', 0.), ('scale', 1.)]:
                channels.append(Vector(tuple(
                    curve.evaluate(frame) if (curve := curves.get((f'pose.bones["{bone.name}"].{path}', i))) else default
                    for i in range(3))))
            location, rotation, scale = channels
            local = Matrix.LocRotScale(location, Euler(rotation, 'XYZ').to_quaternion(), scale)
            parent = bone.parent
            matrices[bone.name] = bone.convert_local_to_pose(
                local, bone.matrix_local,
                parent_matrix=matrices[parent.name] if parent else Matrix.Identity(4),
                parent_matrix_local=parent.matrix_local if parent else Matrix.Identity(4))
        return matrices
    checks = []
    total = 0
    for clip in names:
        if not clip.endswith(('ToThink', 'Thinking', 'ThinkToBody')):
            continue
        action = bpy.data.actions[clip]
        length = round(action.frame_range[1])
        frames = sorted(set(range(1, length + 1, max(1, stride))) | {length})
        floor = math.inf; volume = math.inf; extent = [math.inf, -math.inf]; matrix_error = 0.
        problem = None
        for frame in frames:
            matrices = sampled_matrices(action, frame)
            # Compare the direct Blender bone-conversion API with evaluated
            # depsgraph poses at three anchors. The remaining frames avoid
            # reevaluating thousands of unrelated screen/helper channels.
            if frame in (frames[0], frames[len(frames) // 2], frames[-1]):
                rig.animation_data.action = action
                bpy.context.scene.frame_set(frame)
                bpy.context.view_layer.update()
                matrix_error = max(matrix_error, max(
                    abs(float(matrices[bone.name][i][j]) - float(rig.pose.bones[bone.name].matrix[i][j]))
                    for bone in bones for i in range(4) for j in range(4)))
            inverse = np.array((matrices['head'] @ rig.data.bones['head'].matrix_local.inverted()).inverted())
            for bone, points in clouds.items():
                matrix = np.array(matrices[bone])
                world = points @ matrix[:3, :3].T + matrix[:3, 3]
                floor = min(floor, float(world[:, 2].min()))
                extent = [min(extent[0], float(world[:, 0].min())),
                          max(extent[1], float(world[:, 0].max()))]
                if not bone.startswith(('upper_arm.', 'forearm.', 'hand.')):
                    continue
                local = world @ inverse[:3, :3].T + inverse[:3, 3]
                values = (np.abs(local[:, 0] / 1.04) ** (2 / .65)
                          + np.abs(local[:, 1] / .54) ** (2 / .65)
                          + np.abs((local[:, 2] - 2.98) / .71) ** (2 / .65))
                minimum = float(values.min())
                if minimum < volume:
                    volume = minimum
                    problem = {'frame': frame, 'bone': bone}
            total += 1
        checks.append({'name': clip + '_body_clearance',
                       'passed': floor >= .03 and volume >= .999 and extent[0] >= -4.5 and extent[1] <= 4.5 and matrix_error <= 3e-5,
                       'frames_checked': len(frames), 'minimum_floor_z': floor,
                       'minimum_arm_head_implicit_volume': volume,
                       'x_extent': extent, 'closest_arm_head_sample': problem,
                       'maximum_sampled_vs_evaluated_matrix_error': matrix_error})
    return {'passed': all(row['passed'] for row in checks), 'frames_checked': total, 'checks': checks}

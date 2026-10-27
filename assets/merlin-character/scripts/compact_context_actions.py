"""Losslessly reduce explicitly held channels in new presentation clips.

Only exact constant LINEAR channels are compacted. First/last frame, duration,
value, extrapolation, varying channels, geometry and materials are untouched.
The caller chooses the new clip names and controls saving the Blender file.
"""
import hashlib
import struct

import bpy
import numpy as np
from interaction_support import action_name
import screen_state_support as support


def _coordinates(points):
    values = np.empty(len(points) * 2, dtype=np.float32)
    points.foreach_get('co', values)
    return values.reshape((-1, 2))


def _interpolation_codes(points):
    values = np.empty(len(points), dtype=np.int32)
    points.foreach_get('interpolation', values)
    return values


def action_fingerprint(names):
    digest = hashlib.sha256()
    actions = {action.name: action for action in bpy.data.actions}
    for name in sorted(names):
        for owner, _ in support.owners():
            action = actions[action_name(name, owner)]
            digest.update(action.name.encode('utf-8'))
            for curve in action.fcurves:
                digest.update(curve.data_path.encode('utf-8'))
                digest.update(struct.pack('<i', curve.array_index))
                digest.update(curve.extrapolation.encode('ascii'))
                digest.update(_coordinates(curve.keyframe_points).tobytes())
                digest.update(_interpolation_codes(curve.keyframe_points).tobytes())
    return digest.hexdigest()


def compact_new_actions(names):
    actions = {action.name: action for action in bpy.data.actions}
    report = {'clips': len(names), 'curves_compacted': 0, 'keyframes_removed': 0,
              'exact_constant_channels': True, 'durations_preserved': True}
    for name in names:
        for owner, _ in support.owners():
            action = actions[action_name(name, owner)]
            duration = tuple(action.frame_range)
            for curve in action.fcurves:
                points = curve.keyframe_points
                if len(points) <= 2:
                    continue
                coordinates = _coordinates(points)
                value = float(coordinates[0, 1])
                if not np.all(coordinates[:, 1] == value):
                    continue
                codes = _interpolation_codes(points)
                linear_code = points[0].bl_rna.properties['interpolation'].enum_items['LINEAR'].value
                if not np.all(codes == linear_code):
                    continue
                first = float(coordinates[0, 0]); last = float(coordinates[-1, 0])
                count = len(points)
                points.clear()
                points.add(2)
                points.foreach_set('co', [first, value, last, value])
                for point in points:
                    point.interpolation = 'LINEAR'
                curve.update()
                if curve.evaluate(first) != value or curve.evaluate(last) != value or curve.evaluate((first + last) / 2) != value:
                    raise RuntimeError('Constant channel changed during compaction: ' + action.name)
                report['curves_compacted'] += 1
                report['keyframes_removed'] += count - 2
            if tuple(action.frame_range) != duration:
                raise RuntimeError('Action duration changed during compaction: ' + action.name)
    return report

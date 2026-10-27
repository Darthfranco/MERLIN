"""Re-import the merged GLB and compare all newly authored synchronized states.

Run after the merged GLB is finalized. The original binary animations are
checked separately by verify_dual_screens; this script samples every added clip
at its first, middle and last frames, plus visible dismissal-fragment geometry.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import sys
import tempfile

import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = Path(__file__).resolve().parent
ASSET = HERE.parent
sys.path.insert(0, str(HERE))
import screen_state_support as support
import verify_states_roundtrip as base
from room_support import FACE_OBJECTS
from verify_character import parse_glb
from verify_dual_screens import refresh_action_cache
from preserve_step_handoffs import sample as gltf_sample, float32


def geometry_bounds(points):
    return [min(point[axis] for point in points) for axis in range(3)]+[
        max(point[axis] for point in points) for axis in range(3)]


def raw_handoff_snapshot(document, binary, frame, fps):
    """Evaluate final GLB card geometry without Blender's close-key deduplication."""
    animation = next(item for item in document['animations'] if item['name'] == 'CeilingToLeftPanel')
    time = (frame-1)/fps
    if float(frame).is_integer():
        time = float32(time)  # Exact stored key, including float32 timestamp rounding.
    parents = {child: index for index, node in enumerate(document['nodes']) for child in node.get('children', [])}
    matrices = {}
    basis = Matrix(((1., 0., 0., 0.), (0., 0., -1., 0.), (0., 1., 0., 0.), (0., 0., 0., 1.)))

    def world(index):
        if index not in matrices:
            node = document['nodes'][index]
            if 'matrix' in node:
                matrix = Matrix([[node['matrix'][column*4+row] for column in range(4)] for row in range(4)])
            else:
                t, q, s = (gltf_sample(document, binary, animation, index, path, time)
                           for path in ('translation', 'rotation', 'scale'))
                matrix = Matrix.LocRotScale(Vector(t), Quaternion((q[3], q[0], q[1], q[2])), Vector(s))
            matrices[index] = world(parents[index])@matrix if index in parents else matrix
        return matrices[index]

    result = {}
    for index, node in enumerate(document['nodes']):
        if node.get('name') not in ('Panel • white card', 'MERLIN_LeftPanel'):
            continue
        matrix = world(index)
        points = [tuple(basis@matrix@Vector(position)) for primitive in document['meshes'][node['mesh']]['primitives']
                  for position in base.accessor_values(document, binary, primitive['attributes']['POSITION'])]
        result[node['name']] = {'matrix': base.flat(basis@matrix@basis.inverted()),
            'scale': gltf_sample(document, binary, animation, index, 'scale', time),
            'bounds': geometry_bounds(points)}
    return result, time


def close_key_importer_probe():
    """Exercise the importer utility's fcurve.update step on adjacent float times."""
    action = bpy.data.actions.new('__MERLIN close-key verification')
    try:
        curve = action.fcurves.new('scale', index=0)
        curve.keyframe_points.add(3)
        curve.keyframe_points.foreach_set('co', [124., 1., 124.99999237060547, 1., 125., 0.])
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
        before = [list(point.co) for point in curve.keyframe_points]
        curve.update()
        after = [list(point.co) for point in curve.keyframe_points]
        return {'keys_before_update': before, 'keys_after_update': after,
                'deduplicates_adjacent_keys': len(before) == 3 and len(after) == 2,
                'evaluated_fractional_scale_after_update': curve.evaluate(124.999)}
    finally:
        bpy.data.actions.remove(action)


def visible_fragment_frame(clip, frames):
    fragments = [(owner, obj) for owner, obj in support.owners()
                 if isinstance(obj, bpy.types.Object) and obj.get('panel_kind') == 'fragment']
    best_frame, best_scale = None, 0.
    for frame in range(1, frames+1):
        value = 0.
        for owner, _ in fragments:
            action = support.action_for(clip, owner)
            curves = [curve for curve in action.fcurves if curve.data_path == 'scale']
            value += sum(abs(curve.evaluate(frame)) for curve in curves)
        if value > best_scale:
            best_frame, best_scale = frame, value
    return best_frame


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=Path('/tmp/merlin-dual-baseline'))
    arguments = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    manifest = json.loads((ASSET/'states.json').read_text())
    baseline = json.loads((arguments.baseline/'states.json').read_text())
    new_clips = [clip for clip in manifest['clips'] if clip not in baseline['clips']]
    if len(new_clips) < 9:
        raise ValueError('Expected the nine dual-screen clips and optional context additions')
    document, binary, _ = parse_glb(ASSET/'merlin-states.glb')
    bpy.ops.wm.open_mainfile(filepath=str(ASSET/'merlin-states.blend'))
    refresh_action_cache()
    scene, rig = bpy.context.scene, bpy.data.objects['MERLIN_Rig']
    descriptors = base.describe_owners()
    names = sorted({item['name'] for item in descriptors if item['owner'] != 'rig'})
    objects = {name: bpy.data.objects[name] for name in names}
    face_names = list(FACE_OBJECTS)
    helpers = [name for name, obj in objects.items() if name not in face_names and obj.type == 'MESH']
    screens = base.source_screen_data()
    source, additional, handoffs = {}, {}, {}
    for clip in new_clips:
        frames = manifest['clips'][clip]['frames']
        for frame in (1, round((frames+1)/2), frames):
            support.apply_activity(scene, clip, frame)
            source[(clip, frame)] = base.capture(rig, objects, face_names, helpers)
        fragment_frame = visible_fragment_frame(clip, frames)
        if fragment_frame is not None:
            support.apply_activity(scene, clip, fragment_frame)
            additional[(clip, fragment_frame)] = base.capture(rig, objects, face_names, helpers, True)
    if 'CeilingToLeftPanel' in new_clips:
        switch = manifest.get('ceiling_screen', {}).get('left_handoff_frame', 126)
        cards = ('Panel • white card', 'MERLIN_LeftPanel')
        for frame in (switch-.001, switch):
            support.apply_activity(scene, 'CeilingToLeftPanel', frame)
            handoffs[frame] = {name: {'matrix': base.flat(objects[name].matrix_world),
                'scale': list(objects[name].scale),
                'bounds': geometry_bounds([tuple(objects[name].matrix_world@vertex.co)
                    for vertex in objects[name].evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices])}
                for name in cards}
    report = {'schema_version': 1, 'checked_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'blender_version': bpy.app.version_string, 'source_blend': 'merlin-states.blend',
        'imported_glb': 'merlin-states.glb', 'new_clips': new_clips, 'owner_count': len(descriptors),
        'glb_sha256': hashlib.sha256((ASSET/'merlin-states.glb').read_bytes()).hexdigest(),
        'blend_sha256': hashlib.sha256((ASSET/'merlin-states.blend').read_bytes()).hexdigest(),
        'samples': [], 'missing_tracks': [], 'extra_geometry_poses': [], 'handoff_samples': [],
        'importer_handoff_samples': [], 'importer_precision_probe': close_key_importer_probe(),
        'max_errors': {name: 0. for name in base.LIMITS}, 'tolerances': base.LIMITS,
        'screens': base.exported_screens(document, binary, screens, manifest),
        'clip_durations': base.clip_durations(document, binary, manifest),
        'limitations': ['Representative first/middle/final poses and peak-fragment geometry verify Blender re-import; fractional blends are not exhaustively sampled.',
                       'Blender 4.0.2 fcurve.update deduplicates the adjacent float32 handoff keys. The 125.999 sample is therefore verified directly from final GLB samplers and mesh geometry against Blender source, not claimed as a successful Blender re-import. The exact 126 re-import is required to pass.',
                       'The unchanged original animation payload is verified by the separate dual-screen scene/export report.']}
    print('DUAL_SOURCE_SAMPLED', len(source), 'poses', len(descriptors), 'owners', flush=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = manifest['fps']
    bpy.ops.import_scene.gltf(filepath=str(ASSET/'merlin-states.glb'))
    refresh_action_cache()
    rig = bpy.data.objects['MERLIN_Rig']
    objects, datablocks = base.resolve_imported(descriptors)
    objects.pop('MERLIN_Rig', None)
    report['imported_clips'] = sorted(track.name for track in rig.animation_data.nla_tracks)
    for sid, expected in screens.items():
        imported = base.texture_record(bpy.data.materials[expected['material']])
        original = expected['texture']
        same_size = imported['size'] == original['size']
        pixel_error = max(abs(a-b) for a, b in zip(imported['pixels'], original['pixels'])) if same_size else 1.
        record = {'passed': same_size and pixel_error <= 2/255,
            'source_size': original['size'], 'imported_size': imported['size'],
            'maximum_channel_error': pixel_error, 'tolerance': 2/255}
        report['screens']['screens'][sid]['imported_pixels'] = record
        report['screens']['passed'] &= record['passed']
    for (clip, frame), expected in source.items():
        missing, time = base.select_imported(clip, frame, rig, datablocks)
        report['missing_tracks'] += missing
        if missing:
            continue
        errors = base.errors_for(base.capture(rig, objects, face_names, helpers), expected)
        report['samples'].append({'clip': clip, 'source_frame': frame, 'imported_frame': time, 'errors': errors})
        for key, value in errors.items():
            report['max_errors'][key] = max(report['max_errors'][key], value)
    for (clip, frame), expected in additional.items():
        missing, time = base.select_imported(clip, frame, rig, datablocks)
        report['missing_tracks'] += missing
        if missing:
            continue
        actual = base.capture(rig, objects, face_names, helpers, True)
        geometry = {name: base.geometry_distance(expected['display_geometry'][name]['vertices'],
                    actual['display_geometry'][name]['vertices']) for name in helpers}
        report['extra_geometry_poses'].append({'clip': clip, 'source_frame': frame, 'imported_frame': time,
            'world_vertex_errors': geometry, 'passed': max(geometry.values()) < base.LIMITS['display_geometry']})
    for frame, expected in handoffs.items():
        actual, seconds = raw_handoff_snapshot(document, binary, frame, manifest['fps'])
        raw_errors = {name: max(abs(a-b) for a, b in zip(row['matrix'], actual[name]['matrix']))
                      for name, row in expected.items()}
        bounds_errors = {name: max(abs(a-b) for a, b in zip(row['bounds'], actual[name]['bounds']))
                         for name, row in expected.items()}
        expected_visible = [name for name, row in expected.items() if min(abs(v) for v in row['scale']) > 1e-5]
        raw_visible = [name for name, row in actual.items() if min(abs(v) for v in row['scale']) > 1e-5]
        report['handoff_samples'].append({'clip': 'CeilingToLeftPanel', 'source_frame': frame,
            'verification': 'Final GLB sampler and mesh evaluation versus Blender source',
            'gltf_seconds': seconds, 'world_matrix_errors': raw_errors, 'world_bounds_errors': bounds_errors,
            'visible_cards': raw_visible, 'passed': max(raw_errors.values()) < base.LIMITS['objects']
                and max(bounds_errors.values()) < base.LIMITS['display_geometry']
                and len(raw_visible) == 1 and set(raw_visible) == set(expected_visible)})
        missing, time = base.select_imported('CeilingToLeftPanel', frame, rig, datablocks)
        report['missing_tracks'] += missing
        if missing:
            continue
        errors, visible = {}, []
        for name, wanted in expected.items():
            obj = objects[name]
            errors[name] = max(abs(a-b) for a, b in zip(base.flat(obj.matrix_world), wanted['matrix']))
            if min(abs(v) for v in obj.scale) > 1e-5:
                visible.append(name)
        supported = float(frame).is_integer()
        report['importer_handoff_samples'].append({'clip': 'CeilingToLeftPanel', 'source_frame': frame,
            'imported_frame': time, 'world_matrix_errors': errors, 'visible_cards': visible,
            'supported_at_importer_precision': supported,
            'passed': max(errors.values()) < base.LIMITS['objects'] and len(visible) == 1
                      and visible == expected_visible})
    report['sample_count'] = len(report['samples'])
    report['passed'] = (not report['missing_tracks']
        and set(report['imported_clips']) == set(manifest['clips'])
        and report['sample_count'] == len(new_clips)*3
        and all(report['max_errors'][key] < base.LIMITS[key] for key in base.LIMITS)
        and len(report['extra_geometry_poses']) == len(additional)
        and all(pose['passed'] for pose in report['extra_geometry_poses'])
        and len(report['handoff_samples']) == len(handoffs)
        and all(pose['passed'] for pose in report['handoff_samples'])
        and len(report['importer_handoff_samples']) == len(handoffs)
        and all(pose['passed'] for pose in report['importer_handoff_samples'] if pose['supported_at_importer_precision'])
        and (not handoffs or report['importer_precision_probe']['deduplicates_adjacent_keys'])
        and all(value['passed'] for value in report['clip_durations'].values())
        and report['screens']['passed'])
    target = ASSET/'previews/dual-roundtrip-validation.json' if report['passed'] else Path(tempfile.gettempdir())/'dual-roundtrip-failed.json'
    target.write_text(json.dumps(report, indent=2, allow_nan=False)+'\n')
    print('DUAL_ROUNDTRIP', json.dumps({'passed': report['passed'], 'samples': report['sample_count'],
        'owners': report['owner_count'], 'max_errors': report['max_errors'],
        'missing_tracks': len(report['missing_tracks']), 'screens': report['screens']['passed'],
        'report': str(target)}), flush=True)
    if not report['passed']:
        raise RuntimeError('Dual-screen GLB re-import comparison failed')


if __name__ == '__main__':
    main()

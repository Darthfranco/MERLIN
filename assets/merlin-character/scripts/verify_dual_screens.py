"""Independently verify dual-screen animation, selective dismissal and preservation.

Blender --background --python-exit-code 1 --python verify_dual_screens.py
Optional arguments after --: --baseline DIRECTORY --glb or --glb-only. The baseline directory
must contain the previous merlin-states.blend, merlin-states.glb and states.json.
Only passing evidence is published beside the delivered previews.
"""
from pathlib import Path
from array import array
import argparse
import datetime
import hashlib
import json
import math
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

HERE = Path(__file__).resolve().parent
ASSET = HERE.parent
sys.path.insert(0, str(HERE))
import screen_state_support as support
import verify_screen_states as existing
from animate_character import BONE_NAMES
from animate_casual import _rig_points, _extreme
from verify_character import parse_glb, scalar_floats
from verify_transitions import accessor_values

NEW_CLIPS = ('ReadyToBothPanels', 'BothPanelsIdle', 'BothToLeftPanel',
             'BothToRightPanel', 'SeatedLeftPanelIdle', 'SeatedRightPanelIdle',
             'SeatedLeftToReady', 'SeatedRightToReady', 'BothPanelsToReady')
LOOPS = ('BothPanelsIdle', 'SeatedLeftPanelIdle', 'SeatedRightPanelIdle')
TOLERANCE = 3e-5
report = {}
manifest = {}
ACTION_CACHE = {}


def cached_action(clip, owner):
    return ACTION_CACHE.get(support.base.action_name(clip, owner))


def refresh_action_cache():
    """Cache after each scene load; the verification process never authors actions.

    Existing snapshots call the three stacked playback helpers, so replace their
    local lookups in this isolated read-only process as well as our direct ones.
    """
    global ACTION_CACHE
    ACTION_CACHE = {action.name: action for action in bpy.data.actions}
    support.action_for = cached_action
    support.base.action_for = cached_action
    support.base.base.action_for = cached_action


def check(name, passed, **details):
    report['checks'].append({'name': name, 'passed': bool(passed), **details})


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    allow_nan=False).encode()).hexdigest()


def action_fingerprint(action):
    # Stream compact float buffers into the digest. Building a Python list of
    # every handle on all37×98actions needlessly pressures a small workstation.
    fingerprint = hashlib.sha256()
    for curve in sorted(action.fcurves, key=lambda value: (value.data_path, value.array_index)):
        fingerprint.update(json.dumps([curve.data_path, curve.array_index, curve.extrapolation,
            len(curve.keyframe_points), [modifier.type for modifier in curve.modifiers]]).encode())
        for attribute in ('co', 'handle_left', 'handle_right'):
            values = array('f', [0.])*(len(curve.keyframe_points)*2)
            curve.keyframe_points.foreach_get(attribute, values)
            fingerprint.update(values.tobytes())
        fingerprint.update('\0'.join(point.interpolation+':'+point.handle_left_type+':'+point.handle_right_type
                                     for point in curve.keyframe_points).encode())
    return fingerprint.hexdigest()


def mesh_integer_hash(collection, attribute, count):
    values = array('i', [0])*count
    collection.foreach_get(attribute, values)
    return hashlib.sha256(values.tobytes()).hexdigest()


def preservation_snapshot(clips):
    support.apply_activity(bpy.context.scene, 'ReadyIdle', 1)
    resources = existing.baseline_snapshot()
    resources.pop('blend_sha256', None)
    owners = support.owners()
    geometry = {}
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        geometry[obj.name] = digest({
            'coordinates': existing.digest_collection(obj.data.vertices, 'co', len(obj.data.vertices)*3),
            'polygon_starts': mesh_integer_hash(obj.data.polygons, 'loop_start', len(obj.data.polygons)),
            'polygon_sizes': mesh_integer_hash(obj.data.polygons, 'loop_total', len(obj.data.polygons)),
            'polygon_materials': mesh_integer_hash(obj.data.polygons, 'material_index', len(obj.data.polygons)),
            'loop_vertices': mesh_integer_hash(obj.data.loops, 'vertex_index', len(obj.data.loops)),
            'uv': [existing.digest_collection(layer.data, 'uv', len(layer.data)*2)
                   for layer in obj.data.uv_layers],
            'materials': [material.name if material else None for material in obj.data.materials],
            'screen_id': obj.get('merlin_screen_id'),
        })
    return {'resources': resources,
        'geometry': geometry,
        'owners': [owner for owner, _ in owners],
        'actions': {clip: {owner: action_fingerprint(support.action_for(clip, owner))
                          for owner, _ in owners} for clip in clips},
        'screens': {material.name: existing.material_snapshot(material)
                    for material in bpy.data.materials if material.get('merlin_screen_id')}}


def snapshot(clip, frame):
    return existing.snapshot(clip, frame)


def validate_preservation(baseline, original_manifest):
    current = preservation_snapshot(original_manifest['clips'])
    for field in ('resources', 'geometry', 'owners', 'screens'):
        check('original_'+field+'_unchanged', baseline[field] == current[field])
    changed = [[clip, owner] for clip, owners in baseline['actions'].items()
               for owner, fingerprint in owners.items()
               if fingerprint != current['actions'].get(clip, {}).get(owner)]
    check('all_37_original_clips_and_companions_unchanged', not changed,
          clips=len(original_manifest['clips']), actions=sum(len(x) for x in baseline['actions'].values()),
          changed_actions=changed)
    check('original_manifest_clip_metadata_unchanged', all(
        manifest['clips'].get(clip) == metadata for clip, metadata in original_manifest['clips'].items()))
    for field in ('camera', 'screens', 'lighting'):
        check('original_manifest_'+field+'_unchanged', original_manifest.get(field) == manifest.get(field))


def validate_structure(original_manifest):
    expected = set(original_manifest['clips']) | set(NEW_CLIPS)
    check('all_original_and_nine_dual_manifest_clips', expected <= set(manifest['clips']) and len(expected) == 46,
          actual=len(manifest['clips']), missing=sorted(expected-set(manifest['clips'])),
          additional_clips=sorted(set(manifest['clips'])-expected))
    owners = support.owners()
    check('exactly_98_unique_synchronized_owners', len(owners) == 98 and len({n for n, _ in owners}) == 98)
    errors = []
    for clip in NEW_CLIPS:
        length = manifest['clips'][clip]['frames']
        for owner, data in owners:
            action = support.action_for(clip, owner)
            if action is None:
                errors.append([clip, owner, 'missing action'])
                continue
            if list(action.frame_range) != [1., float(length)]:
                errors.append([clip, owner, 'duration', list(action.frame_range)])
            required = {(curve.data_path, curve.array_index)
                        for curve in support.action_for('ReadyIdle', owner).fcurves}
            present = {(curve.data_path, curve.array_index) for curve in action.fcurves}
            if required-present:
                errors.append([clip, owner, 'missing channels', sorted(required-present)])
            for curve in action.fcurves:
                values = [float(point.co.y) for point in curve.keyframe_points]
                if not values or not all(math.isfinite(value) for value in values):
                    errors.append([clip, owner, 'invalid values', curve.data_path])
                if isinstance(data, bpy.types.Key) and values and (min(values)<-1e-6 or max(values)>1+1e-6):
                    errors.append([clip, owner, 'invalid morph range', curve.data_path])
    check('new_actions_complete_finite_and_synchronized', not errors, errors=errors)
    scene = bpy.context.scene
    check('original_15_bones_unit_rig_24fps_four_by_three',
          set(bpy.data.objects['MERLIN_Rig'].data.bones.keys()) == set(BONE_NAMES)
          and list(bpy.data.objects['MERLIN_Rig'].scale) == [1, 1, 1]
          and scene.render.fps/scene.render.fps_base == 24
          and abs(scene.render.resolution_x/scene.render.resolution_y-4/3) < 1e-6)


def validate_boundaries():
    for clip in NEW_CLIPS:
        metadata = manifest['clips'][clip]
        for endpoint, frame in (('source', 1), ('target', metadata['frames'])):
            reference, reference_frame = metadata[endpoint], metadata[endpoint+'_frame']
            maximum, errors = existing.difference(snapshot(clip, frame), snapshot(reference, reference_frame))
            check(clip+'_'+endpoint+'_continuous', not errors, maximum_error=maximum,
                  reference=[reference, reference_frame], errors=errors)
    for clip in LOOPS:
        maximum, errors = existing.difference(snapshot(clip, 1), snapshot(clip, manifest['clips'][clip]['frames']))
        check(clip+'_seamless_loop', not errors, maximum_error=maximum, errors=errors)


def panel_objects(side):
    return [obj for obj in bpy.data.objects if obj.get('merlin_screen_id') == side]


def visible(obj):
    return max(abs(value) for value in obj.scale) > 1e-5


def panel_card(side):
    return next(obj for obj in panel_objects(side) if obj.get('panel_kind') == 'card')


def bounds(obj):
    coordinates = [obj.matrix_world@Vector(corner) for corner in obj.bound_box]
    return [[min(point[axis] for point in coordinates), max(point[axis] for point in coordinates)]
            for axis in range(3)]


def validate_selective_dismissals():
    ready = snapshot('ReadyIdle', 1)
    seated = snapshot('BothPanelsIdle', 1)
    root_drop = ready['rig']['bones']['root'][11]-seated['rig']['bones']['root'][11]
    check('seated_body_lower_than_ready', root_drop > .3, root_drop=root_drop)
    for clip, retained, dismissed in (('BothToLeftPanel', 'left', 'right'),
                                     ('BothToRightPanel', 'right', 'left')):
        snapshot(clip, 1)
        card = panel_card(retained)
        retained_matrix = existing.flat(card.matrix_world)
        root_origin = Vector(bpy.data.objects['MERLIN_Rig'].pose.bones['root'].head)
        matrix_error = root_distance = 0.
        visibility_errors = []
        body = bpy.data.objects['MERLIN_Rig']
        for frame in range(1, manifest['clips'][clip]['frames']+1):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            matrix_error = max(matrix_error, max(abs(a-b) for a,b in zip(retained_matrix, existing.flat(card.matrix_world))))
            root_distance = max(root_distance, (body.pose.bones['root'].head-root_origin).length)
            if not visible(card) or any(visible(obj) for obj in panel_objects(retained) if obj != card):
                visibility_errors.append(frame)
        removed = [obj.name for obj in panel_objects(dismissed) if visible(obj)]
        check(clip+'_retained_screen_held_and_textured', matrix_error < TOLERANCE and not visibility_errors,
              maximum_matrix_error=matrix_error, visibility_errors=visibility_errors)
        check(clip+'_dismissed_screen_fully_hidden', not removed, still_visible=removed)
        check(clip+'_body_stays_seated', root_distance < .12, maximum_root_distance=root_distance)
    for clip in ('SeatedLeftToReady', 'SeatedRightToReady', 'BothPanelsToReady'):
        support.apply_activity(bpy.context.scene, clip, manifest['clips'][clip]['frames'])
        remaining = [obj.name for side in ('left', 'right') for obj in panel_objects(side) if visible(obj)]
        check(clip+'_both_screens_fully_hidden', not remaining, still_visible=remaining)
    for clip, intended in (('BothPanelsIdle', {'left', 'right'}),
                           ('SeatedLeftPanelIdle', {'left'}), ('SeatedRightPanelIdle', {'right'})):
        support.apply_activity(bpy.context.scene, clip, 1)
        actual = {side for side in ('left', 'right') if visible(panel_card(side))}
        fragments = [obj.name for side in ('left', 'right') for obj in panel_objects(side)
                     if obj.get('panel_kind') != 'card' and visible(obj)]
        check(clip+'_correct_screens_visible', actual == intended and not fragments,
              sides=sorted(actual), fragments=fragments)


def validate_geometry():
    scene = bpy.context.scene
    rig = bpy.data.objects['MERLIN_Rig']
    clouds = _rig_points(rig)
    measurements = {}
    for clip in NEW_CLIPS:
        low, scale_error = math.inf, 0.
        extent = [math.inf, -math.inf]
        support.apply_activity(scene, clip, 1)
        for frame in range(1, manifest['clips'][clip]['frames']+1):
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            low = min(low, _extreme(rig, clouds, 2))
            extent[0] = min(extent[0], _extreme(rig, clouds, 0))
            extent[1] = max(extent[1], _extreme(rig, clouds, 0, maximum=True))
            scale_error = max(scale_error, max(abs(value-1) for bone in rig.pose.bones for value in bone.matrix.to_scale()))
        check(clip+'_body_floor_wall_and_scale_clearance', low >= .025 and extent[0] >= -4.5
              and extent[1] <= 4.5 and scale_error < 2e-5,
              minimum_floor_z=low, x_extent=extent, maximum_scale_error=scale_error)
        measurements[clip] = {'frames_checked': manifest['clips'][clip]['frames'], 'floor_min': low, 'x_extent': extent}
    support.apply_activity(scene, 'BothPanelsIdle', 1)
    left, right = panel_card('left'), panel_card('right')
    left_bounds, right_bounds = bounds(left), bounds(right)
    robot_bounds = [_extreme(rig, clouds, 0), _extreme(rig, clouds, 0, maximum=True)]
    check('seated_robot_between_two_separate_cards', left_bounds[0][1] < robot_bounds[0]
          and right_bounds[0][0] > robot_bounds[1], left_bounds=left_bounds,
          right_bounds=right_bounds, robot_x_extent=robot_bounds)
    framing = []
    for card in (left, right):
        projected = [world_to_camera_view(scene, scene.camera, card.matrix_world@Vector(corner))
                     for corner in card.bound_box]
        framing.append({'card': card.name, 'x': [min(p.x for p in projected), max(p.x for p in projected)],
                        'y': [min(p.y for p in projected), max(p.y for p in projected)],
                        'front': all(p.z > 0 for p in projected)})
    check('both_seated_cards_inside_camera_and_above_floor',
          all(min(r['x']+r['y']) >= 0 and max(r['x']+r['y']) <= 1 and r['front'] for r in framing)
          and min(left_bounds[2][0], right_bounds[2][0]) >= .025, framing=framing)
    report['measurements']['geometry'] = measurements


def validate_screens():
    # Existing detailed UV/front-material validation is independent of clip names.
    existing.report, existing.manifest = report, manifest
    existing.validate_screens()
    errors = []
    for clip in NEW_CLIPS:
        for owner, data in support.owners():
            if isinstance(data, bpy.types.Key) or data.type == 'ARMATURE' or data.get('merlin_screen_id') in ('left', 'right'):
                continue
            if not (data.get('merlin_body_state_owner') or data.get('display_mode') or data.get('face_state_helper')):
                continue
            action = support.action_for(clip, owner)
            if any(abs(point.co.y) > 1e-7 for curve in action.fcurves if curve.data_path == 'scale'
                   for point in curve.keyframe_points):
                errors.append([clip, owner])
    check('unrelated_presentation_helpers_hidden', not errors, errors=errors)


def validate_reverse_walk():
    pairs = {'ReadyToWalkWhistleReverse': 'ReadyToWalkWhistle',
             'WalkWhistleReverse': 'WalkWhistle', 'WalkWhistleReverseToReady': 'WalkWhistleToReady'}
    if not set(pairs) <= set(manifest['clips']):
        return
    mirror = Matrix.Diagonal((-1., 1., 1., 1.))
    rig = bpy.data.objects['MERLIN_Rig']
    errors, maximum, samples = [], 0., 0
    for clip, original in pairs.items():
        frames = manifest['clips'][clip]['frames']
        if frames != manifest['clips'][original]['frames']:
            errors.append([clip, 'duration mismatch'])
        for frame in (1, round((frames+1)/2), frames):
            # The entry/return endpoints deliberately use the exact shared
            # ready pose, which takes precedence over a reflected resting tilt.
            if clip == 'ReadyToWalkWhistleReverse' and frame == 1 or clip == 'WalkWhistleReverseToReady' and frame == frames:
                continue
            support.apply_activity(bpy.context.scene, original, frame)
            expected = {}
            for bone in BONE_NAMES:
                other = bone[:-2]+'.R' if bone.endswith('.L') else bone[:-2]+'.L' if bone.endswith('.R') else bone
                deformation = rig.matrix_world@rig.pose.bones[other].matrix@rig.data.bones[other].matrix_local.inverted()
                expected[bone] = existing.flat(mirror@deformation@mirror)
            support.apply_activity(bpy.context.scene, clip, frame)
            for bone in BONE_NAMES:
                actual = existing.flat(rig.matrix_world@rig.pose.bones[bone].matrix@rig.data.bones[bone].matrix_local.inverted())
                difference = max(abs(a-b) for a, b in zip(actual, expected[bone]))
                maximum = max(maximum, difference)
                if difference > TOLERANCE:
                    errors.append([clip, frame, bone, difference])
            samples += 1
    check('reverse_walk_reflects_forward_gait_and_duration', not errors, sampled_poses=samples,
          maximum_matrix_error=maximum, errors=errors)
    for clip, frame, target, target_frame in (
        ('ReadyToWalkWhistleReverse', 1, 'ReadyIdle', 1),
        ('ReadyToWalkWhistleReverse', manifest['clips']['ReadyToWalkWhistleReverse']['frames'], 'WalkWhistleReverse', 1),
        ('WalkWhistleReverseToReady', 1, 'WalkWhistleReverse', manifest['clips']['WalkWhistleReverse']['frames']),
        ('WalkWhistleReverseToReady', manifest['clips']['WalkWhistleReverseToReady']['frames'], 'ReadyIdle', 1)):
        maximum, errors = existing.difference(snapshot(clip, frame), snapshot(target, target_frame))
        check(clip+'_'+str(frame)+'_continuous', not errors, maximum_error=maximum, errors=errors)


def validate_glb(baseline_directory):
    path = ASSET/'merlin-states.glb'
    document, binary, _ = parse_glb(path)
    previous, old_binary, _ = parse_glb(baseline_directory/'merlin-states.glb')
    animations = {animation['name']: animation for animation in document['animations']}
    check('export_all_manifest_clips', set(animations) == set(manifest['clips']), actual=len(animations))
    preserved = (document['animations'][:len(previous['animations'])] == previous['animations']
                 and document['nodes'] == previous['nodes'] and document['meshes'] == previous['meshes']
                 and document['materials'] == previous['materials']
                 and binary[:len(old_binary)] == old_binary)
    check('export_original_37_animations_and_resources_preserved', preserved)
    errors, counts = [], {}
    required = {(document['nodes'][channel['target']['node']]['name'], channel['target']['path'])
                for channel in animations['ReadyIdle']['channels']}
    for clip in NEW_CLIPS:
        animation = animations[clip]
        channels = {(document['nodes'][channel['target']['node']]['name'], channel['target']['path'])
                    for channel in animation['channels']}
        counts[clip] = len(channels)
        if channels != required:
            errors.append([clip, 'channels differ', sorted(required-channels), sorted(channels-required)])
        ends = []
        for sampler in animation['samplers']:
            times = scalar_floats(document, binary, sampler['input'])
            values = accessor_values(document, binary, sampler['output'])
            if not np.isfinite(times).all() or not np.isfinite(values).all() or abs(times[0]) > 1e-6:
                errors.append([clip, 'invalid sampler'])
            if any(a >= b for a, b in zip(times, times[1:])):
                errors.append([clip, 'non-monotonic time'])
            ends.append(times[-1])
        if abs(max(ends)-(manifest['clips'][clip]['frames']-1)/24) > 1e-5:
            errors.append([clip, 'duration mismatch'])
    check('export_new_channels_times_and_values_valid', not errors, channels=counts, errors=errors)
    report['glb_checked'] = True
    report['glb_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()


def publish():
    failures = [item['name'] for item in report['checks'] if not item['passed']]
    report['passed'], report['failed_checks'] = not failures, failures
    target = ASSET/'previews/dual-screen-validation.json' if not failures else Path(tempfile.gettempdir())/'merlin-dual-validation-failed.json'
    target.write_text(json.dumps(report, indent=2, allow_nan=False)+'\n')
    print('DUAL_SCREEN_VALIDATION', json.dumps({'passed': not failures, 'checks': len(report['checks']),
        'report': str(target), 'failed': failures}), flush=True)
    if failures:
        raise RuntimeError('Dual-screen validation failed: '+', '.join(failures))


def main():
    global report, manifest
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=Path('/tmp/merlin-dual-baseline'))
    parser.add_argument('--glb', action='store_true')
    parser.add_argument('--glb-only', action='store_true', help='Append GLB checks to an unchanged passing scene report.')
    arguments = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    blend_hash = hashlib.sha256((ASSET/'merlin-states.blend').read_bytes()).hexdigest()
    manifest_hash = hashlib.sha256((ASSET/'states.json').read_bytes()).hexdigest()
    if arguments.glb_only:
        report = json.loads((ASSET/'previews/dual-screen-validation.json').read_text())
        manifest = json.loads((ASSET/'states.json').read_text())
        if not report.get('passed') or report.get('blend_sha256') != blend_hash or report.get('manifest_sha256') != manifest_hash:
            raise ValueError('A matching passing scene/manifest report is required before GLB-only validation.')
        report['checks'] = [item for item in report['checks'] if not item['name'].startswith('export_')]
        validate_glb(arguments.baseline)
        publish()
        return
    original_manifest = json.loads((arguments.baseline/'states.json').read_text())
    bpy.ops.wm.open_mainfile(filepath=str(arguments.baseline/'merlin-states.blend'))
    refresh_action_cache()
    print('DUAL_BASELINE_FINGERPRINTING', len(original_manifest['clips']), flush=True)
    original = preservation_snapshot(original_manifest['clips'])
    bpy.ops.wm.open_mainfile(filepath=str(ASSET/'merlin-states.blend'))
    refresh_action_cache()
    manifest = json.loads((ASSET/'states.json').read_text())
    report = {'schema_version': 1, 'checked_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'blend_file': 'merlin-states.blend', 'blend_sha256': blend_hash, 'manifest_sha256': manifest_hash,
        'glb_checked': False, 'blender_version': bpy.app.version_string, 'checks': [], 'measurements': {},
        'limitations': ['Integer-frame body geometry and clip endpoints are checked; numerical checks complement visual review.',
                       'No live device connection, service activation or performance benchmark is claimed.']}
    jobs = [lambda: validate_structure(original_manifest), lambda: validate_preservation(original, original_manifest),
            validate_boundaries, validate_selective_dismissals, validate_geometry, validate_screens, validate_reverse_walk]
    if arguments.glb:
        jobs.append(lambda: validate_glb(arguments.baseline))
    for job in jobs:
        print('DUAL_VALIDATING', job.__name__, flush=True)
        try:
            job()
        except Exception as error:
            check(job.__name__+'_completed', False, error=type(error).__name__+': '+str(error))
    publish()


if __name__ == '__main__':
    main()

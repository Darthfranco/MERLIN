"""Thinking and full-face routes that retain the current body arrangement.

This module authors only Actions on the existing 98 animation owners. It never
creates/deletes panel geometry, edits a material, or replaces screen pixels.
The full-face display covers the room before panels are hidden; reversing the
route restores the exact panel transforms and body pose captured on entry.
"""
from math import pi, radians, sin

import bpy
from mathutils import Matrix, Quaternion, Vector

from animate_character import BONE_NAMES
from animate_transitions import _sample
from animate_left_panel import _reflect_pose
from expressive_face import conform_expression
from interaction_support import action_name
from room_support import FACE_OBJECTS
from transition_support import linear
import screen_state_support as support


CONTEXTS = {
    'right': {'prefix': 'Right', 'activity': 'PanelIdle', 'frame': 1},
    'left': {'prefix': 'Left', 'activity': 'LeftPanelIdle', 'frame': 1},
    'both': {'prefix': 'Both', 'activity': 'BothPanelsIdle', 'frame': 1},
    'seatedLeft': {'prefix': 'SeatedLeft', 'activity': 'SeatedLeftPanelIdle', 'frame': 1},
    'seatedRight': {'prefix': 'SeatedRight', 'activity': 'SeatedRightPanelIdle', 'frame': 1},
    'dance': {'prefix': 'Dance', 'activity': 'Dance', 'frame': 1},
    'nap': {'prefix': 'Nap', 'activity': 'Nap', 'frame': 1},
    'toss': {'prefix': 'Toss', 'activity': 'WallToss', 'frame': 240},
    # Walking exits deliberately use its right-hand endpoint. A caller must not
    # restart WalkWhistle:1 when this context is restored from a full face.
    'walk': {'prefix': 'Walk', 'activity': 'WalkWhistle', 'frame': 192,
             'rest': 'walkRest', 'paused': 'WalkPaused', 'exit': 'WalkWhistleToReady'},
    'walkReverse': {'prefix': 'WalkReverse', 'activity': 'WalkWhistleReverse', 'frame': 192,
                    'rest': 'walkReverseRest', 'paused': 'WalkReversePaused',
                    'exit': 'WalkWhistleReverseToReady'},
    'bodyThink': {'prefix': 'BodyThink', 'activity': 'BodyThink', 'frame': 1,
                  'thinking': False},
}
THINK_FRAMES = 120
THINK_TRANSITION_FRAMES = 32
FACE_FRAMES = 40
IDENTITY = Quaternion((1., 0., 0., 0.))
_ACTIONS = None


def _actions():
    global _ACTIONS
    if _ACTIONS is None:
        _ACTIONS = {action.name: action for action in bpy.data.actions}
    return _ACTIONS


def _action(clip, owner):
    return _actions().get(action_name(clip, owner))


def _new_action(name):
    actions = _actions()
    action = actions.get(name)
    if action is not None:
        # Rebuilding an Action does not require deleting its ID. ID removal
        # remaps every other datablock, which is quadratic for this many owners.
        # Reusing its identity also preserves callers' references to the clip.
        for curve in list(action.fcurves):
            action.fcurves.remove(curve)
        for marker in list(action.pose_markers):
            action.pose_markers.remove(marker)
        for key in list(action.keys()):
            del action[key]
    else:
        action = bpy.data.actions.new(name)
    actions[name] = action
    return action


def _smooth(value):
    value = max(0., min(1., value))
    return value ** 3 * (value * (value * 6 - 15) + 10)


def _row(action, frame):
    return {(curve.data_path, curve.array_index): float(curve.evaluate(frame))
            for curve in action.fcurves}


def _snapshot(clip, frame):
    result = {}
    for owner, _ in support.owners():
        action = _action(clip, owner)
        if action is None:
            raise ValueError('Missing context companion: ' + clip + ', ' + owner)
        result[owner] = _row(action, frame)
    return result


def _mix(a, b, amount):
    if set(a) != set(b):
        raise ValueError('Context endpoints have different animation channels.')
    return {channel: value * (1 - amount) + b[channel] * amount
            for channel, value in a.items()}


def _pose_row(pose, template, previous=None):
    row = dict(template)
    for name, (location, rotation, scale) in pose.items():
        if previous:
            from mathutils import Euler
            compatible = Euler(tuple(previous[(f'pose.bones["{name}"].rotation_euler', i)]
                                     for i in range(3)), 'XYZ')
            euler = rotation.to_euler('XYZ', compatible)
        else:
            euler = rotation.to_euler('XYZ')
        for path, values in [('location', location), ('rotation_euler', euler), ('scale', scale)]:
            for i in range(3):
                row[(f'pose.bones["{name}"].{path}', i)] = float(values[i])
    return row


def _write_clip(name, rows, source, source_frame, target, target_frame, loop=False):
    action = None
    for owner, _ in support.owners():
        result = _new_action(action_name(name, owner))
        for channel in rows[0][owner]:
            values = [row[owner][channel] for row in rows]
            # Most companions are intentionally held. Two identical endpoints
            # retain exact duration and evaluation without thousands of copies
            # of invisible panel/camera/fragment channels in the saved scene.
            if max(values) - min(values) <= 1e-12:
                samples = [1, values[0], len(rows), values[-1]]
            else:
                samples = [value for frame, value_at_frame in enumerate(values, 1)
                           for value in (frame, value_at_frame)]
            path, index = channel
            curve = result.fcurves.new(path, index=index)
            curve.keyframe_points.add(len(samples) // 2)
            curve.keyframe_points.foreach_set('co', samples)
        linear(result)
        if owner == 'rig':
            action = result
    action['frames'] = len(rows)
    action['fps'] = 24
    action['loop'] = loop
    action['source_activity'] = source
    action['source_frame'] = source_frame
    action['target_activity'] = target
    action['target_frame'] = target_frame
    action['preserves_panel_content'] = True
    return action


def _transition_rows(first, last, frames):
    return [{owner: _mix(first[owner], last[owner], _smooth((f - 1) / (frames - 1)))
             for owner in first} for f in range(1, frames + 1)]


def _thought_pose(source, reference, ready, state, phase=0.):
    """Reuse the reviewed thought arms in the source torso's local frame.

    Root, pelvis, legs, feet and body are untouched. Standing/seated gestures
    position the hand relative to the supporting torso. Reclining preserves
    the hands behind the head and lets the expression carry the thought.
    """
    result = {name: (loc.copy(), rot.copy(), scale.copy())
              for name, (loc, rot, scale) in source.items()}
    if state == 'nap':
        # Thinking while reclining keeps the comfortable supporting hands.
        # A chin-reaching transfer would force an arm through the floor.
        loc, rot, scale = result['head']
        result['head'] = (loc, rot @ Quaternion((0, 0, 1), radians(.15) * sin(phase)), scale)
        return result
    for name in BONE_NAMES:
        if name.startswith(('upper_arm.', 'forearm.', 'hand.')):
            if state == 'toss' and name.endswith('.L'):
                continue
            loc, rot, scale = reference[name]
            result[name] = (loc.copy(), rot.copy(), scale.copy())
    loc, rot, scale = source['head']
    delta = ready['head'][1].inverted() @ reference['head'][1]
    result['head'] = (loc.copy(), rot @ delta, scale.copy())
    if state in ('both', 'seatedLeft', 'seatedRight', 'walk'):
        # These torsos/head pitches sit closer to the original chin gesture.
        # Open the elbow a little so the moving palm remains below the shell.
        loc, rot, scale = result['forearm.L']
        result['forearm.L'] = (loc, rot @ Quaternion((1, 0, 0), radians(26)), scale)
    return result


def _build_thinking(rig, state, settings, references, mirrored, ready):
    prefix = settings['prefix']; source_name = settings['activity']; source_frame = settings['frame']
    source = _snapshot(source_name, source_frame)
    source_pose = _sample(rig, source_name, source_frame)
    loop_name = prefix + 'Thinking'
    loop_rows = []
    previous = None
    for frame in range(1, THINK_FRAMES + 1):
        # Reference endpoints are identical, giving a literal closed loop.
        sample = 1 if frame == THINK_FRAMES else 1 + (frame - 1) * 143 / (THINK_FRAMES - 1)
        index = min(143, round(sample) - 1)
        reference = (mirrored if state == 'toss' else references)[index]
        pose = _thought_pose(source_pose, reference, ready, state,
                             2 * pi * (frame - 1) / (THINK_FRAMES - 1))
        row = {owner: dict(values) for owner, values in source.items()}
        row['rig'] = _pose_row(pose, source['rig'], previous)
        previous = row['rig']
        for owner in FACE_OBJECTS:
            row[owner] = _row(_action('BodyThink', owner), sample)
        # Floating notes settle away on the entry. Their meshes and textures
        # remain intact, and the reverse route brings them back into the dance.
        for owner in row:
            if owner.startswith('MusicNote'):
                for i in range(3):
                    row[owner][('scale', i)] = 0.
        loop_rows.append(row)
    loop_rows[-1] = {owner: dict(values) for owner, values in loop_rows[0].items()}
    loop = _write_clip(loop_name, loop_rows, loop_name, 1, loop_name, 1, loop=True)
    loop['body_context'] = state
    conform_expression(loop_name)
    thoughtful = _snapshot(loop_name, 1)
    enter_name = prefix + 'ToThink'; exit_name = prefix + 'ThinkToBody'
    entering = _transition_rows(source, thoughtful, THINK_TRANSITION_FRAMES)
    exiting = list(reversed(entering))
    enter = _write_clip(enter_name, entering, source_name, source_frame, loop_name, 1)
    leave = _write_clip(exit_name, exiting, loop_name, 1, source_name, source_frame)
    conform_expression(enter_name); conform_expression(exit_name)
    for action in (enter, leave):
        action['body_context'] = state
    return {enter_name: enter, loop_name: loop, exit_name: leave}


def _head_deformation(rig, clip, frame):
    _sample(rig, clip, frame)
    return rig.matrix_world @ rig.pose.bones['head'].matrix @ rig.data.bones['head'].matrix_local.inverted()


def _context_transform(row, deformation, amount):
    """Move the ready-shaped expansion mesh from the current head to the lens.

    Shape keys interpolate inside object space. A rigid, positive-scale object
    transform follows the source head at zero expansion, then relaxes to the
    canonical full-face basis. No new shape target or vertex is needed.
    """
    location, rotation, scale = deformation.decompose()
    amount = _smooth(amount)
    transform = Matrix.LocRotScale(location * (1 - amount),
                                   rotation.slerp(IDENTITY, amount),
                                   scale.lerp(Vector((1, 1, 1)), amount))
    loc = Vector(tuple(row.get(('location', i), 0.) for i in range(3)))
    from mathutils import Euler
    rot = Euler(tuple(row.get(('rotation_euler', i), 0.) for i in range(3)), 'XYZ')
    size = Vector(tuple(row.get(('scale', i), 1.) for i in range(3)))
    matrix = transform @ Matrix.LocRotScale(loc, rot.to_quaternion(), size)
    loc, rot, size = matrix.decompose()
    result = dict(row)
    for path, values in [('location', loc), ('rotation_euler', rot.to_euler('XYZ')), ('scale', size)]:
        for i in range(3):
            result[(path, i)] = float(values[i])
    return result


def _build_face(rig, state, settings, ready_head):
    prefix = settings['prefix']; source_name = settings['activity']; source_frame = settings['frame']
    source = _snapshot(source_name, source_frame)
    target = _snapshot('FullFaceIdle', 1)
    ready_face = _snapshot('ReadyIdle', 1)
    deformation = _head_deformation(rig, source_name, source_frame) @ ready_head.inverted()
    rows = []
    for frame in range(1, FACE_FRAMES + 1):
        canonical = _snapshot('ReadyToFace', frame)
        expand = canonical['DisplayHeadShape'][('key_blocks["Expand"].value', 0)]
        # The face reaches its final size on frame 30. Only after this is the
        # entire room covered; underlying transforms resolve on frames31..39.
        covered = _smooth((frame - 31) / 8)
        row = {owner: _mix(source[owner], target[owner], covered) for owner in source}
        for owner in row:
            if owner.startswith('Display'):
                row[owner] = dict(canonical[owner])
                if owner in ('DisplayHead', 'DisplayEyeL', 'DisplayEyeR', 'DisplaySmile'):
                    row[owner] = _context_transform(row[owner], deformation, expand)
            elif owner in FACE_OBJECTS:
                # Open sleepy/whistling pixels before their neutral display
                # counterpart appears, then keep them covered by that display.
                row[owner] = _mix(source[owner], ready_face[owner], _smooth((frame - 1) / 4))
                row[owner] = _mix(row[owner], target[owner], covered)
        if frame == 1:
            row = {owner: dict(values) for owner, values in source.items()}
        elif frame == FACE_FRAMES:
            row = {owner: dict(values) for owner, values in target.items()}
        rows.append(row)
    enter_name = prefix + 'ToFace'; exit_name = 'FaceTo' + prefix
    entering = _write_clip(enter_name, rows, source_name, source_frame, 'FullFaceIdle', 1)
    leaving = _write_clip(exit_name, list(reversed(rows)), 'FullFaceIdle', 1, source_name, source_frame)
    for action in (entering, leaving):
        action['body_context'] = state
        action['panels_occluded_after_frame'] = 31
        action['note'] = 'Same panel objects and content persist. Occluded after expansion; restored before reveal.'
    conform_expression(enter_name); conform_expression(exit_name)
    return {enter_name: entering, exit_name: leaving}


def build_context_states(rig, contexts=None):
    """Return ``(actions, metadata)`` after adding the context-specific clips.

    Call after the dual-panel idle Actions exist. ``contexts`` may be a mapping
    with the same schema as CONTEXTS to author/validate a subset independently.
    All 98 established owners must have companions on each source activity.
    The caller saves/exports the scene and incorporates metadata into its state
    manifest; this function performs no filesystem writes.
    """
    global _ACTIONS
    _ACTIONS = {action.name: action for action in bpy.data.actions}
    if rig.name != 'MERLIN_Rig' or rig.type != 'ARMATURE':
        raise ValueError('The original MERLIN armature is required.')
    contexts = CONTEXTS if contexts is None else contexts
    owner_ids = [owner for owner, _ in support.owners()]
    if len(owner_ids) != 98 or len(set(owner_ids)) != 98:
        raise ValueError('Context routes require the existing 98 unique animation owners.')
    original = rig.animation_data.action
    original_time = bpy.context.scene.frame_current_final
    ready = _sample(rig, 'ReadyIdle', 1)
    ready_head = _head_deformation(rig, 'ReadyIdle', 1)
    references = [_sample(rig, 'BodyThink', frame) for frame in range(1, 145)]
    mirrored = [_reflect_pose(rig, 'BodyThink', frame) for frame in range(1, 145)] if 'toss' in contexts else []
    actions = {}; states = {}; routes = []; context_meta = {}; state_updates = {}
    for state, settings in contexts.items():
        prefix = settings['prefix']
        restored_state = settings.get('rest', state)
        if settings.get('rest'):
            held = _snapshot(settings['activity'], settings['frame'])
            name = settings['paused']
            actions[name] = _write_clip(name, [held] * 96, settings['activity'],
                                       settings['frame'], settings['activity'],
                                       settings['frame'], loop=True)
            states[restored_state] = {
                'label': 'Walk endpoint' if state == 'walk' else 'Reverse walk endpoint',
                'idle': name, 'exit': settings['exit'], 'parent': 'ready',
                'bodyContext': restored_state,
            }
            state_updates[state] = {'rest': restored_state}
        if settings.get('thinking', True):
            actions.update(_build_thinking(rig, state, settings, references, mirrored, ready))
            thought_state = state + 'Think'
            states[thought_state] = {
                'label': state.replace('seated', 'Seated ') + ' · thinking',
                'enter': prefix + 'ToThink', 'idle': prefix + 'Thinking',
                'exit': prefix + 'ThinkToBody', 'parent': restored_state,
                'bodyContext': restored_state, 'contextualThinking': True,
            }
        actions.update(_build_face(rig, state, settings, ready_head))
        routes.extend([
            {'from': restored_state, 'to': 'face', 'clip': prefix + 'ToFace', 'context': restored_state},
            {'from': 'face', 'to': restored_state, 'clip': 'FaceTo' + prefix, 'context': restored_state},
        ])
        if restored_state != state:
            # These explicit edges also make static graph validation possible;
            # runtime waits for the walk then substitutes its endpoint state.
            routes.extend([
                {'from': state, 'to': 'face', 'clip': prefix + 'ToFace', 'context': restored_state},
                {'from': state, 'to': state + 'Think', 'clip': prefix + 'ToThink'},
            ])
        context_meta[state] = {'activity': settings['activity'], 'frame': settings['frame'],
                               'thinking': states.get(state + 'Think', {}).get('idle'),
                               'toFace': prefix + 'ToFace', 'fromFace': 'FaceTo' + prefix}
        print('MERLIN_CONTEXT_READY', state, flush=True)
    if original:
        # Restore the complete set, not just the armature, after authoring.
        support.apply_activity(bpy.context.scene, original.name, original_time)
    return actions, {'contexts': context_meta, 'states': states, 'routes': routes,
                     'stateUpdates': state_updates}

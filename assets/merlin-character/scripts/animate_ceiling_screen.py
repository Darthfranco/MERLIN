"""A springing ceiling grab and a large, reusable live-content screen.

Only new animation Actions are created. The right card's original geometry,
UVs, material and screen identity are retained, including during conversion to
the left card. The robot moves toward the camera, never changes proportions.
"""
from math import cos, pi, sin

import bpy
from mathutils import Matrix, Vector

from animate_character import _ramp, _smooth
from animate_casual import _limb, _move_root, _pose, _rotation, _set_pose
from animate_transitions import (_apply, _blend, _capture, _clearance, _context,
                                 _crouch, _sample)
from animate_panel import panel_owners, PANEL_WIDTH, PANEL_HEIGHT
from animate_left_panel import left_panel_owners
from expressive_face import conform_expression
from room_support import FACE_OBJECTS
import animate_context_states as contexts

WIDTH = 9.65
HEIGHT = 6.80
CENTER = Vector((0., -2.80, 3.60))
ROBOT_Y = -4.10
FRAMES = {'ReadyToCeiling': 168, 'CeilingIdle': 96,
          'CeilingToLeftPanel': 132, 'CeilingToRightPanel': 132,
          'CeilingToReady': 144}
HANDOFF_FRAME = 126
GRAB_FRAME = 53
RELEASE_FRAME = 94
_FEET_CACHE = {}


def _copy(snapshot):
    return {owner: dict(values) for owner, values in snapshot.items()}


def _transform(row, location, rotation, scale):
    for path, values in [('location', location), ('rotation_euler', rotation), ('scale', scale)]:
        for i in range(3):
            row[(path, i)] = float(values[i])


def _shift_pose(rig, pose, context, offset):
    _apply(rig, pose)
    _move_root(rig, offset, context[1])
    return _capture(rig)


def _foot_positions(rig, pose):
    signature = tuple(value for name in ('root', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R')
                      for channel in pose[name] for value in channel)
    if signature in _FEET_CACHE:
        return {side: position.copy() for side, position in _FEET_CACHE[signature].items()}
    _apply(rig, pose)
    positions = {side: rig.pose.bones['foot.' + side].head.copy() for side in ('L', 'R')}
    _FEET_CACHE[signature] = positions
    return {side: position.copy() for side, position in positions.items()}


def _travel(rig, start, finish, frame, length, context):
    """Several short alternating footfalls carry the body through depth."""
    basis, _, _ = context
    u = max(0., min(1., (frame - 1) / max(1, length - 1)))
    if u == 0.: return start
    if u == 1.: return finish
    first_feet = _foot_positions(rig, start)
    last_feet = _foot_positions(rig, finish)
    pose = _blend(start, finish, _smooth(u))
    _apply(rig, pose)
    rotation = rig.pose.bones['root'].matrix.to_3x3() @ basis['root'].inverted()
    envelope = sin(pi * u)
    for side, sign in [('L', 1), ('R', -1)]:
        position = first_feet[side].copy()
        # Three strides per foot, with distinct planted and lifted phases.
        for begin in (.02 + (0 if side == 'L' else .12),
                      .31 + (0 if side == 'L' else .12),
                      .60 + (0 if side == 'L' else .12)):
            end = min(.98, begin + .21)
            future = min(1., end + .11)
            target = first_feet[side].lerp(last_feet[side], _smooth(future))
            if u < begin: break
            if u <= end:
                t = (u - begin) / (end - begin)
                position = position.lerp(target, _smooth(t))
                position.z += .13 * sin(pi * t)
                break
            position = target
        if u > .90:
            position = position.lerp(last_feet[side], _smooth((u - .90) / .10))
        hip = rig.pose.bones['thigh.' + side].head.copy()
        _limb(rig, 'thigh.' + side, 'shin.' + side, 'foot.' + side,
              position, hip + rotation @ Vector((sign * .12, -1, 0)),
              rotation, rotation, basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)
    return _capture(rig)


def _gesture(rig, pose, context, amount, side=1):
    """An open, low presentation gesture; hands stay clear of the large head."""
    _apply(rig, pose)
    arm = 'L' if side > 0 else 'R'
    bone = rig.pose.bones['upper_arm.' + arm]
    bone.rotation_euler.y -= side * .34 * amount
    rig.pose.bones['forearm.' + arm].rotation_euler.x -= .28 * amount
    rig.pose.bones['head'].rotation_euler.z -= side * .055 * amount
    bpy.context.view_layer.update()
    _clearance(rig, context)
    return _capture(rig)


def _panel_offset(frame, lift):
    # A brief loaded pause follows the catch. The weight then brings the card
    # down; the final short glide settles after the hands release its edge.
    if frame <= 53: return lift
    if frame <= 62: return lift - .22 * _ramp(frame, 53, 62)
    if frame <= 94: return lift - .22 + (1.90 - lift + .22) * _ramp(frame, 62, 94)
    if frame <= 125: return 1.90 * (1 - _ramp(frame, 94, 125))
    return .045 * sin(pi * _ramp(frame, 125, 141)) * (1 - _ramp(frame, 125, 141))


def _air_pose(rig, context, root, target, reach=1., tuck=1., strain=0.):
    basis, inverse, _ = context
    rig.animation_data.action = None
    p = _pose(); p['root'] = Vector(root)
    p['rotation']['body'] = [4 + 4 * strain, 0, 0]
    p['rotation']['head'] = [-8 - 3 * strain, 0, 0]
    for side, sign in [('L', 1), ('R', -1)]:
        p['rotation']['upper_arm.' + side] = [-12, -sign * 18, 0]
        p['rotation']['forearm.' + side] = [-22, 0, 0]
        p['rotation']['thigh.' + side] = [-19 * tuck, sign * 3, 0]
        p['rotation']['shin.' + side] = [38 * tuck, 0, 0]
        p['rotation']['foot.' + side] = [-14 * tuck, 0, 0]
    _set_pose(rig, p, basis, inverse)
    for side, sign in [('L', 1), ('R', -1)]:
        shoulder = rig.pose.bones['upper_arm.' + side].head.copy()
        hand = rig.pose.bones['hand.' + side].head.copy()
        # Opening the hands around the shell before reaching the edge avoids
        # a straight palm trajectory crossing the head during the ascent.
        grip = Vector(target) + Vector((sign * (1.22 + .30 * sin(pi * reach)), -.14, -.08))
        _limb(rig, 'upper_arm.' + side, 'forearm.' + side, 'hand.' + side,
              hand.lerp(grip, reach), shoulder + Vector((sign * .72, -.28, -.05)),
              Matrix.Identity(3), _rotation(x=165 * reach, z=sign * 12 * reach), basis)
    if root[2] < .20:
        # Compression belongs in the knees. A floor correction to a straight
        # leg would lift the whole torso and break the palms' edge contact.
        for side, sign in [('L', 1), ('R', -1)]:
            hip = rig.pose.bones['thigh.' + side].head.copy()
            _limb(rig, 'thigh.' + side, 'shin.' + side, 'foot.' + side,
                  Vector((sign * .36, root[1] - .12, .25)),
                  hip + Vector((sign * .14, -1, 0)), Matrix.Identity(3),
                  Matrix.Identity(3), basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)
    return _capture(rig)


def _jump_pose(rig, frame, context, ready, crouch, foreground, up, bottom, lift):
    if frame <= 15:
        return _gesture(rig, ready, context, .2 * sin(pi * _ramp(frame, 1, 15)))
    if frame <= 29:
        return _blend(ready, crouch, _ramp(frame, 15, 29))
    edge = bottom + up * _panel_offset(frame, lift)
    grip_root = Vector((0., edge.y - .44, edge.z - 2.43))
    if frame <= 53:
        u = (frame - 29) / 24
        apex = bottom + up * lift
        root = Vector((0., (apex.y - .44) * _smooth(u),
                       -.43 + (apex.z - 2.43 + .43) * (2 * u - u * u)))
        reach = _ramp(frame, 40, 53)
        pose = _air_pose(rig, context, root, edge, reach, sin(pi * u / 2), 0.)
        return _blend(crouch, pose, _ramp(frame, 29, 35))
    if frame <= 94:
        strain = _ramp(frame, 53, 62) * (1 - _ramp(frame, 81, 94))
        tuck = .8 * (1 - _ramp(frame, 73, 91))
        return _air_pose(rig, context, grip_root, edge, 1., tuck, strain)
    # Land with compression first, then take a short step into the foreground.
    released_edge = bottom + up * _panel_offset(94, lift)
    source = _air_pose(rig, context, (0, released_edge.y - .44, released_edge.z - 2.43),
                       released_edge, 1., 0., 0.)
    landing = _shift_pose(rig, crouch, context, (0, released_edge.y - .44, 0))
    if frame <= 104:
        return _blend(source, landing, _ramp(frame, 94, 104))
    if frame <= 130:
        standing = _shift_pose(rig, ready, context, (0, released_edge.y - .44, 0))
        return _blend(landing, standing, _ramp(frame, 104, 130))
    if frame <= 158:
        standing = _shift_pose(rig, ready, context, (0, released_edge.y - .44, 0))
        return _travel(rig, standing, foreground, frame - 130, 28, context)
    return foreground


def _expression(row, frame, length, clip):
    envelope = _ramp(frame, 1, 8) * (1 - _ramp(frame, length - 8, length))
    blink = max(0., 1 - abs(frame - (145 if clip == 'ReadyToCeiling' else 55)) / 3)
    for owner in FACE_OBJECTS:
        for channel in row[owner]:
            path, _ = channel
            if 'DisplayConform' in path: continue
            if 'Blink' in path: row[owner][channel] = blink * envelope
            if clip == 'ReadyToCeiling':
                if 'GazeUp' in path: row[owner][channel] = .85 * _ramp(frame, 4, 13) * (1 - _ramp(frame, 85, 112))
                if 'Focus' in path: row[owner][channel] = .40 * _ramp(frame, 49, 59) * (1 - _ramp(frame, 92, 115))
                if 'Concentrate' in path: row[owner][channel] = .52 * _ramp(frame, 50, 61) * (1 - _ramp(frame, 91, 113))
                if 'SmileWide' in path: row[owner][channel] = .38 * _ramp(frame, 122, 136) * (1 - _ramp(frame, 153, 168))
            elif 'ToLeftPanel' in clip and 'GazeLeft' in path:
                row[owner][channel] = .40 * envelope
            elif 'ToRightPanel' in clip and 'GazeRight' in path:
                row[owner][channel] = .40 * envelope


def build_ceiling_screen(rig):
    """Return five new performances and additive manifest metadata."""
    contexts._ACTIONS = {action.name: action for action in bpy.data.actions}
    _FEET_CACHE.clear()
    context = _context(rig)
    ready = _sample(rig, contexts._actions()['ReadyIdle'], 1)
    crouch = _crouch(rig, context)
    foreground = _shift_pose(rig, ready, context, (0, ROBOT_Y, 0))
    initial = contexts._snapshot('ReadyIdle', 1)
    camera = bpy.context.scene.camera
    rotation = camera.rotation_euler.copy()
    up = camera.matrix_world.to_3x3() @ Vector((0, 1, 0))
    bottom = CENTER - up * HEIGHT / 2
    center_projection = (CENTER - Vector((0, 0, 2.5))).dot(up)
    half_height = camera.data.ortho_scale * 3 / 8
    lift = half_height + .18 - (center_projection - HEIGHT / 2)
    card = next(owner for owner, obj in panel_owners() if obj['panel_kind'] == 'card')
    left_card = next(owner for owner, obj in left_panel_owners() if obj['panel_kind'] == 'card')
    scale = Vector((WIDTH / PANEL_WIDTH, HEIGHT / PANEL_HEIGHT, 1.))
    actions = {}

    # Body and face keep their accepted breathing loop in the nearer position.
    rows = []
    for f in range(1, FRAMES['CeilingIdle'] + 1):
        row = contexts._snapshot('ReadyIdle', f)
        pose = _shift_pose(rig, _sample(rig, contexts._actions()['ReadyIdle'], f), context, (0, ROBOT_Y, 0))
        row['rig'] = contexts._pose_row(pose, row['rig'], rows[-1]['rig'] if rows else None)
        _transform(row[card], CENTER, rotation, scale)
        rows.append(row)
    rows[-1] = _copy(rows[0])
    actions['CeilingIdle'] = contexts._write_clip('CeilingIdle', rows, 'CeilingIdle', 1, 'CeilingIdle', 1, loop=True)
    print('MERLIN_CEILING_CLIP', 'CeilingIdle', FRAMES['CeilingIdle'], flush=True)
    ceiling = contexts._snapshot('CeilingIdle', 1)

    for name in ['ReadyToCeiling', 'CeilingToLeftPanel', 'CeilingToRightPanel', 'CeilingToReady']:
        length = FRAMES[name]
        target_name = ('CeilingIdle' if name == 'ReadyToCeiling' else
                       'LeftPanelIdle' if name == 'CeilingToLeftPanel' else
                       'PanelIdle' if name == 'CeilingToRightPanel' else 'ReadyIdle')
        source_name = 'ReadyIdle' if name == 'ReadyToCeiling' else 'CeilingIdle'
        source = initial if name == 'ReadyToCeiling' else ceiling
        target = contexts._snapshot(target_name, 1)
        target_pose = _sample(rig, contexts._actions()[target_name], 1)
        rows = []
        for f in range(1, length + 1):
            u = _ramp(f, 1, length)
            row = {owner: contexts._mix(source[owner], target[owner], u) for owner in source}
            if name == 'ReadyToCeiling':
                pose = _jump_pose(rig, f, context, ready, crouch, foreground, up, bottom, lift)
                _transform(row[card], CENTER + up * _panel_offset(f, lift), rotation, scale)
                if f == 1: row[card] = dict(initial[card])
            elif name == 'CeilingToReady':
                t = _ramp(f, 19, 76)
                _transform(row[card], CENTER + up * (lift * t), rotation, scale)
                if f >= 77: row[card] = dict(target[card])
                pose = _travel(rig, foreground, target_pose, max(1, min(102, f - 25)), 102, context)
                if f < 25: pose = _gesture(rig, pose, context, sin(pi * _ramp(f, 1, 25)))
            else:
                t = _ramp(f, 17, 115)
                destination = target[left_card if name == 'CeilingToLeftPanel' else card]
                for channel in row[card]:
                    row[card][channel] = ceiling[card][channel] * (1 - t) + destination[channel] * t
                # Clear the walking route early in depth. Keeping depth tied
                # to width would let a trailing boot pass behind the card.
                depth = _ramp(f, 9, 57)
                depth_y = ceiling[card][('location', 1)] * (1 - depth) + 1.40 * depth
                settle = _ramp(f, 96, 120)
                row[card][('location', 1)] = depth_y * (1 - settle) + destination[('location', 1)] * settle
                height = _ramp(f, 17, 57)
                for channel in [('location', 2), ('scale', 1)]:
                    row[card][channel] = ceiling[card][channel] * (1 - height) + destination[channel] * height
                if name == 'CeilingToLeftPanel':
                    row[left_card] = dict(target[left_card])
                    for i in range(3): row[left_card][('scale', i)] = 0.
                    if f >= HANDOFF_FRAME:
                        row[card] = dict(target[card]); row[left_card] = dict(target[left_card])
                pose = _travel(rig, foreground, target_pose, max(1, min(106, f - 10)), 106, context)
                if f <= 27:
                    pose = _gesture(rig, pose, context, .75 * sin(pi * _ramp(f, 1, 27)),
                                    -1 if name == 'CeilingToLeftPanel' else 1)
            _apply(rig, pose); _clearance(rig, context); pose = _capture(rig)
            row['rig'] = contexts._pose_row(pose, source['rig'], rows[-1]['rig'] if rows else None)
            _expression(row, f, length, name)
            if f == 1: row = _copy(source)
            if f == length: row = _copy(target)
            rows.append(row)
        action = contexts._write_clip(name, rows, source_name, 1, target_name, 1)
        actions[name] = action
        conform_expression(name)
        # Restore literal face endpoint channels after conformity is baked.
        for owner in FACE_OBJECTS:
            for curve in contexts._action(name, owner).fcurves:
                channel = (curve.data_path, curve.array_index)
                curve.keyframe_points[0].co.y = source[owner][channel]
                curve.keyframe_points[-1].co.y = target[owner][channel]
        if name == 'CeilingToLeftPanel':
            # One atomic owner handoff. Interpolation must not briefly shrink
            # the outgoing card while the incoming card becomes visible.
            for owner in (card, left_card):
                for curve in contexts._action(name, owner).fcurves:
                    for key in curve.keyframe_points:
                        if abs(key.co.x - (HANDOFF_FRAME - 1)) < .01:
                            key.interpolation = 'CONSTANT'
            action['screen_handoff_frame'] = HANDOFF_FRAME
        if name == 'ReadyToCeiling':
            action['panel_grab_frame'] = GRAB_FRAME
            action['panel_release_frame'] = RELEASE_FRAME
            for frame, label in {1: 'Ready', 15: 'Look up', 29: 'Anticipation',
                    53: 'Catch ceiling', 62: 'Loaded pause', 77: 'Weighty pull',
                    94: 'Release edge', 104: 'Absorb landing', 130: 'Rise',
                    168: 'Present screen'}.items():
                action.pose_markers.new(label).frame = frame
        print('MERLIN_CEILING_CLIP', name, length, flush=True)

    metadata = {
        'states': {'ceiling': {'label': 'Ceiling screen', 'enter': 'ReadyToCeiling',
            'idle': 'CeilingIdle', 'exit': 'CeilingToReady', 'parent': 'ready'}},
        'routes': [{'from': 'ceiling', 'to': 'left', 'clip': 'CeilingToLeftPanel'},
                   {'from': 'ceiling', 'to': 'right', 'clip': 'CeilingToRightPanel'}],
        'ceiling_screen': {'surface': 'right', 'width': WIDTH, 'height': HEIGHT,
            'center': list(CENTER), 'robot_foreground_y': ROBOT_Y,
            'left_handoff_frame': HANDOFF_FRAME,
            'content_handoff': 'Copy right content to left before CeilingToLeftPanel starts.'},
    }
    return actions, metadata

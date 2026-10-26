"""Baked routes between MERLIN's casual activities and a centered ready pose.

The first and last poses are literal samples of the connected actions.  Every
interior frame is authored in Blender with quaternion blending, two-bone foot
IK, and mesh-based floor/wall clearance; runtime constraints are unnecessary.
``bake_return`` can start at any actual activity playhead, including an original
Wave or Jump. Ball catches and expression synchronization are handled by the
room's transition controller rather than by this rig-only module.
"""
from math import cos, pi, sin
import json

import bpy
from mathutils import Matrix, Vector

from animate_character import BONE_NAMES, _ramp, _smooth
from animate_casual import (_extreme, _limb, _move_root, _pose, _rig_points,
                            _rotation, _set_pose)

READY = {'activity': 'ReadyIdle', 'frame': 1, 'position': [0, 0, 0],
         'facing': [0, -1, 0], 'matches': 'Idle:1'}
TRANSITION_GUIDE = {
    'ReadyIdle': {'frames': 96, 'loop': True, 'source_activity': 'Idle', 'source_frame': 1,
                  'target_activity': 'Idle', 'target_frame': 96,
                  'poses': {1: 'Ready', 25: 'Breathe', 73: 'Breathe', 96: 'Ready'}},
}
for _activity, _last in [('Nap', 192), ('WallToss', 240), ('WalkWhistle', 192)]:
    TRANSITION_GUIDE['ReadyTo' + _activity] = {
        'frames': 96, 'loop': False, 'source_activity': 'ReadyIdle', 'source_frame': 1,
        'target_activity': _activity, 'target_frame': 1,
        'poses': {1: 'Ready', 22: 'Depart', 50: 'Move', 78: 'Settle', 96: _activity},
    }
    TRANSITION_GUIDE[_activity + 'ToReady'] = {
        'frames': 108, 'loop': False, 'source_activity': _activity, 'source_frame': _last,
        'target_activity': 'ReadyIdle', 'target_frame': 1, 'wave_start': 60, 'wave_end': 108,
        'poses': {1: _activity, 22: 'Return', 44: 'Arrive', 60: 'Face forward',
                  76: 'Hello', 90: 'Wave', 108: 'Ready'},
    }
TRANSITION_GUIDE['ReadyToNap']['poses'] = {1:'Ready', 27:'Kneel', 50:'Lower', 78:'Rest', 96:'Nap'}
TRANSITION_GUIDE['NapToReady']['poses'] = {
    1:'Wake', 12:'Plant hand', 20:'Push from side', 32:'Gather feet',
    41:'Compress', 48:'Hop', 56:'Absorb landing', 76:'Hello', 108:'Ready'}
TRANSITION_GUIDE['NapToReady']['wake_phases'] = {
    'stir':[1,8], 'hand_support':[12,20], 'gather_feet':[14,35],
    'compress':[35,41], 'hop':[42,54], 'landing':[54,59], 'wave':[60,108]}

TRANSITION_GUIDE['ReadyToWallToss'].update(ball_reveal_start=76, ball_reveal_end=90)
TRANSITION_GUIDE['WallTossToReady'].update(ball_stow_start=5, ball_stow_end=16)


def _capture(rig):
    return {name: (rig.pose.bones[name].location.copy(),
                   rig.pose.bones[name].rotation_euler.to_quaternion(),
                   rig.pose.bones[name].scale.copy()) for name in BONE_NAMES}


def _apply(rig, pose):
    # Editing pose channels with a pending Action evaluation can silently restore
    # the previous playhead during depsgraph update. Author with animation muted.
    rig.animation_data.action = None
    for name, (location, rotation, scale) in pose.items():
        bone = rig.pose.bones[name]
        bone.rotation_mode = 'XYZ'
        bone.location = location
        bone.rotation_euler = rotation.to_euler('XYZ', bone.rotation_euler)
        bone.scale = scale
    bpy.context.view_layer.update()


def _blend(a, b, amount):
    amount = max(0., min(1., amount))
    return {name: (a[name][0].lerp(b[name][0], amount),
                   a[name][1].slerp(b[name][1], amount), Vector((1, 1, 1)))
            for name in BONE_NAMES}


def _sample(rig, action, frame):
    action = bpy.data.actions[action] if isinstance(action, str) else action
    rig.animation_data.action = action
    whole = int(frame)
    bpy.context.scene.frame_set(whole, subframe=float(frame) - whole)
    bpy.context.view_layer.update()
    return _capture(rig)


def _context(rig):
    basis = {n: rig.data.bones[n].matrix_local.to_3x3().normalized() for n in BONE_NAMES}
    return basis, {n: matrix.inverted() for n, matrix in basis.items()}, _rig_points(rig)


def _clearance(rig, context):
    """Keep actual rigid shells clear of floor and side walls while blending."""
    _, inverse, clouds = context
    bottom = _extreme(rig, clouds, 2)
    if bottom < .033:
        _move_root(rig, (0, 0, .033 - bottom), inverse)
    left = _extreme(rig, clouds, 0)
    right = _extreme(rig, clouds, 0, maximum=True)
    shift = max(0., -4.475 - left) + min(0., 4.475 - right)
    if abs(shift) > 1e-8:
        _move_root(rig, (shift, 0, 0), inverse)


def sample_ready(rig, frame=1):
    """Return a ready sample without altering the selected action or playhead."""
    original, time = rig.animation_data.action, bpy.context.scene.frame_current
    pose = _sample(rig, 'Idle', frame)
    rig.animation_data.action = original
    bpy.context.scene.frame_set(time)
    return pose


def _crouch(rig, context):
    rig.animation_data.action = None
    basis, inverse, _ = context
    p = _pose()
    p['root'] = Vector((0, 0, -.43))
    p['rotation']['body'] = [13, 0, 0]
    p['rotation']['head'] = [-9, 0, 0]
    for side, sign in [('L', 1), ('R', -1)]:
        p['rotation']['upper_arm.' + side] = [-30, -sign * 17, 0]
        p['rotation']['forearm.' + side] = [-43, -sign * 4, 0]
    _set_pose(rig, p, basis, inverse)
    for side, sign in [('L', 1), ('R', -1)]:
        hip = rig.pose.bones['thigh.' + side].head.copy()
        _limb(rig, 'thigh.' + side, 'shin.' + side, 'foot.' + side,
              Vector((sign * .36, -.12, .25)), hip + Vector((sign * .16, -1, 0)),
              Matrix.Identity(3), Matrix.Identity(3), basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)
    return _capture(rig)


def _nap_hands_down(rig, nap, context):
    """Move the hands from the cushion pose to the floor beside the torso."""
    basis, _, _ = context
    _apply(rig, nap)
    for side, sign in [('L', 1), ('R', -1)]:
        shoulder = rig.pose.bones['upper_arm.' + side].head.copy()
        target = shoulder + Vector((.32, sign * .28, -.14))
        pole = shoulder + Vector((.25, sign * .65, .15))
        root_rotation = rig.pose.bones['root'].matrix.to_3x3() @ basis['root'].inverted()
        _limb(rig, 'upper_arm.' + side, 'forearm.' + side, 'hand.' + side,
              target, pole, root_rotation, _rotation(z=sign * 25), basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)
    return _capture(rig)


def _wake_up(rig, source, ready, frame, context):
    """Weight-led recovery: brace, gather feet, push, hop and absorb the landing.

    The pelvis is the turning pivot instead of the floor origin. One palm and
    the heels support the early rise; each foot then steps beneath the body on
    its own arc. All targets are baked to the original unstretched rigid rig.
    """
    basis, inverse, _ = context
    crouch = _crouch(rig, context)
    if frame >= 42:
        # Fast extension, a brief tucked airborne pose, and an articulated
        # landing replace the old linear float directly into standing.
        if frame <= 48:
            pose = _blend(crouch, ready, .82 * _ramp(frame, 41, 47))
        elif frame <= 54:
            pose = _blend(crouch, ready, .82 - .18 * _ramp(frame, 48, 54))
        else:
            pose = _blend(crouch, ready, .64 + .36 * _ramp(frame, 54, 59))
        _apply(rig, pose)
        height = .29 * max(0., sin(pi * (frame - 41) / 13))
        _move_root(rig, (0, 0, height), inverse)
        foot_width = .36 - .03 * _ramp(frame, 41, 59)
        for side, sign in [('L',1),('R',-1)]:
            hip = rig.pose.bones['thigh.' + side].head.copy()
            _limb(rig, 'thigh.' + side, 'shin.' + side, 'foot.' + side,
                  Vector((sign*foot_width, -.12, .25 + height)),
                  hip + Vector((sign*.16,-1,0)), Matrix.Identity(3),
                  Matrix.Identity(3), basis)
        bpy.context.view_layer.update()
        return _capture(rig)

    _apply(rig, source)
    original_pivot = rig.pose.bones['body'].head.copy()
    original_rotation = (rig.pose.bones['root'].matrix.to_3x3()
                         @ basis['root'].inverted()).to_quaternion()
    old_hands = {side: rig.pose.bones['hand.' + side].head.copy() for side in ('L','R')}
    old_elbows = {side: rig.pose.bones['forearm.' + side].head.copy() for side in ('L','R')}
    old_feet = {side: rig.pose.bones['foot.' + side].head.copy() for side in ('L','R')}
    old_poles = {side: rig.pose.bones['shin.' + side].head.copy() for side in ('L','R')}
    old_foot_rotations = {
        side:(rig.pose.bones['foot.' + side].matrix.to_3x3()
              @ basis['foot.' + side].inverted()).to_quaternion() for side in ('L','R')}
    old_hand_rotations = {
        side:(rig.pose.bones['hand.' + side].matrix.to_3x3()
              @ basis['hand.' + side].inverted()).to_quaternion() for side in ('L','R')}

    rise = .09 * _ramp(frame, 6, 13) + .91 * _ramp(frame, 13, 35)
    rotation = original_rotation.slerp(Matrix.Identity(3).to_quaternion(), rise).to_matrix()
    pivot = original_pivot.lerp(Vector((0,0,.87)), _ramp(frame, 10, 35))
    # A small first shift onto the camera-side palm reads as weight transfer.
    pivot.y -= .055 * _ramp(frame, 6, 13) * (1 - _ramp(frame, 20, 34))
    pivot.z -= .055 * _ramp(frame, 6, 13) * (1 - _ramp(frame, 24, 35))
    pivot.z -= .065 * _ramp(frame, 35, 41)
    pose = _blend(source, crouch, rise)
    _apply(rig, pose)
    root = rig.pose.bones['root']
    root.rotation_euler = (inverse['root'] @ rotation @ basis['root']).to_euler('XYZ', root.rotation_euler)
    root.location = inverse['root'] @ (pivot - rotation @ rig.data.bones['body'].head_local)
    bpy.context.view_layer.update()
    # Let the head lead the chest and then recover, instead of remaining locked
    # to the rotating torso throughout the stand-up.
    head_lead = 8 * _ramp(frame, 5, 15) * (1 - _ramp(frame, 22, 34))
    head = rig.pose.bones['head']
    head.rotation_euler.rotate_axis('X', -head_lead * pi / 180)
    bpy.context.view_layer.update()

    for side, sign in [('L',1),('R',-1)]:
        begin, end = (15,34) if side == 'L' else (10,29)
        step = _ramp(frame, begin, end)
        target = old_feet[side].lerp(Vector((sign*.36,-.12,.25)), step)
        if begin < frame < end:
            target.z += .14 * sin(pi*(frame-begin)/(end-begin)) ** 1.4
        hip = rig.pose.bones['thigh.' + side].head.copy()
        pole = old_poles[side].lerp(hip + Vector((sign*.16,-1,0)), rise)
        foot_rotation = old_foot_rotations[side].slerp(Matrix.Identity(3).to_quaternion(), step).to_matrix()
        _limb(rig, 'thigh.' + side, 'shin.' + side, 'foot.' + side,
              target, pole, rotation, foot_rotation, basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)

    for side, sign in [('L',1),('R',-1)]:
        shoulder = rig.pose.bones['upper_arm.' + side].head.copy()
        # The near hand makes firm contact first; the far hand lightly braces
        # beside the torso. Keeping the elbows out clears the oversized head.
        brace = Vector((.04, sign*.76, .215 if side == 'R' else .28))
        target = old_hands[side].lerp(brace, _ramp(frame, 3 if side == 'R' else 6, 12 if side == 'R' else 15))
        release = _ramp(frame, 18 if side == 'R' else 15, 33)
        held = shoulder + Vector((sign*.27,-.24,-.46))
        target = target.lerp(held, release)
        pole = old_elbows[side].lerp(shoulder + Vector((sign*.52,-.12,-.18)),
                                    _ramp(frame,6,18))
        hand_rotation = old_hand_rotations[side].slerp(_rotation(x=-70).to_quaternion(), _ramp(frame,4,12))
        hand_rotation = hand_rotation.slerp(Matrix.Identity(3).to_quaternion(), release).to_matrix()
        _limb(rig, 'upper_arm.' + side, 'forearm.' + side, 'hand.' + side,
              target, pole, rotation, hand_rotation, basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)
    pose = _capture(rig)
    # Gather both arms into the launch pose only after the supporting hand has
    # left the floor, so the pull and push are visible as separate actions.
    pose = _blend(pose, crouch, _ramp(frame, 35, 41))
    _apply(rig, pose)
    # Before the deliberate hop, retain a visible point of support rather than
    # letting simultaneous IK arcs lift the whole robot clear of the floor.
    bottom = _extreme(rig, context[2], 2)
    if bottom > .035:
        _move_root(rig, (0,0,.035-bottom), inverse)
    return _capture(rig)


def _run(rig, start, finish, frame, frames, context):
    """Short eager run with alternating planted targets and a soft torso bob."""
    rig.animation_data.action = None
    basis, inverse, _ = context
    u = max(0., min(1., (frame - 1) / (frames - 1)))
    sign = 1 if finish >= start else -1
    rotation = _rotation(z=sign * 72)
    # A compact integrated velocity ramp keeps the main middle section lively.
    def at(t):
        t = max(0., min(1., t))
        return start + (finish - start) * _smooth(t)
    x = at(u)
    gait = 2 * pi * (frame - 1) / 18
    envelope = sin(pi * u) ** .65
    p = _pose()
    p['root'] = Vector((x, 0, -.10 + .046 * (1 - cos(2 * gait)) * envelope))
    p['root_rotation'] = rotation
    p['rotation']['body'] = [6 * envelope, .9 * sin(gait) * envelope, 2 * sin(gait) * envelope]
    p['rotation']['head'] = [-4 * envelope, 0, -sign * 10]
    for side, side_sign in [('L', 1), ('R', -1)]:
        p['rotation']['upper_arm.' + side] = [-4 + side_sign * 25 * sin(gait) * envelope, -side_sign * 9, 0]
        p['rotation']['forearm.' + side] = [-35 - side_sign * 9 * sin(gait) * envelope, 0, 0]
        p['rotation']['hand.' + side] = [5, 0, 0]
    _set_pose(rig, p, basis, inverse)
    for side, side_sign in [('L', 1), ('R', -1)]:
        offset = rotation @ Vector((side_sign * .33, -.12, 0))
        position = Vector((start + offset.x, offset.y, .25))
        for begin in range(1 + (0 if side == 'L' else 9), frames + 1, 18):
            end = min(frames, begin + 8)
            future = min(frames, end + 4)
            target = Vector((at((future - 1) / (frames - 1)) + offset.x, offset.y, .25))
            if frame < begin:
                break
            if frame <= end and end > begin:
                t = (frame - begin) / (end - begin)
                position = position.lerp(target, _smooth(t))
                position.z += .19 * sin(pi * t) ** 1.2 * envelope
                break
            position = target
        # The final pickup assembles both feet before the turn to face front.
        if u > .82:
            position = position.lerp(Vector((finish + offset.x, offset.y, .25)), _smooth((u - .82) / .18))
        hip = rig.pose.bones['thigh.' + side].head.copy()
        _limb(rig, 'thigh.' + side, 'shin.' + side, 'foot.' + side,
              position, hip + rotation @ Vector((side_sign * .12, -1, 0)),
              rotation, rotation, basis)
    bpy.context.view_layer.update()
    _clearance(rig, context)
    return _capture(rig)


def _key(rig, action, frame, pose, context, exact=False):
    _apply(rig, pose)
    if not exact:
        _clearance(rig, context)
    rig.animation_data.action = action
    for bone in rig.pose.bones:
        for channel in ('location', 'rotation_euler', 'scale'):
            bone.keyframe_insert(channel, frame=frame, group=bone.name)


def _new_action(name, guide):
    previous = bpy.data.actions.get(name)
    if previous:
        previous.name = name + '_previous'
        previous.use_fake_user = False
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    action['fps'] = 24
    for key, value in guide.items():
        action[key] = json.dumps(value) if isinstance(value, dict) else value
    action['preview_frames'] = json.dumps(guide.get('poses', {}))
    return action


def _finish(action, guide):
    for curve in action.fcurves:
        curve.extrapolation = 'CONSTANT'
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
    for frame, label in guide.get('poses', {}).items():
        action.pose_markers.new(label).frame = frame
    return action


def _return(rig, source, source_name, source_frame, name, context):
    ready = _sample(rig, 'Idle', 1)
    wave = {f: _sample(rig, 'Wave', 1 + (f - 60) * 95 / 48) for f in range(60, 109)}
    _apply(rig, source)
    source_x = rig.pose.bones['root'].head.x
    up = rig.pose.bones['root'].matrix.to_3x3() @ rig.data.bones['root'].matrix_local.to_3x3().inverted() @ Vector((0, 0, 1))
    lying = up.z < .55
    guide = dict(TRANSITION_GUIDE.get(name, TRANSITION_GUIDE['NapToReady' if lying else 'WalkWhistleToReady']))
    guide.update(source_activity=source_name, source_frame=source_frame, target_activity='ReadyIdle', target_frame=1)
    action = _new_action(name, guide)
    for frame in range(1, 109):
        if frame == 1:
            pose = source
        elif frame >= 60:
            pose = wave[frame] if frame < 108 else ready
        elif lying:
            pose = _wake_up(rig, source, ready, frame, context)
        elif abs(source_x) < .10:
            pose = _blend(source, ready, _ramp(frame, 1, 40))
        else:
            run_frame = max(1, min(37, frame - 11))
            running = _run(rig, source_x, 0, run_frame, 37, context)
            if frame <= 12:
                pose = _blend(source, running, _ramp(frame, 1, 12))
            elif frame <= 48:
                pose = running
            else:
                pose = _blend(running, ready, _ramp(frame, 48, 59))
        _key(rig, action, frame, pose, context, exact=frame in (1, 108))
    return _finish(action, guide)


def build_transition_actions(rig):
    """Create seven baked actions and select centered ReadyIdle at frame one."""
    if rig.type != 'ARMATURE' or set(BONE_NAMES) - set(rig.pose.bones.keys()):
        raise ValueError('Transitions require the complete MERLIN 15-bone rig.')
    rig.animation_data_create()
    context = _context(rig)
    sources = {name: {f: _sample(rig, name, f) for f in (1, end)}
               for name, end in [('Nap', 192), ('WallToss', 240), ('WalkWhistle', 192)]}
    idle = {f: _sample(rig, 'Idle', f) for f in range(1, 97)}
    ready = idle[1]
    actions = {}
    action = _new_action('ReadyIdle', TRANSITION_GUIDE['ReadyIdle'])
    for frame, pose in idle.items():
        _key(rig, action, frame, pose, context, exact=True)
    actions['ReadyIdle'] = _finish(action, TRANSITION_GUIDE['ReadyIdle'])
    crouch = _crouch(rig, context)
    for activity, end in [('Nap', 192), ('WallToss', 240), ('WalkWhistle', 192)]:
        name = 'ReadyTo' + activity
        guide = TRANSITION_GUIDE[name]
        target = sources[activity][1]
        _apply(rig, target)
        target_x = rig.pose.bones['root'].head.x
        if activity == 'Nap':
            hands_down = _nap_hands_down(rig, target, context)
        action = _new_action(name, guide)
        for frame in range(1, 97):
            if activity == 'Nap':
                if frame <= 30:
                    pose = _blend(ready, crouch, _ramp(frame, 6, 30))
                elif frame <= 78:
                    pose = _blend(crouch, hands_down, _ramp(frame, 30, 78))
                else:
                    pose = _blend(hands_down, target, _ramp(frame, 78, 96))
            else:
                running = _run(rig, 0, target_x, max(1, min(49, frame - 15)), 49, context)
                if frame <= 16:
                    pose = _blend(ready, running, _ramp(frame, 5, 16))
                elif frame <= 64:
                    pose = running
                else:
                    pose = _blend(running, target, _ramp(frame, 64, 96))
            if frame == 1:
                pose = ready
            elif frame == 96:
                pose = target
            _key(rig, action, frame, pose, context, exact=frame in (1, 96))
        actions[name] = _finish(action, guide)
        name = activity + 'ToReady'
        actions[name] = _return(rig, sources[activity][end], activity, end, name, context)
    rig.animation_data.action = actions['ReadyIdle']
    bpy.context.scene.frame_set(1)
    return actions


def bake_return(rig, source_action, source_frame, action_name='ReturnToReady'):
    """Bake a return whose first pose exactly matches an arbitrary playhead.

    Accept a bpy Action or action name. Caller owns expression/prop channels and
    may first advance an in-flight ball to its catch. Returns the new rig Action;
    action metadata records the actual sampled source frame and activity.
    """
    action = bpy.data.actions[source_action] if isinstance(source_action, str) else source_action
    source = _sample(rig, action, source_frame)
    result = _return(rig, source, action.name, source_frame, action_name, _context(rig))
    rig.animation_data.action = result
    bpy.context.scene.frame_set(1)
    return result

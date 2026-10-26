"""Synchronized playback and pose-aware return baking for the Blender character.

This is an authoring helper, not a live assistant integration. Call
build_return_from_activity('WalkWhistle', 76), then apply_activity(scene, name).
An airborne ball finishes its current wall/floor/catch sequence before return.
"""
import json
from math import cos, pi, floor

import bpy
from mathutils import Vector

from room_support import BALL_NAME, FACE_OBJECTS, activity_frame
from animate_character import _smooth


def action_for(name, owner):
    suffix = '' if owner == 'rig' else ' • Ball' if owner == 'ball' else f' • {owner}'
    return bpy.data.actions.get(name + suffix)


def owners():
    return [('rig', bpy.data.objects['MERLIN_Rig'])] + [
        (name, bpy.data.objects[name].data.shape_keys) for name in FACE_OBJECTS
    ] + [('ball', bpy.data.objects[BALL_NAME])]


def apply_activity(scene, name, frame=1):
    action = action_for(name, 'rig')
    if action is None:
        raise ValueError(f'Unknown character action: {name}')
    for owner, datablock in owners():
        datablock.animation_data_create()
        datablock.animation_data.action = action_for(name, owner)
        if owner in FACE_OBJECTS and datablock.animation_data.action is None:
            for key in list(datablock.key_blocks)[1:]:
                key.value = 0
        if owner == 'ball' and datablock.animation_data.action is None:
            datablock.location = (0, 0, -5)
            datablock.scale = (0, 0, 0)
    fade = scene.node_tree.nodes.get('Presentation • scene transitions') if scene.use_nodes else None
    if fade:
        fade.mute = name != 'CasualShowcase'
    if scene.sequence_editor:
        for strip in scene.sequence_editor.sequences_all:
            if strip.type == 'SOUND':
                strip.mute = not (
                    name == 'InteractionShowcase' and strip.name.startswith('Interaction whistle')
                    or name in ('WalkWhistle', 'CasualShowcase') and strip.name == 'Original soft whistle'
                )
    scene.frame_start = 1
    scene.frame_end = round(action.frame_range[1])
    scene['active_activity'] = name
    time = max(1, min(frame, scene.frame_end))
    scene.frame_set(floor(time), subframe=time-floor(time))
    bpy.context.view_layer.update()


def linear(action):
    action.use_fake_user = True
    for curve in action.fcurves:
        curve.extrapolation = 'CONSTANT'
        for key in curve.keyframe_points:
            key.interpolation = 'LINEAR'


def new_action(name):
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old, do_unlink=True)
    return bpy.data.actions.new(name)


def face_at(name, frame):
    values = {}
    for owner in FACE_OBJECTS:
        keys = bpy.data.objects[owner].data.shape_keys
        action = action_for(name, owner)
        values[owner] = {}
        for key in list(keys.key_blocks)[1:]:
            path = key.path_from_id('value')
            curve = action.fcurves.find(path) if action else None
            values[owner][key.name] = curve.evaluate(frame) if curve else 0.
    return values


def ball_at(name, frame):
    action = action_for(name, 'ball')
    values = {'location': Vector((0, 0, -5)), 'rotation_euler': Vector((0, 0, 0)), 'scale': Vector((0, 0, 0))}
    if action:
        for path, value in values.items():
            for i in range(3):
                curve = action.fcurves.find(path, index=i)
                if curve:
                    value[i] = curve.evaluate(frame)
    return values


def _blink(frame, center=73, width=3):
    return .5 + .5*cos(pi*(frame-center)/width) if abs(frame-center) < width else 0.


def build_companions(name, source=None, source_frame=1, target=None, target_frame=1):
    """Bake expression and held toy channels with exact activity endpoints."""
    scene = bpy.context.scene
    rig = bpy.data.objects['MERLIN_Rig']
    action = bpy.data.actions[name]
    length = round(action.frame_range[1])
    start = face_at(source, source_frame) if source else face_at('', 1)
    finish = face_at(target, target_frame) if target else face_at('', 1)
    source_ball = ball_at(source, source_frame) if source else ball_at('', 1)
    target_ball = ball_at(target, target_frame) if target else ball_at('', 1)
    entrance = target in ('Nap', 'WallToss', 'WalkWhistle')
    for owner in FACE_OBJECTS:
        keys = bpy.data.objects[owner].data.shape_keys
        keys.animation_data_create()
        companion = new_action(f'{name} • {owner}')
        keys.animation_data.action = companion
        for frame in range(1, length+1):
            if entrance:
                mix = _smooth((frame-(length-36))/(35))
            else:
                mix = _smooth((frame-1)/16)
            for key in list(keys.key_blocks)[1:]:
                value = start[owner][key.name]*(1-mix)+finish[owner][key.name]*mix
                if key.name == 'Blink' and not entrance and name != 'ReadyIdle':
                    value = max(value, _blink(frame, length-23))
                if key.name == 'Blink' and name == 'ReadyIdle':
                    value = _blink(frame, 57)
                key.value = value
                key.keyframe_insert('value', frame=frame)
        linear(companion)
    ball = bpy.data.objects[BALL_NAME]
    ball.animation_data_create()
    companion = new_action(f'{name} • Ball')
    ball.animation_data.action = companion
    stow_start = action.get('ball_stow_start', 5)
    stow_end = action.get('ball_stow_end', 16)
    reveal_start = action.get('ball_reveal_start', length-20)
    reveal_end = action.get('ball_reveal_end', length-6)
    rest = Vector((.95, -.18, 1.18))
    for frame in range(1, length+1):
        rig.animation_data.action = action
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        hand = rig.matrix_world @ rig.pose.bones['hand.L'].matrix @ rig.data.bones['hand.L'].matrix_local.inverted() @ rest
        amount = (1-_smooth((frame-stow_start)/max(1, stow_end-stow_start)))*source_ball['scale'].x
        amount += _smooth((frame-reveal_start)/max(1, reveal_end-reveal_start))*target_ball['scale'].x
        ball.location = hand if amount > 0 else (0, 0, -5)
        ball.scale = (amount,)*3
        ball.rotation_euler = source_ball['rotation_euler'].lerp(target_ball['rotation_euler'], (frame-1)/max(1, length-1))
        if frame == 1:
            for path, value in source_ball.items():
                setattr(ball, path, value)
        elif frame == length:
            for path, value in target_ball.items():
                setattr(ball, path, value)
        for path in ('location', 'rotation_euler', 'scale'):
            ball.keyframe_insert(path, frame=frame)
    linear(companion)


def compose_clip(name, segments):
    """Join synchronized sampled clips without cuts. Segments use inclusive frames."""
    for owner, _ in owners():
        curves = {}
        offset = 0
        for segment in segments:
            source, start, end = segment[:3]
            duration = segment[3] if len(segment) > 3 else round(end-start)+1
            action = action_for(source, owner)
            if action is None:
                raise ValueError(f'Missing companion action for {source}, {owner}')
            for curve in action.fcurves:
                key = (curve.data_path, curve.array_index)
                values = curves.setdefault(key, [])
                for i in range(duration):
                    f = start+(end-start)*i/max(1, duration-1)
                    values.extend((offset+i+1, curve.evaluate(f)))
            offset += duration
        suffix = '' if owner == 'rig' else ' • Ball' if owner == 'ball' else f' • {owner}'
        action = new_action(name+suffix)
        for (path, index), values in curves.items():
            curve = action.fcurves.new(path, index=index)
            curve.keyframe_points.add(len(values)//2)
            curve.keyframe_points.foreach_set('co', values)
        linear(action)
    action = bpy.data.actions[name]
    action['segments'] = json.dumps(segments)
    action['fps'] = 24
    return action


def build_return_from_activity(activity, source_frame, name='ReturnToReady'):
    """Bake from any current activity pose; preserve a ball already in flight.

    The returned action name is playable with apply_activity. This writes only
    Blender datablocks until the caller explicitly saves/exports the scene.
    """
    from animate_transitions import bake_return
    scene = bpy.context.scene
    rig = bpy.data.objects['MERLIN_Rig']
    if activity == 'CasualShowcase':
        activity, source_frame = activity_frame(activity, source_frame)
    elif activity == 'InteractionShowcase':
        offset = 0
        for segment in json.loads(bpy.data.actions[activity]['segments']):
            clip, start, end = segment[:3]
            duration = segment[3] if len(segment) > 3 else round(end-start)+1
            if source_frame <= offset+duration:
                activity = clip
                source_frame = start+(end-start)*(source_frame-offset-1)/max(1, duration-1)
                break
            offset += duration
    source_action = bpy.data.actions.get(activity)
    if source_action is None:
        raise ValueError(f'Unknown source activity: {activity}')
    source_frame = max(1, min(source_frame, source_action.frame_range[1]))
    exit_frame = source_frame
    if activity == 'WallToss':
        for event in json.loads(scene['ball_events']):
            if event['release'] <= source_frame < event['catch']:
                exit_frame = event['catch']
                break
    temporary = name+' • movement' if exit_frame != source_frame else name
    result = bake_return(rig, source_action, exit_frame, action_name=temporary)
    build_companions(temporary, activity, exit_frame)
    if exit_frame != source_frame:
        action = compose_clip(name, [(activity, source_frame, exit_frame), (temporary, 2, 108)])
        prefix = exit_frame-source_frame
        action['wave_start'] = result.get('wave_start', 60)+prefix
        action['wave_end'] = result.get('wave_end', 108)+prefix
        for owner, _ in owners():
            old = action_for(temporary, owner)
            bpy.data.actions.remove(old, do_unlink=True)
    else:
        action = bpy.data.actions[name]
    action['source_activity'] = activity
    action['source_frame'] = source_frame
    action['catch_before_return'] = exit_frame
    action['target_activity'] = 'ReadyIdle'
    action['target_frame'] = 1
    apply_activity(scene, name, 1)
    return name

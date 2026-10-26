"""Subtle, intent-led facial acting for MERLIN's existing curved display.

Call ``add_expression_shapes()`` once after loading the character, build the
body/prop companions as usual, then ``enhance_expression(clip_name)`` for each
individual clip before composing reels or exporting. The existing cyan shader,
head proportions and neutral face remain unchanged. Every morph channel is
explicitly sampled, so no Blender driver is needed by a glTF viewer.
"""
import json
from math import cos, pi, sin

import bpy
import numpy as np

from room_support import FACE_OBJECTS

EYE_SHAPES = ('GazeLeft', 'GazeRight', 'GazeUp', 'GazeDown', 'Happy', 'Focus')
MOUTH_SHAPES = ('SmileWide', 'Concentrate', 'SoftSmile')
EXPRESSION_VERSION = 1


def _smooth(t):
    t = max(0., min(1., t))
    return t*t*t*(t*(t*6-15)+10)


def _ramp(f, a, b):
    return _smooth((f-a)/max(.001, b-a))


def _hold(f, a, b, c, d):
    return _ramp(f, a, b)*(1-_ramp(f, c, d))


def _pulse(f, center, width=3.):
    return .5+.5*cos(pi*(f-center)/width) if abs(f-center)<width else 0.


def _head_front(x, z):
    inside = max(0., 1-abs(x/1.04)**(2/.65)-abs((z-2.98)/.71)**(2/.65))
    return -.54*inside**(.65/2)


def add_expression_shapes():
    """Add reusable eye-gaze/acting and mouth morphs without replacing geometry.

    GazeLeft/Right refer to the viewer's left/right in the original frontal
    scene. Full gaze is only 0.055 scene units. Each target is projected back
    onto the same head surface as the original face pixels.
    """
    result = {}
    for name in FACE_OBJECTS:
        obj = bpy.data.objects[name]
        if obj.data.shape_keys is None:
            obj.shape_key_add(name='Basis')
        keys = obj.data.shape_keys
        eye = name.startswith('Eye')
        for shape in (EYE_SHAPES if eye else MOUTH_SHAPES)+('DisplayConform',):
            if shape in keys.key_blocks:
                continue
            key = obj.shape_key_add(name=shape)
            for i, vertex in enumerate(key.data):
                co = keys.key_blocks[0].data[i].co
                x, z = co.x, co.z
                if shape == 'DisplayConform':
                    vertex.co = (co.x, co.y-.01, co.z)
                    continue
                if eye:
                    if shape == 'GazeLeft':
                        x -= .055
                    elif shape == 'GazeRight':
                        x += .055
                    elif shape == 'GazeUp':
                        z += .040
                    elif shape == 'GazeDown':
                        z -= .040
                    elif shape == 'Happy':
                        x *= 1.20
                        z = z*.20 + .040*(1-(co.x/.0875)**2)
                    elif shape == 'Focus':
                        z = z*.67-.025
                        # A slight inner tilt conveys concentration, not anger.
                        z -= (1 if obj.location.x > 0 else -1)*co.x*.09
                elif shape == 'SmileWide':
                    x *= 1.16
                    z = 2.827+(z-2.827)*1.10-.004
                elif shape == 'Concentrate':
                    x *= .56
                    z = 2.800+(z-2.800)*.28
                elif shape == 'SoftSmile':
                    x *= .80
                    z = 2.812+(z-2.812)*.76
                # Tiny conservative offset avoids additive morphs intersecting
                # the curved display; there is no raised eyelid or face panel.
                y = _head_front(x+obj.location.x, z+obj.location.z)-.0022-obj.location.y
                vertex.co = (x, y, z)
            key.slider_min, key.slider_max = 0., 1.
        result[name] = [key.name for key in list(keys.key_blocks)[1:]]
    return result


def _values(action, keys, frame):
    result = {}
    for key in list(keys.key_blocks)[1:]:
        curve = action.fcurves.find(key.path_from_id('value')) if action else None
        result[key.name] = float(curve.evaluate(frame)) if curve else 0.
    return result


def _endpoint(action, owner, which, fallback):
    name = action.get(which+'_activity')
    if not name or name == action.name:
        return fallback
    companion = bpy.data.actions.get(f'{name} • {owner}')
    if companion is None:
        return fallback
    keys = bpy.data.objects[owner].data.shape_keys
    return _values(companion, keys, action.get(which+'_frame', 1))


def _profile(name, f, length, owner, base, action):
    """Return sparse acting channels. Unspecified established shapes survive."""
    if name == 'Showcase':
        child, child_frame = ('Wave', f-16) if 17 <= f <= 112 else (('Jump', f-120) if f >= 121 else ('Idle', f))
        child_action = bpy.data.actions.get(child)
        return _profile(child, child_frame, round(child_action.frame_range[1]), owner, base, child_action)
    if name == 'CasualShowcase':
        child, child_frame = ('WalkWhistle', f) if f <= 192 else (('WallToss', f-192) if f <= 432 else ('Nap', f-432))
        child_action = bpy.data.actions.get(child)
        return _profile(child, child_frame, round(child_action.frame_range[1]), owner, base, child_action)
    if action.get('segments'):
        offset = 0
        for segment in json.loads(action['segments']):
            child, start, end = segment[:3]
            duration = segment[3] if len(segment)>3 else round(end-start)+1
            if f <= offset+duration and child != name:
                child_frame = start+(end-start)*(f-offset-1)/max(1, duration-1)
                child_action = bpy.data.actions.get(child)
                return _profile(child, child_frame, round(child_action.frame_range[1]), owner, base, child_action)
            offset += duration
    eye = owner.startswith('Eye')
    side = 1 if owner == 'Eye • L' else -1
    result = {}
    end = length
    source = action.get('source_activity', '')
    target = action.get('target_activity', '')
    returning = target == 'ReadyIdle' or name.endswith('ToReady')
    wake = name == 'NapToReady' or (returning and source == 'Nap')
    # A one-frame offset is perceptible softness without deliberate winking.
    delay = .35 if side > 0 else -.35
    edge = _ramp(f, 1, 9)*(1-_ramp(f, end-8, end))
    gaze_x = gaze_z = happy = focus = wide = soft = effort = blink = 0.

    if name in ('ReadyIdle', 'Idle'):
        blink = _pulse(f, 57+delay, 3.)
        gaze_x = .50*_hold(f, 15, 23, 35, 43)
        gaze_z = .08*_hold(f, 20, 29, 36, 45)
        soft = .08*sin(pi*(f-1)/max(1, end-1))**2
    elif name == 'Wave':
        happy = .78*_hold(f, 9, 22, 67, 89)
        wide = .62*_hold(f, 8, 24, 71, 92)
        blink = _pulse(f, 53+delay, 2.5)
        gaze_z = .10*_hold(f, 15, 29, 63, 83)
    elif name == 'Jump':
        focus = .48*_hold(f, 8, 18, 22, 29)
        effort = .55*_hold(f, 10, 19, 22, 29)
        happy = .42*_hold(f, 27, 34, 45, 56)
        wide = .66*_hold(f, 26, 33, 46, 64)
        blink = .8*_pulse(f, 51+delay, 3.)
        gaze_z = .22*_hold(f, 18, 25, 38, 49)
    elif name == 'ReadyToNap':
        gaze_z = -.42*_hold(f, 9, 18, 48, 66)
        if eye:
            result['Sleepy'] = .58*_hold(f, 9, 22, 65, 83)
            result['Sleep'] = _ramp(f, 62, end-3)
        soft = .6*_hold(f, 14, 30, end-20, end)
        blink = .6*_pulse(f, 29+delay, 4)
    elif name == 'Nap':
        if eye:
            result['Sleep'] = 1.
            result['Sleepy'] = 0.
        else:
            result['SleepSmile'] = 1-.08*sin(pi*(f-1)/max(1, end-1))**2
        # Quiet breathing changes the closed eyelid arcs only very slightly.
        gaze_z = .055*sin(2*pi*(f-1)/max(1, end-1))
    elif wake:
        if eye:
            result['Sleep'] = 1-_ramp(f, 6, 18)
            result['Sleepy'] = .66*_hold(f, 7, 16, 25, 40)
        else:
            result['SleepSmile'] = 1-_ramp(f, 9, 26)
        blink = max(.7*_pulse(f, 22+delay, 3.5), _pulse(f, 33+delay, 2.7))
        gaze_z = -.38*_hold(f, 12, 20, 30, 39) + .18*_hold(f, 37, 43, 49, 57)
        focus = .38*_hold(f, 31, 37, 41, 48)
        effort = .45*_hold(f, 30, 36, 41, 48)
        happy = .35*_hold(f, 46, 55, 90, 104)
        wide = .55*_hold(f, 45, 57, 91, 105)
    elif name == 'WalkWhistle':
        blink = max(_pulse(f, 18+delay), _pulse(f, 91+delay), _pulse(f, 176+delay))
        gaze_x = .25*_hold(f, 8, 16, 68, 80)-.20*_hold(f, 88, 99, 112, 125)
        gaze_z = .14*_hold(f, 30, 46, 136, 156)
        soft = .12*(1-base.get('Whistle', 0))*edge
    elif name == 'WallToss':
        blink = max(_pulse(f, 12+delay), _pulse(f, 115+delay), _pulse(f, 219+delay))
        # Eyes lead the throw and track the catch before the head follows.
        tracking = max(_hold(f, 20, 28, 67, 82), _hold(f, 128, 136, 175, 190))
        gaze_x = .65*tracking
        gaze_z = .22*max(_hold(f, 26, 35, 43, 52), _hold(f, 134, 143, 151, 160))
        happy = .14*max(_hold(f, 81, 88, 98, 107), _hold(f, 189, 196, 206, 215))
        if eye:
            result['Sleepy'] = base.get('Sleepy', 0)*(1-.55*tracking)
    elif name == 'ReadyToPanel':
        grab = float(action.get('panel_grab_frame', 58))
        start = float(action.get('panel_pull_start', 59))
        stop = float(action.get('panel_pull_end', 139))
        gaze_x = .60*_hold(f, 7, 15, stop, stop+12)
        focus = .58*_hold(f, grab-5, start+5, stop-7, stop+8)
        effort = .70*_hold(f, grab, start+6, stop-6, stop+9)
        # Two subtle effort pulses register weight without a vibrating face.
        focus *= .88+.12*cos((f-start)*pi/18)**2
        blink = max(_pulse(f, grab-7+delay), .7*_pulse(f, stop+10+delay, 3.5))
        happy = .34*_hold(f, stop, stop+12, end-14, end-2)
        wide = .35*_hold(f, stop, stop+13, end-14, end-2)
    elif name == 'PanelIdle':
        blink = _pulse(f, 62+delay, 3.)
        gaze_x = .25*_hold(f, 15, 23, 38, 47)
        wide = .08*sin(pi*(f-1)/max(1, end-1))**2
    elif name == 'PanelToReady':
        tap = float(action.get('panel_tap_frame', 30))
        gaze_x = .45*_hold(f, 3, 10, tap+7, tap+19)
        focus = .22*_hold(f, 8, 14, tap, tap+9)
        blink = _pulse(f, tap+2+delay, 2.5)
        happy = .28*_hold(f, tap+6, tap+16, end-24, end-7)
        wide = .4*_hold(f, tap+8, tap+19, end-25, end-5)
    elif name.startswith('ReadyTo'):
        # A glance anticipates locomotion before the body turns away.
        direction = -1 if name in ('ReadyToWallToss', 'ReadyToWalkWhistle') else 1
        gaze_x = direction*.52*_hold(f, 4, 11, 30, 44)
        blink = _pulse(f, 62+delay, 3.)
        wide = .18*_hold(f, 8, 18, 38, 55)
    elif returning:
        # First look toward center, then reconnect with the viewer for the wave.
        if source == 'WallToss':
            gaze_x = .40*_hold(f, 4, 11, 30, 44)
        elif source == 'WalkWhistle':
            gaze_x = -.40*_hold(f, 4, 11, 30, 44)
        blink = _pulse(f, 51+delay, 2.7)
    else:
        blink = _pulse(f, min(end-12, max(15, end*.61))+delay, 3.)

    # The welcome accent aligns with body wave metadata, including future clips.
    wave_start = action.get('wave_start')
    wave_end = action.get('wave_end')
    if returning and wave_start and wave_end:
        welcome = _hold(f, wave_start, wave_start+10, wave_end-17, wave_end-2)
        happy = max(happy, .66*welcome)
        wide = max(wide, .55*welcome)
    if eye:
        result.update(GazeLeft=max(0., -gaze_x)*edge,
                      GazeRight=max(0., gaze_x)*edge,
                      GazeUp=max(0., gaze_z)*edge,
                      GazeDown=max(0., -gaze_z)*edge,
                      Happy=happy*edge, Focus=focus*edge)
        sleep = result.get('Sleep', base.get('Sleep', 0.))
        result['Blink'] = blink*(1-sleep)
        # Additive eyelid shapes should never invert a capsule through itself.
        closed = result.get('Sleep', base.get('Sleep', 0.)) + result['Blink']
        available = max(0., 1-closed)
        sleepy = result.get('Sleepy', base.get('Sleepy', 0.))
        load = .50*sleepy+.80*result['Happy']+.33*result['Focus']
        if load > .90*available and load > 0:
            ratio = .90*available/load
            result['Sleepy'] = sleepy*ratio
            result['Happy'] *= ratio
            result['Focus'] *= ratio
    else:
        result.update(SmileWide=wide*edge, Concentrate=effort*edge, SoftSmile=soft*edge)
        # Do not distort the existing small O while MERLIN whistles.
        available = 1-base.get('Whistle', 0.)
        for shape in MOUTH_SHAPES:
            result[shape] *= available
    return {name: max(0., min(1., value)) for name, value in result.items()}


def enhance_expression(clip_name):
    """Bake readable face acting; preserve connected first/last expressions.

    The body action's source_activity/source_frame and target_activity/
    target_frame custom properties take precedence for endpoint matching.
    Existing companions must already exist (``build_companions`` can create
    them). It is safe to call this repeatedly; additions replace their channels.
    Recompose showcase actions afterward so they inherit the facial updates.
    """
    add_expression_shapes()
    action = bpy.data.actions.get(clip_name)
    if action is None:
        raise ValueError(f'No MERLIN body action named {clip_name}')
    length = round(action.frame_range[1])
    result = {}
    for owner in FACE_OBJECTS:
        keys = bpy.data.objects[owner].data.shape_keys
        companion = bpy.data.actions.get(f'{clip_name} • {owner}')
        if companion is None:
            raise ValueError(f'Build face companions before enhancing {clip_name}: missing {owner}')
        current = [_values(companion, keys, frame) for frame in range(1, length+1)]
        stored = json.loads(companion.get('_expression_base', 'null'))
        if stored and len(stored) == length:
            base = [{**row, **stored[i]} for i, row in enumerate(current)]
        else:
            base = current
            companion['_expression_base'] = json.dumps(base, separators=(',', ':'))
        first = _endpoint(action, owner, 'source', base[0])
        last = _endpoint(action, owner, 'target', base[-1])
        basis = np.asarray([tuple(v.co) for v in keys.key_blocks[0].data])
        deltas = {key.name: np.asarray([tuple(v.co) for v in key.data])-basis
                  for key in list(keys.key_blocks)[1:] if key.name != 'DisplayConform'}
        origin = np.asarray(tuple(bpy.data.objects[owner].location))
        values = []
        for frame in range(1, length+1):
            value = dict(base[frame-1])
            value.update(_profile(clip_name, frame, length, owner, value, action))
            # Ease the precise endpoint expressions into the interior acting.
            # This also preserves arbitrary interruption poses with gaze active.
            opening = _ramp(frame, 1, 6)
            closing = _ramp(frame, length-5, length)
            for shape in value:
                value[shape] = first[shape]*(1-opening)+value[shape]*opening
                value[shape] = value[shape]*(1-closing)+last[shape]*closing
            # Additive morph interpolation follows a chord beneath a curved
            # surface. Correct that sub-pixel depth error only, preserving the
            # connected endpoint expressions. The same expression computes the
            # same correction at both sides of every boundary.
            coords = basis.copy()+origin
            for shape, delta in deltas.items():
                coords += delta*value[shape]
            inside = np.maximum(0., 1-np.abs(coords[:,0]/1.04)**(2/.65)
                                -np.abs((coords[:,2]-2.98)/.71)**(2/.65))
            margin = np.min(-.54*inside**(.65/2)-coords[:,1])
            value['DisplayConform'] = min(1., max(0., (.001-margin)/.01))
            values.append(value)
        for curve in list(companion.fcurves):
            companion.fcurves.remove(curve)
        for key in list(keys.key_blocks)[1:]:
            curve = companion.fcurves.new(key.path_from_id('value'))
            curve.keyframe_points.add(length)
            curve.keyframe_points.foreach_set('co', [v for f, row in enumerate(values, 1)
                                                    for v in (f, row[key.name])])
            curve.extrapolation = 'CONSTANT'
            for point in curve.keyframe_points:
                point.interpolation = 'LINEAR'
        companion.use_fake_user = True
        companion['expression_version'] = EXPRESSION_VERSION
        companion['expression_notes'] = 'Intent-led gaze, asymmetric timing, soft eyelids and welcome accents; sampled channels.'
        result[owner] = {key.name: [min(row[key.name] for row in values), max(row[key.name] for row in values)]
                         for key in list(keys.key_blocks)[1:]}
    action['expression_version'] = EXPRESSION_VERSION
    return result


def conform_expression(clip_name):
    """Correct depth only for existing face channels without changing acting.

    Useful for display-mode clips whose authored blink timing should be retained.
    Run before composing/exporting. Like enhance_expression, this operates only
    on the small face meshes, without evaluating unrelated character geometry.
    """
    add_expression_shapes()
    action = bpy.data.actions[clip_name]
    length = round(action.frame_range[1])
    for owner in FACE_OBJECTS:
        obj = bpy.data.objects[owner]
        keys = obj.data.shape_keys.key_blocks
        companion = bpy.data.actions[clip_name+' • '+owner]
        basis = np.asarray([tuple(v.co) for v in keys[0].data])
        deltas = {key.name: np.asarray([tuple(v.co) for v in key.data])-basis
                  for key in list(keys)[1:] if key.name != 'DisplayConform'}
        origin = np.asarray(tuple(obj.location))
        values = []
        for frame in range(1, length+1):
            value = _values(companion, obj.data.shape_keys, frame)
            coords = basis.copy()+origin
            for shape, delta in deltas.items():
                coords += delta*value[shape]
            inside = np.maximum(0., 1-np.abs(coords[:,0]/1.04)**(2/.65)
                                -np.abs((coords[:,2]-2.98)/.71)**(2/.65))
            margin = np.min(-.54*inside**(.65/2)-coords[:,1])
            values.extend((frame, min(1., max(0., (.001-margin)/.01))))
        path = keys['DisplayConform'].path_from_id('value')
        curve = companion.fcurves.find(path)
        if curve:
            companion.fcurves.remove(curve)
        curve = companion.fcurves.new(path)
        curve.keyframe_points.add(length)
        curve.keyframe_points.foreach_set('co', values)
        curve.extrapolation = 'CONSTANT'
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'

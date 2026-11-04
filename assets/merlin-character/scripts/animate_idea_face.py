"""An obvious "I've got it" thinking face: MERLIN's eyes become lightbulbs.

Like the searching face, the ordinary display eyes fold away and two drawn
symbols take their place. Each loop ponders first (flickering filaments, a
gentle sway, a slow "hmm" ripple in the mouth bars), then the bulbs switch on
with a small pop and a burst of rays, and a brighter smile, before dimming back
to pondering. Enter, loop and exit share the FullFaceIdle frame-1 pose at their
ends, so the state connects to the full face like the other face states.
"""
import math

import bpy
from mathutils import Vector

from fullscreen_face import _target_frame
from interaction_support import owners as existing_owners, action_for as existing_action_for
from animate_face_states import (_disc, _emission, _new_mesh, _pulse, _smooth, _stroke, _transform,
                                 _write_action, _channels, face_state_owners, state_action_for)
from transition_support import new_action, linear
import screen_state_support as support

LENGTHS = {'FaceToIdea': 24, 'FaceIdea': 96, 'IdeaToFace': 24}
NAMES = ('FaceToIdea', 'FaceIdea', 'IdeaToFace')
# Bulb base (the pivot for growing in) sits under where the ordinary eye was.
EYE_X, BASE_Y, GLASS = 1.92, -.07, (0., .92)
GLASS_RADIUS = .50
OWNER_PREFIX = 'Idea'


def _bezier(a, c, b, steps):
    return [tuple((1 - t) ** 2 * a[i] + 2 * (1 - t) * t * c[i] + t * t * b[i] for i in range(2))
            for t in (j / steps for j in range(steps + 1))]


def _bulb_outline():
    """Glass silhouette from the right neck, over the top, to the left neck."""
    cx, cy = GLASS
    start, end = math.radians(-40), math.radians(220)
    arc = [(cx + GLASS_RADIUS * math.cos(start + (end - start) * i / 48),
            cy + GLASS_RADIUS * math.sin(start + (end - start) * i / 48)) for i in range(49)]
    right = _bezier((.21, .33), (.31, .44), arc[0], 8)
    left = _bezier(arc[-1], (-.31, .44), (-.21, .33), 8)
    return right[:-1] + arc + left[1:]


def _polyline(points, width, index=0, layer=0.):
    parts = []
    for a, b in zip(points, points[1:]):
        v, f = _stroke(a, b, width)
        parts.append((v, f, index, layer))
    return parts


def _fan(points, center):
    v = [center] + list(points)
    return v, [(0, i + 1, (i + 1) % len(points) + 1) for i in range(len(points))]


def _create_geometry():
    glow = bpy.data.materials['08 • Display / cyan to ice gradient']
    fill = _emission('Face state • idea glow', (.06, .36, .52), 1)
    outline = _bulb_outline()
    # The lit glass sits just inside the outline, so the drawn edge stays crisp.
    inset = [(x * .9, GLASS[1] + (y - GLASS[1]) * .9) if y > .4 else (x * .85, y + .03) for x, y in outline]
    for side, sign in [('L', 1), ('R', -1)]:
        base = (sign * EYE_X, BASE_Y)
        parts = _polyline(outline, .075)
        for y, half in [(.25, .21), (.15, .19), (.06, .13)]:
            v, f = _stroke((-half, y), (half, y), .06)
            parts.append((v, f, 0))
        v, f = _disc(.05, 24, (0., -.005))
        parts.append((v, f, 0))
        _new_mesh(OWNER_PREFIX + 'Bulb' + side, 'idea bulb ' + side, parts, [glow], base, depth=.046)
        v, f = _fan(inset, (0., .80))
        _new_mesh(OWNER_PREFIX + 'Glow' + side, 'idea glow ' + side, [(v, f, 0)], [fill], base, depth=.043)
        filament = [(-.09, .34), (-.09, .70), (-.045, .82), (0., .70), (.045, .82), (.09, .70), (.09, .34)]
        _new_mesh(OWNER_PREFIX + 'Filament' + side, 'idea filament ' + side, _polyline(filament, .036),
                  [glow], base, depth=.048)
        # Rays burst from the middle of the glass, so they scale outward from there.
        rays = []
        for angle in (22, 58, 90, 122, 158):
            a = math.radians(angle)
            inner, outer = .66, .86
            v, f = _stroke((inner * math.cos(a), inner * math.sin(a)), (outer * math.cos(a), outer * math.sin(a)), .07)
            rays.append((v, f, 0))
        _new_mesh(OWNER_PREFIX + 'Rays' + side, 'idea rays ' + side, rays, [glow],
                  (base[0] + GLASS[0], base[1] + GLASS[1]), depth=.046)


def idea_owners():
    return [(owner, obj) for owner, obj in face_state_owners() if owner.startswith(OWNER_PREFIX)]


def _lit(p):
    """0 while pondering, 1 while the idea is on; zero at both loop ends."""
    return _smooth((p - .44) / .08) * (1 - _smooth((p - .82) / .14))


def _rays(p):
    return _smooth((p - .46) / .06) * (1 - _smooth((p - .68) / .12))


def _settings(kind, frame, length):
    if kind == 'loop':
        return 1., 0. if frame in (1, length) else (frame - 1) / (length - 1)
    u = _smooth((frame - 1) / (length - 1))
    return (1 - u if kind == 'exit' else u), 0.


def _existing_row(owner, base, u, p):
    row = dict(base)
    center, right, up, toward = _target_frame()
    phase, lit = 2 * math.pi * p, _lit(p)
    if owner in ('DisplayEyeL', 'DisplayEyeR'):
        sign = 1 if owner == 'DisplayEyeL' else -1
        hide = _smooth((u - .05) / .90)
        pivot = center + right * (sign * 1.92) + up * .75 + toward * .008
        for i in range(3):
            row[('scale', i)] = 1 - hide
            row[('location', i)] = base.get(('location', i), 0) + pivot[i] * hide
    elif owner.startswith('DisplayBar'):
        index = int(owner.removeprefix('DisplayBar')) - 1
        # A small, slow "hmm" ripple, then a brighter smile while the bulbs are on.
        ponder = .52 + .30 * (.5 + .5 * math.sin(2 * phase - index * .9))
        smile = 1.0 + .32 * (1 - abs(index - 3) / 3)
        height = ponder * (1 - lit) + smile * lit
        row[('scale', 2)] = 1 - u + u * height
    return row


def _helper_row(obj, u, p):
    owner = str(obj['owner_id'])
    loc, rot = Vector(obj['rest_location']), Vector(obj['rest_rotation'])
    _, right, up, _ = _target_frame()
    phase, lit = 2 * math.pi * p, _lit(p)
    pop = _pulse(p, .51, .07)
    show = _smooth((u - .08) / .92)
    # Pondering sways side to side; the switch-on gives a small upward pop.
    loc = loc + right * (.07 * math.sin(phase)) * (1 - lit) + up * (.06 * pop)
    if 'Bulb' in owner:
        size = show * (1 + .06 * pop)
    elif 'Glow' in owner:
        size = show * lit * (1 + .08 * pop)
    elif 'Filament' in owner:
        flicker = max(0., math.sin(9 * phase)) ** 2
        size = show * (1 - .3 * (1 - lit) * flicker + .1 * pop)
    elif 'Rays' in owner:
        size = show * _rays(p) * (1 + .2 * pop)
    else:
        size = 0.
    return _transform(loc, rot, (size, size, size))


def _hidden(obj):
    return _transform(obj['rest_location'], obj['rest_rotation'], (0, 0, 0))


def _held_action(name, row, frames):
    """Exact held channel at the first and last frame, like the compacted companions."""
    action = new_action(name)
    for (path, index), value in row.items():
        curve = action.fcurves.new(path, index=index)
        points = [1, value] if frames == 1 else [1, value, frames, value]
        curve.keyframe_points.add(len(points) // 2)
        curve.keyframe_points.foreach_set('co', points)
    linear(action)
    return action


def create_idea_owners(clips):
    """Add the bulb drawings, hidden in every listed (existing) clip."""
    _create_geometry()
    for owner, obj in idea_owners():
        for clip in clips:
            frames = round(bpy.data.actions[clip].frame_range[1])
            _held_action(clip + ' • ' + owner, _hidden(obj), frames)
    return [owner for owner, _ in idea_owners()]


def build_idea_face(rig):
    """Build FaceToIdea, FaceIdea and IdeaToFace for every synchronized owner."""
    if rig.name != 'MERLIN_Rig':
        raise ValueError('The MERLIN character rig is required.')
    interaction = {owner for owner, _ in existing_owners()}
    ideas = {owner for owner, _ in idea_owners()}
    baseline = {owner: _channels(support.action_for('FullFaceIdle', owner), 1) for owner, _ in support.owners()}
    actions = {}
    for kind, name in zip(('enter', 'loop', 'exit'), NAMES):
        length = LENGTHS[name]
        for owner, data in support.owners():
            if owner in ideas:
                rows = [_helper_row(data, *_settings(kind, frame, length)) for frame in range(1, length + 1)]
                _write_action(name + ' • ' + owner, rows)
            elif owner in interaction:
                rows = [_existing_row(owner, baseline[owner], *_settings(kind, frame, length))
                        for frame in range(1, length + 1)]
                action = _write_action(support.base.action_name(name, owner), rows)
                if owner == 'rig':
                    actions[name] = action
            else:
                # Music notes, the left screen and the other face symbols stay as in FullFaceIdle.
                _held_action(support.base.action_name(name, owner), baseline[owner], length)
        action = actions[name]
        action['frames'] = length
        action['fps'] = 24
        action['loop'] = kind == 'loop'
        action['source_activity'] = 'FaceIdea' if kind in ('loop', 'exit') else 'FullFaceIdle'
        action['source_frame'] = 1
        action['target_activity'] = 'FaceIdea' if kind in ('enter', 'loop') else 'FullFaceIdle'
        action['target_frame'] = 1
        action['face_state'] = 'Idea'
        action['note'] = 'Authored display animation: lightbulb eyes for an obvious thinking moment.'
    return actions

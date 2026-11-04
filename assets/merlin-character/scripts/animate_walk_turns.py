"""Turn around at either wall so walking can continue back the other way.

The forward walk ends at the right wall facing right; the reverse walk starts at
the same spot facing left (and mirrored at the left wall). Each turn is a short
hop-pivot through a forward-facing pose. The first and last frames are exact
samples of the connected walk clips for every synchronized owner.
"""
from math import pi, sin

import bpy

from animate_transitions import _apply, _capture, _context, _finish, _key, _new_action, _sample
from animate_casual import _move_root
from animate_character import BONE_NAMES, _smooth
from transition_support import new_action, linear
import screen_state_support as support

FRAMES = 22
TURNS = {
    # name: (source clip, source frame, target clip, target frame)
    'WalkTurnAtRight': ('WalkWhistle', 192, 'WalkWhistleReverse', 1),
    'WalkTurnAtLeft': ('WalkWhistleReverse', 192, 'WalkWhistle', 1),
}


def _blend_pose(start, finish, u):
    body = _smooth(u)
    # The head leads the turn a little, the way a person looks before they pivot.
    head = _smooth(min(1., u * 1.35))
    pose = {}
    for name in BONE_NAMES:
        amount = head if name == 'head' else body
        location = start[name][0].lerp(finish[name][0], amount)
        rotation = start[name][1].slerp(finish[name][1], amount)
        pose[name] = (location, rotation, start[name][2].lerp(finish[name][2], amount))
    return pose


def _channels(action, frame):
    return {(curve.data_path, curve.array_index): float(curve.evaluate(frame)) for curve in action.fcurves}


def _companion(name, owner, source, source_frame, target, target_frame):
    first = _channels(support.action_for(source, owner), source_frame)
    last = _channels(support.action_for(target, owner), target_frame)
    keys = sorted(set(first) | set(last))
    action = new_action(support.base.action_name(name, owner))
    for path, index in keys:
        a = first.get((path, index), last.get((path, index)))
        b = last.get((path, index), a)
        curve = action.fcurves.new(path, index=index)
        values = []
        for frame in range(1, FRAMES + 1):
            amount = 0. if frame == 1 else 1. if frame == FRAMES else _smooth((frame - 1) / (FRAMES - 1))
            values += [frame, a + (b - a) * amount]
        curve.keyframe_points.add(FRAMES)
        curve.keyframe_points.foreach_set('co', values)
    linear(action)
    return action


def build_walk_turns(rig):
    """Author both wall turns; returns {clip name: rig Action}."""
    if rig.name != 'MERLIN_Rig':
        raise ValueError('The MERLIN character rig is required.')
    context = _context(rig)
    _, inverse, _ = context
    result = {}
    for name, (source, source_frame, target, target_frame) in TURNS.items():
        start = _sample(rig, source, source_frame)
        finish = _sample(rig, target, target_frame)
        guide = {'frames': FRAMES, 'loop': False, 'source_activity': source, 'source_frame': source_frame,
                 'target_activity': target, 'target_frame': target_frame,
                 'poses': {1: source, FRAMES // 2: 'Hop and pivot', FRAMES: target}}
        action = _new_action(name, guide)
        for frame in range(1, FRAMES + 1):
            u = (frame - 1) / (FRAMES - 1)
            if frame == 1:
                pose = start
            elif frame == FRAMES:
                pose = finish
            else:
                _apply(rig, _blend_pose(start, finish, u))
                # A small hop keeps both feet off the floor while the body pivots.
                _move_root(rig, (0, 0, .075 * sin(pi * u) ** 2), inverse)
                pose = _capture(rig)
            _key(rig, action, frame, pose, context, exact=frame in (1, FRAMES))
        result[name] = _finish(action, guide)
        for owner, _ in support.owners():
            if owner != 'rig':
                _companion(name, owner, source, source_frame, target, target_frame)
    return result

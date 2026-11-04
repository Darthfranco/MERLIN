"""Add wall turns for continuous walking and the lightbulb idea face.

Usage (Blender 4.0.2), then export with export_screen_states.py:
  blender --background --python-exit-code 1 --python assets/merlin-character/scripts/build_idea_turn_states.py
Every existing clip keeps its exact authored channels; the new bulb drawings
receive explicit hidden tracks in all of them. A report is written to
previews/idea-turn-validation.json and the scene is saved only if it passes.
"""
from pathlib import Path
import hashlib
import json
import sys

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
sys.path.insert(0, str(HERE))
import screen_state_support as support
from interaction_support import action_name
from compact_context_actions import compact_new_actions
from animate_idea_face import create_idea_owners, build_idea_face, NAMES as IDEA_NAMES, LENGTHS as IDEA_LENGTHS
from animate_walk_turns import build_walk_turns, TURNS, FRAMES as TURN_FRAMES


def action_digest(names, owner_names):
    digest = hashlib.sha256()
    actions = {action.name: action for action in bpy.data.actions}
    for name in sorted(names):
        for owner in owner_names:
            action = actions[action_name(name, owner)]
            digest.update(action.name.encode())
            for curve in action.fcurves:
                digest.update(curve.data_path.encode()); digest.update(str(curve.array_index).encode())
                values = np.empty(len(curve.keyframe_points) * 2, dtype=np.float32)
                curve.keyframe_points.foreach_get('co', values); digest.update(values.tobytes())
    return digest.hexdigest()


def mesh_digests():
    result = {}
    for mesh in bpy.data.meshes:
        digest = hashlib.sha256()
        values = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get('co', values); digest.update(values.tobytes())
        digest.update(json.dumps([m.name if m else None for m in mesh.materials]).encode())
        result[mesh.name] = digest.hexdigest()
    return result


def channels(clip, owner, frame):
    action = support.action_for(clip, owner)
    return {(c.data_path, c.array_index): float(c.evaluate(frame)) for c in action.fcurves}


def largest_difference(a, b):
    keys = set(a) | set(b)
    return max((abs(a.get(k, b.get(k)) - b.get(k, a.get(k))) for k in keys), default=0.)


bpy.ops.wm.open_mainfile(filepath=str(OUT / 'merlin-states.blend'))
scene = bpy.context.scene
rig = bpy.data.objects['MERLIN_Rig']
manifest = json.loads((OUT / 'states.json').read_text())
new_names = set(TURNS) | set(IDEA_NAMES)
if new_names & set(manifest['clips']):
    raise ValueError('These clips are already present; start from the previous scene.')
baseline = list(manifest['clips'])
owners_before = [owner for owner, _ in support.owners()]
actions_before = action_digest(baseline, owners_before)
meshes_before = mesh_digests()
active = scene.get('active_activity')

added_owners = create_idea_owners(baseline)
turns = build_walk_turns(rig)
idea = build_idea_face(rig)
created = {**turns, **idea}
compaction = compact_new_actions(list(created))

checks = []
def check(name, passed, **detail):
    checks.append({'name': name, 'passed': bool(passed), **detail})

owners_after = [owner for owner, _ in support.owners()]
check('existing clips unchanged', action_digest(baseline, owners_before) == actions_before, clips=len(baseline))
check('existing meshes unchanged', all(mesh_digests().get(name) == digest for name, digest in meshes_before.items()),
      meshes=len(meshes_before))
check('eight new bulb owners', len(added_owners) == 8 and set(owners_after) == set(owners_before) | set(added_owners),
      owners=added_owners)
missing = [(clip, owner) for clip in baseline + list(created) for owner in owners_after if support.action_for(clip, owner) is None]
check('every clip has every owner', not missing, missing=missing[:10])
hidden = []
for clip in baseline:
    for owner in added_owners:
        values = channels(clip, owner, 1)
        if any(values[('scale', i)] != 0 for i in range(3)):
            hidden.append(clip)
check('bulbs hidden in every existing clip', not hidden, clips=hidden[:5])
for name, (source, source_frame, target, target_frame) in TURNS.items():
    first = max(largest_difference(channels(name, owner, 1), channels(source, owner, source_frame)) for owner in owners_after)
    last = max(largest_difference(channels(name, owner, TURN_FRAMES), channels(target, owner, target_frame)) for owner in owners_after)
    check(name + ' starts on ' + source, first < 1e-5, error=first)
    check(name + ' ends on ' + target, last < 1e-5, error=last)
    check(name + ' length', round(bpy.data.actions[name].frame_range[1]) == TURN_FRAMES)
face = {owner: channels('FullFaceIdle', owner, 1) for owner in owners_after}
for name, frame in [('FaceToIdea', 1), ('IdeaToFace', IDEA_LENGTHS['IdeaToFace'])]:
    error = max(largest_difference(channels(name, owner, frame), face[owner]) for owner in owners_after)
    check(name + ' meets FullFaceIdle', error < 1e-5, error=error)
for a, fa, b, fb in [('FaceToIdea', 24, 'FaceIdea', 1), ('FaceIdea', 96, 'FaceIdea', 1), ('FaceIdea', 1, 'IdeaToFace', 1)]:
    error = max(largest_difference(channels(a, owner, fa), channels(b, owner, fb)) for owner in owners_after)
    check(f'{a}:{fa} meets {b}:{fb}', error < 1e-5, error=error)
lit = channels('FaceIdea', 'IdeaGlowL', 60)
check('bulbs switch on mid-loop', lit[('scale', 0)] > .9, scale=lit[('scale', 0)])
check('bulbs dark while pondering', channels('FaceIdea', 'IdeaGlowL', 12)[('scale', 0)] == 0)
check('eyes folded away in the loop', channels('FaceIdea', 'DisplayEyeL', 48)[('scale', 0)] < 1e-6)
report = {'passed': all(item['passed'] for item in checks), 'checks': checks, 'compaction': compaction,
          'clips_before': len(baseline), 'clips_after': len(baseline) + len(created), 'added_clips': sorted(created)}
(OUT / 'previews' / 'idea-turn-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print('MERLIN_IDEA_TURN_REPORT', json.dumps({k: v for k, v in report.items() if k != 'checks'}), flush=True)
if not report['passed']:
    for item in checks:
        if not item['passed']: print('FAILED', json.dumps(item), flush=True)
    raise RuntimeError('Validation failed; see previews/idea-turn-validation.json')

manifest['states']['idea'] = {'label': 'Idea face', 'enter': 'FaceToIdea', 'idle': 'FaceIdea', 'exit': 'IdeaToFace', 'parent': 'face'}
manifest['routes'] += [{'from': 'walkRest', 'to': 'walkReverse', 'clip': 'WalkTurnAtRight'},
                       {'from': 'walkReverseRest', 'to': 'walk', 'clip': 'WalkTurnAtLeft'}]
for name, action in created.items():
    manifest['clips'][name] = {'frames': round(action.frame_range[1]), 'source': action.get('source_activity'),
                               'source_frame': action.get('source_frame', 1), 'target': action.get('target_activity'),
                               'target_frame': action.get('target_frame', 1)}
(OUT / 'states.json').write_text(json.dumps(manifest, indent=2) + '\n')
support.apply_activity(scene, active if active and support.action_for(active, 'rig') else 'ReadyIdle', 1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'merlin-states.blend'), compress=True)
print('MERLIN_IDEA_TURN_SAVED', len(manifest['clips']), len(manifest['states']), flush=True)

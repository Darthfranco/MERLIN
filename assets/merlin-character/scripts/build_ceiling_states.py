"""Append ceiling presentation states while retaining every existing clip."""
from pathlib import Path
import json
import sys
import bpy

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
sys.path.insert(0, str(HERE))
from animate_ceiling_screen import build_ceiling_screen, FRAMES
from animate_context_states import build_context_states
from compact_context_actions import action_fingerprint, compact_new_actions
from verify_ceiling_states import verify_ceiling_states, geometry_fingerprint
import screen_state_support as support

bpy.ops.wm.open_mainfile(filepath=str(OUT / 'merlin-states.blend'))
print('MERLIN_CEILING_BASE_OPEN', flush=True)
scene = bpy.context.scene
rig = bpy.data.objects['MERLIN_Rig']
manifest = json.loads((OUT / 'states.json').read_text())
ceiling_names = set(FRAMES) | {'CeilingToThink', 'CeilingThinking', 'CeilingThinkToBody',
                             'CeilingToFace', 'FaceToCeiling'}
baseline = [name for name in manifest['clips'] if name not in ceiling_names]
original_actions = action_fingerprint(baseline)
original_geometry = geometry_fingerprint()
print('MERLIN_CEILING_BASE_FINGERPRINTED', len(baseline), flush=True)
# Bone-only authoring and our mesh-cloud clearance checks do not need Blender
# to recompute every skinned mesh's split normals at each intermediate IK solve.
# This is a temporary evaluation optimization, restored before validation/save.
modifier_visibility = [(modifier, modifier.show_viewport) for obj in bpy.data.objects
                       if obj.type == 'MESH' for modifier in obj.modifiers]
try:
    for modifier, _ in modifier_visibility: modifier.show_viewport = False
    actions, metadata = build_ceiling_screen(rig)
    context_actions, context_metadata = build_context_states(rig, {
        'ceiling': {'prefix': 'Ceiling', 'activity': 'CeilingIdle', 'frame': 1}})
finally:
    for modifier, enabled in modifier_visibility: modifier.show_viewport = enabled
actions.update(context_actions)
compact = compact_new_actions(list(actions))
report = verify_ceiling_states(list(actions))
report['baseline_actions_unchanged'] = action_fingerprint(baseline) == original_actions
report['baseline_action_count'] = len(baseline)
report['geometry_materials_unchanged'] = geometry_fingerprint() == original_geometry
report['compaction'] = compact
report['passed'] = report['passed'] and report['baseline_actions_unchanged'] and report['geometry_materials_unchanged']
(OUT / 'previews' / 'ceiling-validation.json').write_text(json.dumps(report, indent=2) + '\n')
if not report['passed']:
    # Keep a diagnostic candidate without replacing the accepted scene.
    bpy.ops.wm.save_as_mainfile(filepath='/tmp/merlin-ceiling-candidate.blend', compress=True)
    raise RuntimeError('Ceiling validation failed; inspect previews/ceiling-validation.json')
manifest['states'].update(metadata['states'])
manifest['states'].update(context_metadata['states'])
manifest['routes'] = [route for route in manifest.get('routes', []) if route['clip'] not in ceiling_names]
manifest['routes'] += metadata['routes'] + context_metadata['routes']
manifest.setdefault('contexts', {}).update(context_metadata['contexts'])
manifest['ceiling_screen'] = metadata['ceiling_screen']
for name, action in actions.items():
    manifest['clips'][name] = {'frames': round(action.frame_range[1]),
        'source': action['source_activity'], 'source_frame': action.get('source_frame', 1),
        'target': action['target_activity'], 'target_frame': action.get('target_frame', 1)}
(OUT / 'states.json').write_text(json.dumps(manifest, indent=2) + '\n')
support.apply_activity(scene, 'CeilingIdle', 1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'merlin-states.blend'), compress=True)
print('MERLIN_CEILING_SAVED', len(manifest['clips']), flush=True)

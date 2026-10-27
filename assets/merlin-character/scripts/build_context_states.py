"""Add reverse walking and context-preserving thought/full-face performances."""
from pathlib import Path
import sys,json
import bpy
HERE=Path(__file__).resolve().parent;OUT=HERE.parent;sys.path.insert(0,str(HERE))
from animate_reverse_walk import build_reverse_walk
from animate_context_states import build_context_states
from compact_context_actions import compact_new_actions
import screen_state_support as support
bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-states.blend'))
scene=bpy.context.scene;rig=bpy.data.objects['MERLIN_Rig']
manifest=json.loads((OUT/'states.json').read_text())
new=build_reverse_walk(rig)
manifest['states']['walkReverse']=dict(label='Walk & whistle · right to left',enter='ReadyToWalkWhistleReverse',idle='WalkWhistleReverse',exit='WalkWhistleReverseToReady',parent='ready')
context,metadata=build_context_states(rig)
new.update(context)
manifest['states'].update(metadata['states'])
for state,update in metadata['stateUpdates'].items():manifest['states'][state].update(update)
manifest['routes']=[r for r in manifest.get('routes',[]) if r['clip'] in ('BothToLeftPanel','BothToRightPanel')]+metadata['routes']
manifest['contexts']=metadata['contexts']
for name,action in new.items():
 manifest['clips'][name]=dict(frames=round(action.frame_range[1]),source=action.get('source_activity'),source_frame=action.get('source_frame',1),target=action.get('target_activity'),target_frame=action.get('target_frame',1))
manifest['version']=2
(OUT/'states.json').write_text(json.dumps(manifest,indent=2)+'\n')
# Compact only presentation work added after the original 37-clip state set.
# Held companion transforms retain their exact first/last frame and value.
baseline=json.loads((OUT/'interactions.json').read_text())
from animate_body_states import BODY_STATE_GUIDE
from animate_left_panel import LEFT_PANEL_GUIDE
from animate_face_states import LENGTHS as FACE_LENGTHS
original=set(baseline['clips'])|set(BODY_STATE_GUIDE)|set(LEFT_PANEL_GUIDE)|set(FACE_LENGTHS)
compact_new_actions([name for name in manifest['clips'] if name not in original])
support.apply_activity(scene,'BothPanelsIdle',1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-states.blend'),compress=True)
print('MERLIN_CONTEXT_STATES_SAVED',len(manifest['clips']),len(manifest['states']),flush=True)

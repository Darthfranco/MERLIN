"""Export just newly authored clips for verified lossless addition to a baseline.

Usage: blender -b --python export_added_states.py -- BASELINE_MANIFEST OUTPUT_GLB
Then merge_animation_glb.py verifies unchanged resources and appends animations.
"""
from pathlib import Path
import json,sys
import bpy
HERE=Path(__file__).resolve().parent;OUT=HERE.parent;sys.path.insert(0,str(HERE))
import screen_state_support as support
from export_interactions import export_interactions
from preserve_step_handoffs import preserve_step_handoffs
arguments=sys.argv[sys.argv.index('--')+1:]
baseline=json.loads(Path(arguments[0]).read_text())
manifest=json.loads((OUT/'states.json').read_text())
clips=[name for name in manifest['clips'] if name not in baseline['clips']]
if not clips:raise ValueError('No added clips')
bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-states.blend'))
export_interactions(clips,Path(arguments[1]),controller=support,collection_names=['MERLIN • Character','MERLIN • Display mode','MERLIN • Face states'])
handoff=preserve_step_handoffs(Path(arguments[1]),manifest)
print('MERLIN_HANDOFF_EXPORT',json.dumps(handoff),flush=True)
print('MERLIN_ADDED_STATES_EXPORTED',len(clips),flush=True)

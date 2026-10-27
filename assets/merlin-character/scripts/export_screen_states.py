"""Export an existing authored state scene without rebuilding its animation."""
from pathlib import Path
import json,sys
import bpy
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import screen_state_support as support
from screen_content import configure_panel_screens
from export_interactions import export_interactions
OUT=HERE.parent
if Path(bpy.data.filepath)!=OUT/'merlin-states.blend':
    bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-states.blend'))
configure_panel_screens()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-states.blend'),compress=True)
manifest=json.loads((OUT/'states.json').read_text())
export_interactions(list(manifest['clips']),OUT/'merlin-states.glb',controller=support,
                    collection_names=['MERLIN • Character','MERLIN • Display mode','MERLIN • Face states'])
print('MERLIN_STATES_EXPORT_COMPLETE',flush=True)

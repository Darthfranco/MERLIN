"""Extend the saved state asset without rebuilding any accepted earlier motion."""
from pathlib import Path
import json,sys
import bpy
HERE=Path(__file__).resolve().parent;OUT=HERE.parent;sys.path.insert(0,str(HERE))
from animate_dual_screens import build_dual_screens,DUAL_GUIDE
import screen_state_support as support

bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-states.blend'))
scene=bpy.context.scene;rig=bpy.data.objects['MERLIN_Rig']
manifest=json.loads((OUT/'states.json').read_text())
new=build_dual_screens(rig)
manifest['states'].update({
 'both':dict(label='Both screens · seated',enter='ReadyToBothPanels',idle='BothPanelsIdle',exit='BothPanelsToReady',parent='ready'),
 'seatedLeft':dict(label='Left screen · seated',idle='SeatedLeftPanelIdle',exit='SeatedLeftToReady',exitTo='ready',parent='both'),
 'seatedRight':dict(label='Right screen · seated',idle='SeatedRightPanelIdle',exit='SeatedRightToReady',exitTo='ready',parent='both'),
})
manifest['routes']=[dict(from_='both',to='seatedLeft',clip='BothToLeftPanel'),dict(from_='both',to='seatedRight',clip='BothToRightPanel')]
for route in manifest['routes']:route['from']=route.pop('from_')
for name in new:
 g=DUAL_GUIDE[name];manifest['clips'][name]=dict(frames=g['frames'],source=g['source_activity'],source_frame=1,target=g['target_activity'],target_frame=1)
segments=[('ReadyToBothPanels',1,288),('BothPanelsIdle',1,96),('BothToLeftPanel',1,72),('SeatedLeftPanelIdle',1,48),('SeatedLeftToReady',1,132),('ReadyToBothPanels',1,288),('BothToRightPanel',1,72),('SeatedRightPanelIdle',1,48),('SeatedRightToReady',1,132),('ReadyToBothPanels',1,288),('BothPanelsToReady',1,132)]
support.compose_clip('DualScreensShowcase',segments)
scene['dual_screens_showcase']=json.dumps(segments)
manifest['dual_screens']={'showcase':'DualScreensShowcase','panel_scale':.68,'seated_position':'center','dismissal':'Tap the selected side; untouched content remains visible.'}
(OUT/'states.json').write_text(json.dumps(manifest,indent=2)+'\n')
support.apply_activity(scene,'BothPanelsIdle',1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-states.blend'),compress=True)
print('MERLIN_DUAL_STATES_READY',len(manifest['clips']),flush=True)

"""Review the seated layout, independent cancellation and preserved face context."""
from pathlib import Path
import sys
import bpy
HERE=Path(__file__).resolve().parent;OUT=HERE.parent/'previews';sys.path.insert(0,str(HERE))
from screen_state_support import apply_activity

scene=bpy.context.scene
quick='--quick' in sys.argv
scene.render.engine='BLENDER_EEVEE' if quick else 'CYCLES'
if quick:
 scene.eevee.taa_render_samples=32;scene.eevee.use_gtao=True;scene.eevee.use_bloom=True
else:
 scene.cycles.samples=32;scene.cycles.use_denoising=True
 try:
  prefs=bpy.context.preferences.addons['cycles'].preferences
  prefs.compute_device_type='METAL';prefs.refresh_devices()
  available=[d for d in prefs.devices if d.type=='METAL']
  for d in prefs.devices:d.use=d in available
  if available:scene.cycles.device='GPU'
 except (AttributeError,TypeError,RuntimeError):pass
scene.render.resolution_x=800 if quick else 1000
scene.render.resolution_y=600 if quick else 750
scene.render.resolution_percentage=100;scene.render.use_sequencer=False
scene.render.image_settings.file_format='PNG'
poses=[('BothPanelsIdle',1,'both-seated'),('BothToLeftPanel',42,'dismiss-right'),
       ('SeatedRightPanelIdle',1,'right-seated'),('BothPanelsToReady',40,'dismiss-both')]
if '--context' in sys.argv:poses+=[('BothThinking',48,'both-thinking'),('BothToFace',16,'both-expand'),('FaceToBoth',30,'both-return')]
if '--all-poses' in sys.argv:poses+=[('NapThinking',60,'nap-thinking'),('TossThinking',60,'toss-thinking'),('WalkWhistleReverse',90,'reverse-walk')]
if '--single' in sys.argv:poses=poses[:1]
for clip,frame,label in poses:
 apply_activity(scene,clip,frame)
 scene.render.filepath=str((Path('/tmp') if quick else OUT)/('merlin-dual-'+label+'.png'))
 bpy.ops.render.render(write_still=True)
 print('MERLIN_DUAL_RENDER',clip,frame,flush=True)

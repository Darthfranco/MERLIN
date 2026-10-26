"""Render MERLIN's expressive panel/display performance with the reviewed lighting."""
from pathlib import Path
import sys
import bpy
HERE=Path(__file__).resolve().parent
OUT=HERE.parent/'previews'
sys.path.insert(0,str(HERE))
from interaction_support import apply_activity
scene=bpy.context.scene
mode=sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'quick'
scene.render.resolution_percentage=100
scene.render.use_sequencer=False
scene.render.engine='BLENDER_EEVEE'
scene.eevee.use_gtao=True;scene.eevee.gtao_distance=.4;scene.eevee.gtao_factor=1.2
scene.eevee.use_ssr=False;scene.eevee.taa_render_samples=32
scene.eevee.use_soft_shadows=True;scene.eevee.shadow_cube_size='2048'
scene.render.resolution_x=800;scene.render.resolution_y=600
scene.render.image_settings.file_format='PNG'
if mode in ('quick','stills'):
    if mode=='stills':
        scene.render.engine='CYCLES';scene.cycles.samples=64;scene.cycles.use_denoising=True
        try:
            prefs=bpy.context.preferences.addons['cycles'].preferences
            prefs.compute_device_type='METAL';prefs.refresh_devices()
            for device in prefs.devices:device.use=device.type=='METAL'
            scene.cycles.device='GPU'
        except Exception:scene.cycles.device='CPU'
        scene.render.resolution_x=1600;scene.render.resolution_y=1200
        poses=[('NapToReady',28,'natural-wakeup'),('PanelIdle',1,'panel'),
               ('PanelToReady',42,'panel-dismiss'),('FullFaceIdle',1,'fullscreen-face')]
    else:
        poses=[('NapToReady',28,'natural-wakeup'),('NapToReady',55,'landing'),
               ('ReadyToPanel',70,'panel-effort'),('ReadyToPanel',110,'panel-pull'),
               ('PanelIdle',1,'panel'),('PanelToReady',42,'panel-dismiss'),
               ('ReadyToFace',12,'face-expand-start'),('ReadyToFace',23,'face-expand'),
               ('FullFaceIdle',1,'fullscreen-face'),('FaceToReady',23,'face-return')]
    for clip,frame,label in poses:
        apply_activity(scene,clip,frame)
        scene.render.filepath=str((OUT if mode=='stills' else Path('/tmp'))/('merlin-'+label+'.png'))
        bpy.ops.render.render(write_still=True)
    print('INTERACTION_STILLS_COMPLETE',mode,flush=True)
elif mode=='motion':
    # Eevee bloom keeps the preview responsive; Cycles stills retain optical glare.
    for node in scene.node_tree.nodes:
        if node.type=='GLARE':node.mute=True
    # Both compositor effects are bypassed in this continuous Eevee reel.
    # Skip the otherwise identical pass-through compositor for every frame.
    scene.render.use_compositing=False
    scene.eevee.use_bloom=True
    scene.eevee.bloom_threshold=1.0
    scene.eevee.bloom_intensity=.025
    scene.eevee.bloom_radius=6.5
    scene.eevee.bloom_knee=.5
    apply_activity(scene,'ExperienceShowcase',1)
    scene.render.fps=24;scene.frame_step=1
    scene.render.image_settings.file_format='FFMPEG'
    scene.render.ffmpeg.format='MPEG4';scene.render.ffmpeg.codec='H264'
    scene.render.ffmpeg.constant_rate_factor='HIGH';scene.render.ffmpeg.ffmpeg_preset='GOOD'
    scene.render.ffmpeg.audio_codec='NONE'
    scene.render.filepath=str(OUT/'merlin-interactions.mp4')
    bpy.ops.render.render(animation=True)
    print('INTERACTION_MOVIE_COMPLETE',scene.frame_end,flush=True)
else:raise ValueError('Mode must be quick, stills or motion')

"""Render the tablet room and mux its original whistle using Blender only.

blender -b merlin-room.blend -P scripts/render_room.py -- stills
blender -b merlin-room.blend -P scripts/render_room.py -- motion
blender -b merlin-room.blend -P scripts/render_room.py -- all
"""
from pathlib import Path
import sys
import tempfile
import bpy

HERE=Path(__file__).resolve().parent
OUT=HERE.parent/'previews'
sys.path.insert(0,str(HERE))
from room_support import apply_activity
mode=sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'stills'
if mode not in ('stills','motion','all','quick'):
    raise ValueError('Use stills, motion, all or quick')
scene=bpy.context.scene
OUT.mkdir(exist_ok=True)


def cycles(samples):
    scene.render.engine='CYCLES'
    scene.cycles.samples=samples
    scene.cycles.use_denoising=True
    try:
        prefs=bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type='METAL'
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use=d.type=='METAL'
        scene.cycles.device='GPU'
    except Exception:
        scene.cycles.device='CPU'


def eevee(samples):
    scene.render.engine='BLENDER_EEVEE'
    scene.eevee.use_gtao=True
    scene.eevee.gtao_distance=.4
    scene.eevee.gtao_factor=1.2
    scene.eevee.use_ssr=False
    scene.eevee.taa_render_samples=samples
    scene.eevee.use_soft_shadows=True
    scene.eevee.shadow_cube_size='2048'


def ffmpeg(target_scene,path):
    target_scene.render.image_settings.file_format='FFMPEG'
    target_scene.render.ffmpeg.format='MPEG4'
    target_scene.render.ffmpeg.codec='H264'
    target_scene.render.ffmpeg.constant_rate_factor='HIGH'
    target_scene.render.ffmpeg.ffmpeg_preset='GOOD'
    target_scene.render.filepath=str(path)


if mode in ('stills','all','quick'):
    if mode=='quick':
        eevee(64)
        scene.render.resolution_x=800
        scene.render.resolution_y=600
    else:
        cycles(64)
        scene.render.resolution_x=1600
        scene.render.resolution_y=1200
    scene.render.image_settings.file_format='PNG'
    poses=[('WalkWhistle',72,'walk'),('WallToss',31,'wall-toss'),('Nap',72,'nap')]
    if mode=='quick':
        poses += [('WallToss',58,'wall-impact'),('WallToss',70,'floor-bounce'),('WallToss',86,'catch')]
    for name,frame,label in poses:
        apply_activity(scene,name,frame)
        scene.render.filepath=str((Path('/tmp') if mode=='quick' else OUT)/('merlin-'+label+'.png'))
        bpy.ops.render.render(write_still=True)
if mode in ('motion','all'):
    eevee(64)
    scene.render.resolution_x=800
    scene.render.resolution_y=600
    apply_activity(scene,'CasualShowcase',1)
    scene.render.fps=24
    scene.frame_step=1
    with tempfile.TemporaryDirectory(prefix='merlin-room-') as temp:
        silent=Path(temp)/'silent.mp4'
        ffmpeg(scene,silent)
        scene.render.ffmpeg.audio_codec='NONE'
        bpy.ops.render.render(animation=True)
        # Re-encode only once at high quality; Standard avoids a second AgX pass.
        mux=bpy.data.scenes.new('Delivery • whistle mux')
        bpy.context.window.scene=mux
        mux.render.resolution_x=800
        mux.render.resolution_y=600
        mux.render.resolution_percentage=100
        mux.render.fps=24
        mux.render.engine='BLENDER_EEVEE'
        mux.frame_start=1
        mux.frame_end=624
        mux.view_settings.view_transform='Standard'
        mux.view_settings.look='None'
        mux.view_settings.exposure=0
        mux.view_settings.gamma=1
        mux.render.use_sequencer=True
        editor=mux.sequence_editor_create()
        movie=editor.sequences.new_movie('MERLIN casual acting',str(silent),channel=1,frame_start=1)
        assert movie.frame_duration==624, movie.frame_duration
        editor.sequences.new_sound('Original soft whistle',str(HERE.parent/'audio'/'merlin-whistle.wav'),channel=2,frame_start=1)
        ffmpeg(mux,OUT/'merlin-casual.mp4')
        mux.render.ffmpeg.audio_codec='AAC'
        mux.render.ffmpeg.audio_bitrate=192
        mux.render.ffmpeg.audio_channels='STEREO'
        bpy.ops.render.render(animation=True)
        bpy.context.window.scene=scene
        bpy.data.scenes.remove(mux)
    print('MERLIN_CASUAL_VIDEO_COMPLETE',str(OUT/'merlin-casual.mp4'),'624 frames, 24 fps, 800 x 600, original whistle')

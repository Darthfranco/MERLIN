"""Render connected ready/activity transitions with the original room lighting."""
from pathlib import Path
import json
import sys
import tempfile

import bpy

HERE = Path(__file__).resolve().parent
OUT = HERE.parent/'previews'
sys.path.insert(0, str(HERE))
from transition_support import apply_activity

scene = bpy.context.scene
mode = sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'quick'


def eevee(samples=32):
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = .4
    scene.eevee.gtao_factor = 1.2
    scene.eevee.use_ssr = False
    scene.eevee.taa_render_samples = samples
    scene.eevee.use_soft_shadows = True
    scene.eevee.shadow_cube_size = '2048'


def ffmpeg(target, path):
    target.render.image_settings.file_format = 'FFMPEG'
    target.render.ffmpeg.format = 'MPEG4'
    target.render.ffmpeg.codec = 'H264'
    target.render.ffmpeg.constant_rate_factor = 'HIGH'
    target.render.ffmpeg.ffmpeg_preset = 'GOOD'
    target.render.filepath = str(path)


if mode in ('quick', 'stills', 'all'):
    eevee(48)
    scene.render.resolution_x = 800
    scene.render.resolution_y = 600
    scene.render.image_settings.file_format = 'PNG'
    if mode == 'quick':
        poses = [('ReadyIdle', 1, 'ready'), ('NapToReady', 20, 'wake'),
                 ('NapToReady', 34, 'stand'), ('NapToReady', 49, 'hop'),
                 ('NapToReady', 80, 'ready-wave'), ('WallTossToReady', 34, 'run'),
                 ('ReadyToNap', 52, 'lie-down'), ('ReadyToWalkWhistle', 50, 'walk-out')]
    else:
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = 64
        scene.cycles.use_denoising = True
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            prefs.compute_device_type = 'METAL'
            prefs.refresh_devices()
            for device in prefs.devices:
                device.use = device.type == 'METAL'
            scene.cycles.device = 'GPU'
        except Exception:
            scene.cycles.device = 'CPU'
        scene.render.resolution_x = 1600
        scene.render.resolution_y = 1200
        poses = [('ReadyIdle', 1, 'ready'), ('NapToReady', 49, 'wake-jump'),
                 ('WallTossToReady', 80, 'ready-wave')]
    for name, frame, label in poses:
        apply_activity(scene, name, frame)
        scene.render.filepath = str((Path('/tmp') if mode == 'quick' else OUT)/('merlin-'+label+'.png'))
        bpy.ops.render.render(write_still=True)

if mode in ('motion', 'all'):
    eevee(32)
    scene.render.resolution_x = 800
    scene.render.resolution_y = 600
    apply_activity(scene, 'InteractionShowcase')
    length = scene.frame_end
    scene.render.fps = 24
    scene.frame_step = 1
    with tempfile.TemporaryDirectory(prefix='merlin-transitions-') as temp:
        silent = Path(temp)/'silent.mp4'
        ffmpeg(scene, silent)
        scene.render.ffmpeg.audio_codec = 'NONE'
        bpy.ops.render.render(animation=True)
        mux = bpy.data.scenes.new('Delivery • connected animations')
        bpy.context.window.scene = mux
        mux.render.resolution_x = 800
        mux.render.resolution_y = 600
        mux.render.resolution_percentage = 100
        mux.render.fps = 24
        mux.render.engine = 'BLENDER_EEVEE'
        mux.frame_start = 1
        mux.frame_end = length
        mux.view_settings.view_transform = 'Standard'
        mux.view_settings.look = 'None'
        mux.view_settings.exposure = 0
        mux.view_settings.gamma = 1
        mux.render.use_sequencer = True
        editor = mux.sequence_editor_create()
        movie = editor.sequences.new_movie('MERLIN transitions', str(silent), channel=1, frame_start=1)
        assert movie.frame_duration == length, movie.frame_duration
        editor.sequences.new_sound('Original whistle', str(HERE.parent/'audio'/'merlin-whistle.wav'),
                                   channel=2, frame_start=int(scene['interaction_whistle_start']))
        ffmpeg(mux, OUT/'merlin-transitions.mp4')
        mux.render.ffmpeg.audio_codec = 'AAC'
        mux.render.ffmpeg.audio_bitrate = 192
        mux.render.ffmpeg.audio_channels = 'STEREO'
        bpy.ops.render.render(animation=True)
        bpy.context.window.scene = scene
        bpy.data.scenes.remove(mux)
    print('MERLIN_TRANSITIONS_VIDEO_COMPLETE', length, 'frames at 24 fps')

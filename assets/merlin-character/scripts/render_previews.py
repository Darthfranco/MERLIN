"""Render character scene views without rebuilding the model.

blender -b merlin.blend -P scripts/render_previews.py -- hero
blender -b merlin.blend -P scripts/render_previews.py -- poses
blender -b merlin.blend -P scripts/render_previews.py -- motion
"""
from pathlib import Path
import sys
import bpy

out = Path(__file__).resolve().parent.parent / 'previews'
out.mkdir(exist_ok=True)
mode = sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'hero'
if mode not in {'hero','poses','motion','all'}:
    raise ValueError('Use hero, poses, motion, or all')
scene = bpy.context.scene
rig = bpy.data.objects['MERLIN_Rig']


def cycles(samples):
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
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


if mode in {'hero','all'}:
    cycles(96)
    rig.animation_data.action = bpy.data.actions['Idle']
    scene.frame_set(1)
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1400
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(out / 'merlin-hero.png')
    bpy.ops.render.render(write_still=True)
if mode in {'poses','all'}:
    cycles(48)
    scene.render.resolution_x = 720
    scene.render.resolution_y = 840
    scene.render.image_settings.file_format = 'PNG'
    for name, frame in [('Wave', 42), ('Jump', 38)]:
        rig.animation_data.action = bpy.data.actions[name]
        scene.frame_set(frame)
        scene.render.filepath = str(out / ('merlin-'+name.lower()+'.png'))
        bpy.ops.render.render(write_still=True)
if mode in {'motion','all'}:
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = .35
    scene.eevee.gtao_factor = 1.2
    scene.eevee.use_ssr = True
    scene.eevee.taa_render_samples = 32
    scene.render.resolution_x = 640
    scene.render.resolution_y = 752
    rig.animation_data.action = bpy.data.actions['Showcase']
    scene.frame_start = 1
    scene.frame_end = 192
    scene.render.image_settings.file_format = 'FFMPEG'
    scene.render.ffmpeg.format = 'MPEG4'
    scene.render.ffmpeg.codec = 'H264'
    scene.render.ffmpeg.constant_rate_factor = 'HIGH'
    scene.render.filepath = str(out / 'merlin-wave-jump.mp4')
    bpy.ops.render.render(animation=True)

"""Render six reviewed presentation states without saving scene changes.

Run with Blender 4.0.2 and merlin-states.blend as the input file. The authored
lighting and camera remain unchanged; only preview settings and active clips
are selected. Panel fronts are refreshed to their emissive, unshadowed form.
"""
from pathlib import Path
import json
import sys
import time

import bpy

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / 'previews'
sys.path.insert(0, str(HERE))

from screen_content import configure_panel_screens
from screen_state_support import apply_activity

POSES = [
    ('Dance', 24, 'dance'),
    ('BodyThink', 32, 'body-think'),
    ('LeftPanelIdle', 1, 'left-panel'),
    ('CameraIdle', 25, 'camera'),
    ('FaceThink', 39, 'face-think'),
    ('FaceSearch', 30, 'face-search'),
]


def render_stills():
    scene = bpy.context.scene
    configure_panel_screens()
    OUT.mkdir(parents=True, exist_ok=True)
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.cycles.device = 'CPU'
    try:
        preferences = bpy.context.preferences.addons['cycles'].preferences
        preferences.compute_device_type = 'METAL'
        preferences.refresh_devices()
        available = [device for device in preferences.devices if device.type == 'METAL']
        for device in preferences.devices:
            device.use = device in available
        if available:
            scene.cycles.device = 'GPU'
    except (AttributeError, TypeError, RuntimeError):
        pass
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 750
    scene.render.resolution_percentage = 100
    scene.render.use_sequencer = False
    scene.render.use_compositing = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    for node in scene.node_tree.nodes:
        if node.type == 'GLARE':
            node.mute = False
    results = []
    for clip, frame, label in POSES:
        apply_activity(scene, clip, frame)
        destination = OUT / ('merlin-state-' + label + '.png')
        scene.render.filepath = str(destination)
        started = time.monotonic()
        bpy.ops.render.render(write_still=True)
        result = {'clip': clip, 'frame': frame, 'file': destination.name,
                  'seconds': round(time.monotonic() - started, 3),
                  'bytes': destination.stat().st_size}
        results.append(result)
        print('SCREEN_STATE_STILL', json.dumps(result), flush=True)
    print('SCREEN_STATE_STILLS_COMPLETE', json.dumps(results), flush=True)


if __name__ == '__main__':
    render_stills()

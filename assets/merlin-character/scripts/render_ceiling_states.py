"""One review batch for the jump, loaded grip, large layout and dock route."""
from pathlib import Path
import sys
import bpy
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from screen_state_support import apply_activity
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 48
scene.eevee.use_gtao = True
scene.eevee.use_bloom = True
if '--path-traced' in sys.argv:
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'; prefs.refresh_devices()
        available = [device for device in prefs.devices if device.type == 'METAL']
        for device in prefs.devices: device.use = device in available
        if available: scene.cycles.device = 'GPU'
    except (AttributeError, TypeError, RuntimeError):
        pass
scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.resolution_percentage = 100
scene.render.use_sequencer = False
scene.render.image_settings.file_format = 'PNG'
poses = [('ReadyToCeiling', 29, 'anticipation'), ('ReadyToCeiling', 53, 'catch'),
         ('ReadyToCeiling', 77, 'hanging'), ('ReadyToCeiling', 104, 'landing'),
         ('CeilingIdle', 1, 'full'), ('CeilingToRightPanel', 68, 'dock-right'),
         ('CeilingToLeftPanel', 126, 'dock-left'), ('CeilingThinking', 60, 'thinking')]
if '--single' in sys.argv: poses = [poses[4]]
if '--fixes' in sys.argv:
    poses = [('ReadyToCeiling', 46, 'reach'),
             ('CeilingToRightPanel', 74, 'dock-right-fixed'),
             ('CeilingToLeftPanel', 81, 'dock-left-fixed')]
for clip, frame, label in poses:
    apply_activity(scene, clip, frame)
    scene.render.filepath = '/tmp/merlin-ceiling-' + label + ('-cycles' if '--path-traced' in sys.argv else '') + '.png'
    bpy.ops.render.render(write_still=True)
    print('MERLIN_CEILING_RENDER', clip, frame, flush=True)

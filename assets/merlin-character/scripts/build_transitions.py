"""Build MERLIN's connected ready/activity animations from the reviewed room.

blender -b --factory-startup -P assets/merlin-character/scripts/build_transitions.py
"""
from pathlib import Path
import json
import sys

import bpy

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
sys.path.insert(0, str(HERE))
from animate_transitions import build_transition_actions, TRANSITION_GUIDE
from transition_support import (apply_activity, build_companions, build_return_from_activity,
                                compose_clip, owners, action_for, FACE_OBJECTS, BALL_NAME)

bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-room.blend'))
scene = bpy.context.scene
rig = bpy.data.objects['MERLIN_Rig']
actions = build_transition_actions(rig)
print('Rig transitions baked', flush=True)

# Original centered clips get explicit neutral expression/hidden prop channels,
# so switching from a nap or a throw cannot leave stale morphs or a visible toy.
for name in ('Idle', 'Wave', 'Jump', 'Showcase'):
    build_companions(name)
    print('Synchronized', name, flush=True)
for name, action in actions.items():
    source = action.get('source_activity')
    target = action.get('target_activity')
    build_companions(name, source if source != 'ReadyIdle' else None,
                     action.get('source_frame', 1),
                     target if target != 'ReadyIdle' else None,
                     action.get('target_frame', 1))
    print('Synchronized', name, flush=True)

# The review reel uses live-pose return generation to demonstrate interruption
# before each casual loop ends, without a cut or an exposure fade.
build_return_from_activity('Nap', 48, 'PreviewNapReturn')
build_return_from_activity('WallToss', 90, 'PreviewWallReturn')
segments = [
    ('ReadyIdle', 1, 1, 12),
    ('ReadyToNap', 1, 96), ('Nap', 1, 48), ('PreviewNapReturn', 1, 108),
    ('ReadyIdle', 1, 1, 12),
    ('ReadyToWallToss', 1, 96), ('WallToss', 1, 90), ('PreviewWallReturn', 1, 108),
    ('ReadyIdle', 1, 1, 12),
    ('ReadyToWalkWhistle', 1, 96), ('WalkWhistle', 1, 192), ('WalkWhistleToReady', 1, 108),
    ('ReadyIdle', 1, 1, 24),
]
showcase = compose_clip('InteractionShowcase', segments)
print('Continuous interaction showcase composed', flush=True)
scene.timeline_markers.clear()
offset = 0
whistle_start = 1
manifest_segments = []
for segment in segments:
    name, start, end = segment[:3]
    duration = segment[3] if len(segment) > 3 else end-start+1
    scene.timeline_markers.new(name, frame=offset+1)
    manifest_segments.append({'clip': name, 'start': offset+1, 'end': offset+duration,
                              'source_start': start, 'source_end': end})
    if name == 'WalkWhistle':
        whistle_start = offset+1
    offset += duration
showcase['timeline'] = json.dumps(manifest_segments)
showcase['loop'] = True
editor = scene.sequence_editor_create()
strip = editor.sequences.new_sound('Interaction whistle', str(OUT/'audio'/'merlin-whistle.wav'),
                                    channel=2, frame_start=whistle_start)
strip.sound.pack()
strip.sound.filepath = '//audio/merlin-whistle.wav'
scene['interaction_guide'] = json.dumps(TRANSITION_GUIDE)
scene['interaction_whistle_start'] = whistle_start
scene['interaction_notes'] = ('Every return settles into ReadyIdle frame 1 after waving. '
    'Use transition_support.build_return_from_activity for an arbitrary playhead; '
    'an airborne ball is caught before departure. Original model and lighting preserved.')

export_names = ['Idle', 'Wave', 'Jump', 'WalkWhistle', 'WallToss', 'Nap'] + list(actions)
for owner, datablock in owners():
    datablock.animation_data.action = None
    for track in list(datablock.animation_data.nla_tracks):
        datablock.animation_data.nla_tracks.remove(track)
    for name in export_names:
        action = action_for(name, owner)
        if action is None:
            raise RuntimeError(f'Missing {name} animation on {owner}')
        track = datablock.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.action_frame_start = 1
        strip.action_frame_end = action.frame_range[1]
        track.mute = True
for name in FACE_OBJECTS:
    for key in list(bpy.data.objects[name].data.shape_keys.key_blocks)[1:]:
        key.value = 0
ball = bpy.data.objects[BALL_NAME]
ball.scale = (0, 0, 0)
ball.location = (0, 0, -5)
bpy.ops.object.select_all(action='DESELECT')
for obj in bpy.data.collections['MERLIN • Character'].objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=str(OUT/'merlin-transitions.glb'), export_format='GLB',
    use_selection=True, export_animations=True, export_animation_mode='NLA_TRACKS',
    export_nla_strips=True, export_optimize_animation_size=False,
    export_optimize_animation_keep_anim_object=True, export_frame_range=False,
    export_force_sampling=True, export_anim_slide_to_zero=True,
    export_skins=True, export_morph=True, export_cameras=False, export_lights=False,
    export_extras=True)
for _, datablock in owners():
    for track in list(datablock.animation_data.nla_tracks):
        datablock.animation_data.nla_tracks.remove(track)

manifest = {
    'fps': 24,
    'ready': 'ReadyIdle',
    'ready_frame': 1,
    'clips': {name: {'frames': round(bpy.data.actions[name].frame_range[1]),
                     'source': bpy.data.actions[name].get('source_activity'),
                     'source_frame': bpy.data.actions[name].get('source_frame'),
                     'target': bpy.data.actions[name].get('target_activity'),
                     'target_frame': bpy.data.actions[name].get('target_frame'),
                     'wave_start': bpy.data.actions[name].get('wave_start'),
                     'wave_end': bpy.data.actions[name].get('wave_end')}
              for name in export_names},
    'routes': {name: {'enter': 'ReadyTo'+name, 'activity': name, 'exit': name+'ToReady'}
               for name in ('Nap', 'WallToss', 'WalkWhistle')},
    'arbitrary_pose_authoring': 'transition_support.build_return_from_activity(activity, frame)',
    'ball_interrupt_policy': 'Finish an in-flight throw through catch, then return.',
    'audio': {'file': 'audio/merlin-whistle.wav', 'clip': 'WalkWhistle', 'start_frame': 1},
    'showcase': manifest_segments,
}
(OUT/'transitions.json').write_text(json.dumps(manifest, indent=2)+'\n')
# Keep an immediately usable command alongside the editable scene.
text = bpy.data.texts.new('MERLIN • Play transitions.py')
text.write("""# Run in Blender's Python console after adding the scripts folder to sys.path:
# from transition_support import apply_activity, build_return_from_activity
# apply_activity(bpy.context.scene, 'ReadyToNap')
# name = build_return_from_activity('WalkWhistle', 76)
# apply_activity(bpy.context.scene, name)
# The default timeline plays the complete connected InteractionShowcase.
""")
apply_activity(scene, 'InteractionShowcase', 1)
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64
scene.render.resolution_x = 1600
scene.render.resolution_y = 1200
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '//previews/merlin-ready.png'
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-transitions.blend'), compress=True)
print('MERLIN_TRANSITIONS_COMPLETE', json.dumps({'frames': offset, 'clips': export_names}))

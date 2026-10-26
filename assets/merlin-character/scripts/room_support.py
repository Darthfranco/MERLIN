"""Select synchronized character, face and prop actions in the tablet room."""
import bpy

CLIP_LENGTHS = {'WalkWhistle': 192, 'WallToss': 240, 'Nap': 192, 'CasualShowcase': 624}
FACE_OBJECTS = ('Eye • L', 'Eye • R', 'Face • luminous smile')
BALL_NAME = 'Prop • cyan play ball'


def apply_activity(scene, name, frame=1):
    if name not in CLIP_LENGTHS:
        raise ValueError(f'Unknown room activity: {name}')
    rig = bpy.data.objects['MERLIN_Rig']
    rig.animation_data.action = bpy.data.actions[name]
    for objname in FACE_OBJECTS:
        obj = bpy.data.objects[objname]
        obj.data.shape_keys.animation_data.action = bpy.data.actions[f'{name} • {objname}']
    ball = bpy.data.objects.get(BALL_NAME)
    if ball:
        ball.animation_data.action = bpy.data.actions[f'{name} • Ball']
    scene.frame_start = 1
    scene.frame_end = CLIP_LENGTHS[name]
    scene['active_activity'] = name
    if scene.use_nodes:
        fade=scene.node_tree.nodes.get('Presentation • scene transitions')
        if fade:
            fade.mute=name!='CasualShowcase'
    if scene.sequence_editor:
        for strip in scene.sequence_editor.sequences_all:
            if strip.type == 'SOUND':
                strip.mute = name not in ('WalkWhistle', 'CasualShowcase')
    scene.frame_set(frame)
    bpy.context.view_layer.update()


def activity_frame(name, frame):
    if name != 'CasualShowcase':
        return name, frame
    if frame <= 192:
        return 'WalkWhistle', frame
    if frame <= 432:
        return 'WallToss', frame - 192
    return 'Nap', frame - 432

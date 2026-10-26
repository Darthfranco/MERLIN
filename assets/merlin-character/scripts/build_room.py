"""Extend the original MERLIN model with a landscape tablet room using the original lighting.

Run after build_character.py. The original portrait assets are preserved.
The ball path is authored ballistic motion, not a nondeterministic simulation.
"""
from pathlib import Path
import sys
import math
import json
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
sys.path.insert(0, str(HERE))
from room_support import CLIP_LENGTHS, FACE_OBJECTS, BALL_NAME, apply_activity, activity_frame

bpy.ops.wm.open_mainfile(filepath=str(OUT / 'merlin.blend'))
scene = bpy.context.scene
rig = bpy.data.objects['MERLIN_Rig']
# Keep the original character proportions, per the owner's latest correction.
rig.scale=(1,1,1)
bpy.context.view_layer.update()
character = bpy.data.collections['MERLIN • Character']
stage = bpy.data.collections['STUDIO • Dark room']
stage.name='STUDIO • Tablet room'
lights = bpy.data.collections['LIGHTS • Softboxes + underglow']
rig.animation_data.action = bpy.data.actions['Idle']
scene.frame_set(1)
for o in list(stage.objects):
    bpy.data.objects.remove(o, do_unlink=True)
# Preserve every original studio light from merlin.blend unchanged.


def material(name, color, roughness=.92, emission=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    p = mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Specular IOR Level'].default_value = .12
    if emission:
        p.inputs['Emission Color'].default_value = (*emission[0], 1)
        p.inputs['Emission Strength'].default_value = emission[1]
    return mat


def move_to(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def cube(name, loc, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    move_to(o, stage)
    if bevel:
        b = o.modifiers.new('Quiet edge radius', 'BEVEL')
        b.width = bevel
        b.segments = 4
        o.modifiers.new('Surface normals', 'WEIGHTED_NORMAL')
    return o


floor = material('Room • original midnight floor', (.008, .013, .024), .55)
wall = material('Room • original midnight walls', (.008, .013, .024), .85)
cube('Room • floor', (0, 0, -.126), (20, 25, .3), floor)
cube('Room • left wall', (-5.0, -12.825, 10), (1, 34.35, 20), wall)
cube('Room • right wall', (5.0, -12.825, 10), (1, 34.35, 20), wall)
cube('Room • back wall', (0, 4.35, 10), (9.0, .3, 20), wall)
# A small cyclorama radius keeps the backdrop clean while side walls remain
# real, visible surfaces for leaning and bouncing.
cove_mat=material('Room • curved backdrop',(.008,.013,.024),.55)
nt=cove_mat.node_tree
geo=nt.nodes.new('ShaderNodeNewGeometry')
xyz=nt.nodes.new('ShaderNodeSeparateXYZ')
remap=nt.nodes.new('ShaderNodeMapRange')
remap.inputs['From Min'].default_value=.024
remap.inputs['From Max'].default_value=.624
mix=nt.nodes.new('ShaderNodeMixRGB')
mix.inputs[1].default_value=(.008,.013,.024,1)
mix.inputs[2].default_value=(.008,.013,.024,1)
nt.links.new(geo.outputs['Position'],xyz.inputs['Vector'])
nt.links.new(xyz.outputs['Z'],remap.inputs['Value'])
nt.links.new(remap.outputs['Result'],mix.inputs[0])
nt.links.new(mix.outputs[0],nt.nodes.get('Principled BSDF').inputs['Base Color'])
verts=[]
for i in range(49):
    a=math.pi*.5*i/48
    for x in (-4.5,4.5):
        verts.append((x,3.60+.6*math.sin(a),.624-.6*math.cos(a)))
mesh=bpy.data.meshes.new('Room • cyclorama radius')
mesh.from_pydata(verts,[],[(2*i,2*i+1,2*i+3,2*i+2) for i in range(48)])
mesh.update()
cove=bpy.data.objects.new('Room • soft floor transition',mesh)
stage.objects.link(cove)
cove.data.materials.append(cove_mat)
for p in mesh.polygons:p.use_smooth=True
scene.world.name='World • midnight'
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.022, .031, .058, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .18


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def area(name, loc, target, power, color, size, size_y):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.color = color
    data.shape = 'RECTANGLE'
    data.size = size
    data.size_y = size_y
    o = bpy.data.objects.new(name, data)
    lights.objects.link(o)
    o.location = loc
    aim(o, target)
    return o


# The key, fill, rim, top and both sole lights retain their original values.

bpy.ops.object.camera_add(location=(0, -18, 8.3))
camera = bpy.context.object
camera.name = 'Camera • landscape tablet'
move_to(camera, stage)
aim(camera, (0, 0, 2.5))
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 10.2
camera.data.lens = 50
scene.camera = camera
scene.render.resolution_x = 1600
scene.render.resolution_y = 1200
scene.render.resolution_percentage = 100
scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
scene.view_settings.exposure = .35
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.fps = 24
scene['canvas'] = 'Landscape tablet composition / 4:3 / 1600 x 1200'
scene['room_bounds'] = json.dumps({'left': -4.5, 'right': 4.5, 'floor': .024, 'back': 4.20})
scene['note'] = 'Standalone art/animation study; not an implemented iPad application.'
scene['audio'] = '//audio/merlin-whistle.wav; align to WalkWhistle frame 1 (also CasualShowcase frame 1)'
editor=scene.sequence_editor_create()
sound_strip=editor.sequences.new_sound('Original soft whistle',str(OUT/'audio'/'merlin-whistle.wav'),channel=1,frame_start=1)
sound_strip.sound.pack()
sound_strip.sound.filepath='//audio/merlin-whistle.wav'
scene.render.use_sequencer=False


def head_front(x, z):
    inside = max(0, 1 - abs(x / 1.04)**(2/.65) - abs((z - 2.98) / .71)**(2/.65))
    return -.54 * inside**(.65/2)


# Face shapes stay exactly on the curved display, rather than floating lids.
for name in ('Eye • L', 'Eye • R'):
    eye = bpy.data.objects[name]
    eye.shape_key_add(name='Basis')
    for shape in ('Blink', 'Sleep', 'Sleepy'):
        key = eye.shape_key_add(name=shape)
        for i, p in enumerate(key.data):
            co = eye.data.vertices[i].co
            x, z = co.x, co.z
            if shape == 'Blink':
                zz = z * .045
            elif shape == 'Sleep':
                x *= 1.52
                zz = z * .055 - .048 * (1 - (co.x / .0875)**2)
            else:
                zz = z * .50 - .052
            xx = x + eye.location.x
            world_z = zz + eye.location.z
            p.co = (x, head_front(xx, world_z) - .0015, zz)

mouth = bpy.data.objects['Face • luminous smile']
mouth.shape_key_add(name='Basis')
whistle = mouth.shape_key_add(name='Whistle')
for i, p in enumerate(whistle.data):
    if i < 130:
        t = (i // 2) / 64
        a = 2 * math.pi * t
        sign = 1 if i % 2 == 0 else -1
        xx = (.054 + sign*.011) * math.cos(a)
        zz = 2.81 + (.062 + sign*.011) * math.sin(a)
    else:
        cap_index = (i - 130) % 33
        if cap_index == 0:
            xx, zz = .054, 2.81
        else:
            a = 2 * math.pi * (cap_index - 1) / 32
            xx, zz = .054 + .011*math.cos(a), 2.81 + .011*math.sin(a)
    p.co = (xx, head_front(xx, zz)-.0015, zz)
small = mouth.shape_key_add(name='SleepSmile')
for i, p in enumerate(small.data):
    co = mouth.data.vertices[i].co
    xx, zz = co.x * .58, 2.80 + (co.z-2.80)*.65
    p.co = (xx, head_front(xx, zz)-.0015, zz)


def smooth(t):
    t = max(0, min(1, t))
    return t*t*t*(t*(t*6-15)+10)


def pulse(frame, center, width):
    return .5 + .5*math.cos(math.pi*(frame-center)/width) if abs(frame-center) < width else 0


def face_values(name, frame):
    activity, f = activity_frame(name, frame)
    if activity == 'WalkWhistle':
        blink = max(pulse(f, c, 3) for c in (19, 96, 177))
        whistling = max(smooth((f-22)/7)*(1-smooth((f-81)/7)), smooth((f-96)/7)*(1-smooth((f-158)/7)))
        return {'Blink': blink, 'Sleep': 0, 'Sleepy': .12 * (1-blink), 'Whistle': whistling, 'SleepSmile': 0}
    if activity == 'WallToss':
        blink = max(pulse(f, c, 3) for c in (12, 103, 121, 219))
        # Heavy eyelids during the pause, briefly alert as the ball returns.
        sleepy = .5 * (1 - max(pulse(f, 82, 18), pulse(f, 190, 18)))
        return {'Blink': blink, 'Sleep': 0, 'Sleepy': sleepy * (1-blink), 'Whistle': 0, 'SleepSmile': .1}
    return {'Blink': 0, 'Sleep': 1, 'Sleepy': 0, 'Whistle': 0, 'SleepSmile': 1}


def set_linear(action):
    for curve in action.fcurves:
        for key in curve.keyframe_points:
            key.interpolation = 'LINEAR'


for name, length in CLIP_LENGTHS.items():
    for objname in FACE_OBJECTS:
        obj = bpy.data.objects[objname]
        keys = obj.data.shape_keys
        keys.animation_data_create()
        action = bpy.data.actions.new(f'{name} • {objname}')
        action.use_fake_user = True
        keys.animation_data.action = action
        for frame in range(1, length + 1):
            values = face_values(name, frame)
            for key in list(keys.key_blocks)[1:]:
                key.value = values[key.name]
                key.keyframe_insert('value', frame=frame)
        set_linear(action)

# A small tactile toy, with a single dark great-circle join.
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=.13)
ball = bpy.context.object
ball.name = BALL_NAME
move_to(ball, character)
ballmat = material('Prop • soft cyan', (.035, .29, .50), .83, ((.015, .16, .30), .35))
ballseam = material('Prop • fine blue join', (.008, .06, .11), .85)
ball.data.materials.append(ballmat)
ball.data.materials.append(ballseam)
for p in ball.data.polygons:
    p.use_smooth = True
    p.material_index = 1 if abs(p.center.z) < .009 else 0
ball['radius'] = .13
ball['motion'] = 'Authored ballistic arcs, wall rebound, floor bounce, hand catch. No physics cache.'

if '--static' in sys.argv:
    ball.hide_render = True
    for objname in FACE_OBJECTS:
        keys = bpy.data.objects[objname].data.shape_keys
        keys.animation_data.action = None
        for key in list(keys.key_blocks)[1:]:
            key.value = 0
    scene.render.resolution_x = 800
    scene.render.resolution_y = 600
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = .4
    scene.eevee.taa_render_samples = 32
    scene.render.filepath = '/tmp/merlin-room-static.png'
    bpy.ops.render.render(write_still=True)
    sys.exit(0)

from animate_casual import build_casual_actions, CASUAL_GUIDE, get_hand_position
casual = build_casual_actions(rig)
throws = CASUAL_GUIDE['WallToss']['throws']


def hand(frame):
    return Vector(get_hand_position(rig, frame, action='WallToss', hand='L'))


# Exact events are stored for independent geometry/contact verification.
ball_events = []
for event in throws:
    release, hit, floor_hit, catch = (event[k] for k in ('release', 'wall', 'floor', 'catch'))
    start, finish = hand(release), hand(catch)
    t_wall = (hit-release)/24
    t_floor = (floor_hit-release)/24
    t_after = (catch-floor_hit)/24
    z_floor, x_wall = .024+.13, 4.5-.13
    restitution = .78
    denom = .5*restitution*t_floor*t_after - .5*t_after*t_after
    gravity = (finish.z-z_floor-restitution*(start.z-z_floor)*t_after/t_floor)/denom
    if not 0 < gravity < 100:
        raise ValueError(f'Ball timing cannot make a plausible arc: g={gravity}, start={start}, finish={finish}')
    vz0 = (z_floor-start.z)/t_floor + .5*gravity*t_floor
    vx0 = (x_wall-start.x)/t_wall
    vx_back = (finish.x-x_wall)/((catch-hit)/24)
    wall_z = start.z + vz0*t_wall - .5*gravity*t_wall*t_wall
    floor_x = x_wall + vx_back*(floor_hit-hit)/24
    ball_events.append({**event, 'start': list(start), 'end': list(finish), 'wall_position': [x_wall, start.y, wall_z],
                        'floor_position': [floor_x, start.y, z_floor], 'gravity': gravity,
                        'floor_restitution': restitution, 'wall_restitution': abs(vx_back/vx0),
                        'vz0': vz0, 'vx0': vx0, 'vx_back': vx_back})
scene['ball_events'] = json.dumps(ball_events)


def ball_pose(frame):
    for ev in ball_events:
        release, hit, floor_hit, catch = (ev[k] for k in ('release', 'wall', 'floor', 'catch'))
        if release <= frame <= catch:
            t = (frame-release)/24
            start, finish = Vector(ev['start']), Vector(ev['end'])
            x = start.x + ev['vx0']*t if frame <= hit else 4.37+ev['vx_back']*(frame-hit)/24
            if frame <= floor_hit:
                z = start.z+ev['vz0']*t-.5*ev['gravity']*t*t
            else:
                floor_time = (floor_hit-release)/24
                bounce = -ev['floor_restitution']*(ev['vz0']-ev['gravity']*floor_time)
                dt = (frame-floor_hit)/24
                z = .154+bounce*dt-.5*ev['gravity']*dt*dt
            y = start.y+(finish.y-start.y)*(frame-release)/(catch-release)
            return Vector((x,y,z))
    return hand(frame)


cache = {f: ball_pose(f) for f in range(1,241)}
for name, length in CLIP_LENGTHS.items():
    ball.animation_data_create()
    action = bpy.data.actions.new(f'{name} • Ball')
    action.use_fake_user = True
    ball.animation_data.action = action
    for frame in range(1,length+1):
        activity, f = activity_frame(name,frame)
        active = activity == 'WallToss'
        ball.location = cache[f] if active else (0,0,-5)
        ball.scale = (1,1,1) if active else (0,0,0)
        ball.rotation_euler = (.13*f,.07*f,.05*f)
        for path in ('location','scale','rotation_euler'):
            ball.keyframe_insert(path,frame=frame)
    set_linear(action)

scene.timeline_markers.clear()
for frame, label in [(1,'STROLL / whistle'),(193,'WALL / unwind'),(232,'THROW'),(250,'WALL CONTACT'),(262,'FLOOR BOUNCE'),(278,'CATCH'),(340,'THROW AGAIN'),(433,'NAP / hands behind head'),(624,'REST')]:
    scene.timeline_markers.new(label,frame=frame)
rig['casual_activities'] = json.dumps({name:CLIP_LENGTHS[name] for name in CLIP_LENGTHS})
scene['casual_guide'] = json.dumps(CASUAL_GUIDE)

# Short fades make the presentation cuts explicit; individual actions stay lit.
fade=scene.node_tree.nodes.new('CompositorNodeExposure')
fade.name='Presentation • scene transitions'
fade.location=(350,-120)
composite=next(n for n in scene.node_tree.nodes if n.type=='COMPOSITE')
source=composite.inputs['Image'].links[0].from_socket
scene.node_tree.links.new(source,fade.inputs['Image'])
scene.node_tree.links.new(fade.outputs['Image'],composite.inputs['Image'])
for frame,value in [(1,0),(185,0),(192,-16),(193,-16),(200,0),(425,0),(432,-16),(433,-16),(440,0),(624,0)]:
    fade.inputs['Exposure'].default_value=value
    fade.inputs['Exposure'].keyframe_insert('default_value',frame=frame)

# Matching NLA track names merge skeletal, morph-target and prop channels into
# each portable clip. The complete room is retained in Blender, not the GLB.
bpy.ops.object.select_all(action='DESELECT')
for obj in character.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
animated = [(rig, rig)] + [(bpy.data.objects[n].data.shape_keys,bpy.data.objects[n]) for n in FACE_OBJECTS] + [(ball,ball)]
for datablock, obj in animated:
    datablock.animation_data.action = None
    for track in list(datablock.animation_data.nla_tracks):
        datablock.animation_data.nla_tracks.remove(track)
for objname in FACE_OBJECTS:
    for key in list(bpy.data.objects[objname].data.shape_keys.key_blocks)[1:]:
        key.value=0
ball.location=(0,0,-5)
ball.scale=(0,0,0)
export_names=['Idle','Wave','Jump','WalkWhistle','WallToss','Nap']
for datablock, obj in animated:
    names = export_names if datablock == rig else ['WalkWhistle','WallToss','Nap']
    for name in names:
        action_name = name if datablock == rig else f'{name} • Ball' if obj == ball else f'{name} • {obj.name}'
        action = bpy.data.actions[action_name]
        track = datablock.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name,1,action)
        strip.action_frame_start = 1
        strip.action_frame_end = action.frame_range[1]
        track.mute = True
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=str(OUT/'merlin-room.glb'),export_format='GLB',use_selection=True,
    export_animations=True,export_animation_mode='NLA_TRACKS',export_nla_strips=True,
    export_optimize_animation_size=False,
    export_optimize_animation_keep_anim_object=True,
    export_frame_range=False,export_force_sampling=True,export_anim_slide_to_zero=True,
    export_skins=True,export_morph=True,export_cameras=False,export_lights=False,export_extras=True)
for datablock,obj in animated:
    for track in list(datablock.animation_data.nla_tracks):
        datablock.animation_data.nla_tracks.remove(track)
apply_activity(scene,'CasualShowcase',1)
scene.render.engine='CYCLES'
scene.cycles.samples=96
scene.render.image_settings.file_format='PNG'
scene.render.filepath='//previews/merlin-room.png'
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-room.blend'),compress=True)
print('MERLIN_ROOM_COMPLETE',json.dumps(ball_events))

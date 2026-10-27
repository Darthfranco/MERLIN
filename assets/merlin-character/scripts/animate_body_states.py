"""Centered, connected music-jam and thoughtful performances for MERLIN.

All motion is baked onto the existing fifteen bones and display morphs. Four
small musical-note meshes have explicit transform companions in every clip;
their visibility never relies on Blender-only hide flags. These are authored
visual states, with no music service or automatic assistant-state integration.
"""
from math import cos, pi, sin

import bpy
from mathutils import Matrix, Vector

from animate_character import BONE_NAMES, _ramp
from animate_casual import _limb, _pose, _rotation, _set_pose
from animate_transitions import (_apply, _blend, _capture, _clearance, _context,
                                 _finish, _key, _new_action, _sample)
from expressive_face import conform_expression
from interaction_support import owners as interaction_owners, action_for as interaction_action
from room_support import FACE_OBJECTS
from transition_support import linear, new_action


BODY_STATE_GUIDE = {
    'ReadyToDance': {'frames':36, 'loop':False, 'source_activity':'ReadyIdle',
        'source_frame':1, 'target_activity':'Dance', 'target_frame':1,
        'poses':{1:'Ready',12:'Hear the beat',24:'Find the groove',36:'Jam'}},
    'Dance': {'frames':144, 'loop':True, 'source_activity':'Dance',
        'source_frame':1, 'target_activity':'Dance', 'target_frame':1,
        'poses':{1:'Jam',24:'Left groove',48:'Head nod',72:'Right groove',108:'Enjoy',144:'Jam'}},
    'DanceToReady': {'frames':36, 'loop':False, 'source_activity':'Dance',
        'source_frame':1, 'target_activity':'ReadyIdle', 'target_frame':1,
        'poses':{1:'Jam',18:'Last beat',36:'Ready'}},
    'ReadyToThink': {'frames':36, 'loop':False, 'source_activity':'ReadyIdle',
        'source_frame':1, 'target_activity':'BodyThink', 'target_frame':1,
        'poses':{1:'Ready',12:'Consider',25:'Hand to chin',36:'Thinking'}},
    'BodyThink': {'frames':144, 'loop':True, 'source_activity':'BodyThink',
        'source_frame':1, 'target_activity':'BodyThink', 'target_frame':1,
        'poses':{1:'Consider',32:'Chin touch',62:'Look up',91:'Weigh another idea',120:'Reconsider',144:'Consider'}},
    'ThinkToReady': {'frames':36, 'loop':False, 'source_activity':'BodyThink',
        'source_frame':1, 'target_activity':'ReadyIdle', 'target_frame':1,
        'poses':{1:'Thinking',16:'Reconnect',36:'Ready'}},
}
NOTE_PREFIX = 'Music note '


def body_state_owners():
    """Stable, short ASCII owner IDs for the four independent note transforms."""
    return [(obj['merlin_body_state_owner'], obj)
            for obj in sorted(bpy.data.objects, key=lambda obj:obj.name)
            if obj.get('merlin_body_state_owner')]


def state_action_for(clip, owner):
    return bpy.data.actions.get(f'{clip} • {owner}')


def _hold(frame, a, b, c, d):
    return _ramp(frame,a,b)*(1-_ramp(frame,c,d))


def _pulse(frame, center, width=3):
    return .5+.5*cos(pi*(frame-center)/width) if abs(frame-center)<width else 0.


def _feet(rig, context, phase=0, dancing=False):
    """Planted feet carry the lateral torso motion; alternate light toe lifts."""
    basis,_,_=context
    for side,sign in [('L',1),('R',-1)]:
        lift=.035*max(0.,sign*sin(phase))**3 if dancing else 0.
        target=Vector((sign*.33,-.12,.25+lift))
        hip=rig.pose.bones['thigh.'+side].head.copy()
        _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,target,
              hip+Vector((sign*.12,-1,0)),Matrix.Identity(3),Matrix.Identity(3),basis)
    bpy.context.view_layer.update()


def _dance_pose(rig, frame, context):
    rig.animation_data.action=None
    basis,inverse,_=context
    phase=2*pi*(frame-1)/143
    sway=sin(2*phase)
    beat=cos(6*phase)
    p=_pose()
    p['root']=Vector((.13*sway,.012*sin(4*phase),-.10-.035*(1-beat)))
    p['rotation']['body']=[2.5+1.7*beat,-4.2*sway,2.2*sin(2*phase+.25)]
    p['rotation']['head']=[-2+5.2*sin(6*phase-.2),3.0*sway,-3.8*sin(2*phase+.12)]
    for side,sign in [('L',1),('R',-1)]:
        p['rotation']['upper_arm.'+side]=[-21-sign*12*sin(2*phase+.35),-sign*(14+4*beat),sign*2]
        p['rotation']['forearm.'+side]=[-34-sign*13*sin(2*phase-.3),-sign*6,sign*4*sin(2*phase)]
        p['rotation']['hand.'+side]=[8+sign*7*sin(2*phase-.55),0,sign*4]
    _set_pose(rig,p,basis,inverse)
    _feet(rig,context,2*phase,True)
    _clearance(rig,context)
    return _capture(rig)


def _think_pose(rig, frame, context):
    rig.animation_data.action=None
    basis,inverse,_=context
    phase=2*pi*(frame-1)/143
    look=_hold(frame,36,57,87,112)
    other=_hold(frame,85,105,120,138)
    chin=1-.86*_hold(frame,44,63,99,124)
    p=_pose()
    p['root']=Vector((-.045+.07*sin(phase),0,-.055-.010*(1-cos(2*phase))))
    p['rotation']['body']=[1.4+.7*sin(2*phase),-1.6+1.8*sin(phase),1.2*sin(phase)]
    p['rotation']['head']=[-3-6*look+1.5*other,-3+2*sin(phase),-5-7*look+13*other]
    p['rotation']['upper_arm.R']=[-15,7,-3]
    p['rotation']['forearm.R']=[-42-5*sin(phase),5,-4]
    p['rotation']['hand.R']=[12,0,0]
    _set_pose(rig,p,basis,inverse)
    _feet(rig,context)
    # The hand sits just below the chin, supported by a low, outward elbow.
    # On the next thought it lowers slightly, then returns instead of freezing.
    shoulder=rig.pose.bones['upper_arm.L'].head.copy()
    target=Vector((.32-.035*look,-.45,2.18-.22*(1-chin)))
    target.x+=.04*sin(phase)
    target.z+=.012*sin(4*phase)*chin
    pole=shoulder+Vector((.30,-.12,-.50))
    _limb(rig,'upper_arm.L','forearm.L','hand.L',target,pole,
          Matrix.Identity(3),_rotation(x=-115,y=-15,z=-10),basis)
    bpy.context.view_layer.update()
    _clearance(rig,context)
    return _capture(rig)


def _tube(vertices, faces, path, radius):
    begin=len(vertices);segments=10
    for i,(x,y) in enumerate(path):
        previous=Vector(path[max(0,i-1)]);following=Vector(path[min(len(path)-1,i+1)])
        tangent=(following-previous).normalized();normal=Vector((-tangent.y,tangent.x))
        for j in range(segments):
            angle=2*pi*j/segments
            vertices.append((x+radius*cos(angle)*normal.x,y+radius*cos(angle)*normal.y,radius*sin(angle)))
    for i in range(len(path)-1):
        for j in range(segments):
            a=begin+i*segments+j;b=begin+i*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    faces.extend([tuple(reversed(range(begin,begin+segments))),
                  tuple(range(begin+(len(path)-1)*segments,begin+len(path)*segments))])


def _note_head(vertices, faces, x, y):
    begin=len(vertices);rings=10;segments=20
    for i in range(rings+1):
        phi=pi*i/rings
        for j in range(segments):
            theta=2*pi*j/segments
            a=.112*sin(phi)*cos(theta);b=.071*sin(phi)*sin(theta)
            vertices.append((x+a*cos(.35)-b*sin(.35),y+a*sin(.35)+b*cos(.35),.028*cos(phi)))
    for i in range(rings):
        for j in range(segments):
            a=begin+i*segments+j;b=begin+i*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))


def _create_notes():
    for _,obj in body_state_owners():
        mesh=obj.data
        bpy.data.objects.remove(obj,do_unlink=True)
        if mesh.users==0:bpy.data.meshes.remove(mesh)
    collection=bpy.data.collections['MERLIN • Character']
    material=bpy.data.objects['Eye • L'].data.materials[0]
    for index in range(4):
        vertices=[];faces=[]
        if index==2:
            for x,y in [(-.16,-.15),(.12,-.11)]:
                _note_head(vertices,faces,x,y)
                _tube(vertices,faces,[(x+.085,y),(x+.085,.25+(x+.16)*.17)],.022)
            _tube(vertices,faces,[(-.075,.25),(.205,.298)],.030)
        else:
            _note_head(vertices,faces,-.055,-.16)
            _tube(vertices,faces,[(.03,-.16),(.03,.29)],.022)
            if index!=1:
                control=[Vector(p) for p in [(.03,.28),(.24,.20),(.22,.09),(.11,.08)]]
                path=[]
                for j in range(15):
                    t=j/14;p=(1-t)**3*control[0]+3*(1-t)**2*t*control[1]+3*(1-t)*t*t*control[2]+t**3*control[3]
                    path.append(tuple(p))
                _tube(vertices,faces,path,.023)
        mesh=bpy.data.meshes.new(NOTE_PREFIX+f'{index+1:02d} mesh')
        mesh.from_pydata(vertices,[],faces);mesh.update()
        uv=mesh.uv_layers.new(name='Display gradient')
        for polygon in mesh.polygons:
            polygon.use_smooth=True
            for loop in polygon.loop_indices:
                co=mesh.vertices[mesh.loops[loop].vertex_index].co
                uv.data[loop].uv=((co.x+.30)/.60,(co.y+.25)/.60)
        obj=bpy.data.objects.new(NOTE_PREFIX+f'{index+1:02d}',mesh);collection.objects.link(obj)
        obj.data.materials.append(material)
        obj['merlin_body_state_owner']=f'MusicNote{index+1:02d}'
        obj['music_note_index']=index
        obj.rotation_mode='XYZ';obj.scale=(0,0,0);obj.animation_data_create()


def _note_transform(index, clip, frame):
    phase=0.;amount=0.
    if clip=='Dance':phase=2*pi*((1 if frame==144 else frame)-1)/143;amount=1.
    elif clip=='ReadyToDance':amount=_ramp(frame,10,31)
    elif clip=='DanceToReady':amount=1-_ramp(frame,3,24)
    bases=[(-1.70,-.35,1.92),(1.68,-.30,2.53),(-1.30,-.20,4.05),(1.30,-.15,4.25)]
    location=Vector(bases[index]);angle=phase+index*pi*.63
    location.x+=.12*sin(angle);location.z+=.11*sin(angle+.35)
    rotation=bpy.context.scene.camera.rotation_euler.copy()
    rotation.rotate_axis('Z',(.13 if index%2 else -.13)+.11*sin(angle))
    scale=amount*(.94+.06*sin(angle)**2)
    return location,rotation,Vector((scale,)*3)


def ensure_body_state_companions(clip, frames=None):
    """Bake notes for native dance clips and explicit hidden tracks elsewhere."""
    if frames is None:frames=round(bpy.data.actions[clip].frame_range[1])
    for owner,obj in body_state_owners():
        action=new_action(f'{clip} • {owner}')
        obj.animation_data_create();obj.animation_data.action=action
        for frame in range(1,frames+1):
            obj.location,obj.rotation_euler,obj.scale=_note_transform(obj['music_note_index'],clip,frame)
            for channel in ('location','rotation_euler','scale'):
                obj.keyframe_insert(channel,frame=frame)
        linear(action)
    return {owner:state_action_for(clip,owner) for owner,_ in body_state_owners()}


def _clone_ready_companions(clip, frames):
    for owner,data in interaction_owners():
        if owner=='rig':continue
        source=interaction_action('ReadyIdle',owner)
        if source is None:raise ValueError('Missing ReadyIdle companion: '+owner)
        target=new_action(f'{clip} • '+('Ball' if owner=='ball' else owner))
        for old in source.fcurves:
            curve=target.fcurves.new(old.data_path,index=old.array_index)
            value=old.evaluate(1)
            curve.keyframe_points.add(2)
            curve.keyframe_points.foreach_set('co',[1,value,frames,value])
        linear(target)


def _face_values(clip, owner, frame):
    keys=bpy.data.objects[owner].data.shape_keys
    action=interaction_action(clip,owner)
    return {key.name:action.fcurves.find(key.path_from_id('value')).evaluate(frame)
            if action.fcurves.find(key.path_from_id('value')) else 0.
            for key in list(keys.key_blocks)[1:]}


def _loop_face(clip, frame, owner):
    values=_face_values('ReadyIdle',owner,1)
    phase=2*pi*(frame-1)/143
    if clip=='Dance':
        blink=max(_pulse(frame,53),_pulse(frame,119))
        happy=(.22+.30*(.5-.5*cos(4*phase)))*(1-blink)
        x=.25*sin(2*phase);up=.10+.12*(.5-.5*cos(2*phase))
        if owner.startswith('Eye'):
            values.update(Blink=blink,Happy=happy,GazeLeft=max(0,-x),GazeRight=max(0,x),GazeUp=up)
        else:values.update(SmileWide=.55+.12*(.5-.5*cos(4*phase)))
    else:
        look=_hold(frame,36,57,87,112);other=_hold(frame,85,105,120,138)
        blink=max(_pulse(frame,47),_pulse(frame,108))
        if owner.startswith('Eye'):
            x=-.26-.40*look+.78*other
            values.update(Blink=blink,Focus=(.50+.12*sin(phase)**2)*(1-blink),
                          GazeLeft=max(0,-x),GazeRight=max(0,x),GazeUp=.28+.36*look)
        else:values.update(Concentrate=.78+.12*sin(phase)**2,SoftSmile=.10*other)
    return values


def _bake_face(clip):
    guide=BODY_STATE_GUIDE[clip];frames=guide['frames']
    for owner in FACE_OBJECTS:
        keys=bpy.data.objects[owner].data.shape_keys
        first=_face_values(guide['source_activity'],owner,1)
        last=_face_values(guide['target_activity'],owner,1)
        rows=[]
        for frame in range(1,frames+1):
            if guide['loop']:
                value=_loop_face(clip,1 if frame==frames else frame,owner)
            else:
                amount=_ramp(frame,1,frames)
                value={key:first[key]*(1-amount)+last[key]*amount for key in first}
                # A short anticipation glance stays inside the endpoint envelope.
                edge=sin(pi*(frame-1)/(frames-1))**2
                if owner.startswith('Eye'):
                    if clip=='ReadyToDance':value['GazeRight']+=.14*edge
                    if clip=='ReadyToThink':value['GazeUp']+=.12*edge
            rows.append(value)
        action=interaction_action(clip,owner)
        for curve in list(action.fcurves):action.fcurves.remove(curve)
        for key in list(keys.key_blocks)[1:]:
            curve=action.fcurves.new(key.path_from_id('value'))
            curve.keyframe_points.add(frames)
            curve.keyframe_points.foreach_set('co',[v for f,row in enumerate(rows,1) for v in (f,row[key.name])])
        linear(action)
    conform_expression(clip)


def build_body_states(rig):
    """Build six connected body clips, existing companions, and note owners."""
    if rig.type!='ARMATURE' or set(rig.pose.bones.keys())!=set(BONE_NAMES):
        raise ValueError('Body states require the original fifteen-bone MERLIN rig.')
    context=_context(rig);ready=_sample(rig,'ReadyIdle',1)
    for clip in BODY_STATE_GUIDE:
        previous=bpy.data.actions.get(clip)
        if previous:bpy.data.actions.remove(previous,do_unlink=True)
    _create_notes();actions={};starts={}
    for clip,pose_function in [('Dance',_dance_pose),('BodyThink',_think_pose)]:
        guide=BODY_STATE_GUIDE[clip]
        action=_new_action(clip,guide)
        first=pose_function(rig,1,context);starts[clip]=first
        for frame in range(1,guide['frames']+1):
            pose=first if frame in (1,guide['frames']) else pose_function(rig,frame,context)
            _key(rig,action,frame,pose,context,exact=frame in (1,guide['frames']))
        actions[clip]=_finish(action,guide)
        _clone_ready_companions(clip,guide['frames']);_bake_face(clip)
    for clip in ('ReadyToDance','DanceToReady','ReadyToThink','ThinkToReady'):
        guide=BODY_STATE_GUIDE[clip];frames=guide['frames']
        source=ready if guide['source_activity']=='ReadyIdle' else starts[guide['source_activity']]
        target=ready if guide['target_activity']=='ReadyIdle' else starts[guide['target_activity']]
        action=_new_action(clip,guide)
        for frame in range(1,frames+1):
            pose=_blend(source,target,_ramp(frame,1,frames))
            if frame==1:pose=source
            elif frame==frames:pose=target
            _key(rig,action,frame,pose,context,exact=frame in (1,frames))
        actions[clip]=_finish(action,guide)
        _clone_ready_companions(clip,frames);_bake_face(clip)
    for clip in BODY_STATE_GUIDE:ensure_body_state_companions(clip)
    # Add hidden note channels to every previously authored rig clip as well.
    for action in list(bpy.data.actions):
        if action.name not in BODY_STATE_GUIDE and any(c.data_path.startswith('pose.bones[') for c in action.fcurves):
            ensure_body_state_companions(action.name,round(action.frame_range[1]))
    for owner,data in interaction_owners():
        data.animation_data_create();data.animation_data.action=interaction_action('ReadyIdle',owner)
    for owner,data in body_state_owners():data.animation_data.action=state_action_for('ReadyIdle',owner)
    bpy.context.scene.frame_set(1);bpy.context.view_layer.update()
    return {clip:actions[clip] for clip in BODY_STATE_GUIDE}

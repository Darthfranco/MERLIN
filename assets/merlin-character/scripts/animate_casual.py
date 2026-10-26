"""Authored idle-life performances for MERLIN's 15-bone rigid character.

All four clips are baked at 24 fps. Walk feet use explicit planted targets;
limb IK is solved analytically, so exported clips need no runtime constraints.
Ball/facial animation is supplied by the room builder using CASUAL_GUIDE.
"""
from math import acos, cos, floor, pi, radians, sin, sqrt
import json

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector
from animate_character import BONE_NAMES, _smooth, _ramp, _track

HELD_BALL_REST_POINT = (.95, -.18, 1.18)
CASUAL_GUIDE = {
    'WalkWhistle': {'frames':192, 'loop':False, 'poses':{1:'Start',42:'Stroll',96:'Glance',150:'Whistle',192:'Arrive'}},
    'WallToss': {'frames':240, 'loop':True, 'poses':{1:'Lean',32:'Wind up',40:'Release',58:'Wall',70:'Floor',86:'Catch',148:'Release again',194:'Catch again',230:'Chill'},
                 'throws':[{'release':40,'wall':58,'floor':70,'catch':86},{'release':148,'wall':166,'floor':178,'catch':194}]},
    'Nap': {'frames':192, 'loop':True, 'poses':{1:'Rest',48:'Breathe',96:'Nap',144:'Foot twitch',192:'Rest'}},
    'CasualShowcase': {'frames':624, 'loop':False, 'poses':{1:'Walk',192:'Arrive',193:'Wall toss',432:'Chill',433:'Nap',624:'Rest'}},
}


def _rotation(x=0, y=0, z=0):
    return Euler(tuple(radians(v) for v in (x,y,z)), 'XYZ').to_matrix()


def _pose():
    return {'rotation':{n:[0.,0.,0.] for n in BONE_NAMES}, 'root':Vector((0,0,0)), 'root_rotation':Matrix.Identity(3)}


def _set_pose(rig, pose, basis, inverse):
    for name in BONE_NAMES:
        b=rig.pose.bones[name]
        desired=pose['root_rotation'] if name=='root' else _rotation(*pose['rotation'][name])
        b.rotation_mode='XYZ'
        b.rotation_euler=(inverse[name] @ desired @ basis[name]).to_euler('XYZ',b.rotation_euler)
        b.location=inverse[name] @ (pose['root'] if name=='root' else Vector((0,0,0)))
        b.scale=(1,1,1)
    bpy.context.view_layer.update()


def _matrix_at(point, rotation, bone_basis):
    out=(rotation @ bone_basis).to_4x4()
    out.translation=point
    return out


def _limb(rig, first, second, last, target, pole, base_rotation, last_rotation, basis):
    """Place a two-segment rigid limb at a target with a stable bend pole."""
    first_bone=rig.pose.bones[first]
    origin=first_bone.head.copy()
    a=rig.data.bones[second].head_local-rig.data.bones[first].head_local
    b=rig.data.bones[last].head_local-rig.data.bones[second].head_local
    length_a,length_b=a.length,b.length
    delta=Vector(target)-origin
    distance=max(.001,min(delta.length,length_a+length_b-.0002))
    axis=delta.normalized()
    toward=Vector(pole)-origin
    perpendicular=toward-axis*toward.dot(axis)
    if perpendicular.length<.001: perpendicular=axis.cross(Vector((0,1,0)))
    perpendicular.normalize()
    along=(length_a*length_a+distance*distance-length_b*length_b)/(2*distance)
    height=sqrt(max(0,length_a*length_a-along*along))
    knee=origin+axis*along+perpendicular*height
    endpoint=origin+axis*distance
    qa=(base_rotation @ a).rotation_difference(knee-origin)
    qb=(base_rotation @ b).rotation_difference(endpoint-knee)
    matrices={first:_matrix_at(origin,qa.to_matrix() @ base_rotation,basis[first]),
              second:_matrix_at(knee,qb.to_matrix() @ base_rotation,basis[second]),
              last:_matrix_at(endpoint,last_rotation,basis[last])}
    # Assign basis matrices explicitly: .matrix on successive children can use
    # a stale evaluated parent until the depsgraph runs, breaking the IK chain.
    for name in (first,second,last):
        bone=rig.pose.bones[name]
        parent=bone.parent
        parent_pose=matrices.get(parent.name,parent.matrix)
        bone.matrix_basis=(bone.bone.matrix_local.inverted() @ parent.bone.matrix_local
                           @ parent_pose.inverted() @ matrices[name])


def _rig_points(rig):
    """Cache actual rigid mesh vertices in rest-bone space for floor checks."""
    clouds={name:[] for name in BONE_NAMES}
    for obj in bpy.data.objects:
        if obj.type!='MESH' or not any(m.type=='ARMATURE' and m.object==rig for m in obj.modifiers): continue
        groups=[g.name for g in obj.vertex_groups if g.name in clouds]
        if len(groups)!=1: continue
        name=groups[0]
        values=np.empty(len(obj.data.vertices)*3,dtype=np.float64)
        obj.data.vertices.foreach_get('co',values)
        points=values.reshape((-1,3))
        transform=np.array(rig.data.bones[name].matrix_local.inverted() @ rig.matrix_world.inverted() @ obj.matrix_world)
        clouds[name].append(points @ transform[:3,:3].T+transform[:3,3])
    return {name:np.concatenate(parts) for name,parts in clouds.items() if parts}


def _extreme(rig, clouds, axis, names=None, maximum=False):
    values=[]
    for name,points in clouds.items():
        if names is not None and name not in names: continue
        m=np.array(rig.pose.bones[name].matrix)
        transformed=points @ m[axis,:3]+m[axis,3]
        values.append(float(np.max(transformed) if maximum else np.min(transformed)))
    return (max if maximum else min)(values)


def _move_root(rig, offset, inverse):
    rig.pose.bones['root'].location += inverse['root'] @ Vector(offset)
    bpy.context.view_layer.update()


def _walk_x(frame, scale_x=1.0):
    # Integrated velocity ramps: the planted feet remain fixed while speeding up.
    t=max(0.,min(191.,frame-1.)); ramp=18.; end=191.
    def integral(x): return x**6-3*x**5+2.5*x**4
    if t<ramp: travel=ramp*integral(t/ramp)
    elif t>end-ramp:
        u=(end-t)/ramp
        travel=end-ramp-ramp*integral(u)
    else: travel=t-ramp/2
    return (-3.1+6.2*travel/(end-ramp))/scale_x


def _walk_foot(frame, side, rotation, scale_x=1.0):
    rest=rotation @ Vector((.33 if side=='L' else -.33,-.12,0))
    position=Vector((-3.1/scale_x+rest.x,rest.y,.25))
    starts=[8+30*k+(0 if side=='L' else 15) for k in range(6)]
    for index,start in enumerate(starts):
        finish=start+12
        target_frame=192 if side=='R' and index==len(starts)-1 else finish+7
        target=Vector((_walk_x(target_frame,scale_x)+rest.x,rest.y,.25))
        if frame<start: break
        if frame<=finish:
            u=(frame-start)/12
            position=position.lerp(target,_smooth(u))
            position.z += .145*sin(pi*u)**1.3
            return position
        position=target
    if side=='L' and frame>185:
        u=min(1,(frame-185)/7)
        position=position.lerp(Vector((3.1/scale_x+rest.x,rest.y,.25)),_smooth(u))
        position.z+=.06*sin(pi*u)
    return position


def _walk(rig, frame, basis, inverse, clouds):
    p=_pose(); gait=2*pi*(frame-8)/30
    amplitude=_ramp(frame,1,18)*(1-_ramp(frame,174,192))
    p['root']=Vector((_walk_x(frame,rig.scale.x),.018*sin(gait)*amplitude,-.085+.012*cos(2*gait)*amplitude))
    p['root_rotation']=_rotation(z=60)
    p['rotation']['body']=[2.8+.9*cos(2*gait)*amplitude,1.1*sin(gait)*amplitude,1.8*sin(gait)*amplitude]
    glance=_ramp(frame,66,78)*(1-_ramp(frame,98,112))
    p['rotation']['head']=[-1.5-.6*cos(2*gait)*amplitude,-1.4*sin(gait)*amplitude,-12-12*glance-1.8*sin(gait)*amplitude]
    for side,sign in [('L',1),('R',-1)]:
        p['rotation']['upper_arm.'+side]=[-4+sign*13*sin(gait)*amplitude,-sign*7,sign*2]
        p['rotation']['forearm.'+side]=[-9-sign*4*sin(gait+.3)*amplitude,-sign*3,0]
        p['rotation']['hand.'+side]=[4+sign*2*sin(gait-.4)*amplitude,0,0]
    _set_pose(rig,p,basis,inverse)
    for side,sign in [('L',1),('R',-1)]:
        target=_walk_foot(frame,side,p['root_rotation'],rig.scale.x)
        hip=rig.pose.bones['thigh.'+side].head.copy()
        pole=hip+p['root_rotation'] @ Vector((sign*.1,-1.,0))
        _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,target,pole,p['root_rotation'],p['root_rotation'],basis)
    bpy.context.view_layer.update()


def _wall(rig, frame, basis, inverse, clouds):
    p=_pose(); breath=sin(2*pi*(frame-1)/239)
    p['root']=Vector((-3.20,0,-.04));p['root_rotation']=_rotation(z=12)
    p['rotation']['body']=[1,-9+.35*breath,0]
    p['rotation']['head']=[-2-.4*breath,1,5]
    p['rotation']['upper_arm.R']=[-8,8,0]
    p['rotation']['forearm.R']=[-22,5,-3]
    p['rotation']['hand.R']=[4,0,0]
    # The open-room hand holds a ball comfortably forward of the torso.
    shoulder=[-12,-12,0]; elbow=[-60,-15,0]; wrist=[10,-3,0]
    for release in (40,148):
        wind=_ramp(frame,release-15,release-7)*(1-_ramp(frame,release-6,release))
        throw=_ramp(frame,release-7,release)*(1-_ramp(frame,release+4,release+20))
        catch=_ramp(frame,release+38,release+45)*(1-_ramp(frame,release+47,release+60))
        shoulder[0]+=15*wind-22*throw-5*catch
        shoulder[1]+=4*wind-47*throw-7*catch
        elbow[0]+=12*wind+30*throw-9*catch
        elbow[1]+=-5*wind+5*throw
        wrist[0]+=-12*throw+8*catch
        wrist[1]+=-10*throw
        track=_ramp(frame,release-3,release+16)*(1-_ramp(frame,release+31,release+48))
        p['rotation']['head'][2]+=23*track
        p['rotation']['head'][0]+=-3*track
        p['rotation']['body'][2]+=2*throw
    p['rotation']['upper_arm.L']=shoulder;p['rotation']['forearm.L']=elbow;p['rotation']['hand.L']=wrist
    _set_pose(rig,p,basis,inverse)
    # Keep the leftmost head surface just off the wall while it tracks the ball.
    left=_extreme(rig,clouds,0,names={'head'})
    _move_root(rig,(-4.475/rig.scale.x-left,0,0),inverse)
    for side,sign in [('L',1),('R',-1)]:
        hip=rig.pose.bones['thigh.'+side].head.copy()
        foot=rig.pose.bones['foot.'+side].head.copy()
        foot.z=.25
        if side=='L': foot.x+=.09;foot.y-=.13
        pole=hip+p['root_rotation'] @ Vector((sign*.12,-1,0))
        _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,foot,pole,p['root_rotation'],p['root_rotation'] @ _rotation(z=sign*5),basis)
    bpy.context.view_layer.update()


def _nap(rig, frame, basis, inverse, clouds):
    p=_pose();phase=2*pi*(frame-1)/191; breath=sin(2*phase)
    p['root']=Vector((1.60,0,.15))
    p['root_rotation']=_rotation(y=10) @ _rotation(x=-80) @ _rotation(y=-90)
    p['rotation']['body']=[.35*breath,.4*breath,0]
    p['rotation']['head']=[25-.3*breath,.5*breath,0]
    _set_pose(rig,p,basis,inverse)
    for side,sign in [('L',1),('R',-1)]:
        target=p['root_rotation'] @ Vector((sign*.83,.40,2.48))+p['root']
        pole=p['root_rotation'] @ Vector((sign*1.30,.10,2.30))+p['root']
        hand_rotation=p['root_rotation'] @ _rotation(x=128,y=-sign*5)
        _limb(rig,'upper_arm.'+side,'forearm.'+side,'hand.'+side,target,pole,p['root_rotation'],hand_rotation,basis)
    bpy.context.view_layer.update()
    upper={'body','head','upper_arm.L','forearm.L','hand.L','upper_arm.R','forearm.R','hand.R'}
    _move_root(rig,(0,0,.033-_extreme(rig,clouds,2,names=upper)),inverse)
    # Heels rest on the floor, with unequal bent knees for a relaxed silhouette.
    twitch=_ramp(frame,126,135)*(1-_ramp(frame,143,154))
    for side,sign in [('L',1),('R',-1)]:
        hip=rig.pose.bones['thigh.'+side].head.copy()
        target=Vector((hip.x+(.72 if side=='L' else .61),hip.y+sign*.035,.25))
        pole=hip+Vector((.3,sign*.04,1))
        foot_rotation=_rotation(z=90+sign*5)
        if side=='R':
            # Lift the whole foot slightly while twitching, avoiding toe penetration.
            target.z+=.035*twitch
            foot_rotation=foot_rotation @ _rotation(x=-5*twitch)
        _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,target,pole,p['root_rotation'],foot_rotation,basis)
    bpy.context.view_layer.update()


def _source_clip(name,frame):
    if name!='CasualShowcase': return name,frame
    if frame<=192:return 'WalkWhistle',frame
    if frame<=432:return 'WallToss',frame-192
    return 'Nap',frame-432


def build_casual_actions(rig):
    """Build four portable actions; leave CasualShowcase selected at frame 1."""
    if rig.type!='ARMATURE' or set(BONE_NAMES)-set(rig.pose.bones.keys()):
        raise ValueError('Casual actions require the complete MERLIN 15-bone rig.')
    basis={n:rig.data.bones[n].matrix_local.to_3x3().normalized() for n in BONE_NAMES}
    inverse={n:m.inverted() for n,m in basis.items()}
    bpy.context.view_layer.update()
    clouds=_rig_points(rig)
    rig.animation_data_create();actions={}
    scene=bpy.context.scene;scene.render.fps=24
    for name,guide in CASUAL_GUIDE.items():
        previous=bpy.data.actions.get(name)
        if previous and previous.users==0:bpy.data.actions.remove(previous)
        action=bpy.data.actions.new(name)
        action.use_fake_user=True;action['fps']=24;action['loop']=guide['loop']
        action['preview_frames']=json.dumps(guide['poses'])
        rig.animation_data.action=action
        for frame in range(1,guide['frames']+1):
            scene.frame_set(frame)
            source,source_frame=_source_clip(name,frame)
            {'WalkWhistle':_walk,'WallToss':_wall,'Nap':_nap}[source](rig,source_frame,basis,inverse,clouds)
            for bone in rig.pose.bones:
                bone.keyframe_insert('location',frame=frame,group=bone.name)
                bone.keyframe_insert('rotation_euler',frame=frame,group=bone.name)
                bone.keyframe_insert('scale',frame=frame,group=bone.name)
        for curve in action.fcurves:
            curve.extrapolation='CONSTANT'
            for point in curve.keyframe_points:point.interpolation='LINEAR'
        for frame,label in guide['poses'].items():
            marker=action.pose_markers.new(label);marker.frame=frame
        actions[name]=action
    rig.animation_data.action=actions['CasualShowcase']
    scene.frame_start=1;scene.frame_end=624;scene.frame_set(1)
    return actions


def get_hand_position(rig,frame,action='WallToss',hand='L'):
    """Return the held ball center in world space, restoring the active clip/time."""
    previous_action=rig.animation_data.action;previous_frame=bpy.context.scene.frame_current
    rig.animation_data.action=bpy.data.actions[action] if isinstance(action,str) else action
    bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
    point=Vector(HELD_BALL_REST_POINT if hand=='L' else (-.95,-.18,1.18))
    name='hand.'+hand
    result=rig.matrix_world @ rig.pose.bones[name].matrix @ rig.data.bones[name].matrix_local.inverted() @ point
    rig.animation_data.action=previous_action;bpy.context.scene.frame_set(previous_frame)
    return result

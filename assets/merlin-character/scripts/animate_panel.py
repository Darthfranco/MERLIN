"""MERLIN physically presents and cleanly dismisses a white information panel.

The card and restrained polygon fragments are ordinary mesh objects with baked
transform actions, so the performance can travel through glTF. It does not
implement live application content. The robot keeps its reviewed proportions.
"""
from math import cos, pi, sin
import random

import bpy
from mathutils import Matrix, Vector

from animate_character import _ramp, _smooth
from animate_casual import _limb, _move_root, _pose, _rotation, _set_pose
from animate_transitions import (_apply, _blend, _capture, _clearance, _context,
                                 _finish, _key, _new_action, _run, _sample)

PANEL_GUIDE = {
    'ReadyToPanel': {'frames':180, 'loop':False, 'source_activity':'ReadyIdle',
        'source_frame':1, 'target_activity':'PanelIdle', 'target_frame':1,
        'panel_grab_frame':58, 'panel_pull_start':59, 'panel_pull_end':139,
        'poses':{1:'Ready',30:'Approach',58:'Grip',70:'A little effort',110:'Pull',139:'Half screen',158:'Release',180:'Present'}},
    'PanelIdle': {'frames':96, 'loop':True, 'source_activity':'PanelIdle',
        'source_frame':1, 'target_activity':'PanelIdle', 'target_frame':1,
        'poses':{1:'Present',35:'Check panel',59:'Blink',96:'Present'}},
    'PanelToReady': {'frames':144, 'loop':False, 'source_activity':'PanelIdle',
        'source_frame':1, 'target_activity':'ReadyIdle', 'target_frame':1,
        'tap_frame':30, 'panel_tap_frame':30, 'shatter_start':31, 'shatter_end':53,
        'poses':{1:'Present',25:'Reach',30:'Tap',42:'Dissolve',75:'Turn',94:'Return',144:'Ready'}},
}
PANEL_LEFT = .15
PANEL_WIDTH = 4.75
PANEL_HEIGHT = 5.70
PANEL_START = 4.45
PANEL_CENTER = Vector((PANEL_LEFT+PANEL_WIDTH/2, .44, 3.02))
PRESENT_X = -1.55
PREFIX = 'Panel • '


def panel_owners():
    """Every independent panel transform owner, in deterministic order."""
    return [(o.name, o) for o in sorted(bpy.data.objects, key=lambda o:o.name)
            if o.get('merlin_panel_owner', False)]


def panel_action_for(clip, owner):
    return bpy.data.actions.get(f'{clip} • {owner}')


def _action(name):
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old, do_unlink=True)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    return act


def _linear(action):
    for fc in action.fcurves:
        fc.extrapolation = 'CONSTANT'
        for point in fc.keyframe_points:
            point.interpolation = 'LINEAR'


def _material():
    mat = bpy.data.materials.get('Panel • porcelain white') or bpy.data.materials.new('Panel • porcelain white')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (.87,.90,.95,1)
    bsdf.inputs['Metallic'].default_value = 0
    bsdf.inputs['Roughness'].default_value = .85
    bsdf.inputs['Specular IOR Level'].default_value = .15
    # Modest self-light keeps the blank information surface legible in this room.
    bsdf.inputs['Emission Color'].default_value = (.87,.90,.95,1)
    bsdf.inputs['Emission Strength'].default_value = .40
    return mat


def _boundary():
    points=[]
    radius=.20
    for cx,cy,begin in [(PANEL_WIDTH/2-radius,PANEL_HEIGHT/2-radius,0),
                        (-PANEL_WIDTH/2+radius,PANEL_HEIGHT/2-radius,pi/2),
                        (-PANEL_WIDTH/2+radius,-PANEL_HEIGHT/2+radius,pi),
                        (PANEL_WIDTH/2-radius,-PANEL_HEIGHT/2+radius,3*pi/2)]:
        for k in range(9):
            angle=begin+k*pi/16
            points.append(Vector((cx+radius*cos(angle),cy+radius*sin(angle))))
    return points


def _clip(poly, normal, limit):
    out=[]
    for i,a in enumerate(poly):
        b=poly[(i+1)%len(poly)]
        da=a.dot(normal)-limit; db=b.dot(normal)-limit
        if da<=1e-8:out.append(a)
        if (da<0) != (db<0):
            out.append(a+(b-a)*(da/(da-db)))
    return out


def _mesh_object(name, poly, material, collection, center=(0,0)):
    c=Vector(center)
    verts=[(v.x-c.x,v.y-c.y,z) for z in (-.014,.014) for v in poly]
    n=len(poly)
    faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name+' mesh')
    mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);collection.objects.link(obj)
    obj.data.materials.append(material)
    obj['merlin_panel_owner']=True
    obj['panel_center_local']=[c.x,c.y]
    obj.rotation_mode='XYZ'
    # The unbroken card gets a soft physical edge. Fragments stay simple polygons.
    if name==PREFIX+'white card':
        bevel=obj.modifiers.new('Soft card edge','BEVEL');bevel.width=.018;bevel.segments=3
        bpy.context.view_layer.objects.active=obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=bevel.name)
        obj.select_set(False)
    return obj


def create_panel_geometry():
    """Build one rounded blank card and 30 reproducible clipped polygon shards."""
    for _,obj in panel_owners():
        bpy.data.objects.remove(obj,do_unlink=True)
    character=bpy.data.collections['MERLIN • Character']
    mat=_material(); boundary=_boundary()
    card=_mesh_object(PREFIX+'white card',boundary,mat,character)
    card['panel_kind']='card'
    rng=random.Random(402)
    seeds=[]
    for row in range(6):
        for col in range(5):
            seeds.append(Vector(((col+.5+(rng.random()-.5)*.48)*PANEL_WIDTH/5-PANEL_WIDTH/2,
                                  (row+.5+(rng.random()-.5)*.48)*PANEL_HEIGHT/6-PANEL_HEIGHT/2)))
    for i,seed in enumerate(seeds):
        poly=[v.copy() for v in boundary]
        for j,other in enumerate(seeds):
            if i!=j:
                poly=_clip(poly,other-seed,(other.length_squared-seed.length_squared)/2)
        centroid=sum(poly,Vector((0,0)))/len(poly)
        obj=_mesh_object(PREFIX+f'fragment {i+1:02d}',poly,mat,character,centroid)
        obj['panel_kind']='fragment';obj['panel_index']=i
    for _,obj in panel_owners():
        obj.animation_data_create()
        obj.location=PANEL_CENTER
        obj.rotation_euler=bpy.context.scene.camera.rotation_euler
        obj.scale=(0,0,0)
    return card


def _left(frame):
    if frame<=58:return PANEL_START
    if frame<=76:return PANEL_START-.14*_ramp(frame,58,76)
    return PANEL_START-.14+(PANEL_LEFT-(PANEL_START-.14))*_ramp(frame,76,139)


def _root_for_pull(frame):
    return _left(frame)-.90


def _pull_pose(rig, frame, context, tap=False):
    basis,inverse,_=context
    rig.animation_data.action=None
    yaw=55
    rotation=_rotation(z=yaw)
    left=PANEL_LEFT if tap else _left(frame)
    root_x=left-.90
    effort=0 if tap else _ramp(frame,58,67)*(1-_ramp(frame,74,83))
    pulling=0 if tap else _ramp(frame,77,86)*(1-_ramp(frame,130,139))
    gait=2*pi*(frame-77)/22
    p=_pose()
    p['root']=Vector((root_x,0,-.10-.075*effort+.016*cos(2*gait)*pulling))
    p['root_rotation']=rotation
    p['rotation']['body']=[-7*effort-3*pulling,-5*effort,0]
    p['rotation']['head']=[2+4*effort,0,-12]
    p['rotation']['upper_arm.R']=[-23-7*effort,12,7]
    p['rotation']['forearm.R']=[-51,0,-7]
    p['rotation']['hand.R']=[7,0,0]
    _set_pose(rig,p,basis,inverse)
    # Leading palm visibly stays on the panel edge through each backward step.
    shoulder=rig.pose.bones['upper_arm.L'].head.copy()
    target=Vector((left-.10,-.05,1.82))
    pole=shoulder+Vector((-.15,-.55,-.24))
    _limb(rig,'upper_arm.L','forearm.L','hand.L',target,pole,rotation,
          _rotation(z=55) @ _rotation(x=-35,y=-30),basis)
    for side,sign in [('L',1),('R',-1)]:
        offset=rotation @ Vector((sign*.33,-.12,0))
        target=Vector((root_x+offset.x,offset.y,.25))
        if not tap and frame>=77:
            starts=range(77+(0 if side=='L' else 11),140,22)
            position=Vector((_root_for_pull(77)+offset.x,offset.y,.25))
            for begin in starts:
                end=min(139,begin+10)
                future=min(139,end+5)
                landing=Vector((_root_for_pull(future)+offset.x,offset.y,.25))
                if frame<begin:break
                if frame<=end:
                    u=(frame-begin)/max(1,end-begin)
                    position=position.lerp(landing,_smooth(u));position.z+=.105*sin(pi*u)*pulling
                    break
                position=landing
            if frame>=130:
                position=position.lerp(target,_ramp(frame,130,139))
            target=position
        hip=rig.pose.bones['thigh.'+side].head.copy()
        _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,target,
              hip+rotation @ Vector((sign*.10,-1,0)),rotation,rotation,basis)
    bpy.context.view_layer.update();_clearance(rig,context)
    return _capture(rig)


def _present_pose(rig, ready, context, frame=1):
    _apply(rig,ready)
    _move_root(rig,(PRESENT_X,0,0),context[1])
    phase=2*pi*(frame-1)/95
    # Closed-loop pose accents; endpoints remain exactly the resting presentation.
    rig.pose.bones['body'].rotation_euler.x+=.006*sin(phase)
    rig.pose.bones['head'].rotation_euler.z+=.035*(1-cos(phase))
    rig.pose.bones['forearm.L'].rotation_euler.x-=.10*(1-cos(phase))
    bpy.context.view_layer.update()
    return _capture(rig)


def _stepped_blend(rig, start, finish, frame, begin, end, context):
    """A close reposition uses two explicit foot plants, avoiding a side slide."""
    basis,_,_=context
    _apply(rig,start)
    start_feet={side:rig.pose.bones['foot.'+side].head.copy() for side in ('L','R')}
    _apply(rig,finish)
    finish_feet={side:rig.pose.bones['foot.'+side].head.copy() for side in ('L','R')}
    _apply(rig,_blend(start,finish,_ramp(frame,begin,end)))
    rotation=rig.pose.bones['root'].matrix.to_3x3() @ basis['root'].inverted()
    span=end-begin
    for side,sign in [('L',1),('R',-1)]:
        a=begin+(0 if side=='L' else .40*span)
        b=begin+(.60*span if side=='L' else span)
        u=max(0,min(1,(frame-a)/max(1,b-a)))
        target=start_feet[side].lerp(finish_feet[side],_smooth(u))
        target.z+=.13*sin(pi*u)
        hip=rig.pose.bones['thigh.'+side].head.copy()
        _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,target,
              hip+rotation @ Vector((sign*.10,-1,0)),rotation,rotation,basis)
    bpy.context.view_layer.update();_clearance(rig,context)
    return _capture(rig)


def _object_sample(obj, clip, frame):
    camera_rotation=bpy.context.scene.camera.rotation_euler.to_matrix()
    local=Vector((*obj['panel_center_local'],0))
    location=PANEL_CENTER+camera_rotation @ local
    rotation=bpy.context.scene.camera.rotation_euler.copy()
    scale=0.
    kind=obj['panel_kind']
    if clip=='ReadyToPanel' and kind=='card':
        location.x+=_left(frame)-PANEL_LEFT
        scale=1 if frame>=59 else 0
    elif clip=='PanelIdle' and kind=='card':scale=1
    elif clip=='PanelToReady':
        if kind=='card':scale=1 if frame<=30 else 0
        elif 31<=frame<=53:
            index=obj['panel_index']; u=(frame-31)/22
            progress=_smooth(u)
            # Tiny outward release, then elegant shrink; no gravity/debris field.
            radial=Vector((local.x/PANEL_WIDTH,local.y/PANEL_HEIGHT,0))
            radial.normalize()
            location += camera_rotation @ (radial*(.14*progress)+Vector((.025*sin(index*2.3),.025*cos(index),.025))*sin(pi*u))
            rotation.x += .07*sin(index*1.7)*progress
            rotation.y += .09*cos(index*2.1)*progress
            rotation.z += .055*sin(index)*progress
            scale=1-_smooth((u-.12)/.88)
    return location,rotation,Vector((scale,scale,scale))


def ensure_panel_companions(clip, frames=None):
    """Create explicit hidden state for unrelated clips, or native panel motion."""
    if frames is None:frames=round(bpy.data.actions[clip].frame_range[1])
    for owner,obj in panel_owners():
        act=_action(f'{clip} • {owner}')
        obj.animation_data.action=act
        for frame in range(1,frames+1):
            obj.location,obj.rotation_euler,obj.scale=_object_sample(obj,clip,frame)
            for channel in ('location','rotation_euler','scale'):
                obj.keyframe_insert(channel,frame=frame)
        _linear(act)
    return {owner:panel_action_for(clip,owner) for owner,_ in panel_owners()}


def build_panel_actions(rig):
    """Build connected ready → pull/present → tap/dismiss → ready performances."""
    context=_context(rig);ready=_sample(rig,'ReadyIdle',1)
    present=_present_pose(rig,ready,context)
    create_panel_geometry()
    pull_start=_pull_pose(rig,58,context)
    pull_end=_pull_pose(rig,139,context)
    tap=_pull_pose(rig,30,context,tap=True)
    actions={}
    for clip,guide in PANEL_GUIDE.items():
        action=_new_action(clip,guide)
        for f in range(1,guide['frames']+1):
            if clip=='PanelIdle':
                pose=_present_pose(rig,ready,context,f)
            elif clip=='ReadyToPanel':
                if f<=44:
                    run=_run(rig,0,PANEL_START-.90,max(1,f-6),38,context)
                    pose=_blend(ready,run,_ramp(f,1,10)) if f<10 else run
                elif f<=58:
                    run=_run(rig,0,PANEL_START-.90,38,38,context)
                    pose=_blend(run,pull_start,_ramp(f,44,58))
                elif f<=139:pose=_pull_pose(rig,f,context)
                elif f<=168:
                    pose=_stepped_blend(rig,pull_end,present,f,139,168,context)
                else:pose=present
                if f==1:pose=ready
                if f==180:pose=present
            else:
                if f<=26:pose=_stepped_blend(rig,present,tap,f,5,26,context)
                elif f<=34:
                    pose=tap
                    # A small wrist-led touch reads as a tap, not a shove.
                    _apply(rig,pose)
                    rig.pose.bones['hand.L'].rotation_euler.x+=.12*sin(pi*(f-26)/8)
                    bpy.context.view_layer.update();pose=_capture(rig)
                elif f<=75:pose=_stepped_blend(rig,tap,present,f,37,70,context)
                elif f<=110:
                    run=_run(rig,PRESENT_X,0,f-75,35,context)
                    pose=_blend(present,run,_ramp(f,75,83)) if f<83 else run
                else:
                    run=_run(rig,PRESENT_X,0,35,35,context)
                    pose=_blend(run,ready,_ramp(f,110,132))
                if f==1:pose=present
                if f==144:pose=ready
            _key(rig,action,f,pose,context,exact=f in (1,guide['frames']))
        actions[clip]=_finish(action,guide)
        ensure_panel_companions(clip,guide['frames'])
    # End in the default ready pose without leaving a stale presentation object.
    rig.animation_data.action=bpy.data.actions['ReadyIdle']
    for _,obj in panel_owners():
        obj.animation_data.action=None;obj.scale=(0,0,0)
    bpy.context.scene.frame_set(1)
    return actions

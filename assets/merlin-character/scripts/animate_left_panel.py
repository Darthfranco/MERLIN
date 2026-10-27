"""A left-hand counterpart of MERLIN's reviewed right-panel performance.

Reflection is applied to paired bone deformation matrices, then baked back to
ordinary proper rotations and unit scales. No negative rig scale, mirrored text
or runtime rig constraints are needed. The original right clips are retained.
"""
import bpy
import bmesh
from mathutils import Matrix,Vector

from animate_character import BONE_NAMES
from animate_transitions import (_sample,_apply,_capture,_key,_context,
                                 _new_action,_finish)
from animate_panel import panel_owners,panel_action_for,ensure_panel_companions,PANEL_GUIDE
from fullscreen_face import build_fullscreen_companions
from transition_support import FACE_OBJECTS,new_action,linear,action_for
from screen_content import configure_panel_screens

LEFT_TO_RIGHT={'ReadyToLeftPanel':'ReadyToPanel','LeftPanelIdle':'PanelIdle','LeftPanelToReady':'PanelToReady'}
LEFT_PANEL_GUIDE={}
for name,source in LEFT_TO_RIGHT.items():
    guide=dict(PANEL_GUIDE[source])
    guide['source_activity']='LeftPanelIdle' if source!='ReadyToPanel' else 'ReadyIdle'
    guide['target_activity']='ReadyIdle' if source=='PanelToReady' else 'LeftPanelIdle'
    guide['mirrors']=source
    LEFT_PANEL_GUIDE[name]=guide
REFLECTION=Matrix.Diagonal((-1.,1.,1.,1.))


def left_panel_owners():
    return sorted([(o['left_panel_owner_id'],o) for o in bpy.data.objects
                   if o.get('merlin_left_panel_owner')],key=lambda pair:pair[0])


def state_action_for(clip,owner):
    return bpy.data.actions.get(clip+' • '+owner)


def _opposite(name):
    if name.endswith('.L'):return name[:-2]+'.R'
    if name.endswith('.R'):return name[:-2]+'.L'
    return name


def _reflect_pose(rig,source,frame):
    _sample(rig,source,frame)
    target={}
    for name in BONE_NAMES:
        other=_opposite(name)
        deformation=rig.pose.bones[other].matrix@rig.data.bones[other].matrix_local.inverted()
        target[name]=REFLECTION@deformation@REFLECTION@rig.data.bones[name].matrix_local
    rig.animation_data.action=None
    for name in BONE_NAMES:
        bone=rig.pose.bones[name];parent=bone.parent
        bone.rotation_mode='XYZ'
        if parent:
            bone.matrix_basis=(bone.bone.matrix_local.inverted()@parent.bone.matrix_local
                               @target[parent.name].inverted()@target[name])
        else:bone.matrix_basis=bone.bone.matrix_local.inverted()@target[name]
    bpy.context.view_layer.update()
    result=_capture(rig)
    # Matrix roundoff must never produce scale animation on a rigid character.
    return {name:(location,rotation,Vector((1,1,1))) for name,(location,rotation,scale) in result.items()}


def _create_geometry():
    for _,obj in left_panel_owners():bpy.data.objects.remove(obj,do_unlink=True)
    for source_name,source in panel_owners():
        fragment=source.get('panel_kind')=='fragment'
        index=int(source.get('panel_index',0))+1
        owner='LeftFragment%02d'%index if fragment else 'LeftPanel'
        name='MERLIN_LeftFragment_%02d'%index if fragment else 'MERLIN_LeftPanel'
        obj=source.copy();obj.data=source.data.copy();obj.name=name
        bpy.data.collections['MERLIN • Character'].objects.link(obj)
        obj.animation_data_clear()
        obj['merlin_panel_owner']=False
        obj['merlin_left_panel_owner']=True
        obj['left_panel_owner_id']=owner
        obj['right_panel_source']=source_name
        center=source.get('panel_center_local',(0.,0.))
        obj['panel_center_local']=[-center[0],center[1]]
        for vertex in obj.data.vertices:vertex.co.x*=-1
        mesh=bmesh.new();mesh.from_mesh(obj.data)
        bmesh.ops.reverse_faces(mesh,faces=list(mesh.faces))
        mesh.to_mesh(obj.data);mesh.free();obj.data.update()
        obj.rotation_mode='XYZ'
        obj.location=(-2.525,.44,3.02)
        obj.rotation_euler=bpy.context.scene.camera.rotation_euler
        obj.scale=(0,0,0)
        obj.animation_data_create()
    configure_panel_screens()


def _curve_vector(action,path,frame,default):
    values=Vector(default)
    if action:
        for i in range(3):
            curve=action.fcurves.find(path,index=i)
            if curve:values[i]=curve.evaluate(frame)
    return values


def ensure_left_panel_companions(clip,frames=None):
    """Explicit visible/hidden transforms on every left screen owner."""
    if frames is None:frames=round(bpy.data.actions[clip].frame_range[1])
    source=LEFT_TO_RIGHT.get(clip)
    for owner,obj in left_panel_owners():
        action=new_action(clip+' • '+owner)
        obj.animation_data.action=action
        source_action=panel_action_for(source or 'ReadyIdle',obj['right_panel_source'])
        for frame in range(1,frames+1):
            location=_curve_vector(source_action,'location',frame,(2.525,.44,3.02))
            rotation=_curve_vector(source_action,'rotation_euler',frame,bpy.context.scene.camera.rotation_euler)
            scale=_curve_vector(source_action,'scale',frame,(0,0,0))
            obj.location=(-location.x,location.y,location.z)
            obj.rotation_euler=(rotation.x,-rotation.y,-rotation.z)
            obj.scale=scale
            for path in ('location','rotation_euler','scale'):obj.keyframe_insert(path,frame=frame)
        linear(action)


def _face_and_ball_companions(name,source,length):
    for owner in FACE_OBJECTS:
        other='Eye • R' if owner=='Eye • L' else 'Eye • L' if owner=='Eye • R' else owner
        original=action_for(source,other)
        keys=bpy.data.objects[owner].data.shape_keys
        action=new_action(name+' • '+owner)
        keys.animation_data_create();keys.animation_data.action=action
        for frame in range(1,length+1):
            for key in list(keys.key_blocks)[1:]:
                mirrored='GazeRight' if key.name=='GazeLeft' else 'GazeLeft' if key.name=='GazeRight' else key.name
                path='key_blocks["'+mirrored+'"].value'
                curve=original.fcurves.find(path) if original else None
                key.value=curve.evaluate(frame) if curve else 0.
                key.keyframe_insert('value',frame=frame)
        linear(action)
    original=action_for(source,'ball')
    ball_action=new_action(name+' • Ball')
    for old in original.fcurves:
        curve=ball_action.fcurves.new(old.data_path,index=old.array_index)
        curve.keyframe_points.add(length)
        values=[]
        for frame in range(1,length+1):
            value=old.evaluate(frame)
            if old.data_path=='location' and old.array_index==0:value=-value
            values.extend((frame,value))
        curve.keyframe_points.foreach_set('co',values)
    linear(ball_action)


def build_left_panel(rig):
    """Add three connected left-panel clips and content-ready left/right cards."""
    missing=[name for name in LEFT_TO_RIGHT.values() if name not in bpy.data.actions]
    if missing:raise ValueError('Build the reviewed right-panel actions first: '+str(missing))
    ready=_sample(rig,'ReadyIdle',1)
    context=_context(rig)
    _create_geometry()
    actions={}
    # Idle first establishes the exact shared presentation pose.
    for name in ('LeftPanelIdle','ReadyToLeftPanel','LeftPanelToReady'):
        source=LEFT_TO_RIGHT[name];guide=LEFT_PANEL_GUIDE[name]
        action=_new_action(name,guide)
        for frame in range(1,guide['frames']+1):
            pose=_reflect_pose(rig,source,frame)
            if name=='ReadyToLeftPanel' and frame==1:pose=ready
            if name=='LeftPanelToReady' and frame==guide['frames']:pose=ready
            _key(rig,action,frame,pose,context,exact=True)
        actions[name]=_finish(action,guide)
        _face_and_ball_companions(name,source,guide['frames'])
        ensure_left_panel_companions(name,guide['frames'])
        ensure_panel_companions(name,guide['frames'])
        build_fullscreen_companions(name,guide['frames'])
    rig.animation_data.action=bpy.data.actions['ReadyIdle']
    for _,obj in left_panel_owners():obj.animation_data.action=None;obj.scale=(0,0,0)
    bpy.context.scene.frame_set(1)
    return actions

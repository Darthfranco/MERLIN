"""Export the built MERLIN scene without resampling static helpers for minutes.

NLA export samples each owner's track independently in Blender4.0.2. A hidden
helper often has a full-length action containing only constant values. Temporary
two-frame copies preserve every channel and its held value while avoiding those
redundant scene evaluations. Authored actions and the saved scene are unchanged.
"""
from pathlib import Path
import json
import sys

import bpy

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from interaction_support import action_for,apply_activity,owners


def _sample_baked_rig(gather, settings):
    """Avoid recalculating unused mesh normals after geometry has been gathered.

    This narrow Blender 4.0 hook only applies to a baked, unconstrained rig.
    Animation sampling reads object/bone matrices and raw shape-key weights.
    Meshes, morph targets and materials have already been fully exported.
    Unknown dependencies use Blender's unmodified sampling path instead.
    """
    objects={node.blender_object for node in settings['vtree'].nodes.values()
             if node.blender_object is not None}
    supported={'ARMATURE','WEIGHTED_NORMAL','BEVEL','SUBSURF'}
    unsafe=(bpy.app.version[:2]!=(4,0)
        or bool(bpy.app.handlers.frame_change_pre or bpy.app.handlers.frame_change_post)
        or bool(settings.get('gltf_user_extensions')))
    for obj in objects:
        blocks=[obj,getattr(obj,'data',None),getattr(getattr(obj,'data',None),'shape_keys',None)]
        unsafe |= bool(obj.constraints) or obj.parent_type in ('VERTEX','VERTEX_3')
        unsafe |= any(getattr(block,'animation_data',None) and block.animation_data.drivers for block in blocks if block)
        unsafe |= obj.type=='ARMATURE' and any(bone.constraints for bone in obj.pose.bones)
        unsafe |= obj.type=='MESH' and any(mod.type not in supported for mod in obj.modifiers)
    if unsafe:
        print('MERLIN_EXPORT_SAMPLING_MODIFIERS standard dependency-safe fallback',flush=True)
        return gather(settings)
    modifiers=[(mod,mod.show_viewport) for obj in objects if obj.type=='MESH' for mod in obj.modifiers]
    try:
        for mod,_ in modifiers:mod.show_viewport=False
        print('MERLIN_EXPORT_SAMPLING_MODIFIERS',len(modifiers),'temporarily muted after geometry gathering',flush=True)
        return gather(settings)
    finally:
        for mod,visible in modifiers:mod.show_viewport=visible


def _constant(action):
    if not action.fcurves:return False
    for curve in action.fcurves:
        if not curve.keyframe_points or curve.modifiers:return False
        value=float(curve.keyframe_points[0].co.y)
        for point in curve.keyframe_points:
            if float(point.co.y)!=value:return False
            if point.interpolation not in ('LINEAR','CONSTANT'):
                if float(point.handle_left.y)!=value or float(point.handle_right.y)!=value:return False
    return True


def _compact_copy(action):
    copy=bpy.data.actions.new('__MERLIN export constant • '+action.name)
    copy.use_fake_user=False
    for original in action.fcurves:
        kwargs={'index':original.array_index}
        if original.group:kwargs['action_group']=original.group.name
        curve=copy.fcurves.new(original.data_path,**kwargs)
        curve.keyframe_points.add(2)
        value=float(original.keyframe_points[0].co.y)
        curve.keyframe_points.foreach_set('co',[1.,value,2.,value])
        curve.extrapolation='CONSTANT'
        for point in curve.keyframe_points:point.interpolation='LINEAR'
    return copy


def export_interactions(export_names,filepath,controller=None,collection_names=None):
    """Export all synchronized owners; retain the original authored actions.

    Run after the scene is built/saved. No unrelated NLA tracks are discarded.
    The original body-action lengths always determine each merged clip duration.
    Constant non-rig tracks use temporary two-frame actions; glTF holds the final
    sampler value throughout the remainder of that same named clip.
    """
    export_names=list(export_names)
    if controller is None:
        import interaction_support as controller
    if collection_names is None:
        collection_names=('MERLIN • Character','MERLIN • Display mode')
    owned=controller.owners();scene=bpy.context.scene
    # Blender's name lookup scans the Action collection. Resolve the authored
    # sources once before temporary export tracks are added (thousands here).
    action_index={action.name:action for action in bpy.data.actions}
    name_for=getattr(controller,'action_name',None) or controller.base.action_name
    source_for=lambda clip,owner:action_index.get(name_for(clip,owner))
    for owner,data in owned:
        data.animation_data_create()
        if data.animation_data.nla_tracks:
            raise ValueError('Export requires a clean authoring scene; existing NLA tracks on '+owner)
        for name in export_names:
            if source_for(name,owner) is None:raise ValueError('Missing synchronized action: '+name+', '+owner)
    saved_actions={owner:data.animation_data.action for owner,data in owned}
    saved_nla={owner:data.animation_data.use_nla for owner,data in owned}
    saved_frame=scene.frame_current+scene.frame_subframe
    saved_active=scene.get('active_activity')
    saved_range=(scene.frame_start,scene.frame_end)
    saved_selection=list(bpy.context.selected_objects)
    saved_object=bpy.context.view_layer.objects.active
    saved_sound=[(s,s.mute) for s in scene.sequence_editor.sequences_all if s.type=='SOUND'] if scene.sequence_editor else []
    fade=scene.node_tree.nodes.get('Presentation • scene transitions') if scene.use_nodes else None
    saved_fade=fade.mute if fade else None
    copies=[];created=[]
    from io_scene_gltf2.blender.exp import gltf2_blender_gather as gather_module
    original_gather=gather_module.gather_animations
    statistics={'constant_companions':0,'dynamic_or_rig_tracks':0,'owner_frames_before':0,'owner_frames_exported':0}
    try:
        controller.apply_activity(scene,'ReadyIdle',1)
        for owner,data in owned:
            data.animation_data.action=None
            data.animation_data.use_nla=True
            driven=bool(data.animation_data.drivers)
            for name in export_names:
                source=source_for(name,owner)
                original_length=round(source.frame_range[1]-source.frame_range[0])+1
                statistics['owner_frames_before']+=original_length
                if owner!='rig' and not driven and _constant(source):
                    action=_compact_copy(source);copies.append(action)
                    statistics['constant_companions']+=1
                else:
                    action=source;statistics['dynamic_or_rig_tracks']+=1
                statistics['owner_frames_exported']+=round(action.frame_range[1]-action.frame_range[0])+1
                track=data.animation_data.nla_tracks.new();created.append((data,track))
                track.name=name
                strip=track.strips.new(name,1,action)
                strip.action_frame_start=1
                strip.action_frame_end=action.frame_range[1]
                track.mute=True
        bpy.ops.object.select_all(action='DESELECT')
        for collname in collection_names:
            for obj in bpy.data.collections[collname].objects:obj.select_set(True)
        bpy.context.view_layer.objects.active=bpy.data.objects['MERLIN_Rig']
        scene.frame_set(1)
        print('MERLIN_EXPORT_SAMPLING '+json.dumps(statistics),flush=True)
        gather_module.gather_animations=lambda settings:_sample_baked_rig(original_gather,settings)
        bpy.ops.export_scene.gltf(filepath=str(filepath),export_format='GLB',
            use_selection=True,export_animations=True,export_animation_mode='NLA_TRACKS',
            export_nla_strips=True,export_optimize_animation_size=False,
            export_optimize_animation_keep_anim_object=True,export_frame_range=False,
            export_force_sampling=True,export_anim_slide_to_zero=True,
            export_skins=True,export_morph=True,export_cameras=False,export_lights=False,
            export_extras=True)
        print('MERLIN_INTERACTIONS_EXPORTED '+str(filepath),flush=True)
        return statistics
    finally:
        gather_module.gather_animations=original_gather
        for data,track in reversed(created):data.animation_data.nla_tracks.remove(track)
        # Remove only these temporary, detached datablocks in one remap pass.
        # Individual removal rescans every authored Action for every copy.
        if copies:bpy.data.batch_remove(ids=copies)
        for owner,data in owned:
            data.animation_data.action=saved_actions[owner]
            data.animation_data.use_nla=saved_nla[owner]
        scene.frame_start,scene.frame_end=saved_range
        scene.frame_set(int(saved_frame),subframe=saved_frame-int(saved_frame))
        if saved_active is not None:scene['active_activity']=saved_active
        for sound,muted in saved_sound:sound.mute=muted
        if fade:fade.mute=saved_fade
        bpy.ops.object.select_all(action='DESELECT')
        for obj in saved_selection:obj.select_set(True)
        bpy.context.view_layer.objects.active=saved_object
        bpy.context.view_layer.update()


if __name__=='__main__':
    manifest=json.loads((HERE.parent/'interactions.json').read_text())
    export_interactions(list(manifest['clips']),HERE.parent/'merlin-interactions.glb')

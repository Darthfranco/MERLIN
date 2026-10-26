"""Play the rig, expressions, panel and full-screen display as one authored clip."""
import json
import bpy
import transition_support as base
from animate_panel import panel_owners, panel_action_for
from fullscreen_face import fullscreen_owners, fullscreen_action_for


def owners():
    return base.owners()+panel_owners()+fullscreen_owners()


def action_name(clip,owner):
    if owner=='rig':return clip
    if owner=='ball':return clip+' • Ball'
    return clip+' • '+owner


def action_for(clip,owner):
    return bpy.data.actions.get(action_name(clip,owner))


def apply_activity(scene,name,frame=1):
    base.apply_activity(scene,name,frame)
    for owner, data in panel_owners()+fullscreen_owners():
        data.animation_data_create()
        data.animation_data.action=action_for(name,owner)
        if not data.animation_data.action:
            raise ValueError('Missing synchronized display track: '+name+', '+owner)
    scene.frame_set(int(frame),subframe=frame-int(frame))
    bpy.context.view_layer.update()


def compose_clip(name,segments):
    for owner,_ in owners():
        curves={};offset=0
        for segment in segments:
            clip,start,end=segment[:3]
            duration=segment[3] if len(segment)>3 else round(end-start)+1
            action=action_for(clip,owner)
            if action is None:raise ValueError('Missing companion '+clip+', '+owner)
            for curve in action.fcurves:
                values=curves.setdefault((curve.data_path,curve.array_index),[])
                for i in range(duration):
                    time=start+(end-start)*i/max(1,duration-1)
                    values.extend((offset+i+1,curve.evaluate(time)))
            offset+=duration
        action=base.new_action(action_name(name,owner))
        for (path,index),values in curves.items():
            curve=action.fcurves.new(path,index=index)
            curve.keyframe_points.add(len(values)//2)
            curve.keyframe_points.foreach_set('co',values)
        base.linear(action)
    action=bpy.data.actions[name]
    action['segments']=json.dumps(segments)
    action['fps']=24
    return action

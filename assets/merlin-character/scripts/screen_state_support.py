"""Synchronize every character, display, screen, and presentation-state track."""
import json
import bpy
import interaction_support as base
from transition_support import new_action,linear
from animate_body_states import body_state_owners
from animate_face_states import face_state_owners
from animate_left_panel import left_panel_owners


def owners():
    unique={}
    for owner,data in base.owners()+body_state_owners()+face_state_owners()+left_panel_owners():
        if owner in unique and unique[owner]!=data:
            raise ValueError('Duplicate owner identifier: '+owner)
        unique[owner]=data
    return list(unique.items())


def action_for(clip,owner):
    return bpy.data.actions.get(base.action_name(clip,owner))


def apply_activity(scene,name,frame=1):
    base.apply_activity(scene,name,frame)
    for owner,data in owners():
        data.animation_data_create()
        action=action_for(name,owner)
        if action is None:raise ValueError('Missing state companion: '+name+', '+owner)
        data.animation_data.action=action
    scene.frame_set(int(frame),subframe=frame-int(frame))
    bpy.context.view_layer.update()


def compose_clip(name,segments):
    for owner,_ in owners():
        values={};offset=0
        for segment in segments:
            clip,start,end=segment[:3]
            duration=segment[3] if len(segment)>3 else end-start+1
            source=action_for(clip,owner)
            if source is None:raise ValueError('Missing source: '+clip+', '+owner)
            for curve in source.fcurves:
                samples=values.setdefault((curve.data_path,curve.array_index),[])
                for i in range(duration):
                    time=start+(end-start)*i/max(1,duration-1)
                    samples.extend((offset+i+1,curve.evaluate(time)))
            offset+=duration
        target=new_action(base.action_name(name,owner))
        for (path,index),samples in values.items():
            curve=target.fcurves.new(path,index=index)
            curve.keyframe_points.add(len(samples)//2)
            curve.keyframe_points.foreach_set('co',samples)
        linear(target)
    action=bpy.data.actions[name]
    action['segments']=json.dumps(segments);action['fps']=24
    return action

"""Extend the reviewed Blender asset with editable screens and expressive states."""
from pathlib import Path
import json,sys
import bpy
HERE=Path(__file__).resolve().parent
OUT=HERE.parent
sys.path.insert(0,str(HERE))
from animate_body_states import build_body_states,ensure_body_state_companions
from animate_left_panel import build_left_panel,ensure_left_panel_companions
from animate_face_states import build_face_states,ensure_face_state_companions
from screen_content import configure_panel_screens
import screen_state_support as support
from export_interactions import export_interactions

bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-interactions.blend'))
scene=bpy.context.scene;rig=bpy.data.objects['MERLIN_Rig']
old=json.loads((OUT/'interactions.json').read_text())
body=build_body_states(rig)
print('BODY_STATES_READY',list(body),flush=True)
left=build_left_panel(rig)
configure_panel_screens()
print('LEFT_SCREEN_READY',list(left),flush=True)
face=build_face_states(rig)
print('FACE_STATES_READY',list(face),flush=True)
names=list(old['clips'])+list(body)+list(left)+list(face)
assert len(names)==len(set(names))
for name in names:
    length=round(bpy.data.actions[name].frame_range[1])
    if name not in body:ensure_body_state_companions(name,length)
    if name not in left:ensure_left_panel_companions(name,length)
    if name not in face:ensure_face_state_companions(name,length)
    for owner,_ in support.owners():
        if support.action_for(name,owner) is None:raise ValueError('Missing action '+name+', '+owner)

states={
 'ready':{'label':'Ready','idle':'ReadyIdle','parent':None},
 'right':{'label':'Right screen','enter':'ReadyToPanel','idle':'PanelIdle','exit':'PanelToReady','parent':'ready'},
 'left':{'label':'Left screen','enter':'ReadyToLeftPanel','idle':'LeftPanelIdle','exit':'LeftPanelToReady','parent':'ready'},
 'dance':{'label':'Music & dance','enter':'ReadyToDance','idle':'Dance','exit':'DanceToReady','parent':'ready'},
 'bodyThink':{'label':'Deep thought','enter':'ReadyToThink','idle':'BodyThink','exit':'ThinkToReady','parent':'ready'},
 'face':{'label':'Full face','enter':'ReadyToFace','idle':'FullFaceIdle','exit':'FaceToReady','parent':'ready'},
 'camera':{'label':'Camera viewfinder','enter':'FaceToCamera','idle':'CameraIdle','exit':'CameraToFace','parent':'face'},
 'faceThink':{'label':'Thinking face','enter':'FaceToThink','idle':'FaceThink','exit':'ThinkToFace','parent':'face'},
 'search':{'label':'Searching face','enter':'FaceToSearch','idle':'FaceSearch','exit':'SearchToFace','parent':'face'},
 'nap':{'label':'Nap','enter':'ReadyToNap','idle':'Nap','exit':'NapToReady','parent':'ready'},
 'toss':{'label':'Ball toss','enter':'ReadyToWallToss','idle':'WallToss','exit':'WallTossToReady','parent':'ready'},
 'walk':{'label':'Walk & whistle','enter':'ReadyToWalkWhistle','idle':'WalkWhistle','exit':'WalkWhistleToReady','parent':'ready'},
}
segments=[('ReadyIdle',1,1,12)]
for mode in ('dance','bodyThink','left'):
    for key in ('enter','idle','exit'):
        clip=states[mode][key];segments.append((clip,1,round(bpy.data.actions[clip].frame_range[1])))
segments.append(('ReadyToFace',1,40))
for mode in ('camera','faceThink','search'):
    for key in ('enter','idle','exit'):
        clip=states[mode][key];segments.append((clip,1,round(bpy.data.actions[clip].frame_range[1])))
segments.extend([('FaceToReady',1,36),('ReadyIdle',1,1,12)])
support.compose_clip('StatesShowcase',segments)
scene.timeline_markers.clear();timeline=[];offset=0
for segment in segments:
    clip,start,end=segment[:3];duration=segment[3] if len(segment)>3 else end-start+1
    scene.timeline_markers.new(clip,frame=offset+1)
    timeline.append({'clip':clip,'start':offset+1,'end':offset+duration,'source_start':start,'source_end':end})
    offset+=duration
manifest={'version':1,'fps':24,'initial':'ready','states':states,'clips':{},'showcase':timeline,
          'camera':old['camera'],'screens':{},'runtime_note':'Authored animations and local screen preview. No automatic camera, microphone, web search or music playback.'}
for name in names:
    action=bpy.data.actions[name]
    manifest['clips'][name]={'frames':round(action.frame_range[1]),'source':action.get('source_activity'),
                            'source_frame':action.get('source_frame',1),'target':action.get('target_activity'),
                            'target_frame':action.get('target_frame',1)}
for obj in bpy.data.objects:
    sid=obj.get('merlin_screen_id')
    if sid:
        entry=manifest['screens'].setdefault(sid,{'nodes':[],'materials':[]})
        entry['nodes'].append(obj.name)
        for material in obj.data.materials:
            if material and material.get('merlin_screen_id')==sid and material.name not in entry['materials']:
                entry['materials'].append(material.name)
manifest['lighting']={'world_color':[.008,.016,.033],'exposure':scene.view_settings.exposure,
    'lights':[{'name':o.name,'type':o.data.type,'color':list(o.data.color),'energy':o.data.energy,
               'matrix_world':[list(row) for row in o.matrix_world],'size':getattr(o.data,'size',1)}
              for o in scene.objects if o.type=='LIGHT']}
(OUT/'states.json').write_text(json.dumps(manifest,indent=2)+'\n')
scene['states_timeline']=json.dumps(timeline)
scene['screen_api']='screen_content.set_screen_image / set_screen_pixels; browser merlin.screens[id].draw / setSource'
support.apply_activity(scene,'StatesShowcase',1)
scene.render.engine='CYCLES';scene.cycles.samples=64
scene.render.resolution_x=1600;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.filepath='//previews/merlin-states.png'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-states.blend'),compress=True)
print('MERLIN_STATES_BLEND_READY',len(names),offset,flush=True)
if '--no-export' not in sys.argv:
    collections=['MERLIN • Character','MERLIN • Display mode','MERLIN • Face states']
    export_interactions(names,OUT/'merlin-states.glb',controller=support,collection_names=collections)
    print('MERLIN_STATES_EXPORT_COMPLETE',flush=True)

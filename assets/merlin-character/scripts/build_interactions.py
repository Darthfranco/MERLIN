"""Refine MERLIN's acting and add the panel and coherent full-screen face modes.

Run in Blender 4.0.2 after the previous transitions asset has been built.
"""
from pathlib import Path
import sys,json
import bpy
HERE=Path(__file__).resolve().parent
OUT=HERE.parent
sys.path.insert(0,str(HERE))
from animate_transitions import build_transition_actions
from transition_support import build_companions,FACE_OBJECTS
from expressive_face import add_expression_shapes,enhance_expression,conform_expression
from animate_panel import build_panel_actions,ensure_panel_companions
from fullscreen_face import build_fullscreen_actions,build_fullscreen_companions
from interaction_support import apply_activity,owners,action_for,compose_clip

bpy.ops.wm.open_mainfile(filepath=str(OUT/'merlin-transitions.blend'))
scene=bpy.context.scene
rig=bpy.data.objects['MERLIN_Rig']
transitions=build_transition_actions(rig)
add_expression_shapes()
original=['Idle','Wave','Jump','WalkWhistle','WallToss','Nap']
for name in original:
    # Existing companions carry whistling, sleeping and ball trajectories.
    enhance_expression(name)
print('Original expressions enhanced',flush=True)
for name,action in transitions.items():
    source=action.get('source_activity');target=action.get('target_activity')
    build_companions(name,source if source!='ReadyIdle' else None,action.get('source_frame',1),
                     target if target!='ReadyIdle' else None,action.get('target_frame',1))
    enhance_expression(name)
print('Natural wake-up and connected face acting baked',flush=True)
panels=build_panel_actions(rig)
# PanelIdle first because entrance/exit share its precise face endpoints.
for name in ['PanelIdle','ReadyToPanel','PanelToReady']:
    action=bpy.data.actions[name]
    source=action.get('source_activity');target=action.get('target_activity')
    build_companions(name, source if source not in (name,'ReadyIdle') else None,action.get('source_frame',1),
                     target if target not in (name,'ReadyIdle') else None,action.get('target_frame',1))
    enhance_expression(name)
print('Panel presentation and tap dismissal baked',flush=True)
faces=build_fullscreen_actions(rig)
for name in faces:
    build_companions(name)
    conform_expression(name)
export_names=original+list(transitions)+list(panels)+list(faces)
for name in export_names:
    length=round(bpy.data.actions[name].frame_range[1])
    if name not in panels:ensure_panel_companions(name,length)
    if name not in faces:build_fullscreen_companions(name,length)

# A continuous review reel begins asleep and demonstrates every new route.
segments=[('Nap',192,192,12),('NapToReady',1,108),('ReadyIdle',1,1,12),
          ('ReadyToPanel',1,180),('PanelIdle',1,96),('PanelToReady',1,144),
          ('ReadyIdle',1,1,12),('ReadyToFace',1,40),('FullFaceIdle',1,96),
          ('FaceToReady',1,36),('ReadyIdle',1,1,12)]
showcase=compose_clip('ExperienceShowcase',segments)
scene.timeline_markers.clear();offset=0;timeline=[]
for segment in segments:
    name,start,end=segment[:3]
    duration=segment[3] if len(segment)>3 else end-start+1
    scene.timeline_markers.new(name,frame=offset+1)
    timeline.append({'clip':name,'start':offset+1,'end':offset+duration,'source_start':start,'source_end':end})
    offset+=duration
showcase['timeline']=json.dumps(timeline)
scene['experience_notes']='Natural wake-up; expressive face acting; physical right-side panel pull and clean tap dismissal; continuous display expansion with seven-bar cyan mouth.'
scene['experience_timeline']=json.dumps(timeline)
scene['experience_scope']='Authored Blender/GLB animation assets. Live assistant state control and panel content are separate application work.'

manifest={'fps':24,'ready':'ReadyIdle','clips':{},'routes':{},'showcase':timeline,
          'panel':{'side':'right','width_fraction':.466,'tap_shatter_frames':[31,53]},
          'display':{'enter':'ReadyToFace','idle':'FullFaceIdle','exit':'FaceToReady','mouth':'seven rounded cyan bars',
                     'camera_required':'Camera • landscape tablet; preserve its transform and 4:3 orthographic framing'},
          'runtime_note':'Play synchronized tracks with room/camera/lighting. Application interaction triggers and panel content are not included.',
          'camera':{'type':'orthographic','matrix_world':[list(row) for row in scene.camera.matrix_world],
                    'orthographic_width':scene.camera.data.ortho_scale,'aspect_ratio':4/3}}
for name in export_names:
    action=bpy.data.actions[name]
    manifest['clips'][name]={'frames':round(action.frame_range[1]),'source':action.get('source_activity'),
                            'source_frame':action.get('source_frame'),'target':action.get('target_activity'),
                            'target_frame':action.get('target_frame')}
for n in ['Nap','WallToss','WalkWhistle']:manifest['routes'][n]={'enter':'ReadyTo'+n,'idle':n,'exit':n+'ToReady'}
manifest['routes']['Panel']={'enter':'ReadyToPanel','idle':'PanelIdle','exit':'PanelToReady'}
manifest['routes']['Face']={'enter':'ReadyToFace','idle':'FullFaceIdle','exit':'FaceToReady'}
(OUT/'interactions.json').write_text(json.dumps(manifest,indent=2)+'\n')
text=bpy.data.texts.new('MERLIN • New interactions.py')
text.write("# from interaction_support import apply_activity\n# apply_activity(bpy.context.scene, 'ReadyToPanel')\n# apply_activity(bpy.context.scene, 'PanelToReady')\n# apply_activity(bpy.context.scene, 'ReadyToFace')\n# apply_activity(bpy.context.scene, 'FaceToReady')\n# Default timeline: ExperienceShowcase\n")
apply_activity(scene,'ExperienceShowcase',1)
scene.render.engine='CYCLES';scene.cycles.samples=64
scene.render.resolution_x=1600;scene.render.resolution_y=1200
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.filepath='//previews/merlin-expressive-ready.png'
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin-interactions.blend'),compress=True)
print('MERLIN_INTERACTIONS_BLEND_READY',offset,export_names,flush=True)

from export_interactions import export_interactions
export_interactions(export_names,str(OUT/'merlin-interactions.glb'))
print('MERLIN_INTERACTIONS_COMPLETE',offset,export_names,flush=True)

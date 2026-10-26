"""Decode the delivered H.264 movie and extract actual encoded review frames."""
from pathlib import Path
import json,tempfile
import bpy
OUT=Path(__file__).resolve().parent.parent
manifest=json.loads((OUT/'interactions.json').read_text())
segments=manifest['showcase'];length=segments[-1]['end']
scene=bpy.context.scene
scene.sequence_editor_clear()
editor=scene.sequence_editor_create()
movie=editor.sequences.new_movie('Encoded interaction movie',str(OUT/'previews/merlin-interactions.mp4'),channel=1,frame_start=1)
assert movie.frame_duration==length,(movie.frame_duration,length)
assert (movie.elements[0].orig_width,movie.elements[0].orig_height)==(800,600)
scene.render.resolution_x=800;scene.render.resolution_y=600;scene.render.resolution_percentage=100
scene.render.fps=24;scene.render.use_sequencer=True;scene.render.engine='BLENDER_EEVEE'
scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
scene.view_settings.exposure=0;scene.view_settings.gamma=1
scene.render.image_settings.file_format='PNG'
review=[]
for clip,relative in [('NapToReady',28),('NapToReady',55),('ReadyToPanel',70),('ReadyToPanel',110),
                      ('PanelIdle',1),('PanelToReady',42),('PanelToReady',144),
                      ('ReadyToFace',12),('ReadyToFace',23),('FullFaceIdle',49),('FaceToReady',23),('FaceToReady',36)]:
    segment=next(s for s in segments if s['clip']==clip)
    frame=segment['start']+relative-segment['source_start']
    scene.frame_set(frame)
    path=Path(tempfile.gettempdir())/f'merlin-interaction-decoded-{clip}-{relative}.png'
    scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)
    review.append({'frame':frame,'clip':clip,'clip_frame':relative})
report={'passed':True,'video':'merlin-interactions.mp4','frames':length,'fps':24,'dimensions':[800,600],
        'duration_seconds':length/24,'audio':'Silent performance preview; no speech or soundtrack authored.',
        'decoded_review_frames':review}
(OUT/'previews/interaction-video-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('INTERACTION_VIDEO_CHECK_COMPLETE',json.dumps(report))

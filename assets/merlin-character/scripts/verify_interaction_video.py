"""Decode the delivered H.264 movie and extract actual encoded review frames."""
from pathlib import Path
import json,struct,tempfile
import bpy
OUT=Path(__file__).resolve().parent.parent

def encoded_metadata(path):
    """Read MP4 timing directly; scene playback settings are not evidence."""
    data=path.read_bytes()
    def atoms(start,end):
        while start<end:
            assert end-start>=8,'Truncated MP4 box'
            size,kind=struct.unpack_from('>I4s',data,start);header=8
            if size==1:
                assert end-start>=16,'Truncated extended MP4 box'
                size=struct.unpack_from('>Q',data,start+8)[0];header=16
            elif size==0:size=end-start
            assert header<=size<=end-start,'Invalid MP4 box size'
            yield kind,start+header,start+size
            start+=size
    def child(parent,kind):
        return next((box for box in atoms(parent[1],parent[2]) if box[0]==kind),None)
    def timing(box):
        assert box is not None,'Missing MP4 timing box'
        p=box[1];version=data[p]
        assert version in (0,1),'Unsupported MP4 timing version'
        offset=p+(20 if version else 12)
        timescale=struct.unpack_from('>I',data,offset)[0]
        duration=struct.unpack_from('>Q' if version else '>I',data,offset+4)[0]
        assert timescale>0,'Invalid MP4 timebase'
        return timescale,duration
    moov=next(box for box in atoms(0,len(data)) if box[0]==b'moov')
    movie_scale,movie_duration=timing(child(moov,b'mvhd'))
    videos=[];audio_tracks=0
    for track in atoms(moov[1],moov[2]):
        if track[0]!=b'trak':continue
        media=child(track,b'mdia');handler=child(media,b'hdlr')
        kind=data[handler[1]+8:handler[1]+12]
        audio_tracks+=kind==b'soun'
        if kind!=b'vide':continue
        scale,duration=timing(child(media,b'mdhd'))
        table=child(child(media,b'minf'),b'stbl')
        stts=child(table,b'stts');assert stts is not None,'Missing frame timing table'
        entries=struct.unpack_from('>I',data,stts[1]+4)[0]
        assert stts[1]+8+entries*8<=stts[2],'Truncated frame timing table'
        samples=[struct.unpack_from('>II',data,stts[1]+8+i*8) for i in range(entries)]
        assert samples and all(count>0 and delta>0 for count,delta in samples),'Invalid frame timing samples'
        deltas={delta for count,delta in samples}
        assert len(deltas)==1,'Expected constant frame rate'
        frames=sum(count for count,delta in samples)
        sample_duration=sum(count*delta for count,delta in samples)
        assert duration==sample_duration,'Media duration differs from timed video frames'
        stsz=child(table,b'stsz');assert stsz is not None,'Missing encoded sample count'
        assert struct.unpack_from('>I',data,stsz[1]+8)[0]==frames,'Encoded sample count differs'
        videos.append({'frames':frames,'fps':scale/next(iter(deltas)),
                       'duration_seconds':duration/scale,'media_timescale':scale,
                       'frame_duration_units':next(iter(deltas))})
    assert len(videos)==1,'Expected one encoded video stream'
    result=videos[0]
    result.update(container_duration_seconds=movie_duration/movie_scale,
                  container_timescale=movie_scale,audio_tracks=audio_tracks)
    assert abs(result['container_duration_seconds']-result['duration_seconds'])<=2/movie_scale,'Container duration differs from video'
    return result

manifest=json.loads((OUT/'interactions.json').read_text())
segments=manifest['showcase'];length=segments[-1]['end']
metadata=encoded_metadata(OUT/'previews/merlin-interactions.mp4')
assert metadata['frames']==length,(metadata['frames'],length)
assert abs(metadata['fps']-24)<1e-6,metadata
assert abs(metadata['duration_seconds']-length/24)<1e-6,metadata
assert metadata['audio_tracks']==0,metadata
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
report={'passed':True,'video':'merlin-interactions.mp4','frames':metadata['frames'],'fps':metadata['fps'],'dimensions':[800,600],
        'duration_seconds':metadata['duration_seconds'],'encoded_timing':metadata,'audio':'Silent performance preview; no speech or soundtrack authored.',
        'decoded_review_frames':review}
(OUT/'previews/interaction-video-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('INTERACTION_VIDEO_CHECK_COMPLETE',json.dumps(report))

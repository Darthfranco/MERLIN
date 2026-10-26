"""Decode the finished transition movie and check timing and whistle placement."""
from pathlib import Path
import array
import json
import math
import tempfile
import wave

import bpy

ASSETS = Path(__file__).resolve().parent.parent
manifest = json.loads((ASSETS/'transitions.json').read_text())
segments = manifest['showcase']
length = segments[-1]['end']
walking = next(item for item in segments if item['clip'] == 'WalkWhistle')
movie_path = ASSETS/'previews'/'merlin-transitions.mp4'
scene = bpy.context.scene
scene.sequence_editor_clear()
editor = scene.sequence_editor_create()
movie = editor.sequences.new_movie('Encoded transition video', str(movie_path), channel=1, frame_start=1)
editor.sequences.new_sound('Encoded transition audio', str(movie_path), channel=2, frame_start=1)
assert movie.frame_duration == length, movie.frame_duration
assert (movie.elements[0].orig_width, movie.elements[0].orig_height) == (800, 600)
scene.frame_start = 1
scene.frame_end = length
scene.render.fps = 24
scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.resolution_percentage = 100
scene.render.engine = 'BLENDER_EEVEE'
scene.render.use_sequencer = True
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.image_settings.file_format = 'PNG'
review = []
for clip, relative in [('ReadyIdle', 1), ('ReadyToNap', 52), ('PreviewNapReturn', 49),
                        ('PreviewNapReturn', 80), ('ReadyToWallToss', 42),
                        ('PreviewWallReturn', 35), ('ReadyToWalkWhistle', 42),
                        ('WalkWhistleToReady', 35), ('WalkWhistleToReady', 108)]:
    segment = next(item for item in segments if item['clip'] == clip)
    frame = segment['start']+relative-1
    scene.frame_set(frame)
    path = Path(tempfile.gettempdir())/f'merlin-transition-decoded-{clip}-{relative}.png'
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    review.append({'frame': frame, 'clip': clip, 'clip_frame': relative})
with tempfile.TemporaryDirectory(prefix='merlin-audio-check-') as temp:
    audio_path = str(Path(temp)/'decoded.wav')
    bpy.ops.sound.mixdown(filepath=audio_path, container='WAV', codec='PCM', format='S16')
    with wave.open(audio_path, 'rb') as stream:
        channels = stream.getnchannels()
        rate = stream.getframerate()
        count = stream.getnframes()
        samples = array.array('h', stream.readframes(count))
start = round((walking['start']-1)/24*rate)*channels
finish = round(walking['end']/24*rate)*channels
walking_audio = samples[start:finish]
peak = max(abs(value) for value in walking_audio)/32768
rms = math.sqrt(sum(value*value for value in walking_audio)/len(walking_audio))/32768
outside = samples[:max(0, start-rate*channels//10)] + samples[finish+rate*channels//10:]
outside_rms = math.sqrt(sum(value*value for value in outside)/max(1, len(outside)))/32768
assert abs(count/rate-length/24) < .1
assert .05 < peak < .2 and rms > .01, (peak, rms)
assert outside_rms < .001, outside_rms
report = {'passed': True, 'video': movie_path.name, 'frames': length, 'fps': 24,
          'dimensions': [800, 600], 'duration_seconds': length/24,
          'audio_decoded_duration_seconds': count/rate, 'audio_channels': channels,
          'audio_sample_rate': rate, 'whistle_frames': [walking['start'], walking['end']],
          'walk_audio_peak_dbfs': 20*math.log10(peak), 'walk_audio_rms_dbfs': 20*math.log10(rms),
          'outside_walk_audio_rms': outside_rms, 'decoded_review_frames': review}
(ASSETS/'previews'/'transition-video-validation.json').write_text(json.dumps(report, indent=2)+'\n')
print('TRANSITION_VIDEO_CHECK_COMPLETE', json.dumps(report))

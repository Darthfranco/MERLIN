#!/usr/bin/env python3
"""Local MERLIN-only keyword spotting + speech activity, JSON lines over stdio.

No recognizer/transcripts, network calls, audio files, or retained audio segments.
The small recurrent/model state and at most 511 pending PCM samples stay in RAM.
"""

import argparse
import base64
import contextlib
import json
from pathlib import Path
import sys

SAMPLE_RATE = 16000
WINDOW = 512
MAX_PCM_BYTES = 16000
MAX_LINE = 24000
MIN_SPEECH = 0.16
MIN_SILENCE = 1.1


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Detector:
    def __init__(self, model_dir):
        import numpy as np
        import sherpa_onnx

        self.np = np
        self.kws = sherpa_onnx.KeywordSpotter(
            tokens=str(model_dir / "tokens.txt"),
            encoder=str(model_dir / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            decoder=str(model_dir / "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            joiner=str(model_dir / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            keywords_file=str(model_dir / "keywords.txt"),
            num_threads=1, sample_rate=SAMPLE_RATE, provider="cpu",
            keywords_score=1.5, keywords_threshold=0.35, num_trailing_blanks=1,
        )
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(model_dir / "silero_vad.onnx")
        config.silero_vad.window_size = WINDOW
        config.silero_vad.threshold = 0.5
        config.silero_vad.min_speech_duration = MIN_SPEECH
        config.silero_vad.min_silence_duration = MIN_SILENCE
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        config.provider = "cpu"
        self.vad = sherpa_onnx.VadModel.create(config)
        if self.vad.window_size() != WINDOW:
            raise RuntimeError("Unsupported VAD window")
        self.reset()

    def reset(self):
        self.stream = self.kws.create_stream()
        self.vad.reset()
        self.pending = self.np.empty(0, dtype=self.np.float32)
        self.sample = 0
        self.processed = 0
        self.stream_start = 0
        self.keyword_enabled = True
        self.speech = False

    def process(self, pcm, keyword_enabled):
        if keyword_enabled != self.keyword_enabled:
            # A conversation cannot leave old keyword hypotheses armed on return.
            self.stream = self.kws.create_stream()
            self.stream_start = self.processed
            self.keyword_enabled = keyword_enabled
        samples = self.np.frombuffer(pcm, dtype="<i2").astype(self.np.float32) / 32768.0
        self.sample += len(samples)
        self.pending = self.np.concatenate((self.pending, samples))
        events = []
        offset = 0
        while len(self.pending) - offset >= WINDOW:
            window = self.pending[offset:offset + WINDOW]
            offset += WINDOW
            self.processed += WINDOW
            speech = bool(self.vad.is_speech(window))
            if speech != self.speech:
                if speech:
                    events.append({"type": "speech_start", "sample": self.processed,
                                   "startSample": max(0, self.processed - round(MIN_SPEECH * SAMPLE_RATE) - WINDOW)})
                else:
                    events.append({"type": "speech_end", "sample": self.processed,
                                   "endSample": max(0, self.processed - round(MIN_SILENCE * SAMPLE_RATE))})
                self.speech = speech
            if keyword_enabled:
                self.stream.accept_waveform(SAMPLE_RATE, window)
                while self.kws.is_ready(self.stream):
                    self.kws.decode_stream(self.stream)
                    result = self.kws.keyword_spotter.get_result(self.stream)
                    if result.keyword.strip() == "MERLIN":
                        timestamps = result.timestamps
                        start = self.stream_start + round(timestamps[0] * SAMPLE_RATE) if timestamps else self.processed
                        end = self.stream_start + round(timestamps[-1] * SAMPLE_RATE) + 1280 if timestamps else self.processed
                        events.append({"type": "wake", "sample": self.processed,
                                       "startSample": max(0, min(start, self.processed)),
                                       "endSample": max(0, min(end, self.processed))})
                        # A new stream discards feature history, not only the result.
                        self.stream = self.kws.create_stream()
                        self.stream_start = self.processed
                        break
                age = self.processed - self.stream_start
                if (not speech and age >= SAMPLE_RATE * 30) or age >= SAMPLE_RATE * 60:
                    # Bound feature history even in an endlessly noisy room.
                    self.stream = self.kws.create_stream()
                    self.stream_start = self.processed
        self.pending = self.pending[offset:].copy()
        return {"sample": self.sample, "speech": self.speech, "events": events}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            detector = Detector(args.model_dir)
    except Exception:
        emit({"type": "fatal", "error": "setup"})
        return 1
    emit({"type": "ready"})
    while True:
        line = sys.stdin.readline(MAX_LINE + 1)
        if not line:
            return 0
        if len(line) > MAX_LINE or not line.endswith("\n"):
            emit({"type": "fatal", "error": "request"})
            return 1
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
                raise ValueError("request")
            if request.get("type") == "reset":
                detector.reset()
                result = {"sample": 0, "speech": False, "events": []}
            elif request.get("type") == "audio":
                if not isinstance(request.get("pcm"), str) or not isinstance(request.get("keywordEnabled"), bool):
                    raise ValueError("request")
                pcm = base64.b64decode(request["pcm"], validate=True)
                if not 2 <= len(pcm) <= MAX_PCM_BYTES or len(pcm) % 2:
                    raise ValueError("request")
                with contextlib.redirect_stdout(sys.stderr):
                    result = detector.process(pcm, request["keywordEnabled"])
                # Do not retain the transport representation between messages.
                del pcm
            else:
                raise ValueError("request")
            emit({"id": request_id, **result})
            del request, line
        except Exception:
            # Do not surface audio-derived errors or payloads.
            emit({"id": request_id, "error": "detection"})
            return 1


if __name__ == "__main__":
    sys.exit(main())

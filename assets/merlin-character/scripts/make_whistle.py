#!/usr/bin/env python3
"""Create MERLIN's quiet, original WalkWhistle sound using only Python stdlib.

Run from any directory. The default output is audio/merlin-whistle.wav beside
the character scripts. This is a procedural whistle, not recorded speech or a
sample of existing music. Its eight-second timeline matches the 192-frame,
24-fps WalkWhistle action; place the sound at the action's first frame.
"""

from array import array
import argparse
import json
import math
from pathlib import Path
import random
import sys
import wave


SAMPLE_RATE = 48_000
DURATION = 8.0
# (onset seconds, sounding duration seconds, MIDI pitch, relative breath)
# Unequal spacing and a pause for breath keep this small authored motif casual.
NOTES = (
    (1.08, 0.38, 78, 0.76),
    (1.55, 0.24, 81, 0.63),
    (1.87, 0.53, 79, 0.81),
    (2.55, 0.29, 76, 0.66),
    (2.94, 0.57, 78, 0.74),
    (4.14, 0.32, 76, 0.66),
    (4.55, 0.24, 79, 0.60),
    (4.89, 0.45, 81, 0.72),
    (5.48, 0.31, 78, 0.67),
    (5.88, 0.29, 76, 0.62),
    (6.25, 0.43, 74, 0.58),
)


def smoothstep(value):
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def synthesize():
    """Return exactly eight seconds of quiet, deterministic floating audio."""
    result = [0.0] * round(DURATION * SAMPLE_RATE)
    random_source = random.Random(261026)
    for note_index, (onset, duration, midi, strength) in enumerate(NOTES):
        base_hz = 440.0 * 2.0 ** ((midi - 69.0) / 12.0)
        onset_index = round(onset * SAMPLE_RATE)
        length = round(duration * SAMPLE_RATE)
        phase = random_source.random() * math.tau
        breath_low = 0.0
        breath_high = 0.0
        low_coefficient = 1.0 - math.exp(-math.tau * 3600.0 / SAMPLE_RATE)
        high_coefficient = 1.0 - math.exp(-math.tau * 850.0 / SAMPLE_RATE)
        for index in range(length):
            elapsed = index / SAMPLE_RATE
            progress = elapsed / duration
            # A soft lip attack, a little upward scoop, then a relaxed release.
            attack = smoothstep(elapsed / 0.065)
            release = smoothstep((duration - elapsed) / 0.105)
            envelope = attack * release * (0.97 - 0.13 * progress)
            scoop_cents = -30.0 * math.exp(-elapsed / 0.035)
            release_cents = -12.0 * smoothstep((progress - 0.70) / 0.30)
            vibrato_cents = 4.2 * smoothstep(elapsed / 0.16) * math.sin(
                math.tau * (4.65 + note_index * 0.037) * elapsed + note_index
            )
            drift_cents = 2.4 * math.sin(math.tau * 0.8 * elapsed + note_index)
            hz = base_hz * 2.0 ** (
                (scoop_cents + release_cents + vibrato_cents + drift_cents) / 1200.0
            )
            phase += math.tau * hz / SAMPLE_RATE
            tone = math.sin(phase) + 0.012 * math.sin(2.0 * phase + 0.4)
            # A very small filtered air component softens the otherwise pure sine.
            white_noise = random_source.uniform(-1.0, 1.0)
            breath_low += low_coefficient * (white_noise - breath_low)
            breath_high += high_coefficient * (breath_low - breath_high)
            breath = breath_low - breath_high
            flutter = 1.0 + 0.012 * math.sin(math.tau * 7.1 * elapsed + note_index)
            result[onset_index + index] += (
                0.145 * strength * envelope * flutter * (tone + 0.065 * breath)
            )

    # Subtle short room reflections; no long ringing or hard repeated echo.
    dry = result[:]
    for delay_seconds, gain in ((0.043, 0.035), (0.079, 0.022), (0.127, 0.012)):
        delay_samples = round(delay_seconds * SAMPLE_RATE)
        for index in range(delay_samples, len(result)):
            result[index] += dry[index - delay_samples] * gain
    return result


def save_and_verify(output, samples):
    output.parent.mkdir(parents=True, exist_ok=True)
    pcm = array("h", (round(max(-1.0, min(1.0, sample)) * 32767) for sample in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(output), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes(pcm.tobytes())

    with wave.open(str(output), "rb") as stream:
        assert stream.getnchannels() == 1
        assert stream.getsampwidth() == 2
        assert stream.getframerate() == SAMPLE_RATE
        assert stream.getnframes() == round(DURATION * SAMPLE_RATE)
        decoded = array("h", stream.readframes(stream.getnframes()))
        if sys.byteorder != "little":
            decoded.byteswap()
    values = [sample / 32767.0 for sample in decoded]
    peak = max(abs(sample) for sample in values)
    rms = math.sqrt(sum(sample * sample for sample in values) / len(values))
    mean = sum(values) / len(values)
    largest_step = max(abs(b - a) for a, b in zip(values, values[1:]))
    assert peak < 0.16, "The idle whistle should stay quiet."
    assert abs(mean) < 0.0001, "Unexpected DC offset."
    assert largest_step < 0.04, "Unexpected abrupt sample discontinuity."
    assert all(sample == 0 for sample in decoded[: round(0.95 * SAMPLE_RATE)])
    assert all(sample == 0 for sample in decoded[round(7.0 * SAMPLE_RATE) :])
    return {
        "file": str(output),
        "duration_seconds": len(values) / SAMPLE_RATE,
        "sample_rate_hz": SAMPLE_RATE,
        "channels": 1,
        "bits_per_sample": 16,
        "peak_dbfs": round(20.0 * math.log10(peak), 2),
        "rms_dbfs": round(20.0 * math.log10(rms), 2),
        "mean": round(mean, 8),
        "largest_sample_step": round(largest_step, 5),
        "first_note_seconds": NOTES[0][0],
        "last_note_release_seconds": round(NOTES[-1][0] + NOTES[-1][1], 2),
        "provenance": "Original procedural motif; no recordings or external samples.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "audio" / "merlin-whistle.wav",
    )
    options = parser.parse_args()
    print(json.dumps(save_and_verify(options.output, synthesize()), indent=2))


if __name__ == "__main__":
    main()

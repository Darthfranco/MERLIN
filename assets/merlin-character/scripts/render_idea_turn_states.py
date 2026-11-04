"""Render the idea face and a wall turn without saving scene changes.

Usage: blender -b assets/merlin-character/merlin-states.blend --python this.py [-- OUTPUT_DIR]
Uses the same Cycles still settings as render_screen_states.py.
"""
from pathlib import Path
import sys

import bpy

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import render_screen_states as stills

stills.POSES = [
    ('FaceIdea', 14, 'face-idea-ponder'),
    ('FaceIdea', 56, 'face-idea-lit'),
    ('WalkTurnAtRight', 11, 'walk-turn'),
]
if '--' in sys.argv and sys.argv[sys.argv.index('--') + 1:]:
    stills.OUT = Path(sys.argv[sys.argv.index('--') + 1])

if __name__ == '__main__':
    stills.render_stills()

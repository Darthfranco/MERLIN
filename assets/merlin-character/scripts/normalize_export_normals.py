"""Reconcile only signed-zero normal bits on the known expanding-head primitive.

Independent Blender mesh evaluation can produce +0.0 versus -0.0. This opt-in
pre-merge step requires identical numeric normal values and every other named
scene resource. It does not introduce tolerances into the strict GLB merger.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import json
import math
import struct

from merge_animation_glb import Resources, read_glb, write_glb

NODE = 'Display mode • expanding head'
PRIMITIVE = 1


def normal_data(document, binary):
    node = next(node for node in document['nodes'] if node['name'] == NODE)
    index = document['meshes'][node['mesh']]['primitives'][PRIMITIVE]['attributes']['NORMAL']
    accessor = document['accessors'][index]
    if accessor['componentType'] != 5126 or accessor['type'] != 'VEC3' or 'sparse' in accessor:
        raise ValueError('Expected ordinary float32 VEC3 normals')
    view = document['bufferViews'][accessor['bufferView']]
    if view.get('buffer', 0) != 0:
        raise ValueError('Expected embedded normals')
    start = view.get('byteOffset', 0)+accessor.get('byteOffset', 0)
    stride = view.get('byteStride', 12)
    offsets = [start+i*stride+axis*4 for i in range(accessor['count']) for axis in range(3)]
    if offsets[-1]+4 > view.get('byteOffset', 0)+view['byteLength']:
        raise ValueError('Normal accessor exceeds its buffer view')
    words = [struct.unpack_from('<I', binary, offset)[0] for offset in offsets]
    return offsets, words


def normalize_signed_zero_normals(baseline_path, additions_path):
    if Path(baseline_path).resolve() == Path(additions_path).resolve():
        raise ValueError('Baseline and additions must be separate files')
    baseline, old_binary = read_glb(baseline_path)
    additions, new_binary = read_glb(additions_path)
    old_scene = Resources(baseline, old_binary).scene_fingerprint()
    new_scene = Resources(additions, new_binary).scene_fingerprint()
    if old_scene == new_scene:
        return {'passed': True, 'changed': False, 'scene_resources_identical': True}
    candidate = copy.deepcopy(new_scene)
    original_normal = old_scene[NODE]['mesh']['primitives'][PRIMITIVE]['attributes']['NORMAL']
    candidate[NODE]['mesh']['primitives'][PRIMITIVE]['attributes']['NORMAL']['packed_sha256'] = original_normal['packed_sha256']
    if candidate != old_scene:
        raise ValueError('Resources differ beyond the permitted expanding-head normal payload')
    _, old_words = normal_data(baseline, old_binary)
    offsets, new_words = normal_data(additions, new_binary)
    if len(old_words) != len(new_words):
        raise ValueError('Normal counts differ')
    changes = []
    binary = bytearray(new_binary)
    lengths = []
    for index, (old, new, offset) in enumerate(zip(old_words, new_words, offsets)):
        if old != new:
            if {old, new} != {0, 0x80000000}:
                raise ValueError('A normal component differs numerically; signed-zero normalization refused')
            struct.pack_into('<I', binary, offset, old)
            changes.append({'vertex': index//3, 'axis': index%3,
                            'baseline_bits': hex(old), 'exported_bits': hex(new)})
    for index in range(0, len(old_words), 3):
        row = [struct.unpack('<f', struct.pack('<I', word))[0] for word in old_words[index:index+3]]
        lengths.append(math.sqrt(sum(value*value for value in row)))
    if Resources(additions, bytes(binary)).scene_fingerprint() != old_scene:
        raise AssertionError('Strict resource equality was not restored')
    changed_offsets = {offset+byte for index, offset in enumerate(offsets)
                       if old_words[index] != new_words[index] for byte in range(4)}
    if any(a != b and index not in changed_offsets for index, (a, b) in enumerate(zip(new_binary, binary))):
        raise AssertionError('Unrelated binary bytes changed')
    before_hash = hashlib.sha256(Path(additions_path).read_bytes()).hexdigest()
    write_glb(additions_path, additions, bytes(binary))
    checked, checked_binary = read_glb(additions_path)
    if checked != additions or checked_binary != bytes(binary):
        raise AssertionError('Serialized normalization changed unrelated data')
    return {'passed': True, 'changed': True, 'node': NODE, 'primitive': PRIMITIVE,
            'normal_count': len(old_words)//3, 'changed_normal_count': len({c['vertex'] for c in changes}),
            'changed_component_count': len(changes), 'changes': changes,
            'maximum_numeric_component_error': 0., 'maximum_numeric_vector_error': 0.,
            'normal_length_range': [min(lengths), max(lengths)],
            'scene_resources_identical': True, 'other_binary_bytes_unchanged': True,
            'input_sha256': before_hash, 'normalized_sha256': hashlib.sha256(Path(additions_path).read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('additions', type=Path)
    parser.add_argument('--report', type=Path)
    arguments = parser.parse_args()
    report = normalize_signed_zero_normals(arguments.baseline, arguments.additions)
    if arguments.report:
        arguments.report.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()

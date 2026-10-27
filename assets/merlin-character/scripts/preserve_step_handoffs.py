"""Preserve the ceiling card's stepped owner handoff in a sampled glTF export.

The surrounding animation stays LINEAR. A duplicate held value at the previous
representable float32 timestamp makes the ownership switch effectively atomic
without changing shared samplers, existing accessors, or scene resources.
"""
from pathlib import Path
import argparse
import bisect
import copy
import json
import math
import struct

from merge_animation_glb import read_glb, write_glb

CLIP = 'CeilingToLeftPanel'
WIDTHS = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}
DEFAULTS = {'translation': (0., 0., 0.), 'rotation': (0., 0., 0., 1.),
            'scale': (1., 1., 1.)}


def float32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def previous_float32(value):
    value = float32(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError('Handoff time must be positive and finite')
    bits = struct.unpack('<I', struct.pack('<f', value))[0]
    return struct.unpack('<f', struct.pack('<I', bits - 1))[0]


def values(document, binary, index):
    accessor = document['accessors'][index]
    if (accessor['componentType'] != 5126 or accessor['type'] not in WIDTHS
            or 'sparse' in accessor or 'bufferView' not in accessor):
        raise ValueError('Expected an ordinary float animation accessor')
    width = WIDTHS[accessor['type']]
    view = document['bufferViews'][accessor['bufferView']]
    if view.get('buffer', 0) != 0:
        raise ValueError('Expected an embedded animation buffer')
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    stride = view.get('byteStride', width * 4)
    end = view.get('byteOffset', 0) + view['byteLength']
    if accessor['count'] and start + (accessor['count']-1)*stride + width*4 > end:
        raise ValueError('Animation accessor exceeds its buffer view')
    rows = [struct.unpack_from('<'+'f'*width, binary, start+i*stride)
            for i in range(accessor['count'])]
    if any(not math.isfinite(v) for row in rows for v in row):
        raise ValueError('Animation accessor contains non-finite values')
    return rows


def card_nodes(document):
    result = {}
    fallbacks = {'right': 'Panel • white card', 'left': 'MERLIN_LeftPanel'}
    for side, fallback in fallbacks.items():
        matches = [i for i, node in enumerate(document['nodes'])
                   if node.get('extras', {}).get('merlin_screen_id') == side
                   and node.get('extras', {}).get('panel_kind') == 'card']
        if not matches:
            matches = [i for i, node in enumerate(document['nodes']) if node.get('name') == fallback]
        if len(matches) != 1:
            raise ValueError('Expected one '+side+' panel card node')
        result[side] = matches[0]
    return result


def channel_rows(document, binary, animation, node, path):
    channels = [channel for channel in animation['channels']
                if channel.get('target') == {'node': node, 'path': path}]
    if len(channels) > 1:
        raise ValueError('Duplicate animation channel for card '+path)
    if not channels:
        return None
    channel = channels[0]
    sampler = animation['samplers'][channel['sampler']]
    interpolation = sampler.get('interpolation', 'LINEAR')
    if interpolation not in ('LINEAR', 'STEP'):
        raise ValueError('Unsupported card interpolation: '+interpolation)
    times = [row[0] for row in values(document, binary, sampler['input'])]
    rows = values(document, binary, sampler['output'])
    if len(times) != len(rows) or not times or any(a >= b for a, b in zip(times, times[1:])):
        raise ValueError('Invalid animation sampler times')
    if len(rows[0]) != len(DEFAULTS[path]):
        raise ValueError('Unexpected card channel width')
    return channel, sampler, times, rows


def sample(document, binary, animation, node, path, time):
    data = channel_rows(document, binary, animation, node, path)
    if data is None:
        return tuple(document['nodes'][node].get(path, DEFAULTS[path]))
    _, sampler, times, rows = data
    index = bisect.bisect_right(times, time)-1
    if index < 0:
        return rows[0]
    if index == len(times)-1 or sampler.get('interpolation') == 'STEP' or time == times[index]:
        return rows[index]
    ratio = (time-times[index])/(times[index+1]-times[index])
    first, last = rows[index], rows[index+1]
    if path == 'rotation':
        dot = sum(a*b for a, b in zip(first, last))
        if dot < 0:
            last, dot = tuple(-v for v in last), -dot
        if dot < .9995:
            angle = math.acos(max(-1., min(1., dot)))
            den = math.sin(angle)
            return tuple((a*math.sin((1-ratio)*angle)+b*math.sin(ratio*angle))/den
                         for a, b in zip(first, last))
    row = tuple(a+(b-a)*ratio for a, b in zip(first, last))
    if path == 'rotation':
        length = math.sqrt(sum(v*v for v in row))
        return tuple(v/length for v in row)
    return row


def append_accessor(document, binary, source_index, rows):
    accessor = copy.deepcopy(document['accessors'][source_index])
    binary.extend(b'\0' * (-len(binary) % 4))
    width = WIDTHS[accessor['type']]
    packed = b''.join(struct.pack('<'+'f'*width, *row) for row in rows)
    view = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(packed)}
    binary.extend(packed)
    accessor['bufferView'] = len(document['bufferViews'])
    accessor.pop('byteOffset', None)
    accessor['count'] = len(rows)
    for key, fn in (('min', min), ('max', max)):
        if key in accessor:
            accessor[key] = [fn(row[i] for row in rows) for i in range(width)]
    document['bufferViews'].append(view)
    document['accessors'].append(accessor)
    return len(document['accessors'])-1


def validate_handoff(document, binary, animation, cards, fps, frame):
    held = (frame-2)/fps
    before = (frame-1-.001)/fps
    boundary = float32((frame-1)/fps)
    errors = {}
    # The outgoing card is visible and must hold its entire transform. The
    # incoming card is hidden: only its zero scale must hold before the switch.
    # A zero-scale decomposition can legitimately use a different rotation,
    # and its hidden translation/rotation do not affect the presented screen.
    for side, paths in (('right', DEFAULTS), ('left', ('scale',))):
        for path in paths:
            first = sample(document, binary, animation, cards[side], path, held)
            last = sample(document, binary, animation, cards[side], path, before)
            errors[side+'_'+path] = max(abs(a-b) for a, b in zip(first, last))
    before_scale = {side: sample(document, binary, animation, node, 'scale', before)
                    for side, node in cards.items()}
    after_scale = {side: sample(document, binary, animation, node, 'scale', boundary)
                   for side, node in cards.items()}
    same_transform = {}
    for path in DEFAULTS:
        outgoing = sample(document, binary, animation, cards['right'], path, before)
        incoming = sample(document, binary, animation, cards['left'], path, boundary)
        direct = max(abs(a-b) for a, b in zip(outgoing, incoming))
        same_transform[path] = min(direct, max(abs(a+b) for a, b in zip(outgoing, incoming))) if path == 'rotation' else direct
    hidden = lambda row: max(abs(v) for v in row) < 1e-7
    visible = lambda row: min(abs(v) for v in row) > 1e-5
    passed = (max(errors.values()) < 3e-5 and max(same_transform.values()) < 3e-5
              and visible(before_scale['right']) and hidden(before_scale['left'])
              and hidden(after_scale['right']) and visible(after_scale['left']))
    if not passed:
        raise ValueError('Ceiling handoff validation failed: '+json.dumps({'held_errors': errors,
            'transform_errors': same_transform, 'before_scale': before_scale, 'after_scale': after_scale}))
    return {'passed': True, 'source_frame': frame, 'before_source_frame': frame-.001,
            'stored_switch_seconds': boundary, 'predecessor_seconds': previous_float32(boundary),
            'held_errors': errors, 'transform_errors': same_transform}


def preserve_step_handoffs(glb_path, manifest):
    """Atomically patch a GLB in place; repeat calls are byte-preserving no-ops."""
    if isinstance(manifest, (str, Path)):
        manifest = json.loads(Path(manifest).read_text())
    original, original_binary = read_glb(glb_path)
    matches = [i for i, animation in enumerate(original.get('animations', [])) if animation.get('name') == CLIP]
    if not matches:
        return {'passed': True, 'changed': False, 'reason': 'Ceiling handoff clip absent'}
    if len(matches) != 1:
        raise ValueError('Duplicate ceiling handoff animation')
    fps = float(manifest['fps'])
    frame = float(manifest.get('ceiling_screen', {}).get('left_handoff_frame', 126))
    if not math.isfinite(fps) or fps <= 0 or not math.isfinite(frame) or frame < 3:
        raise ValueError('Invalid handoff timing metadata')
    document, binary = copy.deepcopy(original), bytearray(original_binary)
    animation = document['animations'][matches[0]]
    cards = card_nodes(document)
    old_time, new_time = float32((frame-2)/fps), float32((frame-1)/fps)
    predecessor = previous_float32(new_time)
    changed = []
    for side, paths in (('right', DEFAULTS), ('left', ('scale',))):
        for path in paths:
            data = channel_rows(document, binary, animation, cards[side], path)
            if data is None:
                if path == 'scale':
                    raise ValueError('Missing '+side+' scale handoff channel')
                continue
            channel, sampler, times, rows = data
            if sampler.get('interpolation') == 'STEP':
                continue
            if old_time not in times or new_time not in times:
                raise ValueError('Expected sampled keys immediately before and at the handoff')
            old_index, new_index = times.index(old_time), times.index(new_time)
            if rows[old_index] == rows[new_index]:
                continue
            if predecessor in times:
                if rows[times.index(predecessor)] != rows[old_index]:
                    raise ValueError('Existing predecessor key does not preserve the held value')
                continue
            times.insert(new_index, predecessor)
            rows.insert(new_index, rows[old_index])
            replacement = copy.deepcopy(sampler)
            replacement['input'] = append_accessor(document, binary, sampler['input'], [(t,) for t in times])
            replacement['output'] = append_accessor(document, binary, sampler['output'], rows)
            channel['sampler'] = len(animation['samplers'])
            animation['samplers'].append(replacement)
            changed.append(side+'.'+path)
    proof = validate_handoff(document, binary, animation, cards, fps, frame)
    if changed:
        document['buffers'][0]['byteLength'] = len(binary)
        write_glb(glb_path, document, bytes(binary))
    return {'passed': True, 'changed': bool(changed), 'clip': CLIP, 'channels': changed,
            'appended_binary_bytes': len(binary)-len(original_binary), 'validation': proof}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('glb', type=Path)
    parser.add_argument('manifest', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(preserve_step_handoffs(arguments.glb, arguments.manifest), indent=2))


if __name__ == '__main__':
    main()

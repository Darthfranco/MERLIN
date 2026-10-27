"""Append new Blender-exported clips without re-exporting the original library.

Usage: python3 merge_animation_glb.py baseline.glb additions.glb result.glb
The two exports must have identical named scene resources. Animation targets are
resolved by unique node names; only new animation accessors/views are appended.
Original JSON resources and the original binary payload remain byte-for-byte.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import json
import struct


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, total = struct.unpack_from('<III', data)
    if magic != 0x46546C67 or version != 2 or total != len(data):
        raise ValueError('Invalid GLB header')
    chunks = []
    cursor = 12
    while cursor < len(data):
        length, kind = struct.unpack_from('<II', data, cursor)
        cursor += 8
        chunks.append((kind, data[cursor:cursor+length]))
        cursor += length
    if cursor != len(data) or [kind for kind, _ in chunks] != [0x4E4F534A, 0x004E4942]:
        raise ValueError('Expected one JSON and one binary GLB chunk')
    document = json.loads(chunks[0][1])
    if len(document.get('buffers', [])) != 1 or 'uri' in document['buffers'][0]:
        raise ValueError('Only single embedded-buffer GLBs are supported')
    return document, chunks[1][1]


def write_glb(path, document, binary):
    encoded = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary += b'\0' * (-len(binary) % 4)
    data = (struct.pack('<III', 0x46546C67, 2, 28+len(encoded)+len(binary))
            + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded
            + struct.pack('<II', len(binary), 0x004E4942) + binary)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix+'.pending')
    temporary.write_bytes(data)
    temporary.replace(target)


class Resources:
    def __init__(self, document, binary):
        self.document, self.binary = document, binary
        self.names = [node.get('name') for node in document.get('nodes', [])]
        if not all(self.names) or len(self.names) != len(set(self.names)):
            raise ValueError('All nodes must have unique nonempty names')

    def view_bytes(self, index):
        view = self.document['bufferViews'][index]
        if view.get('buffer', 0) != 0:
            raise ValueError('External buffer view')
        start, length = view.get('byteOffset', 0), view['byteLength']
        value = self.binary[start:start+length]
        if len(value) != length:
            raise ValueError('Buffer view exceeds binary data')
        return value

    def accessor(self, index):
        value = copy.deepcopy(self.document['accessors'][index])
        sparse = value.pop('sparse', None)
        view_index = value.pop('bufferView', None)
        start = value.pop('byteOffset', 0)
        width = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[value['componentType']]
        count = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4,
                 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}[value['type']]
        size = width*count
        if value['type'].startswith('MAT') and width != 4:
            raise ValueError('Matrix padding is unsupported for non-float data')
        if view_index is not None:
            view = self.document['bufferViews'][view_index]
            stride = view.get('byteStride', size)
            data = self.view_bytes(view_index)
            rows = [data[start+i*stride:start+i*stride+size] for i in range(value['count'])]
        else:
            rows = [b'\0'*size for _ in range(value['count'])]
        if any(len(row) != size for row in rows):
            raise ValueError('Accessor exceeds buffer view')
        if sparse:
            indices, values = sparse['indices'], sparse['values']
            code, width = {5121: ('B', 1), 5123: ('H', 2), 5125: ('I', 4)}[indices['componentType']]
            index_data, value_data = self.view_bytes(indices['bufferView']), self.view_bytes(values['bufferView'])
            previous = -1
            for i in range(sparse['count']):
                index = struct.unpack_from('<'+code, index_data, indices.get('byteOffset', 0)+i*width)[0]
                if index <= previous or index >= len(rows):
                    raise ValueError('Invalid sparse accessor index')
                previous = index
                offset = values.get('byteOffset', 0)+i*size
                row = value_data[offset:offset+size]
                if len(row) != size:
                    raise ValueError('Sparse accessor exceeds buffer view')
                rows[index] = row
        value['packed_sha256'] = digest(b''.join(rows))
        return value

    def image(self, index):
        value = copy.deepcopy(self.document['images'][index])
        if 'uri' in value or 'bufferView' not in value:
            raise ValueError('Only embedded images are supported')
        value['image_sha256'] = digest(self.view_bytes(value.pop('bufferView')))
        return value

    def texture(self, index):
        value = copy.deepcopy(self.document['textures'][index])
        if 'source' in value:
            value['source'] = self.image(value['source'])
        if 'sampler' in value:
            value['sampler'] = self.document['samplers'][value['sampler']]
        return value

    def material(self, index):
        def visit(value, key=''):
            if isinstance(value, dict):
                result = {k: visit(v, k) for k, v in value.items()}
                if key.endswith('Texture') and 'index' in result:
                    result['index'] = self.texture(result['index'])
                return result
            if isinstance(value, list):
                return [visit(item) for item in value]
            return value
        return visit(self.document['materials'][index])

    def mesh(self, index):
        mesh = copy.deepcopy(self.document['meshes'][index])
        for primitive in mesh['primitives']:
            if 'extensions' in primitive:
                raise ValueError('Compressed/extended mesh primitives are not supported')
            primitive['attributes'] = {k: self.accessor(v) for k, v in primitive['attributes'].items()}
            if 'indices' in primitive:
                primitive['indices'] = self.accessor(primitive['indices'])
            if 'material' in primitive:
                primitive['material'] = self.material(primitive['material'])
            if 'targets' in primitive:
                primitive['targets'] = [{k: self.accessor(v) for k, v in target.items()}
                                        for target in primitive['targets']]
        return mesh

    def skin(self, index):
        value = copy.deepcopy(self.document['skins'][index])
        value['joints'] = [self.names[i] for i in value['joints']]
        if 'skeleton' in value:
            value['skeleton'] = self.names[value['skeleton']]
        if 'inverseBindMatrices' in value:
            value['inverseBindMatrices'] = self.accessor(value['inverseBindMatrices'])
        return value

    def scene_fingerprint(self):
        result = {}
        for node in self.document['nodes']:
            value = copy.deepcopy(node)
            if 'children' in value:
                value['children'] = sorted(self.names[i] for i in value['children'])
            if 'mesh' in value:
                value['mesh'] = self.mesh(value['mesh'])
            if 'skin' in value:
                value['skin'] = self.skin(value['skin'])
            result[value['name']] = value
        return result


def merge(baseline_path, additions_path, output_path):
    if Path(output_path).resolve() in (Path(baseline_path).resolve(), Path(additions_path).resolve()):
        raise ValueError('Output must be separate from both input files')
    baseline, old_binary = read_glb(baseline_path)
    additions, new_binary = read_glb(additions_path)
    old, new = Resources(baseline, old_binary), Resources(additions, new_binary)
    old_scene, new_scene = old.scene_fingerprint(), new.scene_fingerprint()
    if old_scene != new_scene:
        changed = sorted(name for name in set(old_scene) | set(new_scene)
                         if old_scene.get(name) != new_scene.get(name))
        raise ValueError('Scene resources differ; refusing animation-only merge: '+', '.join(changed))
    if set(additions.get('extensionsRequired', [])) - set(baseline.get('extensionsRequired', [])):
        raise ValueError('New required extensions cannot be appended as animation-only data')
    original_names = [a['name'] for a in baseline['animations']]
    added_names = [a['name'] for a in additions['animations']]
    if len(set(added_names)) != len(added_names) or set(added_names) & set(original_names):
        raise ValueError('Duplicate or already-present animation name')
    result = copy.deepcopy(baseline)
    # Preserve the entire old BIN chunk, including its alignment bytes.
    binary = bytearray(old_binary)
    node_map = {i: old.names.index(name) for i, name in enumerate(new.names)}
    views, accessors = {}, {}

    def copy_view(index):
        if index not in views:
            view = copy.deepcopy(additions['bufferViews'][index])
            data = new.view_bytes(index)
            binary.extend(b'\0'*(-len(binary) % 4))
            view['buffer'], view['byteOffset'] = 0, len(binary)
            binary.extend(data)
            views[index] = len(result['bufferViews'])
            result['bufferViews'].append(view)
        return views[index]

    def copy_accessor(index):
        if index not in accessors:
            value = copy.deepcopy(additions['accessors'][index])
            if 'sparse' in value or 'bufferView' not in value:
                raise ValueError('Animation samplers require ordinary embedded accessors')
            new.accessor(index)  # Validate bounds, storage and component shape.
            value['bufferView'] = copy_view(value['bufferView'])
            accessors[index] = len(result['accessors'])
            result['accessors'].append(value)
        return accessors[index]

    for animation in additions['animations']:
        animation = copy.deepcopy(animation)
        for sampler in animation['samplers']:
            sampler['input'] = copy_accessor(sampler['input'])
            sampler['output'] = copy_accessor(sampler['output'])
        for channel in animation['channels']:
            target = channel['target']
            if set(target) != {'node', 'path'}:
                raise ValueError('Expected an ordinary node animation target')
            target['node'] = node_map[target['node']]
        result['animations'].append(animation)
    result['buffers'][0]['byteLength'] = len(binary)
    write_glb(output_path, result, bytes(binary))
    checked, checked_binary = read_glb(output_path)
    if checked_binary[:len(old_binary)] != old_binary:
        raise AssertionError('Original binary payload was changed')
    for field, value in baseline.items():
        if field in ('buffers', 'accessors', 'bufferViews', 'animations'):
            continue
        if checked[field] != value:
            raise AssertionError('Original scene JSON field was changed: '+field)
    for field in ('accessors', 'bufferViews', 'animations'):
        if checked[field][:len(baseline[field])] != baseline[field]:
            raise AssertionError('Original data prefix was changed: '+field)
    return {'passed': True, 'baseline_sha256': digest(Path(baseline_path).read_bytes()),
            'additions_sha256': digest(Path(additions_path).read_bytes()),
            'merged_sha256': digest(Path(output_path).read_bytes()),
            'baseline_clips': original_names, 'added_clips': added_names,
            'matched_named_nodes': len(node_map), 'scene_resources_identical': True,
            'original_binary_bytes_preserved': len(old_binary),
            'appended_views': len(views), 'appended_accessors': len(accessors),
            'appended_binary_bytes': len(binary)-len(old_binary),
            'final_bytes': Path(output_path).stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('additions', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--report', type=Path)
    arguments = parser.parse_args()
    report = merge(arguments.baseline, arguments.additions, arguments.output)
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(json.dumps(report, indent=2)+'\n')
    print('MERLIN_ANIMATION_MERGE', json.dumps(report))


if __name__ == '__main__':
    main()

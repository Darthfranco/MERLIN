"""Re-import the delivered state GLB and compare every synchronized owner.

Run with Blender --background --python-exit-code 1 --python this_file.py after
export_screen_states.py finishes. Samples first/middle/last of every manifest
clip, plus a display expansion and both panel shatter poses. Does not render or
save either asset. Only a successful report is published in previews/.
"""
from pathlib import Path
import datetime
import hashlib
import json
import struct
import sys
import tempfile

import bpy
from mathutils import kdtree

HERE = Path(__file__).resolve().parent
ASSET = HERE.parent
sys.path.insert(0, str(HERE))
import screen_state_support as support
from animate_character import BONE_NAMES
from room_support import FACE_OBJECTS
from verify_character import parse_glb, scalar_floats
from verify_interaction_roundtrip import (snapshot, difference, select_imported,
    geometry_distance, gradient_samples, material_checks, LIMITS as BASE_LIMITS)

REPORT = ASSET / 'previews' / 'states-roundtrip-validation.json'
LIMITS = dict(BASE_LIMITS, bone_deformation=2e-4)
UV_TOLERANCE = 2e-6


def flat(matrix):
    return [float(value) for row in matrix for value in row]


def capture(rig, objects, face_names, helper_names, geometry=False):
    result = snapshot(rig, objects, face_names, helper_names, geometry)
    result['bone_deformation'] = {
        name: flat(rig.matrix_world @ rig.pose.bones[name].matrix
                   @ rig.data.bones[name].matrix_local.inverted())
        for name in BONE_NAMES
    }
    return result


def errors_for(actual, expected):
    errors = difference(actual, expected)
    errors['bone_deformation'] = max(
        abs(a-b) for name, values in expected['bone_deformation'].items()
        for a, b in zip(actual['bone_deformation'][name], values))
    return errors


def accessor_values(document, binary, index):
    accessor = document['accessors'][index]
    if 'sparse' in accessor or 'bufferView' not in accessor:
        raise ValueError('Screen accessor needs ordinary embedded storage')
    formats = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2),
               5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
    size = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
    code, width = formats[accessor['componentType']]
    view = document['bufferViews'][accessor['bufferView']]
    offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    stride = view.get('byteStride', width*size)
    values = [struct.unpack_from('<'+code*size, binary, offset+i*stride)
              for i in range(accessor['count'])]
    if accessor.get('normalized'):
        maximum = float(2**(width*8-(1 if code.islower() else 0))-1)
        values = [tuple(max(-1., value/maximum) for value in row) for row in values]
    return values


def texture_record(material):
    images = [node.image for node in material.node_tree.nodes
              if node.type == 'TEX_IMAGE' and node.image]
    if len(images) != 1:
        raise ValueError('Screen must reference one image: '+material.name)
    image = images[0]
    width, height = image.size
    pixels = list(image.pixels)
    return {'size': [width, height], 'pixels': pixels}


def source_screen_data():
    result = {}
    for obj in bpy.data.objects:
        sid = obj.get('merlin_screen_id')
        if not sid:
            continue
        materials = [m for m in obj.data.materials if m and m.get('merlin_screen_id') == sid]
        if len(materials) != 1:
            raise ValueError('Missing unique screen material: '+obj.name)
        material = materials[0]
        entry = result.setdefault(sid, {'material': material.name,
                                       'texture': texture_record(material), 'nodes': {}})
        uv = obj.data.uv_layers.active
        if not uv:
            raise ValueError('Screen UV missing: '+obj.name)
        points = []
        wrong_sides = 0
        for polygon in obj.data.polygons:
            if obj.data.materials[polygon.material_index] != material:
                continue
            if sid in ('left', 'right') and polygon.normal.z < .99:
                wrong_sides += 1
            for li in polygon.loop_indices:
                co = obj.data.vertices[obj.data.loops[li].vertex_index].co
                points.append((tuple(co), tuple(uv.data[li].uv)))
        entry['nodes'][obj.name] = {'points': points,
            'role': obj.get('merlin_screen_role', 'surface'),
            'wrong_sides': wrong_sides,
            'center': list(obj.get('panel_center_local', (0., 0.)))}
    return result


def exported_screens(document, binary, source, manifest):
    result = {'passed': True, 'screens': {}}
    materials = document.get('materials', [])
    nodes = {node.get('name'): node for node in document.get('nodes', [])}
    for sid, expected in source.items():
        matches = [(i, m) for i, m in enumerate(materials)
                   if m.get('extras', {}).get('merlin_screen_id') == sid]
        record = {'passed': True, 'nodes': {}, 'issues': []}
        result['screens'][sid] = record
        if len(matches) != 1:
            record['passed'] = False
            record['issues'].append('Expected one material with stable screen ID')
            continue
        material_index, material = matches[0]
        texture_index = material.get('emissiveTexture', {}).get('index')
        texture = document['textures'][texture_index] if texture_index is not None else {}
        image = document['images'][texture['source']] if 'source' in texture else {}
        view = document['bufferViews'][image['bufferView']] if 'bufferView' in image else {}
        offset, length = view.get('byteOffset', 0), view.get('byteLength', 0)
        embedded = length > 8 and binary[offset:offset+8] == b'\x89PNG\r\n\x1a\n'
        pbr = material.get('pbrMetallicRoughness', {})
        strength = material.get('extensions', {}).get('KHR_materials_emissive_strength', {}).get('emissiveStrength', 1.)
        record.update({'material': material.get('name'), 'embedded_png': embedded,
                       'embedded_bytes': length, 'emission_strength': strength,
                       'black_diffuse': pbr.get('baseColorFactor', [1,1,1,1])[:3] == [0,0,0],
                       'emissive_factor': material.get('emissiveFactor', [0,0,0])})
        if not embedded or not record['black_diffuse'] or strength != 1. or record['emissive_factor'] != [1,1,1]:
            record['issues'].append('Embedded emissive screen material differs from the runtime contract')
        if set(expected['nodes']) != set(manifest['screens'][sid]['nodes']):
            record['issues'].append('Screen node manifest differs from source')
        for name, original in expected['nodes'].items():
            node = nodes.get(name, {})
            problems = []
            if node.get('extras', {}).get('merlin_screen_id') != sid:
                problems.append('Stable node ID missing')
            if node.get('extras', {}).get('merlin_screen_uv_origin') != 'top-left':
                problems.append('Exported UV convention metadata missing')
            primitives = document['meshes'][node['mesh']]['primitives'] if 'mesh' in node else []
            fronts = [p for p in primitives if p.get('material') == material_index]
            if not fronts:
                problems.append('Screen front primitive missing')
            tree = kdtree.KDTree(len(original['points']))
            for index, (co, _) in enumerate(original['points']):
                tree.insert(co, index)
            tree.balance()
            position_error = uv_error = mapping_error = 0.
            uv_min, uv_max, count = 1., 0., 0
            for primitive in fronts:
                attrs = primitive['attributes']
                if 'TEXCOORD_0' not in attrs:
                    problems.append('Screen primitive UV0 missing')
                    continue
                positions = accessor_values(document, binary, attrs['POSITION'])
                uvs = accessor_values(document, binary, attrs['TEXCOORD_0'])
                for position, uv in zip(positions, uvs):
                    # glTF stores Y-up local positions and top-left UV values.
                    blender_co = (position[0], -position[2], position[1])
                    _, index, distance = tree.find(blender_co)
                    expected_uv = original['points'][index][1]
                    position_error = max(position_error, distance)
                    uv_error = max(uv_error, abs(uv[0]-expected_uv[0]), abs(uv[1]-(1-expected_uv[1])))
                    if sid in ('left', 'right'):
                        cx, cy = original['center']
                        mapping_error = max(mapping_error,
                            abs(uv[0]-((blender_co[0]+cx)/4.75+.5)),
                            abs(uv[1]-(.5-(blender_co[1]+cy)/5.70)))
                    uv_min, uv_max = min(uv_min, *uv), max(uv_max, *uv)
                    count += 1
            if max(position_error, uv_error, mapping_error) > UV_TOLERANCE:
                problems.append('Screen geometry or full-panel UV mapping changed')
            if not count or uv_min < -UV_TOLERANCE or uv_max > 1+UV_TOLERANCE or original['wrong_sides']:
                problems.append('UV bounds or front-only source assignment invalid')
            record['nodes'][name] = {'passed': not problems, 'role': original['role'],
                'front_vertices': count, 'uv_range': [uv_min, uv_max],
                'position_error': position_error, 'uv_error': uv_error,
                'full_panel_mapping_error': mapping_error, 'issues': problems}
        record['passed'] = not record['issues'] and all(n['passed'] for n in record['nodes'].values())
    result['passed'] = set(result['screens']) == {'left','right','camera'} and all(r['passed'] for r in result['screens'].values())
    return result


def describe_owners():
    descriptors = []
    for owner, data in support.owners():
        if isinstance(data, bpy.types.Object):
            descriptors.append({'owner': owner, 'kind': 'object', 'name': data.name})
        elif isinstance(data, bpy.types.Key):
            users = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.shape_keys == data]
            if len(users) != 1:
                raise ValueError('Expected one mesh for morph owner '+owner)
            descriptors.append({'owner': owner, 'kind': 'shape', 'name': users[0].name,
                                'key_names': list(data.key_blocks.keys())})
        else:
            raise TypeError('Unexpected owner type: '+owner)
    return descriptors


def clip_durations(document, binary, manifest):
    result = {}
    for animation in document.get('animations', []):
        name = animation.get('name')
        times = [value for sampler in animation.get('samplers', [])
                 for value in scalar_floats(document, binary, sampler['input'])]
        expected = (manifest['clips'][name]['frames']-1)/manifest['fps'] if name in manifest['clips'] else None
        start, finish = min(times), max(times)
        result[name] = {'seconds': finish-start, 'expected_seconds': expected,
                        'passed': expected is not None and abs(start) < 1e-5
                                  and abs(finish-expected) < 1e-5}
    return result


def resolve_imported(descriptors):
    objects = {}
    for descriptor in descriptors:
        name = descriptor['name']
        obj = bpy.data.objects.get(name)
        if descriptor['kind'] == 'shape' and (obj is None or obj.type != 'MESH' or not obj.data.shape_keys):
            candidates = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.shape_keys
                          and list(o.data.shape_keys.key_blocks.keys()) == descriptor['key_names']]
            named = [o for o in candidates if o.name.startswith(name)]
            candidates = named or candidates
            obj = candidates[0] if len(candidates) == 1 else None
        if obj is None:
            raise ValueError('Cannot resolve imported owner '+descriptor['owner'])
        objects[name] = obj
    data = []
    for descriptor in descriptors:
        obj = objects[descriptor['name']]
        data.append((descriptor['owner'], obj if descriptor['kind'] == 'object' else obj.data.shape_keys))
    return objects, data


def main():
    manifest = json.loads((ASSET/'states.json').read_text())
    document, binary, _ = parse_glb(ASSET/'merlin-states.glb')
    bpy.ops.wm.open_mainfile(filepath=str(ASSET/'merlin-states.blend'))
    scene = bpy.context.scene
    rig = bpy.data.objects['MERLIN_Rig']
    descriptors = describe_owners()
    names = sorted({d['name'] for d in descriptors if d['owner'] != 'rig'})
    objects = {name: bpy.data.objects[name] for name in names}
    face_names = list(FACE_OBJECTS)
    helpers = [name for name, obj in objects.items() if name not in face_names and obj.type == 'MESH']
    screens = source_screen_data()
    original_gradient = gradient_samples()
    source = {}
    for clip, guide in manifest['clips'].items():
        for frame in (1, round((guide['frames']+1)/2), guide['frames']):
            support.apply_activity(scene, clip, frame)
            source[(clip, frame)] = capture(rig, objects, face_names, helpers)
    additional = {}
    for clip, frame in [('ReadyToFace',23), ('PanelToReady',42), ('LeftPanelToReady',42)]:
        support.apply_activity(scene, clip, frame)
        additional[(clip, frame)] = capture(rig, objects, face_names, helpers, True)
    report = {
        'schema_version': 1, 'checked_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'blender_version': bpy.app.version_string,
        'source_blend': 'merlin-states.blend', 'imported_glb': 'merlin-states.glb',
        'glb_sha256': hashlib.sha256((ASSET/'merlin-states.glb').read_bytes()).hexdigest(),
        'blend_sha256': hashlib.sha256((ASSET/'merlin-states.blend').read_bytes()).hexdigest(),
        'expected_clips': list(manifest['clips']), 'owner_count': len(descriptors),
        'scope': {'owners': descriptors, 'bone_joints': list(BONE_NAMES), 'geometry_objects': helpers},
        'samples': [], 'missing_tracks': [], 'extra_geometry_poses': [],
        'max_errors': {name: 0. for name in LIMITS}, 'tolerances': LIMITS,
        'materials': material_checks(document, binary),
        'screens': exported_screens(document, binary, screens, manifest),
        'clip_durations': clip_durations(document, binary, manifest),
        'limitations': ['Representative frames verify exported samples, not every fractional runtime blend.',
            'Pixel, material and geometry checks do not benchmark browser lighting, rendering speed or live camera access.'],
    }
    print('STATES_SOURCE_SAMPLED', len(source), 'poses', len(descriptors), 'owners', flush=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 24
    bpy.ops.import_scene.gltf(filepath=str(ASSET/'merlin-states.glb'))
    rig = bpy.data.objects['MERLIN_Rig']
    objects, datablocks = resolve_imported(descriptors)
    # Rig is an owner but not a geometry helper in the snapshot.
    objects.pop('MERLIN_Rig', None)
    report['imported_clips'] = sorted(t.name for t in rig.animation_data.nla_tracks)
    report['resolved_imported_objects'] = {name: obj.name for name, obj in objects.items()}
    imported_gradient = gradient_samples()
    gradient_error = max(abs(a-b) for ar,br in zip(original_gradient['samples'],imported_gradient['samples']) for a,b in zip(ar,br))
    report['materials']['imported_gradient_pixels'] = {
        'passed': original_gradient['size'] == imported_gradient['size'] and gradient_error <= 2/255,
        'maximum_channel_error': gradient_error, 'source_size': original_gradient['size'],
        'imported_size': imported_gradient['size'], 'tolerance': 2/255}
    report['materials']['passed'] &= report['materials']['imported_gradient_pixels']['passed']
    for sid, expected in screens.items():
        material = bpy.data.materials.get(expected['material'])
        imported = texture_record(material)
        original = expected['texture']
        same_size = imported['size'] == original['size']
        pixel_error = max(abs(a-b) for a,b in zip(imported['pixels'], original['pixels'])) if same_size else 1.
        record = {'passed': same_size and pixel_error <= 2/255,
                  'source_size': original['size'], 'imported_size': imported['size'],
                  'maximum_channel_error': pixel_error, 'tolerance': 2/255}
        report['screens']['screens'][sid]['imported_pixels'] = record
        report['screens']['passed'] &= record['passed']
    for (clip, frame), expected in source.items():
        missing, time = select_imported(clip, frame, rig, datablocks)
        report['missing_tracks'] += missing
        if missing:
            continue
        errors = errors_for(capture(rig, objects, face_names, helpers), expected)
        report['samples'].append({'clip': clip, 'source_frame': frame, 'imported_frame': time, 'errors': errors})
        for key, value in errors.items():
            report['max_errors'][key] = max(report['max_errors'][key], value)
    for (clip, frame), expected in additional.items():
        missing, time = select_imported(clip, frame, rig, datablocks)
        report['missing_tracks'] += missing
        if missing:
            continue
        actual = capture(rig, objects, face_names, helpers, True)
        geometry = {name: geometry_distance(expected['display_geometry'][name]['vertices'],
                    actual['display_geometry'][name]['vertices']) for name in helpers}
        report['extra_geometry_poses'].append({'clip': clip, 'source_frame': frame,
            'imported_frame': time, 'world_vertex_errors': geometry,
            'passed': max(geometry.values()) < LIMITS['display_geometry']})
    report['sample_count'] = len(report['samples'])
    report['passed'] = (not report['missing_tracks']
        and set(report['imported_clips']) == set(manifest['clips'])
        and len(report['samples']) == len(manifest['clips'])*3
        and all(report['max_errors'][k] < LIMITS[k] for k in LIMITS)
        and len(report['extra_geometry_poses']) == 3
        and all(p['passed'] for p in report['extra_geometry_poses'])
        and all(d['passed'] for d in report['clip_durations'].values())
        and report['screens']['passed'] and report['materials']['passed'])
    target = REPORT if report['passed'] else Path(tempfile.gettempdir())/'states-roundtrip-failed.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2, allow_nan=False)+'\n')
    print('STATES_ROUNDTRIP', json.dumps({'passed': report['passed'], 'samples': report['sample_count'],
        'owners': report['owner_count'], 'max_errors': report['max_errors'],
        'missing_tracks': len(report['missing_tracks']), 'screens': report['screens']['passed'],
        'materials': report['materials']['passed'], 'report': str(target)}), flush=True)
    if not report['passed']:
        raise RuntimeError('MERLIN state GLB re-import comparison failed')


if __name__ == '__main__':
    main()

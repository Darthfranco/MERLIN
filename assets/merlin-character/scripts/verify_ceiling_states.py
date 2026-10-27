"""Focused invariants for the ceiling screen, without modifying the asset."""
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path: sys.path.insert(0, str(HERE))

import animate_context_states as contexts
from animate_ceiling_screen import CENTER, HEIGHT, WIDTH, HANDOFF_FRAME, GRAB_FRAME, RELEASE_FRAME
from animate_panel import panel_owners
from animate_left_panel import left_panel_owners
from animate_casual import _rig_points
from verify_context_states import verify_context_states, verify_context_geometry


def geometry_fingerprint():
    digest = hashlib.sha256()
    def add(value): digest.update(json.dumps(value, sort_keys=True, default=str).encode())
    def bulk(items, path, width, kind=np.float32):
        data = np.empty(len(items) * width, dtype=kind)
        items.foreach_get(path, data); digest.update(data.tobytes())
    for mesh in sorted(bpy.data.meshes, key=lambda item: item.name):
        add(mesh.name); bulk(mesh.vertices, 'co', 3)
        bulk(mesh.loops, 'vertex_index', 1, np.int32)
        bulk(mesh.polygons, 'material_index', 1, np.int32)
        for layer in mesh.uv_layers:
            add(layer.name); bulk(layer.data, 'uv', 2)
        if mesh.shape_keys:
            for key in mesh.shape_keys.key_blocks:
                add(key.name); bulk(key.data, 'co', 3)
        add([material.name if material else None for material in mesh.materials])
    for material in sorted(bpy.data.materials, key=lambda item: item.name):
        add([material.name, list(material.diffuse_color), material.use_nodes])
        if material.use_nodes:
            for node in material.node_tree.nodes:
                add([node.name, node.bl_idname])
                for socket in node.inputs:
                    if hasattr(socket, 'default_value'):
                        value = socket.default_value
                        add([socket.name, list(value) if hasattr(value, '__iter__') else value])
            add([(link.from_node.name, link.from_socket.name, link.to_node.name, link.to_socket.name)
                 for link in material.node_tree.links])
    return digest.hexdigest()


def _sampler(rig, action):
    curves = {(curve.data_path, curve.array_index): curve for curve in action.fcurves}
    def sample(frame):
        matrices = {}
        for bone in rig.data.bones:
            channels = []
            for path, default in [('location', 0.), ('rotation_euler', 0.), ('scale', 1.)]:
                channels.append(Vector(tuple(
                    curve.evaluate(frame) if (curve := curves.get((f'pose.bones["{bone.name}"].{path}', i))) else default
                    for i in range(3))))
            location, rotation, scale = channels
            local = Matrix.LocRotScale(location, Euler(rotation, 'XYZ').to_quaternion(), scale)
            parent = bone.parent
            matrices[bone.name] = bone.convert_local_to_pose(local, bone.matrix_local,
                parent_matrix=matrices[parent.name] if parent else Matrix.Identity(4),
                parent_matrix_local=parent.matrix_local if parent else Matrix.Identity(4))
        return matrices
    return sample


def verify_ceiling_states(names):
    report = verify_context_states(names)
    thought = verify_context_geometry(names)
    report['checks'] += thought['checks']
    report['thinking_frames_checked'] = thought['frames_checked']
    contexts._ACTIONS = {action.name: action for action in bpy.data.actions}
    rig = bpy.data.objects['MERLIN_Rig']; clouds = _rig_points(rig)
    card = next(owner for owner, obj in panel_owners() if obj['panel_kind'] == 'card')
    left = next(owner for owner, obj in left_panel_owners() if obj['panel_kind'] == 'card')
    checks = report['checks']
    def check(name, passed, **details): checks.append({'name': name, 'passed': bool(passed), **details})
    total = 0
    for name in ('ReadyToCeiling', 'CeilingIdle', 'CeilingToLeftPanel', 'CeilingToRightPanel', 'CeilingToReady'):
        action = contexts._actions()[name]; sample = _sampler(rig, action)
        floor = math.inf; volume = math.inf; x_extent = [math.inf, -math.inf]
        closest = None; contact = 0.; top = -math.inf; card_depth = math.inf; depth_sample = None
        for frame in range(1, round(action.frame_range[1]) + 1):
            matrices = sample(frame)
            inverse = np.array((matrices['head'] @ rig.data.bones['head'].matrix_local.inverted()).inverted())
            panel_transform = None
            if name in ('CeilingToLeftPanel', 'CeilingToRightPanel'):
                owner = left if name == 'CeilingToLeftPanel' and frame >= HANDOFF_FRAME else card
                panel_row = contexts._row(contexts._action(name, owner), frame)
                panel_location = np.array([panel_row[('location', i)] for i in range(3)])
                panel_rotation = np.array(Euler([panel_row[('rotation_euler', i)] for i in range(3)]).to_matrix())
                panel_size = np.array([panel_row[('scale', i)] for i in range(3)])
                panel_transform = (panel_location, panel_rotation, panel_size)
            for bone, points in clouds.items():
                matrix = np.array(matrices[bone])
                world = points @ matrix[:3, :3].T + matrix[:3, 3]
                floor = min(floor, float(world[:, 2].min()))
                top = max(top, float(world[:, 2].max()))
                x_extent = [min(x_extent[0], float(world[:, 0].min())), max(x_extent[1], float(world[:, 0].max()))]
                if panel_transform:
                    location, rotation, size = panel_transform
                    local = (world - location) @ rotation
                    covered = (np.abs(local[:, 0]) <= 4.75 * size[0] / 2) & (np.abs(local[:, 1]) <= 5.7 * size[1] / 2)
                    if covered.any():
                        nearest = float(local[covered, 2].min())
                        if nearest < card_depth:
                            card_depth = nearest; depth_sample = {'frame': frame, 'bone': bone}
                if bone.startswith(('upper_arm.', 'forearm.', 'hand.')):
                    local = world @ inverse[:3, :3].T + inverse[:3, 3]
                    values = (np.abs(local[:, 0] / 1.04) ** (2 / .65)
                              + np.abs(local[:, 1] / .54) ** (2 / .65)
                              + np.abs((local[:, 2] - 2.98) / .71) ** (2 / .65))
                    minimum = float(values.min())
                    if minimum < volume: volume = minimum; closest = {'frame': frame, 'bone': bone}
            if name == 'ReadyToCeiling' and GRAB_FRAME <= frame <= RELEASE_FRAME:
                row = contexts._row(contexts._action(name, card), frame)
                location = Vector(tuple(row[('location', i)] for i in range(3)))
                rotation = Euler(tuple(row[('rotation_euler', i)] for i in range(3)))
                bottom = location - rotation.to_matrix() @ Vector((0, HEIGHT / 2, 0))
                for side, sign in [('L', 1), ('R', -1)]:
                    target = bottom + Vector((sign * 1.22, -.14, -.08))
                    contact = max(contact, (matrices['hand.' + side].translation - target).length)
            total += 1
        check(name + '_physical_clearance', floor >= .03 and volume >= .999 and x_extent[0] >= -4.5 and x_extent[1] <= 4.5,
              minimum_floor_z=floor, minimum_arm_head_implicit_volume=volume, closest_arm_head_sample=closest,
              x_extent=x_extent, maximum_character_z=top)
        if name == 'ReadyToCeiling':
            check(name + '_held_edge_contact', contact <= .09, maximum_wrist_target_error=contact)
        if name in ('CeilingToLeftPanel', 'CeilingToRightPanel'):
            check(name + '_card_does_not_cut_robot', card_depth >= .02,
                  minimum_character_depth_in_front_of_panel=card_depth, closest_sample=depth_sample)
    # The handoff is a stepped change of ownership, not an interpolated fade.
    outgoing = contexts._row(contexts._action('CeilingToLeftPanel', card), HANDOFF_FRAME - .001)
    incoming = contexts._row(contexts._action('CeilingToLeftPanel', left), HANDOFF_FRAME)
    outgoing_at_switch = contexts._row(contexts._action('CeilingToLeftPanel', card), HANDOFF_FRAME)
    before_left = contexts._row(contexts._action('CeilingToLeftPanel', left), HANDOFF_FRAME - .001)
    transform_error = max(abs(outgoing[channel] - incoming[channel]) for channel in outgoing)
    check('ceiling_left_owner_handoff', transform_error < 3e-5
          and max(outgoing_at_switch[('scale', i)] for i in range(3)) == 0
          and max(before_left[('scale', i)] for i in range(3)) == 0,
          frame=HANDOFF_FRAME, visible_transform_error=transform_error)
    camera = bpy.context.scene.camera; up = camera.matrix_world.to_3x3() @ Vector((0, 1, 0))
    projection = (CENTER - Vector((0, 0, 2.5))).dot(up)
    half = camera.data.ortho_scale * 3 / 8
    check('ceiling_card_inside_frame_above_floor', WIDTH < camera.data.ortho_scale
          and abs(projection) + HEIGHT / 2 < half and (CENTER - up * HEIGHT / 2).z > .03,
          frame_width_fraction=WIDTH / camera.data.ortho_scale,
          frame_height_fraction=HEIGHT / (half * 2),
          bottom_z=(CENTER - up * HEIGHT / 2).z,
          projected_y_extent=[projection - HEIGHT / 2, projection + HEIGHT / 2])
    # The foreground character remains in front of the card's actual plane;
    # this also catches a seemingly correct projection slicing through toes.
    inverse_panel = camera.rotation_euler.to_matrix().transposed()
    sample = _sampler(rig, contexts._actions()['CeilingIdle'])(1)
    minimum_depth = math.inf; screen_y = [math.inf, -math.inf]
    for bone, points in clouds.items():
        matrix = np.array(sample[bone]); world = points @ matrix[:3, :3].T + matrix[:3, 3]
        local = (world - np.array(CENTER)) @ np.array(inverse_panel).T
        covered = (np.abs(local[:, 0]) <= WIDTH / 2) & (np.abs(local[:, 1]) <= HEIGHT / 2)
        if covered.any(): minimum_depth = min(minimum_depth, float(local[covered, 2].min()))
        projected = (world - np.array((0, 0, 2.5))) @ np.array(up)
        screen_y = [min(screen_y[0], float(projected.min())), max(screen_y[1], float(projected.max()))]
    check('ceiling_robot_visible_in_foreground', minimum_depth >= .02 and screen_y[0] >= -half - .025,
          minimum_character_depth_in_front_of_panel=minimum_depth,
          projected_character_y_extent=screen_y)
    report['body_frames_checked'] = total
    report['passed'] = all(row['passed'] for row in checks)
    print('MERLIN_CEILING_VERIFIED', report['passed'], total, flush=True)
    return report


if __name__ == '__main__':
    from pathlib import Path
    from animate_ceiling_screen import FRAMES
    names = list(FRAMES) + ['CeilingToThink', 'CeilingThinking', 'CeilingThinkToBody', 'CeilingToFace', 'FaceToCeiling']
    result = verify_ceiling_states(names)
    output = Path(__file__).resolve().parent.parent / 'previews' / 'ceiling-validation.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    if not result['passed']: raise RuntimeError('Ceiling scene validation failed')

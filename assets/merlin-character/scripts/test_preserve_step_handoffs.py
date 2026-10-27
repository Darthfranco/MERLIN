"""Focused, Blender-free checks for sampled card ownership handoffs."""
from pathlib import Path
import copy
import tempfile
import unittest

from merge_animation_glb import read_glb, write_glb
from preserve_step_handoffs import (append_accessor, float32, previous_float32,
    preserve_step_handoffs, sample, values)


class StepHandoffTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)/'fixture.glb'
        self.manifest = {'fps': 24, 'ceiling_screen': {'left_handoff_frame': 126}}
        self.document = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 0}],
            'bufferViews': [], 'accessors': [], 'scenes': [{'nodes': [0, 1, 2]}], 'scene': 0,
            'nodes': [{'name': 'Outgoing card', 'extras': {'merlin_screen_id': 'right', 'panel_kind': 'card'}},
                      {'name': 'Incoming card', 'extras': {'merlin_screen_id': 'left', 'panel_kind': 'card'}},
                      {'name': 'Unrelated shared sampler target'}],
            'animations': [{'name': 'CeilingToLeftPanel', 'samplers': [], 'channels': []}]}
        self.binary = bytearray()
        self.document['accessors'].append({'componentType': 5126, 'type': 'SCALAR', 'count': 0, 'min': [0], 'max': [0]})
        times = [0., 124/24, 125/24, 131/24]
        input_index = append_accessor(self.document, self.binary, 0, [(v,) for v in times])
        values_by_node = {
            0: {'translation': [(0, 3, -1), (-2, 3, -.4), (2, 3, -.4), (2, 3, -.4)],
                'rotation': [(0, 0, 0, 1), (0, 0, 1, 0), (0, 0, 0, 1), (0, 0, 0, 1)],
                'scale': [(2, 2, 2), (1, 1, 1), (0, 0, 0), (0, 0, 0)]},
            1: {'translation': [(-2, 3, -.4)]*4, 'rotation': [(0, 0, 1, 0)]*4,
                'scale': [(0, 0, 0), (0, 0, 0), (1, 1, 1), (1, 1, 1)]}}
        animation = self.document['animations'][0]
        for node, channels in values_by_node.items():
            for path, rows in channels.items():
                template = len(self.document['accessors'])
                self.document['accessors'].append({'componentType': 5126,
                    'type': 'VEC4' if path == 'rotation' else 'VEC3', 'count': 0})
                output = append_accessor(self.document, self.binary, template, rows)
                sampler = len(animation['samplers'])
                animation['samplers'].append({'input': input_index, 'output': output, 'interpolation': 'LINEAR'})
                animation['channels'].append({'sampler': sampler, 'target': {'node': node, 'path': path}})
        # A different target deliberately shares the outgoing card's scale sampler.
        animation['channels'].append({'sampler': 2, 'target': {'node': 2, 'path': 'scale'}})
        self.document['animations'].append(copy.deepcopy(animation))
        self.document['animations'][1]['name'] = 'Unrelated clip'
        self.save()

    def save(self):
        self.document['buffers'][0]['byteLength'] = len(self.binary)
        write_glb(self.path, self.document, bytes(self.binary))

    def test_hold_switch_shared_resources_and_idempotence(self):
        before, old_binary = read_glb(self.path)
        old_animation = before['animations'][0]
        old_early = {path: sample(before, old_binary, old_animation, 0, path, 2.)
                     for path in ('translation', 'rotation', 'scale')}
        report = preserve_step_handoffs(self.path, self.manifest)
        self.assertEqual(set(report['channels']), {'right.translation', 'right.rotation', 'right.scale', 'left.scale'})
        after, binary = read_glb(self.path)
        self.assertEqual(binary[:len(old_binary)], old_binary)
        for key in ('accessors', 'bufferViews'):
            self.assertEqual(after[key][:len(before[key])], before[key])
        for key in ('nodes', 'scenes', 'asset'):
            self.assertEqual(after[key], before[key])
        self.assertEqual(after['animations'][1], before['animations'][1])
        animation = after['animations'][0]
        self.assertEqual(animation['samplers'][:len(old_animation['samplers'])], old_animation['samplers'])
        self.assertEqual(animation['channels'][-1], old_animation['channels'][-1])
        boundary = float32(125/24)
        predecessor = previous_float32(boundary)
        for node in (0, 1):
            expected = (1., 1., 1.) if node == 0 else (0., 0., 0.)
            self.assertEqual(sample(after, binary, animation, node, 'scale', (125.999-1)/24), expected)
            self.assertEqual(sample(after, binary, animation, node, 'scale', predecessor), expected)
            self.assertEqual(sample(after, binary, animation, node, 'scale', boundary), tuple(1-v for v in expected))
        for path, row in old_early.items():
            self.assertEqual(sample(after, binary, animation, 0, path, 2.), row)
        shared = sample(after, binary, animation, 2, 'scale', (125.5-1)/24)
        self.assertTrue(0.49 < shared[0] < .51)
        for sampler in animation['samplers'][len(old_animation['samplers']):]:
            times = [r[0] for r in values(after, binary, sampler['input'])]
            self.assertEqual(times[times.index(boundary)-1], predecessor)
            self.assertTrue(all(a < b for a, b in zip(times, times[1:])))
        once = self.path.read_bytes()
        repeated = preserve_step_handoffs(self.path, self.manifest)
        self.assertFalse(repeated['changed'])
        self.assertEqual(self.path.read_bytes(), once)

    def test_absent_clip_is_byte_preserving_noop(self):
        self.document['animations'][0]['name'] = 'Other'
        self.save()
        original = self.path.read_bytes()
        self.assertFalse(preserve_step_handoffs(self.path, self.manifest)['changed'])
        self.assertEqual(original, self.path.read_bytes())

    def test_existing_step_channels_are_preserved(self):
        for sampler in self.document['animations'][0]['samplers']:
            sampler['interpolation'] = 'STEP'
        self.save()
        original = self.path.read_bytes()
        self.assertFalse(preserve_step_handoffs(self.path, self.manifest)['changed'])
        self.assertEqual(original, self.path.read_bytes())

    def test_failed_handoff_does_not_modify_file(self):
        self.document['nodes'][1]['translation'] = [10, 10, 10]
        self.document['animations'][0]['channels'] = [c for c in self.document['animations'][0]['channels']
            if c['target'] != {'node': 1, 'path': 'translation'}]
        self.save()
        original = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'handoff validation failed'):
            preserve_step_handoffs(self.path, self.manifest)
        self.assertEqual(original, self.path.read_bytes())

    def test_unsupported_interpolation_does_not_modify_file(self):
        self.document['animations'][0]['samplers'][0]['interpolation'] = 'CUBICSPLINE'
        self.save()
        original = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Unsupported card interpolation'):
            preserve_step_handoffs(self.path, self.manifest)
        self.assertEqual(original, self.path.read_bytes())

    def test_known_names_work_without_extras(self):
        for node, name in zip(self.document['nodes'][:2], ('Panel • white card', 'MERLIN_LeftPanel')):
            node.pop('extras')
            node['name'] = name
        self.save()
        self.assertTrue(preserve_step_handoffs(self.path, self.manifest)['passed'])

    def test_hidden_incoming_transform_may_move_before_switch(self):
        animation = self.document['animations'][0]
        for path, rows in {
            'translation': [(8, 8, 8), (7, 7, 7), (-2, 3, -.4), (-2, 3, -.4)],
            'rotation': [(0, 0, 0, 1), (0, 0, 0, 1), (0, 0, 1, 0), (0, 0, 1, 0)]}.items():
            channel = next(c for c in animation['channels'] if c['target'] == {'node': 1, 'path': path})
            sampler = animation['samplers'][channel['sampler']]
            sampler['output'] = append_accessor(self.document, self.binary, sampler['output'], rows)
        self.save()
        report = preserve_step_handoffs(self.path, self.manifest)
        self.assertTrue(report['validation']['passed'])
        self.assertEqual(set(report['validation']['held_errors']),
                         {'right_translation', 'right_rotation', 'right_scale', 'left_scale'})
        self.assertEqual(max(report['validation']['transform_errors'].values()), 0.)


if __name__ == '__main__':
    unittest.main()

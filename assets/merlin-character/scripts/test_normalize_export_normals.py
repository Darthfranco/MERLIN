"""The pre-merge normal repair accepts signed zero and rejects numeric changes."""
from pathlib import Path
import copy
import struct
import tempfile
import unittest

from merge_animation_glb import read_glb, write_glb
from normalize_export_normals import NODE, normalize_signed_zero_normals


class SignedZeroNormalsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.baseline = Path(self.directory.name)/'baseline.glb'
        self.additions = Path(self.directory.name)/'additions.glb'
        self.document = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 24}],
            'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 24}],
            'accessors': [{'bufferView': 0, 'componentType': 5126, 'type': 'VEC3', 'count': 2}],
            'nodes': [{'name': NODE, 'mesh': 0}],
            'meshes': [{'primitives': [{'attributes': {}}, {'attributes': {'NORMAL': 0}}]}]}
        self.binary = struct.pack('<ffffff', 1., -0., 0., 0., 1., 0.)
        write_glb(self.baseline, self.document, self.binary)

    def test_only_zero_sign_is_repaired_and_repeat_is_noop(self):
        write_glb(self.additions, self.document, struct.pack('<ffffff', 1., 0., 0., -0., 1., 0.))
        original_baseline = self.baseline.read_bytes()
        report = normalize_signed_zero_normals(self.baseline, self.additions)
        self.assertEqual(report['changed_component_count'], 2)
        self.assertEqual(report['maximum_numeric_vector_error'], 0.)
        self.assertEqual(read_glb(self.additions), read_glb(self.baseline))
        self.assertEqual(self.baseline.read_bytes(), original_baseline)
        normalized = self.additions.read_bytes()
        self.assertFalse(normalize_signed_zero_normals(self.baseline, self.additions)['changed'])
        self.assertEqual(self.additions.read_bytes(), normalized)

    def test_small_numeric_change_is_rejected_without_writing(self):
        write_glb(self.additions, self.document, struct.pack('<ffffff', 1., 1e-20, 0., 0., 1., 0.))
        original = self.additions.read_bytes()
        with self.assertRaisesRegex(ValueError, 'differs numerically'):
            normalize_signed_zero_normals(self.baseline, self.additions)
        self.assertEqual(self.additions.read_bytes(), original)

    def test_other_resource_change_is_rejected_without_writing(self):
        document = copy.deepcopy(self.document)
        document['nodes'][0]['translation'] = [1., 0., 0.]
        write_glb(self.additions, document, struct.pack('<ffffff', 1., 0., 0., 0., 1., 0.))
        original = self.additions.read_bytes()
        with self.assertRaisesRegex(ValueError, 'beyond the permitted'):
            normalize_signed_zero_normals(self.baseline, self.additions)
        self.assertEqual(self.additions.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()

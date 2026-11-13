"""Actual build source and immutable digest admission, no fake image-build claim."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import vast_image_attestation as att


class BuildContract(unittest.TestCase):
    def test_ci_and_tests_use_one_actual_recipe_with_seven_roles(self):
        c = json.loads(att.CONFIG.read_text())
        self.assertEqual(len(c['roles']), 7)
        workflow = (ROOT / '.github/workflows/vast-fleet-images.yml').read_text()
        self.assertIn("c=json.load(open('deploy/vast/build-contract.json'))", workflow)
        self.assertIn('file: ${{ steps.base.outputs.dockerfile }}', workflow)
        self.assertIn('target: ${{ steps.base.outputs.target }}', workflow)
        self.assertEqual(c['dockerfile'], 'services/audiomonastry-ai-runtime/Dockerfile.vast')
        self.assertEqual(c['roles']['song']['target'], 'song')
        self.assertIn("open('build-source-sha.txt','w').write(source_sha())", workflow)
        self.assertIn('Seven per-build source attestations required', workflow)
        self.assertIn('Sources changed after image build; no promotion', workflow)
        for name in ['test_voice_handlers.py', 'test_ears_handlers.py', 'test_stem_handler.py', 'test_dockerfile_torch.py']:
            text = (ROOT / c['context'] / 'tests' / name).read_text()
            self.assertIn('Dockerfile.vast', text)
            self.assertNotIn('Dockerfile.base', text)

    def test_stale_source_and_different_digest_cannot_allocate(self):
        # Explicit unit fixtures; never emitted as an actual attestation.
        roles = json.loads(att.CONFIG.read_text())['roles']
        images = {r: 'ghcr.io/kainplanmusic/audiomonastry-ai-runtime-vast@sha256:' + str(i) * 64 for i, r in enumerate(roles)}
        images['music'] = images['voice']
        record = att.attest(images, 'https://github.com/example/test/actions/runs/1')
        self.assertEqual(att.verify(images, record), record)
        record['buildSourceSha256'] = '0' * 64
        with self.assertRaises(ValueError): att.verify(images, record)
        with self.assertRaises(ValueError): att.verify({**images, 'brain': images['ears']}, record)
        with self.assertRaises(ValueError): att.verify(images, {})


if __name__ == '__main__': unittest.main()

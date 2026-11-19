"""vis ist eine Renderer-Rolle ohne Modelle; nur sie darf eine leere Modellliste haben."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import registry  # noqa: E402

MANIFEST = json.loads((ROOT / 'model_manifest.json').read_text())


class RendererRoleTests(unittest.TestCase):
    def test_vis_loads_without_models_and_studio_carries_the_restoration_models(self):
        self.assertEqual([], registry.apply_role(copy.deepcopy(MANIFEST), 'vis')['models'])
        studio = [m['id'] for m in registry.apply_role(copy.deepcopy(MANIFEST), 'studio')['models']]
        self.assertIn('universr', studio)
        self.assertIn('mel-roformer-dereverb', studio)

    def test_other_roles_still_need_models(self):
        broken = copy.deepcopy(MANIFEST)
        broken['roles']['song']['models'] = []
        broken['roles']['song']['preloadModels'] = []
        with self.assertRaisesRegex(ValueError, 'nicht-leere Liste'):
            registry.apply_role(broken, 'song')

    def test_empty_list_without_renderer_flag_is_rejected(self):
        broken = copy.deepcopy(MANIFEST)
        del broken['roles']['vis']['renderer']
        with self.assertRaisesRegex(ValueError, 'nicht-leere Liste'):
            registry.apply_role(broken, 'vis')

    def test_vis_build_has_the_renderer_but_not_the_restoration_stack(self):
        contract = json.loads((ROOT.parents[1] / 'deploy/vast/build-contract.json').read_text())['roles']
        self.assertEqual({'AI_INSTALL_RENDER': '1'}, contract['vis']['buildArgs'])
        self.assertEqual('1', contract['studio']['buildArgs']['AI_INSTALL_UNIVERSR'])
        self.assertEqual('1', contract['studio']['buildArgs']['AI_INSTALL_MSST'])


if __name__ == '__main__':
    unittest.main()

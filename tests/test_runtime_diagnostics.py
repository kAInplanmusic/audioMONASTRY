"""Messlauf 2026-11-18: song stuerzte ab (visual/effects.json fehlt im Image), Preload-Fehler waren nur als Klassenname sichtbar."""
import importlib
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/audiomonastry-ai-runtime'))


NEEDS_FASTAPI = unittest.skipUnless(importlib.util.find_spec('fastapi'), 'fastapi fehlt (Runtime-Abhaengigkeit)')


@NEEDS_FASTAPI
class VastAppWithoutVisualTests(unittest.TestCase):
    def import_without_visual(self, error):
        sys.modules.pop('vast_app', None)
        sys.modules.pop('visual_renderer', None)

        real_import = __import__

        def fake_import(name, *args, **kwargs):
            if name == 'visual_renderer':
                raise error
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=fake_import):
            return importlib.import_module('vast_app')

    def tearDown(self):
        sys.modules.pop('vast_app', None)
        sys.modules.pop('visual_renderer', None)

    def test_image_without_visual_directory_still_imports_and_non_vis_roles_get_404(self):
        from fastapi.testclient import TestClient
        module = self.import_without_visual(FileNotFoundError('/opt/audiomonastry-ai/visual/effects.json'))
        self.assertIsNone(module.visual_renderer)
        with patch.dict(os.environ, {'AI_ROLE': 'song'}):
            with self.assertRaises(module.HTTPException) as caught:
                module._require_vis()
        self.assertEqual(404, caught.exception.status_code)
        self.assertTrue(TestClient(module.app))

    def test_the_vis_role_reports_a_missing_module_clearly_instead_of_crashing(self):
        module = self.import_without_visual(ImportError('no module'))
        with patch.dict(os.environ, {'AI_ROLE': 'vis'}):
            with self.assertRaises(module.HTTPException) as caught:
                module._require_vis()
        self.assertEqual(503, caught.exception.status_code)


@NEEDS_FASTAPI
class PreloadFailureLogTests(unittest.TestCase):
    def test_the_failure_log_carries_text_and_frames_not_only_the_class(self):
        import app
        logged = []
        with patch.object(app.STATE.manager, 'preload', side_effect=TypeError("unsupported operand type(s) for +: 'NoneType' and 'str'")), \
                patch.dict(os.environ, {'AI_ROLE': ''}), patch.object(app, 'log_event', side_effect=lambda *a, **k: logged.append((a, k))):
            app._preload_models_background()
        failure = [k for a, k in logged if a[:2] == ('ERROR', 'model preload failed')][0]
        self.assertEqual('TypeError', failure['error'])
        self.assertIn('unsupported operand', failure['detail'])
        self.assertTrue(failure['where'])                                   # Dateiname:Zeile Funktion
        self.assertTrue(any(app.STATE.startup_errors[-1].startswith('TypeError') for _ in [0]))


if __name__ == '__main__':
    unittest.main()

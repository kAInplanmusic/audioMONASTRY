"""Exercise the QA wrapper without CUDA hardware or model downloads."""
import os
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class GpuQaWorkerTest(unittest.TestCase):
    def test_inference_runs_and_native_diagnostics_are_redacted(self):
        calls = []
        manager = SimpleNamespace(configure=lambda spec: calls.append(spec), infer=lambda: None)
        original = manager.infer

        def production(job):
            os.write(2, b'native engine: test-secret-value https://example.test/private\n')
            return {'status': 'success', 'model': job['input']['model']}

        cuda = SimpleNamespace(is_available=lambda: True, reset_peak_memory_stats=lambda: None,
                               synchronize=lambda: None, get_device_name=lambda _: 'test GPU',
                               max_memory_allocated=lambda: 12, max_memory_reserved=lambda: 24)
        modules = {
            'torch': SimpleNamespace(cuda=cuda, version=SimpleNamespace(cuda='12.8'), __version__='test'),
            'runpod': SimpleNamespace(serverless=SimpleNamespace(start=lambda _: None)),
            'registry': SimpleNamespace(read_manifest=lambda: {'roles': {'brain': {'models': ['test-model']}}},
                                        load_manifest=lambda role: role),
            'runpod_worker': SimpleNamespace(manager=manager, handler=production),
        }
        with patch.dict('sys.modules', modules), patch.dict(os.environ, {'QA_TEST_TOKEN': 'test-secret-value'}):
            namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/runpod-gpu-qa-worker.py'))
            result = namespace['handler']({'input': {'model': 'test-model'}})
        self.assertEqual(calls, ['brain'])
        self.assertEqual(result['inference']['status'], 'success')
        self.assertIn('native engine: [REDACTED] [URL]', result['qa']['diagnosticTail'])
        self.assertNotIn('test-secret-value', result['qa']['diagnosticTail'])
        self.assertIs(manager.infer, original)
        self.assertIsNone(result['qa']['render'])
        os.fstat(1)
        os.fstat(2)


if __name__ == '__main__':
    unittest.main()

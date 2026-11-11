"""Readiness must reject empty and non-finite real-handler outputs."""
import base64
import importlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import runtime_probe

class RuntimeProbeTests(unittest.TestCase):
    def run_probe(self, output):
        with patch('handlers.run_inference', return_value=output):
            return runtime_probe.load_verified('fixture',SimpleNamespace(task='analyze'))

    def test_empty_result_cannot_mark_model_ready(self):
        with self.assertRaises(RuntimeError):self.run_probe({})

    def test_nonfinite_audio_cannot_mark_model_ready(self):
        stream=io.BytesIO();sf.write(stream,np.array([0,np.nan],dtype=np.float32),44100,format='WAV',subtype='FLOAT')
        with self.assertRaises(RuntimeError):
            self.run_probe({'audioBase64':base64.b64encode(stream.getvalue()).decode()})

    def test_valid_audio_is_checked_and_accepted(self):
        stream=io.BytesIO();sf.write(stream,np.array([0,.1,0],dtype=np.float32),44100,format='WAV',subtype='FLOAT')
        self.assertTrue(self.run_probe({'audioBase64':base64.b64encode(stream.getvalue()).decode()})['verifiedInference'])


class LoaderRollbackTests(unittest.TestCase):
    def test_failed_real_loader_does_not_leak_budget_or_mark_loaded(self):
        from model_manager import ModelManager
        manifest=json.loads((Path(__file__).resolve().parents[1]/'model_manifest.json').read_text())
        model=next(x for x in manifest['models'] if x['id']=='clap-music')
        manager=ModelManager()
        manager.configure({'models':[model], 'runtime':{'device':'simulated','vramBudgetGb':48}})
        def fail(*args):raise RuntimeError('real loader failed')
        manager.set_loader(fail)
        for _ in range(2):
            with self.assertRaises(RuntimeError):manager.load(model['id'])
            self.assertFalse(manager.is_loaded(model['id']))
            self.assertEqual(manager._used_vram_gb,0)


class ResidentCpuTests(unittest.TestCase):
    def test_selected_cpu_models_are_loaded_in_resident_ears_role(self):
        import registry
        models={m['id']:m for m in registry.load_manifest('ears')['models']}
        for name in ('dsp-analysis','basic-pitch'):
            self.assertTrue(models[name]['preload'],name+' would be unreachable in resident-only mode')

if __name__=='__main__':unittest.main()

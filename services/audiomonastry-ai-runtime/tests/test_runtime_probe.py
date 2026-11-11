"""Readiness must reject empty and non-finite real-handler outputs."""
import base64
import importlib
import io
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

if __name__=='__main__':unittest.main()

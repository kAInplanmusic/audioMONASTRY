"""Offline tests for real-inference readiness gate; never pretend GPU is tested."""
from __future__ import annotations
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "startup_model_proof.py"
spec = importlib.util.spec_from_file_location("startup_model_proof", SCRIPT)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class FakeManager:
    def __init__(self, *, cuda=True, output=None):
        self.cuda = cuda
        self.output = output if output is not None else {"text": "genuine synthetic fixture"}
        self.events = []

    def gpu_state(self):
        return {"device": "cuda" if self.cuda else "simulated", "available": True}

    def get_model_info(self):
        return [{"id": "qwen38-27b-fp8", "task": "llm", "estimatedVRAM": 37}]

    def is_loaded(self, mid):
        return True

    def infer(self, task, mid, data):
        self.events.append((task, mid, data))
        return self.output


class ProofTests(unittest.TestCase):
    def fixture(self, data):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "proof.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        self.addCleanup(tmp.cleanup)
        return str(path)

    def good(self):
        return self.fixture({"models": {"qwen38-27b-fp8": {
            "task": "llm", "input": {"prompt": "test"}, "kind": "text",
            "requiredResultKeys": ["text"]}}})

    def test_valid_probe_executes_inference(self):
        m = FakeManager()
        result = proof.verify_resident_models(m, fixture_path=self.good())
        self.assertEqual(result["verified"], ["qwen38-27b-fp8"])
        self.assertTrue(result["gpuVerified"])
        self.assertEqual(len(m.events), 1)

    def test_simulated_cuda_must_not_pass(self):
        with self.assertRaisesRegex(proof.ProbeFailure, "real CUDA"):
            proof.verify_resident_models(FakeManager(cuda=False), fixture_path=self.good())

    def test_missing_fixture_blocks(self):
        with self.assertRaises(proof.ProbeFailure):
            proof.verify_resident_models(FakeManager(), fixture_path="/absent/file.json")

    def test_missing_model_blocks(self):
        f = self.fixture({"models": {}})
        with self.assertRaisesRegex(proof.ProbeFailure, "missing"):
            proof.verify_resident_models(FakeManager(), fixture_path=f)

    def test_no_model_metadata_as_valid_result(self):
        m = FakeManager(output={"model": "qwen38-27b-fp8"})
        with self.assertRaises(proof.ProbeFailure):
            proof.verify_resident_models(m, fixture_path=self.good())

    def test_wrong_task_blocks(self):
        f = self.fixture({"models": {"qwen38-27b-fp8": {
            "task": "song", "input": {"prompt": "test"}, "kind": "text",
            "requiredResultKeys": ["text"]}}})
        with self.assertRaisesRegex(proof.ProbeFailure, "mismatches manifest"):
            proof.verify_resident_models(FakeManager(), fixture_path=f)

    def test_forged_audio_rejected(self):
        f = self.fixture({"models": {"qwen38-27b-fp8": {
            "task": "llm", "input": {"prompt": "test"}, "kind": "audio",
            "requiredResultKeys": ["audioBase64"]}}})
        m = FakeManager(output={"audioBase64": base64.b64encode(b"x" * 128).decode()})
        with self.assertRaisesRegex(proof.ProbeFailure, "signature"):
            proof.verify_resident_models(m, fixture_path=f)

    def test_fake_result_field_is_not_proof(self):
        f = self.fixture({"models": {"qwen38-27b-fp8": {
            "task": "llm", "input": {"prompt": "test"}, "kind": "text",
            "requiredResultKeys": ["model"]}}})
        with self.assertRaisesRegex(proof.ProbeFailure, "real output"):
            proof.verify_resident_models(FakeManager(), fixture_path=f)

    def test_non_silent_pcm_audio_is_decoded(self):
        import io
        import math
        import struct
        import wave
        buffer=io.BytesIO()
        with wave.open(buffer,"wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(16000)
            sound.writeframes(b"".join(struct.pack("<h",int(1000*math.sin(i*.12))) for i in range(16000)))
        payload={"kind":"audio","requiredResultKeys":["audioBase64"]}
        proof._non_empty_result({"audioBase64":base64.b64encode(buffer.getvalue()).decode()},payload)

    def test_silent_audio_rejected_even_with_valid_wav(self):
        import io
        import wave
        buffer=io.BytesIO()
        with wave.open(buffer,"wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(16000)
            sound.writeframes(b"\\0"*32000)
        payload={"kind":"audio","requiredResultKeys":["audioBase64"]}
        with self.assertRaisesRegex(proof.ProbeFailure,"silent"):
            proof._non_empty_result({"audioBase64":base64.b64encode(buffer.getvalue()).decode()},payload)

    def test_incomplete_53_stem_result_rejected(self):
        payload={"kind":"structured","requiredResultKeys":["stems"],"expectedStemCount":53}
        with self.assertRaisesRegex(proof.ProbeFailure,"stem count"):
            proof._non_empty_result({"stems":{"vocals":"nonempty"}},payload)

    def test_non_finite_embedding_is_rejected(self):
        payload={"kind":"structured","requiredResultKeys":["embedding"]}
        with self.assertRaisesRegex(proof.ProbeFailure,"embedding"):
            proof._non_empty_result({"embedding":[0.1,float("nan")]},payload)

if __name__ == "__main__":
    unittest.main()

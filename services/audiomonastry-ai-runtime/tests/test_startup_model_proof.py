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

if __name__ == "__main__":
    unittest.main()

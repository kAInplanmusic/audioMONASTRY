"""R2 regression: a partial file mirror must not hide a complete TAR."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("pods_r2_regression", ROOT / "scripts/runpod-pods.py")
pods = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pods)
REV = "a" * 40
SHA = "b" * 64


class Target:
    def __init__(self, files, tar=True, revision=REV, repo="owner/model"):
        self.doc = {"revision": revision, "repo": repo, "files": files}
        self.tar = tar

    def get_bytes(self, key):
        if key.endswith("_manifest.json"):
            return json.dumps(self.doc).encode()
        return (SHA + "  model.tar").encode() if self.tar else None

    def head(self, key):
        return {"content-length": "100"} if self.tar and key.endswith(".tar") else None

    def presign(self, method, key, ttl):
        return "https://example.test/" + key


class ManifestCompletenessTests(unittest.TestCase):
    def models(self):
        return {"fixture": {"repository": "owner/model", "revision": REV,
                            "requiredWeightFiles": [{"path": "model.safetensors", "size": 4096}]}}

    def entries(self, target):
        return pods.weight_entries({"models": ["fixture"]}, self.models(), target, "weights", 3600)

    def test_incomplete_file_mirror_falls_back_to_tar(self):
        entries, missing = self.entries(Target([{"path": "config.json", "size": 2, "sha256": SHA}]))
        self.assertEqual(missing, [])
        self.assertTrue(entries[0]["name"].endswith(".tar"))
        self.assertEqual(entries[0]["sha256"], SHA)

    def test_incomplete_mirror_without_tar_is_missing(self):
        entries, missing = self.entries(Target([{"path": "config.json", "size": 2, "sha256": SHA}], tar=False))
        self.assertEqual(entries, [])
        self.assertEqual(len(missing), 1)

    def test_complete_file_mirror_remains_preferred(self):
        entries, missing = self.entries(Target([{"path": "model.safetensors", "size": 4096, "sha256": SHA}]))
        self.assertEqual(missing, [])
        self.assertEqual(entries[0]["path"], "model.safetensors")

    def test_wrong_weight_size_is_incomplete(self):
        entries, _ = self.entries(Target([{"path": "model.safetensors", "size": 10, "sha256": SHA}]))
        self.assertIn("name", entries[0])

    def test_wrong_revision_is_rejected(self):
        entries, _ = self.entries(Target([{"path": "model.safetensors", "size": 4096, "sha256": SHA}], revision="c" * 40))
        self.assertIn("name", entries[0])

    def test_wrong_repository_is_rejected(self):
        entries, _ = self.entries(Target([{"path": "model.safetensors", "size": 4096, "sha256": SHA}], repo="wrong/model"))
        self.assertIn("name", entries[0])

    def test_auxiliary_checkpoint_uses_signed_url_and_pinned_hash(self):
        lock = json.loads((ROOT / "services/audiomonastry-ai-runtime/weight_assets.lock.json").read_text())["models"]
        checkpoint = lock["beat-this"]["files"][0]
        class AuxiliaryTarget(Target):
            def head(self, key):
                return {"content-length": str(checkpoint["size"])} if key.endswith("final0.ckpt") else None
        model = {"beat-this": {"repository": lock["beat-this"]["repository"],
                               "revision": lock["beat-this"]["revision"], "directRepo": True}}
        entries, missing = pods.weight_entries({"models": ["beat-this"]}, model,
                                               AuxiliaryTarget([], tar=False), "weights", 3600)
        self.assertEqual(missing, [])
        self.assertEqual(entries[0]["dest"], "/data/weights/beat-this/final0.ckpt")
        self.assertEqual(entries[0]["sha256"], checkpoint["sha256"])
        self.assertIn("final0.ckpt", entries[0]["url"])


if __name__ == "__main__":
    unittest.main()

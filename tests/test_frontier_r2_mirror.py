"""Safety and reproducibility tests for staged frontier AI model mirroring."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts/frontier-r2-mirror.py"
spec = importlib.util.spec_from_file_location("frontier_r2_mirror", PATH)
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


class FrontierMirrorTests(unittest.TestCase):
    def test_pins_are_real_shas_and_unique(self):
        catalog = mirror.read_catalog()
        entries = catalog["models"]
        self.assertGreaterEqual(len(entries), 8)
        self.assertEqual(len(entries), len(set(m["id"] for m in entries)))
        self.assertTrue(all(len(m["revision"]) == 40 for m in entries))

    def test_no_production_registration_and_no_stt(self):
        catalog = mirror.read_catalog()
        current = json.loads((ROOT / "services/audiomonastry-ai-runtime/model_manifest.json").read_text())
        production = set(m["id"] for m in current["models"])
        self.assertTrue(production.isdisjoint(m["id"] for m in catalog["models"]))
        self.assertTrue(catalog["noSTT"])
        self.assertFalse(any("transcrib" in m["purpose"].lower() and "speech" in m["purpose"].lower()
                             for m in catalog["models"]))

    def test_r2_prefix_isolated_from_production(self):
        m = mirror.read_catalog()["models"][0]
        key = mirror.object_key("weights-candidates", m)
        self.assertTrue(key.startswith("weights-candidates/"))
        self.assertNotEqual(key.split("/")[0], "weights")

    def test_invalid_revision_rejected(self):
        catalog = mirror.read_catalog()
        catalog["models"][0]["revision"] = "main"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, "immutable"):
                mirror.read_catalog(path)

    def test_dry_run_does_not_require_r2_creds(self):
        process = subprocess.run([sys.executable, str(PATH), "--only", "qwen3.5-9b"],
                                 cwd=str(ROOT), capture_output=True, text=True, timeout=20)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("DRY RUN", process.stdout)

    def test_yes_requires_explicit_target_and_workdir(self):
        process = subprocess.run([sys.executable, str(PATH), "--yes"],
                                 cwd=str(ROOT), capture_output=True, text=True, timeout=20)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("--only or --all", process.stderr)

    def test_yes_fails_for_production_prefix(self):
        process = subprocess.run([sys.executable, str(PATH), "--yes", "--only", "qwen3.5-9b",
                                  "--prefix", "weights", "--workdir", "/tmp"],
                                 cwd=str(ROOT), capture_output=True, text=True, timeout=20)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("invalid/production R2 prefix", process.stderr)


if __name__ == "__main__":
    unittest.main()

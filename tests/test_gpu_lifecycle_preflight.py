"""Safe offline regressions for eight-role Vast lifecycle preflight."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("lifecycle", ROOT / "scripts/gpu-lifecycle-preflight.py")
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class LifecyclePreflightTests(unittest.TestCase):
    def test_eight_roles_and_no_endpoint(self):
        report = lifecycle.audit(ROOT)
        self.assertEqual(report["status"], "pass", report["problems"])
        self.assertEqual(set(report["roles"]), lifecycle.ROLES)
        self.assertEqual(report["gpuHourlyCapEUR"], 8)
        self.assertEqual(report["idleDeleteMinutes"], 30)
        self.assertEqual(report["gpuAction"], "dry-run-only")
        self.assertEqual(report["productionModelIds"], 22)

    def test_missing_model_and_wrong_provider_fail_closed(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            for path in ("deploy/gpu-provider.json", "deploy/gpu/pod-fleet.json",
                         "deploy/gpu/frontier-candidates.json",
                         "services/audiomonastry-ai-runtime/model_manifest.json"):
                dest = root / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / path, dest)
            policy = root / "deploy/gpu-provider.json"
            p = json.loads(policy.read_text())
            p["provider"] = "huggingface"
            policy.write_text(json.dumps(p))
            fleet = root / "deploy/gpu/pod-fleet.json"
            f = json.loads(fleet.read_text())
            f["pods"][0]["models"].append("missing-model-xyz")
            fleet.write_text(json.dumps(f))
            report = lifecycle.audit(root)
            self.assertEqual(report["status"], "blocked")
            self.assertTrue(any("provider" in x for x in report["problems"]))
            self.assertTrue(any("missing-model-xyz" in x for x in report["problems"]))


if __name__ == "__main__":
    unittest.main()

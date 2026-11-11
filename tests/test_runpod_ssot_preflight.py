"""RunPod SSOT static guard regression suite. GPU/RunPod not required."""
from __future__ import annotations
import copy
import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "runpod_ssot_preflight", ROOT / "scripts/runpod-ssot-preflight.py"
)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

class RunPodSsotPreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fleet = json.loads((ROOT / "deploy/runpod/pod-fleet.json").read_text())
        cls.manifest = json.loads((ROOT / "services/audiomonastry-ai-runtime/model_manifest.json").read_text())

    def check(self, fleet=None, manifest=None):
        return guard.check(copy.deepcopy(fleet or self.fleet), copy.deepcopy(manifest or self.manifest))

    def test_all_eight_roles_inspected(self):
        report = self.check()
        self.assertEqual([x["role"] for x in report["roles"]], list(guard.ROLES))
        self.assertFalse(report["gpuVerified"])
        self.assertFalse(report["weightsVerified"])

    def test_partial_revision_blocks_release(self):
        manifest = copy.deepcopy(self.manifest)
        next(m for m in manifest['models'] if m['id']=='mel-roformer-bve')['revision'] = 'abcdef0'
        report = self.check(manifest=manifest)
        self.assertIn("mel-roformer-bve", str(report["errors"]))
        self.assertFalse(report["ok"])

    def test_budget_drift_blocks(self):
        fleet = copy.deepcopy(self.fleet)
        fleet["budget"]["maxEurPerHour"] = 12
        self.assertIn("hard limit", str(self.check(fleet=fleet)["errors"]))

    def test_retired_role_reintroduction_blocks(self):
        fleet = copy.deepcopy(self.fleet)
        fleet["pods"][0]["role"] = "orchestrator"
        self.assertFalse(self.check(fleet=fleet)["ok"])

    def test_missing_model_blocks(self):
        fleet = copy.deepcopy(self.fleet)
        fleet["pods"][1]["models"].append("phantom-model")
        self.assertIn("phantom-model", str(self.check(fleet=fleet)["errors"]))

    def test_24gb_fallback_cannot_hide_oom(self):
        fleet = copy.deepcopy(self.fleet)
        fleet["pods"][5]["vramReserveGb"] = 20
        self.assertIn("NVIDIA GeForce RTX 4090", str(self.check(fleet=fleet)["errors"]))

    def test_gpu_cost_overrun_blocks(self):
        fleet = copy.deepcopy(self.fleet)
        studio = next(p for p in fleet["pods"] if p["role"] == "studio")
        next(g for g in fleet["gpuPools"][studio["gpuPool"]] if g["id"] == studio["gpuPoolId"])["usdPerHour"] = 8.0
        self.assertIn("above hard cap", str(self.check(fleet=fleet)["errors"]))

if __name__ == "__main__":
    unittest.main()

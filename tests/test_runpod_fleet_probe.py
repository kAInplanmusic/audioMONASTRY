import importlib.util
import json
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fleet_probe", ROOT / "scripts/runpod-fleet-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def response(self, path):
        if path.startswith("/pods"):
            return {"pods": [{"status": "RUNNING", "cost": 0.35,
                              "env": {"PRIVATE_TOKEN": "never-publish-this"}},
                             {"status": "EXITED", "cost": 9}],
                    "pagination": {"hasNextPage": False, "nextCursor": None}}
        if path.startswith("/catalog"):
            return {"gpus": [{"id": "NVIDIA A40", "memory": 48,
                              "price": {"community": 0.35, "serverless": 0.8}}]}
        if path == "/serverless":
            return {"endpoints": [], "pagination": {"hasNextPage": False}}
        raise AssertionError(path)

    def test_report_omits_secrets_and_stopped_compute(self):
        with patch.object(probe, "request", side_effect=self.response):
            report = probe.probe()
        self.assertEqual(report["existingComputeUsdPerHour"], 0.35)
        self.assertTrue(report["readOnly"])
        self.assertTrue(report["budgetVerified"])
        self.assertEqual(report["createdPods"], 0)
        self.assertNotIn("never-publish-this", json.dumps(report))

    def test_unknown_active_worker_cost_does_not_grant_budget(self):
        def response(path):
            if path == "/serverless":
                return {"endpoints": [{"id": "example"}], "pagination": {"hasNextPage": False}}
            if path == "/serverless/example/workers":
                return {"workers": [{"status": "RUNNING", "gpuTypeId": "unknown", "gpuCount": 1}]}
            return self.response(path)
        with patch.object(probe, "request", side_effect=response):
            report = probe.probe()
        self.assertFalse(report["budgetVerified"])
        self.assertIsNone(report["budgetHeadroomEurPerHour"])

    def test_auth_diagnostic_publishes_status_only(self):
        with patch.dict("os.environ", {"RP_API_KEY": "private-test-key"}), patch.object(
            probe.urllib.request, "urlopen",
            side_effect=urllib.error.HTTPError("https://api.runpod.io/", 401, "Unauthorized", {}, None)
        ):
            report = probe.legacy_auth_diagnostic()
        self.assertEqual(report, {"restV1": {"httpStatus": 401}, "graphql": {"httpStatus": 401}})
        self.assertNotIn("private-test-key", json.dumps(report))

    def test_all_pod_pages_count_toward_budget(self):
        def response(path):
            if path == "/pods?includeClusterPods=true":
                return {"pods": [{"status": "RUNNING", "cost": 0.4}],
                        "pagination": {"hasNextPage": True, "nextCursor": "next"}}
            if path.endswith("cursor=next"):
                return {"pods": [{"status": "RUNNING", "cost": 0.6}],
                        "pagination": {"hasNextPage": False}}
            return self.response(path)
        with patch.object(probe, "request", side_effect=response):
            report = probe.probe()
        self.assertEqual(report["podCount"], 2)
        self.assertEqual(report["existingComputeUsdPerHour"], 1)


if __name__ == "__main__":
    unittest.main()

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

    def test_graphql_uses_documented_auth_without_leaking_key(self):
        import sys
        sys.path.insert(0, str(ROOT / "scripts"))
        import runpod_graphql
        with patch.dict("os.environ", {"RUNPOD_API_KEY": "private-test-key"}), patch.object(
            runpod_graphql.urllib.request, "urlopen",
            side_effect=urllib.error.HTTPError("https://api.runpod.io/?api_key=private-test-key", 401, "Unauthorized", {}, None)
        ) as call:
            with self.assertRaisesRegex(RuntimeError, "Runpod GraphQL HTTP 401") as error:
                runpod_graphql.query("{ myself { id } }")
        self.assertIn("api_key=private-test-key", call.call_args.args[0].full_url)
        self.assertNotIn("private-test-key", str(error.exception))

    def test_graphql_endpoint_cost_is_not_guessed(self):
        import sys
        sys.path.insert(0, str(ROOT / "scripts"))
        data = {"myself": {"clientBalance": 0, "pods": [], "endpoints": [{"id": "example", "workersMin": 0}]}, "gpuTypes": []}
        with patch("runpod_graphql.query", return_value=data):
            report = probe.probe_graphql()
        self.assertTrue(report["authenticated"])
        self.assertFalse(report["gpuTestsFunded"])
        self.assertFalse(report["budgetVerified"])
        self.assertIsNone(report["budgetHeadroomEurPerHour"])

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

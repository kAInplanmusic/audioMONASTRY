"""Tests für scripts/runpod-pods.py – ohne Netz, ohne Kosten.

Der einzige Netzwerkzugang ist `transport`; die Tests ersetzen ihn und protokollieren
jeden Aufruf. Damit ist belegt: ohne --yes kein Start/Löschen, fehlende Gewichte
starten nichts, Budgetbruch beendet die Flotte, Bereitschaft wird je Instanz gemeldet.

Lauf: python3 tests/test_runpod_pods.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("runpod_pods", ROOT / "scripts" / "runpod-pods.py")
pods = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(pods)

TOKEN = "t" * 40


class FakeTarget:
    def __init__(self, missing=()):
        self.missing = set(missing)

    def head(self, key):
        return None if any(m in key for m in self.missing) else {"content-length": "100"}

    def get_bytes(self, key):
        return None if any(m in key for m in self.missing) else b"ab" * 32 + b"  file.tar\n"

    def presign(self, method, key, ttl):
        return f"https://r2.example/{key}?sig"


class Recorder:
    def __init__(self, pods_list=None, cost=0.53, ready_after=0):
        self.calls = []
        self.pods_list = pods_list or []
        self.cost = cost
        self.ready_polls = {}
        self.ready_after = ready_after

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, json.loads(body) if body else None))
        if url.endswith("/v1/pods") and method == "GET":
            return 200, json.dumps(self.pods_list).encode()
        if url.endswith("/v1/pods") and method == "POST":
            b = json.loads(body)
            pod = {"id": f"id-{b['name'].split('-')[-1]}", "name": b["name"], "desiredStatus": "RUNNING", "costPerHr": self.cost}
            self.pods_list.append(pod)
            return 201, json.dumps(pod).encode()
        if method == "DELETE":
            pid = url.rsplit("/", 1)[1]
            self.pods_list = [p for p in self.pods_list if p["id"] != pid]
            return 204, b""
        if url.endswith("/ready"):
            n = self.ready_polls.get(url, 0) + 1
            self.ready_polls[url] = n
            return (200, b'{"status":"ready"}') if n > self.ready_after else (503, b'{"status":"loading_models"}')
        return 404, b""

    def methods(self):
        return [c[0] for c in self.calls]


class Base(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        os.environ.update({"RP_API_KEY": "k", "RP_POD_IMAGE": "ghcr.io/x/runtime:abc", "AI_POD_TOKEN": TOKEN})
        os.environ.pop("HF_TOKEN", None)
        pods.sleep = lambda _s: None
        self.target = FakeTarget()
        pods.s3lite.S3Target.from_r2_env = staticmethod(lambda env=None: self.target)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env)

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = pods.main(list(argv))
        return code, out.getvalue()


class PlanTest(Base):
    def test_plan_ist_im_budget_und_passt_in_den_vram(self):
        p = pods.plan(pods.load_fleet(), pods.load_models())
        self.assertEqual(p["problems"], [])
        self.assertEqual([r["role"] for r in p["pods"]], ["brain", "ears", "voice", "stems", "music"])
        self.assertLessEqual(p["eurPerHourMax"], 4)
        for r in p["pods"]:
            self.assertLessEqual(r["vramGb"], 42, r["role"])

    def test_zu_teuer_wird_erkannt(self):
        fleet = pods.load_fleet()
        fleet["budget"]["maxEurPerHour"] = 1
        self.assertTrue(any("Budget" in x for x in pods.plan(fleet, pods.load_models())["problems"]))


class UpTest(Base):
    def test_ohne_yes_kein_http(self):
        rec = Recorder()
        pods.transport = rec
        code, out = self.run_main("up")
        self.assertEqual(code, 3)
        self.assertEqual(rec.calls, [])
        self.assertIn("Ohne --yes", out)

    def test_kurzes_token_wird_abgelehnt(self):
        os.environ["AI_POD_TOKEN"] = "kurz"
        pods.transport = Recorder()
        self.assertEqual(self.run_main("up", "--yes")[0], 2)

    def test_start_legt_fuenf_pods_mit_richtigem_aufbau_an(self):
        rec = Recorder()
        pods.transport = rec
        code, out = self.run_main("up", "--yes")
        self.assertEqual(code, 0, out)
        posts = [c[2] for c in rec.calls if c[0] == "POST"]
        self.assertEqual([b["name"] for b in posts], [f"audiomonastry-pod-{r}" for r in ("brain", "ears", "voice", "stems", "music")])
        brain = posts[0]
        self.assertEqual(brain["dockerEntrypoint"], ["python", "pod_start.py"])
        self.assertEqual(brain["env"]["AI_ROLE"], "brain+orchestrator")
        self.assertEqual(brain["env"]["AI_ROLE_MODELS"], "qwen3-30b-a3b-awq,qwen3-4b")
        self.assertEqual(brain["env"]["AI_RESIDENT_ONLY"], "1")
        self.assertEqual(brain["env"]["AI_POD_TOKEN"], TOKEN)
        self.assertEqual(brain["ports"], ["8000/http"])
        self.assertEqual(brain["gpuTypeIds"], ["NVIDIA A40", "NVIDIA RTX A6000"])
        urls = json.loads(brain["env"]["AI_WEIGHTS_URLS"])
        self.assertEqual(len(urls), 2)
        self.assertTrue(all(u["url"].startswith("https://r2.example/weights/") for u in urls))
        ears = posts[1]
        self.assertNotIn("essentia", ears["env"]["AI_WEIGHTS_URLS"])  # ohne Gewichte
        self.assertIn("RP_POD_ID_BRAIN=id-brain", out)

    def test_laufende_pods_werden_nicht_doppelt_angelegt(self):
        rec = Recorder(pods_list=[{"id": "x1", "name": "audiomonastry-pod-brain", "desiredStatus": "RUNNING", "costPerHr": 0.53}])
        pods.transport = rec
        code, _ = self.run_main("up", "--yes", "--only", "brain")
        self.assertEqual(code, 0)
        self.assertNotIn("POST", rec.methods())

    def test_fehlende_gewichte_starten_nichts(self):
        self.target.missing = {"qwen3-4b"}
        rec = Recorder()
        pods.transport = rec
        code, out = self.run_main("up", "--yes")
        self.assertEqual(code, 4)
        self.assertNotIn("POST", rec.methods())
        self.assertIn("weights-mirror", out)

    def test_budgetbruch_beendet_die_flotte(self):
        rec = Recorder(cost=1.75)  # 5 × 1,75 $/h ≈ 8 €/h
        pods.transport = rec
        code, out = self.run_main("up", "--yes")
        self.assertEqual(code, 4)
        self.assertEqual(rec.methods().count("DELETE"), 5)
        self.assertEqual(rec.pods_list, [])
        self.assertIn("Budget überschritten", out)

    def test_bereitschaft_wird_je_instanz_gemeldet(self):
        rec = Recorder(ready_after=2)
        pods.transport = rec
        code, out = self.run_main("up", "--yes", "--wait", "60")
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("bereit ("), 5)


class DownTest(Base):
    def test_down_ohne_yes_loescht_nichts(self):
        rec = Recorder(pods_list=[{"id": "a", "name": "audiomonastry-pod-brain", "desiredStatus": "RUNNING"}])
        pods.transport = rec
        code, _ = self.run_main("down")
        self.assertEqual(code, 3)
        self.assertNotIn("DELETE", rec.methods())

    def test_down_beendet_nur_eigene_pods(self):
        rec = Recorder(pods_list=[{"id": "a", "name": "audiomonastry-pod-brain", "desiredStatus": "RUNNING"},
                                  {"id": "b", "name": "fremder-pod", "desiredStatus": "RUNNING"}])
        pods.transport = rec
        code, _ = self.run_main("down", "--yes")
        self.assertEqual(code, 0)
        self.assertEqual([c[1].rsplit("/", 1)[1] for c in rec.calls if c[0] == "DELETE"], ["a"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

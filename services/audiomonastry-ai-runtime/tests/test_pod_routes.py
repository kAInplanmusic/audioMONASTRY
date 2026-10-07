"""HTTP-Routen des Pod-Modus (Token-Schutz, /runsync, /run, /status).

Läuft nur, wenn FastAPI + httpx installiert sind (im Runtime-Image immer), sonst
wird übersprungen:
    python3 services/audiomonastry-ai-runtime/tests/test_pod_routes.py
"""
from __future__ import annotations

import importlib
import os
import pathlib
import sys
import time
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

try:
    import fastapi  # noqa: F401
    from fastapi.testclient import TestClient
    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False


class FakeManager:
    def is_loaded(self, mid):
        return mid == "m1"

    def load(self, mid):
        raise AssertionError("Resident-Modus darf nicht nachladen")

    def infer(self, task, model, payload):
        return {"ok": True, "payload": payload}

    def get_status(self):
        return {"m1": "loaded"}


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI nicht installiert")
class PodRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["AI_POD_TOKEN"] = "geheim-123"
        os.environ["AI_RESIDENT_ONLY"] = "1"
        cls.app_module = importlib.import_module("app")
        importlib.reload(cls.app_module)
        cls.app_module.STATE.manager = FakeManager()
        cls.client = TestClient(cls.app_module.app)  # ohne Kontextmanager: kein Lifespan/Preload
        cls.auth = {"Authorization": "Bearer geheim-123"}

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("AI_POD_TOKEN", None)
        os.environ.pop("AI_RESIDENT_ONLY", None)

    def test_health_ohne_token(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_alles_andere_braucht_token(self):
        self.assertEqual(self.client.post("/runsync", json={"input": {}}).status_code, 401)
        self.assertEqual(self.client.get("/status/x", headers={"Authorization": "Bearer falsch"}).status_code, 401)
        self.assertEqual(self.client.get("/ready").status_code, 401)

    def test_runsync_serverless_format(self):
        r = self.client.post("/runsync", headers=self.auth,
                             json={"input": {"task": "tts", "model": "m1", "input": {"text": "hallo"}}})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "COMPLETED")
        self.assertEqual(body["output"]["status"], "success")
        self.assertEqual(body["output"]["result"]["payload"], {"text": "hallo"})

    def test_resident_nicht_geladenes_modell(self):
        r = self.client.post("/runsync", headers=self.auth, json={"input": {"task": "tts", "model": "m2", "input": {}}})
        self.assertEqual(r.json()["output"]["code"], "MODEL_UNAVAILABLE")

    def test_run_und_status(self):
        sub = self.client.post("/run", headers=self.auth, json={"input": {"task": "tts", "model": "m1", "input": {}}}).json()
        self.assertEqual(sub["status"], "IN_QUEUE")
        for _ in range(100):
            job = self.client.get(f"/status/{sub['id']}", headers=self.auth).json()
            if job["status"] == "COMPLETED":
                break
            time.sleep(0.02)
        self.assertEqual(job["output"]["status"], "success")
        self.assertEqual(self.client.get("/status/unbekannt", headers=self.auth).status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)

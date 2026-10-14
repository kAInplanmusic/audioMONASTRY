"""Pod-Modus: Job-Format wie Serverless, Resident ohne Nachladen, sicherer Gewichte-Start.

Ohne GPU, ohne Netz, ohne FastAPI:
    python3 services/audiomonastry-ai-runtime/tests/test_pod_mode.py
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import pathlib
import sys
import tarfile
import tempfile
import time
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import pod_jobs  # noqa: E402
import pod_start  # noqa: E402
import registry  # noqa: E402


class ModelUnavailableError(Exception):
    pass


class FakeManager:
    def __init__(self, loaded=("a",), fail=None):
        self.loaded = set(loaded)
        self.loads = []
        self.fail = fail

    def is_loaded(self, mid):
        return mid in self.loaded

    def load(self, mid):
        self.loads.append(mid)
        self.loaded.add(mid)

    def infer(self, task, model, payload):
        if self.fail:
            raise self.fail
        return {"echo": payload, "task": task}

    def get_status(self):
        return {m: "loaded" for m in self.loaded}


class RunJobTest(unittest.TestCase):
    def test_erfolg_hat_serverless_form(self):
        out = pod_jobs.run_job(FakeManager(), {"task": "tts", "model": "a", "input": {"text": "hi"}}, resident_only=True)
        self.assertEqual(out["status"], "success")
        self.assertEqual(out["result"]["echo"], {"text": "hi"})
        self.assertIn("durationMs", out)

    def test_resident_laedt_nie_nach(self):
        mgr = FakeManager(loaded=())
        out = pod_jobs.run_job(mgr, {"task": "tts", "model": "b", "input": {}}, resident_only=True)
        self.assertEqual(out["code"], "MODEL_UNAVAILABLE")
        self.assertEqual(mgr.loads, [])

    def test_ohne_resident_wird_geladen(self):
        mgr = FakeManager(loaded=())
        out = pod_jobs.run_job(mgr, {"task": "tts", "model": "b", "input": {}}, resident_only=False)
        self.assertEqual(out["status"], "success")
        self.assertEqual(mgr.loads, ["b"])

    def test_warmup_meldet_stand(self):
        out = pod_jobs.run_job(FakeManager(), {"task": "warmup", "model": "", "input": {}}, resident_only=True)
        self.assertEqual(out["result"]["models"], {"a": "loaded"})

    def test_ungueltige_eingaben(self):
        self.assertEqual(pod_jobs.run_job(FakeManager(), "x", resident_only=True)["code"], "INVALID_INPUT")
        self.assertEqual(pod_jobs.run_job(FakeManager(), {"task": "../x"}, resident_only=True)["code"], "INVALID_TASK")
        self.assertEqual(pod_jobs.run_job(FakeManager(), {"task": "tts", "model": "z"}, resident_only=True,
                                          known_models={"a"})["code"], "INVALID_MODEL")

    def test_fehlerarten(self):
        out = pod_jobs.run_job(FakeManager(fail=ModelUnavailableError("x")), {"task": "tts", "model": "a", "input": {}}, resident_only=True)
        self.assertEqual(out["code"], "MODEL_UNAVAILABLE")
        out = pod_jobs.run_job(FakeManager(fail=ValueError("geheim")), {"task": "tts", "model": "a", "input": {}}, resident_only=True)
        self.assertEqual(out["code"], "INFERENCE_FAILED")
        self.assertNotIn("geheim", json.dumps(out))


class JobStoreTest(unittest.TestCase):
    def test_run_und_status(self):
        store = pod_jobs.JobStore(lambda inp: {"status": "success", "result": inp})
        sub = store.submit({"x": 1})
        self.assertEqual(sub["status"], "IN_QUEUE")
        for _ in range(100):
            job = store.get(sub["id"])
            if job and job["status"] == "COMPLETED":
                break
            time.sleep(0.01)
        self.assertEqual(job["output"]["result"], {"x": 1})
        self.assertIsNone(store.get("unbekannt"))
        store.shutdown()

    def test_runsync_fehler_bleibt_completed_mit_fehler_output(self):
        store = pod_jobs.JobStore(lambda inp: {"status": "error", "code": "X"})
        res = store.run_sync({})
        self.assertEqual(res["status"], "COMPLETED")
        self.assertEqual(res["output"]["code"], "X")
        store.shutdown()

    def test_runsync_gibt_nach_wartezeit_in_progress_zurueck(self):
        # Pod-Proxy schneidet nach 100 s ab: lange Jobs laufen weiter, Aufrufer pollt.
        store = pod_jobs.JobStore(lambda inp: (time.sleep(0.3), {"status": "success"})[1])
        res = store.run_sync({}, wait_s=0.05)
        self.assertEqual(res["status"], "IN_PROGRESS")
        for _ in range(100):
            if store.get(res["id"])["status"] == "COMPLETED":
                break
            time.sleep(0.02)
        self.assertEqual(store.get(res["id"])["output"]["status"], "success")
        store.shutdown()

    def test_runner_ausnahme_wird_fehler_output(self):
        def boom(_inp):
            raise RuntimeError("x")
        store = pod_jobs.JobStore(boom)
        self.assertEqual(store.run_sync({}, wait_s=2)["output"]["code"], "INFERENCE_FAILED")
        store.shutdown()


def _tar_bytes(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class PodStartTest(unittest.TestCase):
    def test_parse_lehnt_unsichere_namen_ab(self):
        with self.assertRaises(ValueError):
            pod_start.parse_entries(json.dumps([{"name": "../x.tar", "url": "u", "sha256": "s"}]))
        with self.assertRaises(ValueError):
            pod_start.parse_entries(json.dumps([{"name": "x.tar", "url": "u"}]))
        self.assertEqual(pod_start.parse_entries(""), [])

    def test_laden_pruefen_entpacken(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = _tar_bytes([("hub/models--org--m/blobs/abc", b"gewicht")])
            src = os.path.join(tmp, "src.tar")
            with open(src, "wb") as fh:
                fh.write(data)
            entry = {"name": "m.tar", "url": pathlib.Path(src).as_uri(), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
            hf = os.path.join(tmp, "hf")
            pod_start.fetch_weights([entry], hf, os.path.join(tmp, "work"), parallel=1)
            with open(os.path.join(hf, "hub/models--org--m/blobs/abc"), "rb") as fh:
                self.assertEqual(fh.read(), b"gewicht")

    def test_falscher_hash_bricht_ab(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "src.tar")
            with open(src, "wb") as fh:
                fh.write(_tar_bytes([("a", b"x")]))
            entry = {"name": "m.tar", "url": pathlib.Path(src).as_uri(), "sha256": "0" * 64}
            pod_start.time.sleep = lambda _s: None  # Retries ohne Warten
            with self.assertRaises(ValueError):
                pod_start.fetch_weights([entry], os.path.join(tmp, "hf"), os.path.join(tmp, "w"), parallel=1)

    def test_archiv_mit_pfadausbruch_wird_abgelehnt(self):
        with tempfile.TemporaryDirectory() as tmp:
            arch = os.path.join(tmp, "bad.tar")
            with open(arch, "wb") as fh:
                fh.write(_tar_bytes([("../../etc/evil", b"x")]))
            with self.assertRaises(ValueError):
                pod_start.safe_extract(arch, os.path.join(tmp, "hf"))

    def test_datei_eintrag_landet_im_hf_cache_layout(self):
        """Edge-Spiegel: dateiweise Gewichte werden als Blob + Snapshot-Symlink abgelegt.

        Blob-Name ist der SHA256 der Datei - genau der Name, den transformers offline
        erwartet. Der Snapshot liegt unter dem Commit, den der Eintrag nennt.
        """
        with tempfile.TemporaryDirectory() as tmp:
            payload = b"gewicht-datei-inhalt"
            src = os.path.join(tmp, "src.bin")
            with open(src, "wb") as fh:
                fh.write(payload)
            sha = hashlib.sha256(payload).hexdigest()
            entry = {"path": "sub/model.safetensors", "url": pathlib.Path(src).as_uri(),
                     "sha256": sha, "size": len(payload), "repo": "org/modell", "commit": "abc123"}
            hf = os.path.join(tmp, "hf")
            pod_start.fetch_weights([entry], hf, os.path.join(tmp, "work"), parallel=1)

            blob = os.path.join(hf, "hub/models--org--modell/blobs", sha)
            snapshot = os.path.join(hf, "hub/models--org--modell/snapshots/abc123/sub/model.safetensors")
            with open(blob, "rb") as fh:
                self.assertEqual(fh.read(), payload)
            self.assertTrue(os.path.islink(snapshot))
            with open(snapshot, "rb") as fh:
                self.assertEqual(fh.read(), payload)
            with open(os.path.join(hf, "hub/models--org--modell/refs/main"), encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "abc123")
            # Kein TAR-Rest im Arbeitsverzeichnis.
            self.assertEqual(os.listdir(os.path.join(tmp, "work")), [])

    def test_datei_eintrag_braucht_hash_repo_commit_und_sicheren_pfad(self):
        def entries(raw):
            return pod_start.parse_entries(json.dumps(raw))

        with self.assertRaises(ValueError):
            entries([{"path": "a.bin", "url": "u", "sha256": "s"}])  # repo/commit fehlen
        for unsafe in ("../a.bin", "/etc/passwd", "a\\b.bin", "sub//a.bin", "./a.bin"):
            with self.assertRaises(ValueError):
                entries([{"path": unsafe, "url": "u", "sha256": "s", "repo": "o/m", "commit": "c"}])
        ok = entries([{"path": "sub/a.bin", "url": "u", "sha256": "s", "repo": "o/m", "commit": "c"}])
        self.assertEqual(ok[0]["path"], "sub/a.bin")

    def test_falscher_hash_bricht_auch_bei_datei_eintraegen_ab(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "src.bin")
            with open(src, "wb") as fh:
                fh.write(b"inhalt")
            entry = {"path": "a.bin", "url": pathlib.Path(src).as_uri(), "sha256": "0" * 64,
                     "size": 6, "repo": "o/m", "commit": "c"}
            pod_start.time.sleep = lambda _s: None  # Retries ohne Warten
            with self.assertRaises(ValueError):
                pod_start.fetch_weights([entry], os.path.join(tmp, "hf"), os.path.join(tmp, "w"), parallel=1)


class PodSelectionTest(unittest.TestCase):
    def setUp(self):
        self.data = registry.read_manifest()

    def test_ohne_auswahl_identisch_zu_apply_role(self):
        self.assertEqual(registry.apply_pod_selection(self.data, "ears"), registry.apply_role(self.data, "ears"))

    def test_brain_plus_orchestrator_mit_teilmenge(self):
        res = registry.apply_pod_selection(self.data, "brain+orchestrator", "qwen3-30b-a3b-awq,qwen3-4b")
        self.assertEqual([m["id"] for m in res["models"]], ["qwen3-30b-a3b-awq", "qwen3-4b"])
        self.assertTrue(all(m["preload"] for m in res["models"]))
        self.assertEqual(res["role"], "brain+orchestrator")

    def test_stems_aus_voicegen(self):
        # FLEET-P1-006: RP5-Hauptmodell + Alias htdemucs-6s (bis GPU-Beleg), Spiegel von pod-fleet.json.
        res = registry.apply_pod_selection(self.data, "voiceGen", "bs-roformer-sw-6stem,htdemucs-6s")
        self.assertEqual([m["id"] for m in res["models"]], ["bs-roformer-sw-6stem", "htdemucs-6s"])
        self.assertTrue(all(m["preload"] for m in res["models"]))
        self.assertEqual(res["models"][0]["quantization"], "bf16")

    def test_ears_neue_handler_waehlbar_altmodelle_bleiben_preload(self):
        # FLEET-P1-002..005 (PARTIAL): neue Modelle in roles.ears.models, NICHT im
        # Preload; die Altmodelle bleiben Standard bis zum GPU-Beleg.
        res = registry.apply_role(self.data, "ears")
        preload = {m["id"]: m["preload"] for m in res["models"]}
        for mid in ("qwen3-asr-1.7b", "moss-audio-8b-instruct", "pyannote-community-1", "songformer", "clip-vit-l14"):
            self.assertIs(preload[mid], False, mid)
        for mid in ("whisper-large-v3", "qwen2-audio-7b", "pyannote-diarization", "essentia"):
            self.assertIs(preload[mid], True, mid)
        self.assertNotIn("beat-this", preload)

    def test_teilmenge_ausserhalb_der_rolle(self):
        with self.assertRaises(ValueError):
            registry.apply_pod_selection(self.data, "ears", "htdemucs-6s")

    def test_lego_xl_base_auf_dem_voice_pod(self):
        # Betreiber-Entscheid 2026-10-12: xl-base (LEGO) liegt auf RP4 voice.
        res = registry.apply_pod_selection(
            self.data, "voiceGen", "qwen3-tts-17b,qwen3-tts-voicedesign,stable-audio-open-1.0,acestep-v15-xl-base")
        self.assertIn("acestep-v15-xl-base", [m["id"] for m in res["models"]])
        self.assertNotIn("acestep-v15-xl-base", self.data["roles"]["music"]["preloadModels"])
        self.assertNotIn("htdemucs-6s", self.data["roles"]["voiceGen"]["preloadModels"])
        self.assertNotIn("bs-roformer-sw-6stem", self.data["roles"]["voiceGen"]["preloadModels"])


class NeueFlottenmodelleTest(unittest.TestCase):
    """status 'neu' = entschieden, aber ohne Handler: nie in einer Rolle, nie geladen."""

    def setUp(self):
        self.data = registry.read_manifest()
        self.neu = [m for m in self.data["models"] if m.get("status") == "neu"]

    def test_es_gibt_neue_modelle_und_keines_steht_in_einer_rolle(self):
        self.assertGreater(len(self.neu), 0)
        ids = {m["id"] for m in self.neu}
        for role, spec in self.data["roles"].items():
            self.assertEqual(ids & set(spec["models"]), set(), role)

    def test_rolle_mit_neuem_modell_wird_abgelehnt(self):
        data = json.loads(json.dumps(self.data))
        # beat-this bleibt status "neu" (PIN-ERFORDERLICH, FLEET-P1-005).
        data["roles"]["ears"]["models"].append("beat-this")
        with self.assertRaises(ValueError):
            registry.apply_role(data, "ears")

    def test_pin_platzhalter_nur_mit_status_neu(self):
        model = {"id": "x", "revision": "PIN-ERFORDERLICH"}
        with self.assertRaises(ValueError):
            registry._validate_revision(model)
        registry._validate_revision(dict(model, status="neu"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

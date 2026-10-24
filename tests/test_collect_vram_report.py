"""Tests für scripts/collect-vram-report.py – ohne Netz, ohne GPU, ohne Kosten.

Belegt die Beweis-Regel des Tickets: ein Report wird nur dann `MEASURED`, wenn
der Pod eine GPU sieht, Samples geliefert hat und mindestens eine Inferenz
erfolgreich war. Alles andere ist `NOT_MEASURED` mit Gründen – niemals eine Zahl.

Lauf: python3 tests/test_collect_vram_report.py
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
import wave
import base64
import io

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("collect_vram", ROOT / "scripts" / "collect-vram-report.py")
assert spec is not None and spec.loader is not None
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


def report(gpu_visible: bool = True, samples: int = 3, peak_mb: float | None = 9000.0,
           avg_mb: float | None = 8000.0, notes=None) -> dict:
    return {
        "gpu": {"gpuVisible": gpu_visible, "notes": notes or [], "driverVersion": "550.54.15"},
        "load": {"sampleCount": samples, "peakMb": peak_mb, "avgMb": avg_mb},
        "verdict": {"budgetMb": 43008, "peek": None, "withinBudget": True if peak_mb else None},
    }


def requests(ok: int = 4, failed: int = 0) -> dict:
    return collect.summarize_requests(
        [{"status": 200, "latencyMs": 900, "ok": True, "error": None}] * ok
        + [{"status": 503, "latencyMs": 20, "ok": False, "error": "HTTP 503: MODEL_UNAVAILABLE"}] * failed,
        {"task": "llm", "model": "qwen3-30b-a3b-awq"},
    )


class EvaluateTest(unittest.TestCase):
    def test_voller_befund_ist_gemessen(self):
        status, reasons = collect.evaluate(report(), requests(ok=4))
        self.assertEqual(status, "MEASURED")
        self.assertEqual(reasons, [])

    def test_ohne_gpu_keine_messung(self):
        status, reasons = collect.evaluate(
            report(gpu_visible=False, samples=7, peak_mb=None, avg_mb=None,
                   notes=["torch_not_installed", "no_gpu_visible"]),
            requests(ok=0, failed=24),
        )
        self.assertEqual(status, "NOT_MEASURED")
        self.assertTrue(any("keine GPU" in reason for reason in reasons))
        self.assertTrue(any("peakMb/avgMb" in reason for reason in reasons))

    def test_ohne_samples_keine_messung(self):
        status, reasons = collect.evaluate(report(samples=0, peak_mb=None, avg_mb=None), requests(ok=4))
        self.assertEqual(status, "NOT_MEASURED")
        self.assertTrue(any("kein Sample" in reason for reason in reasons))

    def test_fehlgeschlagene_inferenz_ist_keine_lastmessung(self):
        status, reasons = collect.evaluate(report(), requests(ok=0, failed=8))
        self.assertEqual(status, "NOT_MEASURED")
        self.assertTrue(any("keine erfolgreiche Inferenz" in reason for reason in reasons))


class RequestSummaryTest(unittest.TestCase):
    def test_zaehlt_ok_fehler_und_latenzen(self):
        summary = requests(ok=3, failed=2)
        self.assertEqual(summary["count"], 5)
        self.assertEqual(summary["ok"], 3)
        self.assertEqual(summary["failed"], 2)
        self.assertEqual(summary["latencyMs"]["min"], 20)
        self.assertEqual(summary["latencyMs"]["max"], 900)
        self.assertEqual(summary["errors"], ["HTTP 503: MODEL_UNAVAILABLE"])

    def test_leere_liste_hat_keine_latenz(self):
        summary = collect.summarize_requests([], {"task": "tts", "model": "m"})
        self.assertEqual(summary["count"], 0)
        self.assertIsNone(summary["latencyMs"])


class RecordTest(unittest.TestCase):
    def test_schreibt_datei_je_rolle_und_datum(self):
        collected = {"report": report(), "requests": requests(), "error": None, "reachable": True}
        record = collect.build_record("ears", "https://abc-8000.proxy.runpod.net", "abc", collected,
                                     users=4, duration=20.0, interval=0.5,
                                     git={"commit": "c0ffee", "branch": "main"})
        self.assertEqual(record["status"], "MEASURED")
        self.assertEqual(record["peakMb"], 9000.0)
        self.assertEqual(record["avgMb"], 8000.0)
        self.assertEqual(record["gitCommit"], "c0ffee")
        self.assertEqual(record["driverVersion"], "550.54.15")
        self.assertEqual(record["budgetMb"], 43008)
        self.assertEqual(record["ticket"], "FLEET-P1-011")
        self.assertEqual(record["users"], 4)

        with tempfile.TemporaryDirectory() as tmp:
            path = collect.write_record(record, pathlib.Path(tmp))
            self.assertEqual(path.name, f"ears-{record['date']}.json")
            round_trip = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(round_trip["peakMb"], 9000.0)
            self.assertEqual(round_trip["status"], "MEASURED")

    def test_netzfehler_wird_nicht_als_messung_verkauft(self):
        collected = {"report": {}, "requests": requests(ok=0, failed=0),
                     "error": "GET /vram/report → HTTP 0: {'_error': 'URLError'}", "reachable": False}
        record = collect.build_record("music", "https://x-8000.proxy.runpod.net", "x", collected,
                                     users=4, duration=20.0, interval=0.5, git={})
        self.assertEqual(record["status"], "NOT_MEASURED")
        self.assertIsNone(record["peakMb"])
        self.assertIn("GET /vram/report", record["reasons"][0])


class PayloadTest(unittest.TestCase):
    def test_jede_flottenrolle_hat_ein_lastprofil(self):
        fleet = json.loads((ROOT / "deploy" / "runpod" / "pod-fleet.json").read_text(encoding="utf-8"))
        for pod in fleet["pods"]:
            load = collect.role_request(pod["role"])
            self.assertIn("task", load)
            self.assertIn("model", load)
            self.assertIsInstance(load["input"], dict)

    def test_stille_wav_ist_gueltiges_wav(self):
        raw = base64.b64decode(collect.silence_wav_b64(seconds=1))
        with wave.open(io.BytesIO(raw), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getframerate(), 16000)
            self.assertEqual(handle.getnframes(), 16000)

    def test_audio_lastprofile_nutzen_das_wav(self):
        for role in ("ears", "stems"):
            load = collect.role_request(role)
            self.assertGreater(len(load["input"]["audio"]), 1000)


if __name__ == "__main__":
    unittest.main(verbosity=2)

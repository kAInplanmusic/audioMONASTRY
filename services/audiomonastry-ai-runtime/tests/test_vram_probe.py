"""FLEET-P1-011 – Tests der VRAM-Sonde (ohne GPU, mit gefälschtem torch).

Beweist, was ohne A40 beweisbar ist:
  * pro-Device-Snapshot über `mem_get_info` / `max_memory_allocated`,
  * Rückfall auf nvidia-smi und ausdrücklicher Fehler ohne CUDA (kein Nullwert
    als "Messung"),
  * Aggregation von Spitze und Durchschnitt über ein Lastfenster,
  * Phasen cold/warmup und die 42-GB-Bewertung,
  * Token-Schutz und Ablauf der Route /vram/report.

NICHT beweisbar ohne echte GPU: absolute VRAM-Werte, OOM-Verhalten, Wirkung der
4 parallelen Nutzer. Das steht im Report als `verdict.measured=false`, bis der
Lauf auf einer A40 stattgefunden hat.

Aufruf:
    python3 services/audiomonastry-ai-runtime/tests/test_vram_probe.py
"""
from __future__ import annotations

import importlib
import json
import pathlib
import statistics
import sys
import threading
import time
import types
import unittest
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import vram_probe  # noqa: E402
from vram_probe import BUDGET_MB, LoadSampler, VramProbe, to_mb  # noqa: E402

try:
    import fastapi  # noqa: F401
    from fastapi.testclient import TestClient

    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False

MIB = 1024 * 1024
A40_TOTAL_MIB = 46068  # echte A40-Kapazität in MiB (nvidia-smi)


# --------------------------------------------------------------------------- Fakes
class FakeProps:
    def __init__(self, total_bytes: int) -> None:
        self.total_memory = total_bytes


class FakeCuda:
    """Minimaler torch.cuda-Ersatz: nur die Aufrufe, die vram_probe nutzt."""

    def __init__(self, devices, available: bool = True) -> None:
        self.devices = devices
        self.available = available
        self.reset_calls = 0

    def is_available(self) -> bool:
        return self.available

    def device_count(self) -> int:
        return len(self.devices) if self.available else 0

    def get_device_name(self, index: int) -> str:
        return self.devices[index]["name"]

    def get_device_properties(self, index: int) -> FakeProps:
        return FakeProps(self.devices[index]["total"])

    def mem_get_info(self, index: int):
        device = self.devices[index]
        return device["free"], device["total"]

    def memory_allocated(self, index: int) -> int:
        return self.devices[index]["allocated"]

    def memory_reserved(self, index: int) -> int:
        return self.devices[index].get("reserved", self.devices[index]["allocated"])

    def max_memory_allocated(self, index: int) -> int:
        return self.devices[index]["peak"]

    def reset_peak_memory_stats(self, *args, **kwargs) -> None:
        self.reset_calls += 1


class FakeTorch:
    def __init__(self, cuda: FakeCuda, cuda_version: str = "12.4") -> None:
        self.cuda = cuda
        self.version = types.SimpleNamespace(cuda=cuda_version)


def a40(used_mib: int, allocated_mib: int = 0, peak_mib: int = 0, index: int = 0) -> dict:
    return {
        "name": "NVIDIA A40",
        "total": A40_TOTAL_MIB * MIB,
        "free": (A40_TOTAL_MIB - used_mib) * MIB,
        "allocated": allocated_mib * MIB,
        "peak": peak_mib * MIB,
    }


def fake_smi(rows: dict, calls: list | None = None):
    """nvidia-smi-Ersatz: liefert Zeilen je Feldliste, protokolliert Aufrufe."""

    def runner(fields):
        key = ",".join(fields)
        if calls is not None:
            calls.append(key)
        return rows.get(key)

    return runner


SMI_ROWS = {
    "index,name,memory.total,memory.used": [["0", "NVIDIA A40", str(A40_TOTAL_MIB), "1200"]],
    "driver_version": [["550.54.15"]],
}


class FakeClock:
    """Springt beim Schlafen exakt um die Schlafdauer – Tests ohne Wartezeit."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class ScriptedProbe:
    """Sonde mit vorgegebenen Belegungen (MiB) – für die Aggregationsprüfung."""

    def __init__(self, used_mib, allocated_mib=None, total_mib: int = A40_TOTAL_MIB) -> None:
        self.used = list(used_mib)
        self.allocated = list(allocated_mib) if allocated_mib is not None else None
        self.total = total_mib
        self.index = 0
        self.captures = []
        self.reset_calls = 0

    def snapshot(self) -> dict:
        i = min(self.index, len(self.used) - 1)
        used = self.used[i]
        allocated = self.allocated[i] if self.allocated else None
        self.index += 1
        return {
            "capturedAt": "2026-10-24T00:00:00+00:00",
            "source": "torch",
            "cudaAvailable": True,
            "gpuVisible": True,
            "notes": [],
            "devices": [
                {
                    "index": 0,
                    "name": "NVIDIA A40",
                    "source": "torch",
                    "totalBytes": self.total * MIB,
                    "usedBytes": used * MIB,
                    "torchAllocatedBytes": None if allocated is None else allocated * MIB,
                    "torchPeakAllocatedBytes": None if allocated is None else allocated * MIB,
                }
            ],
        }

    def reset_peak_stats(self) -> bool:
        self.reset_calls += 1
        return True

    def capture(self, label: str) -> dict:
        self.captures.append(label)
        return {**self.snapshot(), "label": label}


class BlockingProbe(ScriptedProbe):
    """Snapshot blockiert bis `release` – macht `start()` deterministisch prüfbar."""

    def __init__(self) -> None:
        super().__init__([1000])
        self.release = threading.Event()
        self.entered = threading.Event()

    def snapshot(self) -> dict:
        self.entered.set()
        self.release.wait(5)
        return super().snapshot()


# ------------------------------------------------------------------ Snapshot-Tests
class SnapshotTest(unittest.TestCase):
    def test_je_device_total_belegt_und_prozess_spitze(self):
        cuda = FakeCuda([a40(1200, allocated_mib=900, peak_mib=1100), a40(2000, allocated_mib=1500, peak_mib=1800, index=1)])
        probe = VramProbe("brain", torch_module=FakeTorch(cuda), smi_runner=fake_smi(SMI_ROWS))
        snap = probe.snapshot()

        self.assertEqual(snap["source"], "torch")
        self.assertTrue(snap["cudaAvailable"])
        self.assertTrue(snap["gpuVisible"])
        self.assertEqual([d["index"] for d in snap["devices"]], [0, 1])
        self.assertEqual(snap["devices"][0]["usedMb"], 1200.0)
        self.assertEqual(snap["devices"][0]["totalMb"], float(A40_TOTAL_MIB))
        self.assertEqual(snap["devices"][0]["freeMb"], float(A40_TOTAL_MIB - 1200))
        self.assertEqual(snap["devices"][0]["torchAllocatedMb"], 900.0)
        self.assertEqual(snap["devices"][0]["torchPeakAllocatedMb"], 1100.0)
        self.assertEqual(snap["devices"][1]["usedMb"], 2000.0)
        self.assertAlmostEqual(snap["devices"][0]["usedPercent"], round(100.0 * 1200 / A40_TOTAL_MIB, 1))
        # usedBytes ist die Rohwahrheit für die Aggregation.
        self.assertEqual(snap["devices"][0]["usedBytes"], 1200 * MIB)

    def test_ohne_cuda_klarer_befund_statt_nullwert(self):
        probe = VramProbe("ears", torch_module=FakeTorch(FakeCuda([], available=False)), smi_runner=fake_smi({}))
        report = probe.report()

        self.assertFalse(report["gpu"]["gpuVisible"])
        self.assertFalse(report["gpu"]["cudaAvailable"])
        self.assertIn("cuda_unavailable", report["gpu"]["notes"])
        self.assertIn("no_gpu_visible", report["gpu"]["notes"])
        self.assertEqual(report["gpu"]["deviceCount"], 0)
        self.assertIsNone(report["gpu"]["totalMb"])
        # Ohne GPU ist die Last Null – und der Report sagt das, statt 0 MB zu "messen".
        self.assertFalse(report["verdict"]["measured"])
        self.assertIsNone(report["verdict"]["peakMb"])
        self.assertIsNone(report["verdict"]["withinBudget"])

    def test_rueckfall_auf_nvidia_smi_ohne_torch(self):
        calls = []
        probe = VramProbe("voice", smi_runner=fake_smi(SMI_ROWS, calls))
        with mock.patch.object(vram_probe, "_import_torch", return_value=None):
            snap = probe.snapshot()

        self.assertEqual(snap["source"], "nvidia-smi")
        self.assertFalse(snap["cudaAvailable"])
        self.assertTrue(snap["gpuVisible"])
        self.assertIn("torch_not_installed", snap["notes"])
        self.assertIn("fallback_nvidia-smi", snap["notes"])
        self.assertEqual(snap["devices"][0]["usedMb"], 1200.0)
        self.assertEqual(snap["devices"][0]["totalMb"], float(A40_TOTAL_MIB))
        # nvidia-smi kennt nur die Gerätesicht, keine Prozess-Spitze.
        self.assertIsNone(snap["devices"][0]["torchAllocatedMb"])
        self.assertIsNone(snap["devices"][0]["torchPeakAllocatedMb"])

    def test_treiberversion_kommt_aus_nvidia_smi(self):
        calls = []
        probe = VramProbe("music", torch_module=None, smi_runner=fake_smi(SMI_ROWS, calls))
        self.assertEqual(probe.driver_version(), "550.54.15")
        probe.driver_version()
        # Negativ-Cache: ein zweiter Report startet keinen zweiten Prozess.
        self.assertEqual(calls.count("driver_version"), 1)
        self.assertIsNone(probe.cuda_version())

    def test_to_mb_laesst_unbekannt_unbekannt(self):
        self.assertIsNone(to_mb(None))
        self.assertEqual(to_mb(MIB), 1.0)


# ------------------------------------------------------------------- Sampler-Tests
class SamplerTest(unittest.TestCase):
    def test_sammelt_peak_und_durchschnitt(self):
        probe = ScriptedProbe([100, 300, 200], allocated_mib=[50, 150, 120])
        clock = FakeClock()
        sampler = LoadSampler(
            probe, duration_s=2.0, interval_s=1.0, users=4, clock=clock, sleeper=clock.sleep
        )

        sampler.run()

        state = sampler.state()
        self.assertEqual(state["sampleCount"], 3)  # t=0, t=1, t=2
        self.assertEqual(state["users"], 4)
        self.assertFalse(state["running"])
        device = state["devices"][0]
        self.assertEqual(device["samples"], 3)
        self.assertEqual(device["peakMb"], 300.0)
        self.assertEqual(device["avgMb"], 200.0)  # (100 + 300 + 200) / 3
        self.assertEqual(device["peakTorchAllocatedMb"], 150.0)
        self.assertEqual(device["avgTorchAllocatedMb"], round((50 + 150 + 120) / 3, 1))
        self.assertEqual(state["peakMb"], 300.0)
        self.assertEqual(state["avgMb"], 200.0)
        self.assertTrue(state["gpuVisible"])
        # Die Statistik wird zu Beginn des Fensters zurückgesetzt.
        self.assertEqual(probe.reset_calls, 1)

    def test_start_ist_einmalig_und_stop_beendet_das_fenster(self):
        probe = BlockingProbe()
        clock = FakeClock()
        sampler = LoadSampler(probe, duration_s=60.0, interval_s=1.0, clock=clock, sleeper=clock.sleep)

        self.assertTrue(sampler.start())
        self.assertTrue(probe.entered.wait(2), "Sampler-Thread hat nicht gestartet")
        self.assertFalse(sampler.start(), "zweites start() darf kein zweites Fenster öffnen")

        sampler.stop()
        probe.release.set()
        self.assertTrue(sampler.wait(5))
        self.assertFalse(sampler.running)
        self.assertEqual(sampler.state()["sampleCount"], 1)

    def test_aggregation_ohne_samples_bleibt_leer(self):
        sampler = LoadSampler(ScriptedProbe([1000]), duration_s=1.0)
        state = sampler.state()
        self.assertEqual(state["sampleCount"], 0)
        self.assertEqual(state["devices"], [])
        self.assertIsNone(state["peakMb"])
        self.assertIsNone(state["avgMb"])


# -------------------------------------------------------------------- Report-Tests
class ReportTest(unittest.TestCase):
    def _probe_with(self, used_mib: int) -> VramProbe:
        cuda = FakeCuda([a40(used_mib, allocated_mib=used_mib - 5000, peak_mib=used_mib - 4000)])
        return VramProbe("stems", torch_module=FakeTorch(cuda), smi_runner=fake_smi(SMI_ROWS))

    def test_phasen_cold_warmup_und_lastfenster(self):
        probe = self._probe_with(40000)
        probe.capture("cold")
        probe.capture("warmup")
        clock = FakeClock()
        probe.clock, probe.sleeper = clock, clock.sleep

        self.assertTrue(probe.start_load(duration_s=2.0, interval_s=1.0, users=4))
        self.assertTrue(probe.wait_for_load(5), "Lastfenster wurde nicht fertig")

        report = probe.report()
        self.assertEqual(report["ticket"], "FLEET-P1-011")
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["runtime"]["role"], "stems")
        self.assertEqual(sorted(report["phases"]), ["cold", "load", "warmup"])
        self.assertEqual(report["phases"]["cold"]["label"], "cold")
        self.assertEqual(report["phases"]["warmup"]["devices"][0]["usedMb"], 40000.0)
        self.assertEqual(report["load"]["sampleCount"], 3)  # t=0, 1, 2
        self.assertEqual(report["load"]["users"], 4)
        self.assertEqual(report["load"]["peakMb"], 40000.0)
        self.assertEqual(report["load"]["avgMb"], 40000.0)
        self.assertEqual(report["gpu"]["driverVersion"], "550.54.15")
        self.assertEqual(report["gpu"]["cudaVersion"], "12.4")
        self.assertEqual(report["gpu"]["deviceCount"], 1)
        self.assertTrue(report["verdict"]["measured"])
        self.assertEqual(report["verdict"]["budgetMb"], BUDGET_MB)
        self.assertTrue(report["verdict"]["withinBudget"])

    def test_ueber_42_gb_wird_als_ueberschreitung_gemeldet(self):
        probe = self._probe_with(44000)  # 44 GB > 42 GB Budget
        clock = FakeClock()
        probe.clock, probe.sleeper = clock, clock.sleep
        probe.start_load(duration_s=1.0, interval_s=1.0, users=4)
        probe.wait_for_load(5)

        report = probe.report()
        self.assertEqual(report["load"]["peakMb"], 44000.0)
        self.assertFalse(report["verdict"]["withinBudget"])
        self.assertEqual(report["verdict"]["peakMb"], 44000.0)


# --------------------------------------------------------------------- Routen-Test
@unittest.skipUnless(HAVE_FASTAPI, "FastAPI nicht installiert")
class RouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os_environ_token = "geheim-vram-123"
        import os

        os.environ["AI_POD_TOKEN"] = os_environ_token
        os.environ["AI_RESIDENT_ONLY"] = "1"
        cls.app_module = importlib.import_module("app")
        importlib.reload(cls.app_module)
        # Echte Route + echte Sonde, nur die GPU ist gefälscht.
        cuda = FakeCuda([a40(9000, allocated_mib=8000, peak_mib=8500)])
        cls.app_module.VRAM_PROBE = VramProbe(
            "brain", torch_module=FakeTorch(cuda), smi_runner=fake_smi(SMI_ROWS)
        )
        cls.app_module.VRAM_PROBE.capture("cold")  # wie beim echten App-Import
        cls.client = TestClient(cls.app_module.app)  # ohne Lifespan/Preload
        cls.auth = {"Authorization": f"Bearer {os_environ_token}"}

    @classmethod
    def tearDownClass(cls):
        import os

        os.environ.pop("AI_POD_TOKEN", None)
        os.environ.pop("AI_RESIDENT_ONLY", None)

    def test_get_braucht_pod_token(self):
        self.assertEqual(self.client.get("/vram/report").status_code, 401)
        self.assertEqual(self.client.get("/vram/report", headers={"Authorization": "Bearer falsch"}).status_code, 401)

    def test_get_liefert_report_mit_phase_und_gpu(self):
        response = self.client.get("/vram/report", headers=self.auth)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["ticket"], "FLEET-P1-011")
        self.assertTrue(body["gpu"]["gpuVisible"])
        self.assertEqual(body["gpu"]["usedMb"], 9000.0)
        self.assertEqual(body["gpu"]["deviceCount"], 1)
        self.assertIn("cold", body["phases"])  # beim App-Import gesetzt
        self.assertFalse(body["load"]["running"])

    def test_post_start_wait_liefert_lastfenster(self):
        started = self.client.post(
            "/vram/report",
            headers=self.auth,
            json={"action": "start", "durationSeconds": 0.5, "intervalSeconds": 0.1, "users": 4},
        )
        self.assertIn(started.status_code, (202, 409))  # 409 = vorheriges Fenster läuft noch
        state = {}
        for _ in range(100):
            state = self.client.get("/vram/report", headers=self.auth).json()["load"]
            if not state["running"] and state["sampleCount"] > 0:
                break
            time.sleep(0.05)
        self.assertFalse(state["running"])
        self.assertGreater(state["sampleCount"], 0)

        finished = self.client.post("/vram/report", headers=self.auth, json={"action": "wait", "waitSeconds": 5})
        self.assertEqual(finished.status_code, 200)
        body = finished.json()
        self.assertTrue(body["finished"])
        self.assertGreaterEqual(body["load"]["sampleCount"], 1)
        self.assertEqual(body["load"]["peakMb"], 9000.0)
        self.assertEqual(body["load"]["avgMb"], 9000.0)
        self.assertTrue(body["verdict"]["measured"])

    def test_post_snapshot_mit_label(self):
        response = self.client.post("/vram/report", headers=self.auth, json={"label": "manual-check"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("manual-check", response.json()["phases"])

    def test_post_unbekannte_aktion_und_kaputtes_json(self):
        self.assertEqual(
            self.client.post("/vram/report", headers=self.auth, json={"action": "explode"}).status_code, 400
        )
        broken = self.client.post(
            "/vram/report", headers={**self.auth, "Content-Type": "application/json"}, content=b"{nicht json"
        )
        self.assertEqual(broken.status_code, 400)
        self.assertEqual(self.client.post("/vram/report", json={"action": "start"}).status_code, 401)

    def test_dauer_wird_begrenzt(self):
        # 99999 s dürfen nicht in einen stundenlangen Sampler münden.
        response = self.client.post(
            "/vram/report",
            headers=self.auth,
            json={"action": "start", "durationSeconds": 99999, "intervalSeconds": 99999},
        )
        self.assertIn(response.status_code, (202, 409))
        state = response.json()
        self.assertLessEqual(state.get("durationSeconds", 0), self.app_module.VRAM_MAX_DURATION_S)
        self.client.post("/vram/report", headers=self.auth, json={"action": "stop"})
        # Aufräumen: der nächste Test soll kein laufendes Fenster vorfinden.
        for _ in range(100):
            if not self.client.get("/vram/report", headers=self.auth).json()["load"]["running"]:
                break
            time.sleep(0.05)


if __name__ == "__main__":
    unittest.main(verbosity=2)

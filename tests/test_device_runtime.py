"""Regressionstests fuer die Geraete-Wahl der AI-Runtime (ohne GPU lauffaehig).

Anlass: DA-2026-09-29-048 (Deep-Audit). Sechs Befunde an
`services/backend-core/python/device_utils.py`:

  F65  lokal generierte ID ohne Format-/Kollisionsgarantie (Helfer war ungenutzt)
  F76  unsynchronisierter Lesezugriff auf `_device`
  F77  ungueltiger AI_DEVICE-Wert wurde ohne Warnung ignoriert
  F80  Geraete-Indizes (cuda:0, cuda:1) in AI_DEVICE wurden still ignoriert

Der Test faehrt BEIDE Wege: die reine Normalisierung (`normalize_env_device`,
ohne torch) und `resolve_device` mit einem gestubbten torch, damit das Ergebnis
unabhaengig davon ist, ob auf dem Rechner eine GPU liegt.

Lauf: python3 tests/test_device_runtime.py
"""
from __future__ import annotations

import importlib
import logging
import os
import pathlib
import sys
import threading
import types
import unittest
from contextlib import contextmanager

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULE_DIR = ROOT / "services" / "backend-core" / "python"
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

import device_utils  # noqa: E402


def _fake_torch(cuda: bool = False, mps: bool = False) -> types.ModuleType:
    """Minimaler torch-Ersatz: nur die Attribute, die device_utils abfragt."""
    module = types.ModuleType("torch")
    module.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    module.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps)
    )
    return module


@contextmanager
def _runtime(ai_device: str | None, cuda: bool = False, mps: bool = False):
    """Setzt AI_DEVICE, stubbte torch und leert den Cache - danach zurueck."""
    previous_env = os.environ.get("AI_DEVICE")
    previous_torch = sys.modules.get("torch")
    device_utils._device = None
    sys.modules["torch"] = _fake_torch(cuda=cuda, mps=mps)
    if ai_device is None:
        os.environ.pop("AI_DEVICE", None)
    else:
        os.environ["AI_DEVICE"] = ai_device
    try:
        yield
    finally:
        device_utils._device = None
        if previous_env is None:
            os.environ.pop("AI_DEVICE", None)
        else:
            os.environ["AI_DEVICE"] = previous_env
        if previous_torch is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = previous_torch


class NormalizeTest(unittest.TestCase):
    """Reine Normalisierung - kein torch, keine Umgebung."""

    def test_gueltige_werte_bleiben_und_warnen_nicht(self) -> None:
        for value in ("cpu", " cuda ", "MPS"):
            with self.subTest(value=value):
                self.assertEqual(device_utils.normalize_env_device(value), (value.strip().lower(), None))

    def test_leerer_wert_ist_auto_detect_ohne_warnung(self) -> None:
        self.assertEqual(device_utils.normalize_env_device(""), ("", None))
        self.assertEqual(device_utils.normalize_env_device("   "), ("", None))

    def test_geraete_index_wird_entfernt_und_gemeldet(self) -> None:
        # F80: cuda:0 / cuda:1 sind keine gueltigen Werte fuer die Runtime; sie
        # werden auf das Basis-Geraet reduziert - aber NICHT still.
        for raw, base in (("cuda:0", "cuda"), ("cuda:1", "cuda"), ("mps:0", "mps")):
            with self.subTest(raw=raw):
                value, warning = device_utils.normalize_env_device(raw)
                self.assertEqual(value, base)
                self.assertIsNotNone(warning)
                self.assertIn(raw, warning or "")
                self.assertIn("Index", warning or "")

    def test_ungueltiger_wert_faellt_auf_auto_detect_und_meldet(self) -> None:
        # F77: frueher wurde der Wert ungeprueft uebernommen, jetzt Auto-Detect.
        value, warning = device_utils.normalize_env_device("tpu")
        self.assertEqual(value, "")
        self.assertIn("ungültig", warning or "")
        self.assertIn("cuda, mps, cpu", warning or "")


class ResolveDeviceTest(unittest.TestCase):
    def test_auto_detect_ohne_gpu_ergibt_cpu(self) -> None:
        with _runtime(None):
            self.assertEqual(device_utils.resolve_device(), "cpu")

    def test_auto_detect_mit_gpu_ergibt_cuda(self) -> None:
        with _runtime(None, cuda=True):
            self.assertEqual(device_utils.resolve_device(), "cuda")

    def test_ungueltiger_wert_wird_gemeldet_und_faellt_auf_cpu(self) -> None:
        with _runtime("banana"):
            with self.assertLogs("audiomonastry.device", level=logging.WARNING) as captured:
                self.assertEqual(device_utils.resolve_device(), "cpu")
        joined = "\n".join(captured.output)
        self.assertIn("ungültig", joined)
        self.assertIn("banana", joined)

    def test_index_wird_gemeldet_und_cuda_ohne_gpu_faellt_auf_cpu(self) -> None:
        with _runtime("cuda:1"):
            with self.assertLogs("audiomonastry.device", level=logging.WARNING) as captured:
                self.assertEqual(device_utils.resolve_device(), "cpu")
        joined = "\n".join(captured.output)
        self.assertIn("cuda:1", joined)
        self.assertIn("Index", joined)

    def test_cuda_angefordert_ohne_geraet_meldet_und_bleibt_cpu(self) -> None:
        with _runtime("cuda"):
            with self.assertLogs("audiomonastry.device", level=logging.WARNING) as captured:
                self.assertEqual(device_utils.resolve_device(), "cpu")
        self.assertIn("CUDA nicht verfügbar", "\n".join(captured.output))

    def test_ergebnis_wird_gecacht(self) -> None:
        # Dokumentiertes Verhalten: EINE Entscheidung pro Prozess. Wer die ENV
        # spaeter aendert, bekommt weiter das erste Ergebnis (kein Flackern der
        # Modell-Geraete mitten im Betrieb).
        with _runtime("cpu"):
            first = device_utils.resolve_device()
            os.environ["AI_DEVICE"] = "cuda"
            self.assertEqual(device_utils.resolve_device(), first)

    def test_paralleler_erstzugriff_ist_threadsicher(self) -> None:
        # F76: `_device` wird nur unter dem Lock gelesen/geschrieben. 16 Threads
        # starten gleichzeitig; alle muessen dasselbe Ergebnis sehen.
        with _runtime("cpu"):
            barrier = threading.Barrier(16)
            results: list[str] = []
            lock = threading.Lock()

            def worker() -> None:
                barrier.wait()
                value = device_utils.resolve_device()
                with lock:
                    results.append(value)

            threads = [threading.Thread(target=worker) for _ in range(16)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
            self.assertEqual(len(results), 16)
            self.assertEqual(set(results), {"cpu"})

    def test_half_precision_ist_auf_cpu_falsch(self) -> None:
        # F82: die Funktion meldet nur - auf cpu nie fp16.
        with _runtime("cpu"):
            self.assertFalse(device_utils.half_precision_compatible())


class KeinToterCodeTest(unittest.TestCase):
    """F65/F76: die entfernten Reste duerfen nicht zurueckwandern."""

    def test_es_gibt_keinen_zweiten_id_generator(self) -> None:
        # Task-IDs vergibt Celery (task.id); ein lokaler Helfer ohne Aufrufer
        # waere wieder toter Code. Das Modul exportiert ihn nicht mehr.
        self.assertFalse(hasattr(device_utils, "generate_id"))
        self.assertFalse(hasattr(device_utils, "_id_counter"))

    def test_modul_importiert_kein_uuid_oder_time_mehr(self) -> None:
        source = (MODULE_DIR / "device_utils.py").read_text(encoding="utf-8")
        self.assertNotIn("import uuid", source)
        self.assertNotIn("import time", source)

    def test_nur_eine_auswertung_von_ai_device(self) -> None:
        # Vorher stand die Auswertung zweimal in der Datei (die zweite Fassung
        # war nach dem `return` unerreichbar, samt zweitem Lock-Block).
        source = (MODULE_DIR / "device_utils.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("def resolve_device"), 1)
        self.assertEqual(source.count("with _device_lock:"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

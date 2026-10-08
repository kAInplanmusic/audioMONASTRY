"""Resident-Modus: nichts wird je verdraengt (Betreiber 2026-10-07).

    python3 services/audiomonastry-ai-runtime/tests/test_resident_only.py
"""
from __future__ import annotations

import pathlib
import sys
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from model_manager import ModelManager, ModelUnavailableError  # noqa: E402

REV = "31c69efc29464b6bb0aee1398b5a7b50a99340c3"


def model(mid: str, vram: float, **extra: object) -> dict:
    d = {"id": mid, "repository": "Qwen/Qwen3-14B", "revision": REV, "task": "llm",
         "estimatedVRAM": vram, "loadClass": "FREQUENT"}
    d.update(extra)
    return d


def manager(resident: bool, models: list) -> ModelManager:
    m = ModelManager()
    m.configure({"runtime": {"vramBudgetGb": 20, "vramSafetyMarginGb": 6, "device": "simulated",
                             "residentOnly": resident}, "models": models})
    return m


class TestResidentOnly(unittest.TestCase):
    def test_ohne_resident_wird_lru_verdraengt(self) -> None:
        m = manager(False, [model("a", 8), model("b", 8)])
        m.load("a")
        m.load("b")  # 14 frei -> a wird verdraengt
        self.assertEqual(sorted(m._loaded), ["b"])

    def test_resident_verdraengt_nie_und_wirft(self) -> None:
        m = manager(True, [model("a", 8), model("b", 8)])
        m.load("a")
        with self.assertRaises(ModelUnavailableError) as ctx:
            m.load("b")
        self.assertIn("resident-only", str(ctx.exception))
        self.assertEqual(sorted(m._loaded), ["a"])

    def test_resident_tauscht_keine_exklusive_gruppe(self) -> None:
        m = manager(True, [model("x", 4, exclusiveGroup="g"), model("y", 4, exclusiveGroup="g")])
        m.load("x")
        with self.assertRaises(ModelUnavailableError):
            m.load("y")
        self.assertEqual(sorted(m._loaded), ["x"])


if __name__ == "__main__":
    unittest.main()

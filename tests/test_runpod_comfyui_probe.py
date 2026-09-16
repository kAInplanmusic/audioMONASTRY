"""Regressionstest: Kontrakt-Probe fuer die ComfyUI-Worker (RUNPOD-P1-001).

Prueft die reine Logik von `scripts/runpod-comfyui-probe.py` (stdlib, ohne
Netz/GPU):

1. `summarize_response` nennt Felder, Typen und GROESSEN. Das ist der Punkt, an
   dem die Kontrakt-Dokumentation bisher scheiterte: die Probe druckte nur die
   ersten 4000 Zeichen der Rohantwort, und ein base64-Bild/-Video ist laenger –
   die Nutzlast war damit abgeschnitten und nicht aufhebbar. `--out` schreibt
   sie vollstaendig.
2. `build_payload` haelt die dokumentierten Nutzlasten ein: Prompt-Rollen
   senden `{prompt}`, Workflow-Rollen `{workflow: {}}` (der Fehler IST die
   Information), `--health-check` sendet `{health_check: true}`.

Lauf: python3 tests/test_runpod_comfyui_probe.py
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace
from typing import Any

PROBE_PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "runpod-comfyui-probe.py"


def load_probe() -> Any:
    """Modul laden – der Dateiname enthaelt Bindestriche, daher per Pfad."""
    spec = importlib.util.spec_from_file_location("runpod_comfyui_probe", PROBE_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - Umgebungsfehler
        raise ImportError(f"Probe nicht ladbar: {PROBE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


probe = load_probe()


class SummarizeResponseTest(unittest.TestCase):
    def test_kleine_felder_werden_ausgeschrieben(self) -> None:
        summary = probe.summarize_response({"status": "ok", "count": 3})
        self.assertIn('status="ok"', summary)
        self.assertIn("count=3", summary)

    def test_grosse_nutzlast_wird_nur_als_groesse_genannt(self) -> None:
        blob = "data:image/png;base64," + "A" * 50_000
        summary = probe.summarize_response({"image_url": blob, "prompt_id": "abc"})
        # Kein Blob im Klartext, aber Laenge und Praefix sind sichtbar.
        self.assertIn("image_url=<str 50022 Zeichen", summary)
        self.assertIn("data:image/png;base64,", summary)
        self.assertIn("prompt_id=\"abc\"", summary)
        self.assertLess(len(summary), 400)

    def test_rohes_base64_ohne_praefix_wird_erkannt(self) -> None:
        # videoReal liefert rohes base64 (gemessen 2026-09-16).
        summary = probe.summarize_response({"video": "A" * 5000})
        self.assertIn("video=<str 5000 Zeichen", summary)

    def test_nicht_dict_bleibt_lesbar(self) -> None:
        self.assertIn("list", probe.summarize_response([1, 2, 3]))
        self.assertIn("str", probe.summarize_response("nur ein string"))


class BuildPayloadTest(unittest.TestCase):
    def _args(self, **overrides: Any) -> SimpleNamespace:
        base = {"payload": "", "health_check": False, "role": "imageHq", "prompt": "", "negative_prompt": ""}
        base.update(overrides)
        return SimpleNamespace(**base)

    def test_prompt_rolle_sendet_prompt(self) -> None:
        payload = probe.build_payload(self._args(role="imageHq", prompt="a red cube"))
        self.assertEqual(payload, {"prompt": "a red cube"})

    def test_prompt_rolle_hat_einen_default(self) -> None:
        self.assertIn("prompt", probe.build_payload(self._args(role="videoReal")))

    def test_negative_prompt_wird_mitgegeben(self) -> None:
        payload = probe.build_payload(self._args(role="imageHq", negative_prompt="blurry"))
        self.assertEqual(payload["negative_prompt"], "blurry")

    def test_workflow_rollen_senden_leeren_workflow(self) -> None:
        for role in ("music", "videoAbstract"):
            with self.subTest(role=role):
                self.assertEqual(probe.build_payload(self._args(role=role)), {"workflow": {}})

    def test_health_check_hat_vorrang_vor_prompt(self) -> None:
        payload = probe.build_payload(self._args(role="music", health_check=True, prompt="egal"))
        self.assertEqual(payload, {"health_check": True})

    def test_explizite_payload_hat_vorrang(self) -> None:
        payload = probe.build_payload(self._args(role="music", payload='{"workflow": {"3": {}}}'))
        self.assertEqual(payload, {"workflow": {"3": {}}})


if __name__ == "__main__":
    unittest.main()

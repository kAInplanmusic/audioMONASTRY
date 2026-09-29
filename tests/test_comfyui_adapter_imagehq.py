"""Regressionstest: imageHq-Vertrag im ComfyUI-Adapter (AUDIT-RESTTODOS C2).

Der Endpoint der Rolle `imageHq` laeuft seit 2026-09-27 (b90f7a8, "Weg A") auf
`runpod/worker-comfyui` statt auf dem PrunaAI-FLUX-Image. Dieser Test pinnt den
Adapter-Vertrag daran:

1. `COMFY_ROLES["imageHq"]` ist `worker: comfyui` / `protocol: workflow` – der
   Aufrufer sendet `{workflow: <ComfyUI-API-JSON>}` (wie `runpodVision.ts` es
   baut), NIEMALS einen prompt-Body: ein `prompt`-Feld wuerde der Worker
   ignorieren und still das Demo-Bild des Graphen liefern.
2. Der Alt-Eintrag (PrunaAI FLUX, `flux1-dev-juiced`) bleibt als Kommentar
   ueber dem neuen Eintrag erhalten (Historie wird nie umgeschrieben).
3. Worker-Antwort `{images: [{filename, type: "base64", data: <rohes b64>}]}`
   normalisiert zu `kind: "image"` mit `data:`-Praefix – derselbe Vertrag wie
   bei `imageLora` (rohes base64 ohne Praefix fiel frueher durch, b90f7a8).

Ohne Netz/GPU; der Adapter wird per Pfad geladen (Dateiname mit Bindestrichen
ist hier nicht das Problem, aber konsistent zu den Geschwister-Tests).

Lauf: python3 tests/test_comfyui_adapter_imagehq.py
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
ADAPTER = ROOT / "services" / "audiomonastry-ai-runtime" / "comfyui_adapter.py"


def load_adapter() -> Any:
    spec = importlib.util.spec_from_file_location("comfyui_adapter", ADAPTER)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Adapter nicht ladbar: {ADAPTER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


adapter = load_adapter()
EMPTY_ENV: dict[str, str] = {}  # hermetisch: Host-COMFY_WORKFLOW_* spielen nicht rein


class ImageHqRollenEintragTest(unittest.TestCase):
    def test_rolle_laeuft_auf_worker_comfyui_mit_workflow_protokoll(self) -> None:
        spec = adapter.COMFY_ROLES.get("imageHq")
        self.assertIsNotNone(spec, "imageHq fehlt in COMFY_ROLES")
        self.assertEqual(spec["worker"], "comfyui")
        self.assertEqual(spec["protocol"], "workflow")
        self.assertNotEqual(
            spec.get("defaultModel"),
            "flux1-dev-juiced",
            "Alt-Modell des PrunaAI-FLUX-Workers darf nicht mehr aktiv referenziert werden",
        )

    def test_alt_entry_bliebt_als_kommentar_erhalten(self) -> None:
        lines = ADAPTER.read_text(encoding="utf-8").splitlines()
        historisch = [
            line for line in lines
            if line.strip().startswith("#") and "Historisch bis 2026-09-27" in line
        ]
        self.assertTrue(historisch, "Alt-Eintrag muss als 'Historisch bis 2026-09-27'-Kommentar erhalten bleiben")
        kommentar_block = "\n".join(
            line for line in lines if line.strip().startswith("#")
        )
        self.assertIn("b90f7a8", kommentar_block, "Commit-Beleg fehlt im Historien-Kommentar")
        self.assertIn("flux1-dev-juiced", kommentar_block, "Alt-Modellname fehlt im Historien-Kommentar")
        # Aktiv (nicht-Kommentar) darf der Alt-Worker nirgends mehr stehen:
        aktiv = "\n".join(line for line in lines if not line.strip().startswith("#"))
        self.assertNotIn("flux1-dev-juiced", aktiv)
        self.assertNotIn('"worker": "flux"', aktiv)

    def test_ohne_deklarierten_workflow_klar_abbruch_statt_prompt_body(self) -> None:
        # Ohne Inline-Workflow und ohne workflows/imageHq.json muss der Adapter
        # KLAR melden, was fehlt - statt einen prompt-Body zu bauen.
        if (ADAPTER.parent / "workflows" / "imageHq.json").is_file():
            self.skipTest("workflows/imageHq.json existiert inzwischen - Workflow-Pfad waere aktiv")
        with self.assertRaises(ValueError):
            adapter.build_request(
                "image.generate", "imageHq", "flux1-dev",
                {"prompt": "ein roter Wuerfel"}, None, EMPTY_ENV,
            )


class ImageHqRequestVertragTest(unittest.TestCase):
    def test_request_ist_workflow_body_ohne_prompt(self) -> None:
        graph = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {}}}
        request = adapter.build_request(
            "image.generate", "imageHq", "flux1-dev",
            {"prompt": "ein roter Wuerfel", "workflow": graph}, None, EMPTY_ENV,
        )
        self.assertIn("workflow", request, "imageHq muss {workflow: ...} senden (worker-comfyui-Vertrag)")
        self.assertEqual(request["workflow"], graph)
        self.assertNotIn("prompt", request, "ein prompt-Feld wuerde der Worker still ignorieren")


class ImageHqAntwortVertragTest(unittest.TestCase):
    def test_rohes_base64_wird_zu_data_uri_normalisiert(self) -> None:
        raw = {
            "images": [
                {"filename": "vision_00001_.png", "type": "base64", "data": "aU5WQk9Sdw=="},
            ],
        }
        normalized = adapter.normalize_output(raw)
        self.assertEqual(normalized["kind"], "image")
        self.assertEqual(normalized["count"], 1)
        item = normalized["items"][0]
        self.assertEqual(item["filename"], "vision_00001_.png")
        self.assertTrue(
            item["data"].startswith("data:image/png;base64,"),
            "rohes base64 braucht das data:-Praefix (sonst nicht von Text unterscheidbar)",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

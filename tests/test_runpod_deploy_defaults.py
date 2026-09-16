"""Regressionstest: Voreinstellungen des Deploy-Skripts (scripts/runpod-deploy.py).

Hintergrund: `videoAbstract` wurde aus genau diesem Skript heraus mit dem
**generischen** `COMFYUI`-Image angelegt - das bringt keine Gewichte mit und laedt
auch keine nach, also scheiterte jeder Job (live geprueft am 2026-09-16: der
Worker meldete leere Modell-Listen). Ein Skript, das die kaputte Konfiguration bei
jedem Redeploy wiederherstellt, ist gefaehrlicher als eine falsche Doku. Dieser
Test haelt die Voreinstellungen deshalb auf dem live verifizierten Stand.

Lauf: python3 tests/test_runpod_deploy_defaults.py
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import types
import unittest
from typing import Any
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "runpod-deploy.py"

#: Rollen, deren Idle-Timeout am 2026-09-16 auf 120 s gesetzt wurde, weil Worker
#: ueber den 900-s-Wert hinaus auf RUNNING blieben und weiter abgerechnet wurden.
GEMESSENE_ROLLEN = ("music", "imageHq", "videoReal", "videoAbstract", "orchestrator")


def load_deploy() -> Any:
    """Skript laden, ohne das RunPod-SDK zu installieren.

    Das Skript importiert `runpod` auf Modulebene; geprueft werden hier nur die
    Konstanten (ROLE_DEFAULTS, PREBUILT_IMAGES), also genuegt ein Platzhalter.
    So laeuft der Test ohne Netz, GPU und SDK.
    """
    sys.modules.setdefault("runpod", mock.MagicMock(spec=types.ModuleType("runpod")))
    spec = importlib.util.spec_from_file_location("runpod_deploy", SCRIPT)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


deploy = load_deploy()


class RoleDefaultsTest(unittest.TestCase):
    def test_video_abstract_nutzt_den_wan_worker_mit_gewichten(self) -> None:
        # Der eigentliche Regressionsschutz: nicht das gewichtslose Generik-Image.
        self.assertEqual(deploy.ROLE_DEFAULTS["videoAbstract"]["imageDefault"], "WAN22")
        self.assertEqual(deploy.ROLE_DEFAULTS["videoReal"]["imageDefault"], "WAN22")
        self.assertIn("generate-video-ksampler", deploy.PREBUILT_IMAGES["WAN22"])

    def test_imagehq_nutzt_das_live_image_und_nicht_den_generik_worker(self) -> None:
        self.assertEqual(deploy.ROLE_DEFAULTS["imageHq"]["imageDefault"], "FLUX_DEV")
        self.assertIn("prunaai-runpod-worker-flux-1-dev", deploy.PREBUILT_IMAGES["FLUX_DEV"])

    def test_keine_rolle_der_flotte_laeuft_auf_dem_gewichtslosen_worker(self) -> None:
        for role, defaults in deploy.ROLE_DEFAULTS.items():
            with self.subTest(role=role):
                if defaults.get("imageKind") == "prebuilt":
                    self.assertNotEqual(
                        defaults.get("imageDefault"),
                        "COMFYUI",
                        f"{role}: COMFYUI bringt keine Gewichte mit – es laedt auch keine nach",
                    )

    def test_idle_timeout_der_gemessenen_rollen_ist_120(self) -> None:
        for role in GEMESSENE_ROLLEN:
            with self.subTest(role=role):
                self.assertEqual(deploy.ROLE_DEFAULTS[role]["idleTimeout"], 120)

    def test_videorollen_laufen_auf_dem_ada_pool(self) -> None:
        # Die Wan-Images sind auf CUDA 12.8/Ada ausgelegt.
        self.assertEqual(deploy.ROLE_DEFAULTS["videoReal"]["gpuPoolId"], "ADA_24")
        self.assertEqual(deploy.ROLE_DEFAULTS["videoAbstract"]["gpuPoolId"], "ADA_24")

    def test_brain_und_ears_bleiben_kurz_und_auf_ampere(self) -> None:
        self.assertEqual(deploy.ROLE_DEFAULTS["brain"]["idleTimeout"], 15)
        self.assertEqual(deploy.ROLE_DEFAULTS["ears"]["idleTimeout"], 15)
        self.assertEqual(deploy.ROLE_DEFAULTS["brain"]["gpuPoolId"], "AMPERE_48")


if __name__ == "__main__":
    unittest.main()

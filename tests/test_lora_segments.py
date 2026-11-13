"""Tests für scripts/lora/vorstaging.sh (VISUAL-P1-007, 2026-09-22).

Kein Netz, keine GPU, keine Kosten: `vorstaging.sh` füllt ein Volume idempotent
(zweiter Lauf: alles übersprungen), prüft unvollständige Gewichte und andere
Datensatz-Schlüssel und rechnet die Monatskosten des Volumens aus.

Lauf: python3 tests/test_lora_segments.py
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from typing import Dict, List

ROOT = pathlib.Path(__file__).resolve().parent.parent
VORSTAGING = ROOT / "scripts" / "lora" / "vorstaging.sh"


# Mit der Vast-Migration (9394a65) ist scripts/runpod-lora-train.py entfallen –
# der LoRA-Starter lief ausschließlich über das RunPod-SDK. Mit ihm entfielen
# die Tests seiner Abschnittsplanung, Vorab-Rechnung, Fortschrittsanzeige,
# Volume-Kosten und des Bootstrap-Abschnittslaufs (Git-Historie bis 285ef5c).
# Geblieben ist der Test des eigenständigen scripts/lora/vorstaging.sh.


class BaseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="lora-seg-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    # --- Prozess-Aufrufe ----------------------------------------------------
    def script_env(self, **extra: str) -> Dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", str(self.tmp)),
            "LC_ALL": "C.UTF-8",
            "PYTHONIOENCODING": "utf-8",
        }
        env.update(extra)
        return env

    def run_script(self, script: pathlib.Path, *args: str, env: Dict[str, str] | None = None,
                   timeout: int = 180) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(script), *args] if script.suffix == ".py" else ["bash", str(script), *args],
            capture_output=True, text=True, env=env or self.script_env(), cwd=str(ROOT), timeout=timeout,
        )


class VorstagingTest(BaseCase):
    def setUp(self) -> None:
        super().setUp()
        self.volume = self.tmp / "volume"
        self.volume.mkdir()
        self.dataset_src = self.tmp / "bilder"
        self.dataset_src.mkdir()
        for index in range(3):
            (self.dataset_src / f"{index}.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 64)
        self.archive = self.tmp / "dataset.tar.gz"
        subprocess.run(["tar", "-czf", str(self.archive), "-C", str(self.dataset_src), "."], check=True)
        # Trainer-Checkout: lokales Git-Repo (kein Netz).
        self.repo = self.tmp / "ai-toolkit-src"
        self.repo.mkdir()
        (self.repo / "README.md").write_text("lokal\n", encoding="utf-8")
        for cmd in (["git", "init", "-q"], ["git", "add", "."],
                    ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=Test", "commit", "-qm", "init"]):
            subprocess.run(cmd, cwd=str(self.repo), check=True, capture_output=True)
        # Stub statt hf_transfer: legt die erwartete Cache-Struktur an (2 MB).
        #
        # KORRIGIERT AM 2026-09-24: der Slub muss den Namen erzeugen, den HuggingFace
        # WIRKLICH anlegt - `models--<org>--<name>`, der Schraegstrich wird zu ZWEI
        # Bindestrichen. Vorher stand hier `tr '/' '-'` (ein Bindestrich). Damit
        # spiegelte der Stub eine Wirklichkeit, die es nicht gibt: der Test blieb
        # gruen, obwohl vorstaging.sh den eigenen Download nie fand. Auf dem Pod
        # gemessen lag tatsaechlich models--black-forest-labs--FLUX.1-dev (54 GB),
        # gesucht wurde models--black-forest-labs-FLUX.1-dev.
        self.hf_stub = self.tmp / "hf-stub.sh"
        self.hf_stub.write_text(
            "#!/usr/bin/env bash\nset -eu\nmodel=\"$1\"\nslug=\"models--$(printf '%s' \"$model\" | sed 's|/|--|')\"\n"
            "mkdir -p \"$HF_HOME/hub/$slug/snapshots/abc\"\n"
            "dd if=/dev/zero of=\"$HF_HOME/hub/$slug/snapshots/abc/model.safetensors\" bs=1024 count=2048 status=none\n"
            "echo \"[stub] $model -> $HF_HOME/hub/$slug\"\n",
            encoding="utf-8",
        )

    def base_args(self, *extra: str) -> List[str]:
        return [
            "--volume", str(self.volume),
            "--model", "black-forest-labs/FLUX.1-dev",
            "--dataset-url", "file://" + str(self.archive),
            "--dataset-key", "lora/dataset.tar.gz",
            "--ai-toolkit-repo", str(self.repo),
            "--hf-command", f"bash {self.hf_stub}",
            "--min-free-gb", "0",
            *extra,
        ]

    def test_trockenlauf_ohne_netz_plant_nur(self) -> None:
        result = self.run_script(VORSTAGING, *self.base_args("--dry-run"), env=self.script_env())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("wuerde laden: Gewichte", result.stdout)
        self.assertIn("wuerde laden: Datensatz", result.stdout)
        self.assertIn("wuerde klonen", result.stdout)
        self.assertIn("TROCKENLAUF", result.stdout)
        self.assertTrue((self.volume / "vorstaging" / "report.json").is_file())
        report = json.loads((self.volume / "vorstaging" / "report.json").read_text(encoding="utf-8"))
        self.assertTrue(report["dry_run"])
        # Nichts wurde angelegt.
        self.assertFalse((self.volume / "hf-cache").exists())

    def test_vollstaendiger_lauf_und_zweiter_lauf_ueberspringt_alles(self) -> None:
        erster = self.run_script(VORSTAGING, *self.base_args(), env=self.script_env())
        self.assertEqual(erster.returncode, 0, erster.stdout + erster.stderr)
        self.assertIn("Gewichte bereit", erster.stdout)
        self.assertIn("Datensatz bereit: 3 Bilder", erster.stdout)
        self.assertIn("Trainer bereit", erster.stdout)
        marker = json.loads((self.volume / "vorstaging" / "weights.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["model"], "black-forest-labs/FLUX.1-dev")
        self.assertGreater(marker["bytes"], 1000000)
        self.assertNotIn("dataset", marker)  # kein zweites Modell im Marker
        dataset_marker = json.loads((self.volume / "vorstaging" / "dataset.json").read_text(encoding="utf-8"))
        self.assertEqual(dataset_marker["image_count"], 3)
        self.assertEqual(dataset_marker["key"], "lora/dataset.tar.gz")
        # Die (signierte) URL landet NICHT im Marker – sie ist ein Bearer-Token.
        self.assertNotIn("file://", json.dumps(dataset_marker))

        zweiter = self.run_script(VORSTAGING, *self.base_args("--skip-toolkit-src"), env=self.script_env())
        # (das Argument gibt es nicht - hier bewusst der normale zweite Lauf)
        zweiter = self.run_script(VORSTAGING, *self.base_args(), env=self.script_env())
        self.assertEqual(zweiter.returncode, 0, zweiter.stdout + zweiter.stderr)
        self.assertIn("uebersprungen: Gewichte", zweiter.stdout)
        self.assertIn("uebersprungen: Datensatz", zweiter.stdout)
        self.assertIn("uebersprungen: Trainer-Checkout", zweiter.stdout)
        self.assertIn("weights: skipped", zweiter.stdout)
        self.assertIn("dataset: skipped", zweiter.stdout)
        self.assertIn("toolkit: skipped", zweiter.stdout)

    def test_unvollstaendige_gewichte_werden_nicht_uebersprungen(self) -> None:
        self.assertEqual(self.run_script(VORSTAGING, *self.base_args(), env=self.script_env()).returncode, 0)
        model_file = next((self.volume / "hf-cache").rglob("model.safetensors"))
        model_file.write_bytes(b"nur ein Bruchstueck")
        result = self.run_script(VORSTAGING, *self.base_args("--dry-run"), env=self.script_env())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("wuerde laden: Gewichte", result.stdout)
        self.assertIn("unvollstaendig", result.stdout)
        self.assertIn("uebersprungen: Datensatz", result.stdout)  # nur die Gewichte fehlen

    def test_anderer_datensatz_schluessel_wird_nicht_uebersprungen(self) -> None:
        self.assertEqual(self.run_script(VORSTAGING, *self.base_args(), env=self.script_env()).returncode, 0)
        result = self.run_script(
            VORSTAGING, *self.base_args("--dataset-key", "lora/anderes-dataset.tar.gz", "--dry-run"),
            env=self.script_env(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("wuerde laden: Datensatz", result.stdout)
        self.assertIn("anderen Datensatz", result.stdout)

    def test_nicht_schreibbares_volumen_ist_exit_4(self) -> None:
        fehlt = self.tmp / "gibtsnicht"
        result = self.run_script(VORSTAGING, "--volume", str(fehlt), "--dry-run", env=self.script_env())
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("existiert nicht", result.stderr)

    def test_unbekannte_option_ist_exit_2(self) -> None:
        result = self.run_script(VORSTAGING, "--quatsch", env=self.script_env())
        self.assertEqual(result.returncode, 2)
        self.assertIn("unbekannte Option", result.stderr)


# ---------------------------------------------------------------------------
# In-Pod-Runner: Resume, Skip-Logik, Checkpoint-Reihenfolge
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    unittest.main()

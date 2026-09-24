"""Tests für die ai-toolkit-Segment-Anbindung (VISUAL-P1-007, 2026-09-22).

Kein Netz, keine GPU, kein Pod, keine Kosten. Geprüft wird genau die Kette, die
beim ersten bezahlten Lauf gefehlt hat:

  * `train.steps` wird auf den ABSOLUTEN Abschnitts-Zielschritt gepatcht (und
    `sample_steps` bleibt unberührt – die Regex darf nur `steps:` treffen),
  * der Resume-Checkpoint wird in `save_root` (`<training-folder>/<name>`) gelegt,
    weil ai-toolkit NUR dort sucht (`get_latest_save_path`), und ein Checkpoint
    mit falschem Metadaten-Schritt bricht VOR dem Training ab (Exit 4),
  * der neueste Checkpoint wird nach Schritt (nicht nach Dateizeit) eingesammelt
    und flach nach `LORA_CHECKPOINT_DIR` kopiert (dort sucht `bootstrap.sh`),
  * fehlende Angaben ergeben Exit 2, OHNE den Trainer zu starten.

Lauf: python3 tests/test_lora_trainer_aitoolkit.py
"""
from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "scripts" / "lora" / "aitk-segment.py"
TRAINER = REPO / "scripts" / "lora" / "trainer-aitoolkit.sh"

CONFIG_TEMPLATE = """---
job: extension
config:
  name: "cosmic-r16"
  process:
    - type: sd_trainer
      training_folder: "/workspace/lora/output"
      network:
        type: lora
        linear: 16
        linear_alpha: 16
      save:
        dtype: float16
        save_every: 250
      datasets:
        - folder_path: "/workspace/lora/images"
          caption_ext: txt
          resolution: [1024]
      train:
        batch_size: 1
        steps: 1500
        gradient_checkpointing: true
      model:
        name_or_path: "black-forest-labs/FLUX.1-dev"
        is_flux: true
      sample:
        sample_every: 250
        sample_steps: 20
"""


def write_safetensors(path: Path, step: int | None) -> None:
    """Baut einen minimalen safetensors-Container mit (oder ohne) ai-toolkit-
    Metadaten – dasselbe Format, das `save()` schreibt."""
    header: dict = {"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
    if step is not None:
        header["__metadata__"] = {
            "training_info": json.dumps({"step": step, "epoch": 1}),
            "format": "pt",
        }
    raw = json.dumps(header).encode("utf-8")
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(raw)))
        handle.write(raw)
        handle.write(b"\x00" * 4)


def run_helper(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HELPER), *args],
                          capture_output=True, text=True, timeout=120)


class PatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = self.root / "basis.yml"
        self.config.write_text(CONFIG_TEMPLATE, encoding="utf-8")
        self.out = self.root / "gepatcht.yml"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def patch(self, *extra: str) -> subprocess.CompletedProcess:
        return run_helper(
            "patch", "--config", str(self.config), "--out", str(self.out),
            "--name", "cosmic-r16", "--steps", "1000", "--save-every", "250",
            "--images-dir", str(self.root / "images"),
            "--training-folder", str(self.root / "out"), "--json", *extra,
        )

    def test_patch_setzt_absoluten_zielschritt_und_laesst_sample_steps_in_ruhe(self) -> None:
        (self.root / "images").mkdir()
        result = self.patch("--disable-sampling")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        text = self.out.read_text(encoding="utf-8")
        self.assertIn("        steps: 1000", text)
        self.assertIn("sample_steps: 20", text)          # NICHT gepatcht
        self.assertIn("save_every: 250", text)
        self.assertIn("disable_sampling: true", text)
        self.assertIn(str(self.root / "images"), text)   # folder_path
        self.assertEqual(report["steps_absolute"], 1000)
        # save_root ist <training-folder>/<name> – genau da sucht ai-toolkit
        self.assertEqual(Path(report["save_root"]), (self.root / "out" / "cosmic-r16").resolve())
        keys = [entry["key"] for entry in report["patched"]]
        self.assertIn("train.steps", keys)
        self.assertIn("datasets[0].folder_path", keys)

    def test_patch_ohne_eindeutigen_schluessel_bricht_ab(self) -> None:
        (self.root / "images").mkdir()
        doppelt = self.config.read_text(encoding="utf-8") + "\n        steps: 42\n"
        self.config.write_text(doppelt, encoding="utf-8")
        result = self.patch()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("2 Treffer", result.stderr)
        self.assertFalse(self.out.exists())  # nichts halb geschrieben

    def test_patch_bricht_ab_wenn_ein_schluessel_fehlt(self) -> None:
        (self.root / "images").mkdir()
        self.config.write_text(CONFIG_TEMPLATE.replace("        steps: 1500\n", ""), encoding="utf-8")
        result = self.patch()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("0 Treffer", result.stderr)


class CheckpointMetaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_schritt_aus_metadaten(self) -> None:
        path = self.root / "cosmic-r16_000001000.safetensors"
        write_safetensors(path, 1000)
        result = run_helper("step", "--file", str(path), "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["step"], 1000)

    def test_ohne_metadaten_ist_exit_3(self) -> None:
        path = self.root / "ohne-meta.safetensors"
        write_safetensors(path, None)
        result = run_helper("step", "--file", str(path))
        self.assertEqual(result.returncode, 3)
        self.assertIn("kein training_info.step", result.stderr)

    def test_kaputte_datei_ist_exit_3_statt_ausnahme(self) -> None:
        path = self.root / "kaputt.safetensors"
        path.write_bytes(b"zu-kurz")
        result = run_helper("step", "--file", str(path))
        self.assertEqual(result.returncode, 3)
        # kein Stack-Trace, sondern eine lesbare Meldung (Repo-Regel: AI-P1-005)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("Datei nicht lesbar", result.stderr)


class PlaceResumeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.folder = self.root / "out"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_passender_schritt_wird_in_save_root_gelegt(self) -> None:
        ckpt = self.root / "irgendwie-benannt.safetensors"
        write_safetensors(ckpt, 1000)
        result = run_helper("place-resume", "--file", str(ckpt), "--training-folder", str(self.folder),
                            "--name", "cosmic-r16", "--expect-start", "1000", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        placed = Path(json.loads(result.stdout)["placed"])
        self.assertEqual(placed, self.folder / "cosmic-r16" / "cosmic-r16_000001000.safetensors")
        self.assertTrue(placed.exists())

    def test_falscher_schritt_ist_exit_4_und_kopiert_nichts(self) -> None:
        ckpt = self.root / "alt.safetensors"
        write_safetensors(ckpt, 250)
        result = run_helper("place-resume", "--file", str(ckpt), "--training-folder", str(self.folder),
                            "--name", "cosmic-r16", "--expect-start", "1000")
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        self.assertIn("Doppelarbeit", result.stderr)
        self.assertFalse((self.folder / "cosmic-r16").exists())

    def test_checkpoint_ohne_metadaten_ist_exit_3(self) -> None:
        ckpt = self.root / "ohne-meta.safetensors"
        write_safetensors(ckpt, None)
        result = run_helper("place-resume", "--file", str(ckpt), "--training-folder", str(self.folder),
                            "--name", "cosmic-r16", "--expect-start", "1000")
        self.assertEqual(result.returncode, 3)


class CollectTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.folder = self.root / "out"
        self.root_dir = self.folder / "cosmic-r16"
        self.root_dir.mkdir(parents=True)
        self.into = self.root / "ckpt"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_neuester_schritt_gewinnt_nicht_die_dateizeit(self) -> None:
        alt = self.root_dir / "cosmic-r16_000000250.safetensors"
        neu = self.root_dir / "cosmic-r16_000001000.safetensors"
        write_safetensors(alt, 250)
        write_safetensors(neu, 1000)
        # Die Datei mit dem HOHEN Schritt ist AELTER (z. B. weil sie kopiert
        # wurde) - eingesammelt werden muss trotzdem sie.
        os.utime(neu, (1_000_000, 1_000_000))
        os.utime(alt, None)
        result = run_helper("collect", "--training-folder", str(self.folder), "--name", "cosmic-r16",
                            "--into", str(self.into), "--min-step", "0", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["step"], 1000)
        self.assertTrue((self.into / "cosmic-r16_000001000.safetensors").exists())
        self.assertFalse((self.into / "cosmic-r16_000000250.safetensors").exists())

    def test_min_step_filtert_den_alten_checkpoint_weg(self) -> None:
        write_safetensors(self.root_dir / "cosmic-r16_000000250.safetensors", 250)
        result = run_helper("collect", "--training-folder", str(self.folder), "--name", "cosmic-r16",
                            "--into", str(self.into), "--min-step", "500")
        self.assertEqual(result.returncode, 3)
        self.assertIn("kein Checkpoint", result.stderr)


class TrainerSkriptTest(unittest.TestCase):
    """Ende-zu-Ende gegen einen STUB-Trainer: der echte Trainer wird nicht
    gebraucht, um zu belegen, dass die Abschnittsangaben wirklich ankommen."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.aidir = self.root / "ai-toolkit"
        self.aidir.mkdir()
        (self.aidir / "run.py").write_text(
            "import json, os, sys\n"
            "open(os.environ['STUB_LOG'], 'w', encoding='utf-8').write(\n"
            "    json.dumps({'cwd': os.getcwd(), 'argv': sys.argv[1:]}, ensure_ascii=False))\n",
            encoding="utf-8",
        )
        self.config = self.root / "cosmic-r16.yml"
        self.config.write_text(CONFIG_TEMPLATE, encoding="utf-8")
        self.images = self.root / "images"
        self.images.mkdir()
        (self.images / "0001_cosmic-0.png").write_bytes(b"png")
        self.out = self.root / "lora-out"
        self.ckpt_dir = self.root / "ckpt"
        self.stub_log = self.root / "stub.json"
        self.checkpoint = self.root / "segment1_upload.safetensors"
        write_safetensors(self.checkpoint, 1000)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_trainer(self, env_overrides: dict) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env.update({
            "STUB_LOG": str(self.stub_log),
            "LORA_SEGMENT_INDEX": "2",
            "LORA_SEGMENT_START": "1000",
            "LORA_SEGMENT_END": "2000",
            "LORA_MAX_STEPS": "2000",
            "LORA_SAVE_EVERY_STEPS": "250",
            "LORA_RESUME_FROM": str(self.checkpoint),
            "LORA_CHECKPOINT_DIR": str(self.ckpt_dir),
            "LORA_OUTPUT_DIR": str(self.out),
            "LORA_DATASET_DIR": str(self.images),
        })
        env.update(env_overrides)
        return subprocess.run(
            ["bash", str(TRAINER), "--aidir", str(self.aidir), "--config", str(self.config),
             "--name", "cosmic-r16"],
            capture_output=True, text=True, timeout=120, env=env,
        )

    def test_abschnitt2_setzt_resume_und_absolutes_ziel(self) -> None:
        result = self.run_trainer({})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # 1) Trainer lief IM ai-toolkit-Verzeichnis mit der gepatchten Konfiguration
        stub = json.loads(self.stub_log.read_text(encoding="utf-8"))
        self.assertEqual(stub["cwd"], str(self.aidir))
        self.assertEqual(stub["argv"], ["segment-config.yml"])
        # 2) absoluter Zielschritt = Abschnittsende (nicht 1000 Schritte Länge)
        patched = (self.out / "segment-config.yml").read_text(encoding="utf-8")
        self.assertIn("steps: 2000", patched)
        self.assertIn(str(self.images), patched)
        # 3) Resume-Checkpoint liegt dort, wo ai-toolkit sucht
        self.assertTrue((self.out / "cosmic-r16" / "cosmic-r16_000001000.safetensors").exists())
        # 4) Checkpoint flach eingesammelt (Vertrag von bootstrap.sh)
        self.assertTrue((self.ckpt_dir / "cosmic-r16_000001000.safetensors").exists())
        self.assertIn("Checkpoint liegt jetzt in", result.stdout)

    def test_ohne_zielschritt_startet_nichts(self) -> None:
        result = self.run_trainer({"LORA_SEGMENT_END": "", "LORA_MAX_STEPS": ""})
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("Zielschritt", result.stderr)
        self.assertFalse(self.stub_log.exists())          # Trainer nie gestartet
        self.assertFalse((self.out / "segment-config.yml").exists())

    def test_falscher_resume_schritt_bricht_vor_dem_training_ab(self) -> None:
        write_safetensors(self.checkpoint, 250)
        result = self.run_trainer({})
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("Doppelarbeit", result.stderr)
        self.assertFalse(self.stub_log.exists())          # kein GPU-Geld ausgegeben

    def test_trockenlauf_startet_den_trainer_nicht(self) -> None:
        env = dict(os.environ)
        env.update({
            "STUB_LOG": str(self.stub_log),
            "LORA_SEGMENT_START": "0", "LORA_SEGMENT_END": "1000",
            "LORA_CHECKPOINT_DIR": str(self.ckpt_dir),
            "LORA_OUTPUT_DIR": str(self.out), "LORA_DATASET_DIR": str(self.images),
        })
        result = subprocess.run(
            ["bash", str(TRAINER), "--aidir", str(self.aidir), "--config", str(self.config),
             "--name", "cosmic-r16", "--print"],
            capture_output=True, text=True, timeout=120, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("TROCKENLAUF", result.stdout)
        self.assertIn("steps: 1000", result.stdout)
        self.assertFalse(self.stub_log.exists())

    def test_falscher_trainer_pfad_ist_exit_2(self) -> None:
        env = dict(os.environ, LORA_SEGMENT_START="0", LORA_SEGMENT_END="1000",
                   LORA_OUTPUT_DIR=str(self.out), LORA_DATASET_DIR=str(self.images))
        result = subprocess.run(
            ["bash", str(TRAINER), "--aidir", str(self.root / "gibts-nicht"), "--config", str(self.config),
             "--name", "cosmic-r16"],
            capture_output=True, text=True, timeout=120, env=env,
        )
        self.assertEqual(result.returncode, 2)
        # genau der Fehler des ersten Laufs: geratenes '/app'
        self.assertIn("verbrannte 90 min", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

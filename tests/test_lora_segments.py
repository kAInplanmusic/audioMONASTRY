"""Independent local progress, volume staging and bootstrap regression tests.

Cases exclusively exercising the deleted provider training starter are retired.
All local file/loopback/stub contracts below remain independent of that starter.
"""
from __future__ import annotations

import contextlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from typing import Any, Dict, List

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "scripts" / "lora" / "bootstrap.sh"
VORSTAGING = ROOT / "scripts" / "lora" / "vorstaging.sh"
PROGRESS_CLI = ROOT / "scripts" / "lora" / "lora-progress.py"

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

class FortschrittsmarkerTest(unittest.TestCase):
    def test_progress_cli_haengt_an_und_laedt_per_file_url(self) -> None:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="lora-prog-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        local = tmp / "progress.jsonl"
        ziel = tmp / "r2" / "progress.jsonl"
        result = subprocess.run(
            [sys.executable, str(PROGRESS_CLI), "--step", "250", "--loss", "0.05", "--total-steps", "1000",
             "--state", "RUNNING", "--file", str(local), "--url", "file://" + str(ziel)],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = json.loads(local.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual((marker["step"], marker["state"]), (250, "RUNNING"))
        self.assertIn("ts", marker)
        # Der Upload ist angekommen (Datei-HTTP-Stub via file://).
        self.assertEqual(json.loads(ziel.read_text(encoding="utf-8").splitlines()[-1])["step"], 250)

    def test_progress_cli_meldet_fehlgeschlagenen_upload(self) -> None:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="lora-prog-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        local = tmp / "progress.jsonl"
        result = subprocess.run(
            [sys.executable, str(PROGRESS_CLI), "--step", "1", "--file", str(local),
             "--url", "http://127.0.0.1:9/gibtsnicht"],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("Upload fehlgeschlagen", result.stderr)
        # Die lokale Markerzeile existiert trotzdem (kein Datenverlust).
        self.assertEqual(json.loads(local.read_text(encoding="utf-8").splitlines()[-1])["step"], 1)


# ---------------------------------------------------------------------------
# Vorstaging auf dem Network Volume (idempotent, ohne Netz)
# ---------------------------------------------------------------------------
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
class PutRecorder(http.server.BaseHTTPRequestHandler):
    """Minimaler HTTP-Server als R2-Ersatz (nur loopback, kein externes Netz)."""

    records: List[Dict[str, Any]] = []

    def do_PUT(self) -> None:  # noqa: N802 (http.server-Vertrag)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        PutRecorder.records.append({"path": self.path, "body": body.decode("utf-8", "replace")})
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        payload = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: Any, **kwargs: Any) -> None:  # kein Test-Rauschen
        return


class BootstrapAbschnittTest(BaseCase):
    def setUp(self) -> None:
        super().setUp()
        PutRecorder.records = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PutRecorder)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.shutdown)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def bootstrap_env(self, work: pathlib.Path) -> Dict[str, str]:
        return self.script_env(LORA_WORK=str(work))

    def trainer_stub(self, work: pathlib.Path) -> pathlib.Path:
        """Stub-Trainer: prueft den Resume, schreibt Checkpoint + LoRA + Marker."""
        stub = work / "trainer.sh"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            "set -u\n"
            f'echo "resume=${{LORA_RESUME_FROM:-<leer>}} max_steps=${{LORA_MAX_STEPS:-}} every=${{LORA_SAVE_EVERY_STEPS:-}} '
            f'seg=${{LORA_SEGMENT_INDEX:-}} start=${{LORA_SEGMENT_START:-}} end=${{LORA_SEGMENT_END:-}}" >> "{work}/trainer.log"\n'
            'if [ -n "${LORA_SEGMENT_START:-}" ] && [ "${LORA_SEGMENT_START}" != "0" ] && [ -z "${LORA_RESUME_FROM:-}" ]; then\n'
            '  echo "kein Resume uebergeben" >&2; exit 9\n'
            "fi\n"
            'mkdir -p "$LORA_CHECKPOINT_DIR" "$LORA_OUTPUT_DIR"\n'
            'dd if=/dev/zero of="$LORA_CHECKPOINT_DIR/ckpt-${LORA_MAX_STEPS:-end}.safetensors" bs=1024 count=4 status=none\n'
            'dd if=/dev/zero of="$LORA_OUTPUT_DIR/monkstyle.safetensors" bs=1024 count=4 status=none\n'
            'if [ -n "${LORA_PROGRESS_FILE:-}" ]; then\n'
            '  printf \'{"schema":"visual-lora-progress/1","ts":"%s","step":%s,"state":"RUNNING","loss":0.05}\\n\' '
            '"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LORA_MAX_STEPS:-0}" >> "$LORA_PROGRESS_FILE"\n'
            "fi\n"
            'echo TRAIN_DONE\n',
            encoding="utf-8",
        )
        return stub

    def spec(self, work: pathlib.Path, **overrides: Any) -> Dict[str, Any]:
        dataset = work / "dataset-in"
        dataset.mkdir(parents=True, exist_ok=True)
        (dataset / "a.png").write_bytes(b"\x89PNG-fake")
        spec: Dict[str, Any] = {
            "dataset": {"url": "http://127.0.0.1:9/dataset-gibt-es-nicht.tar.gz", "dir": str(dataset),
                        "reuse_existing": True},
            "train": {
                "command": f"bash {self.trainer_stub(work)}",
                "output_dir": str(work / "out"),
                "expected_glob": "*.safetensors",
                "max_steps": 1000,
                "resume_from": "auto",
                "save_every_steps": 250,
                "checkpoint_dir": str(work / "ckpt"),
                "segment": {"index": 1, "start_step": 0, "end_step": 1000, "total_steps": 2000,
                            "steps": 1000, "is_last": False},
            },
            "progress": {"upload_url": None, "read_url": None, "file": str(work / "progress.jsonl")},
            "result": {"upload_url": None},
            "limits": {"max_runtime_minutes": 30, "cost_max": 1.0, "currency": "USD"},
        }
        for key, value in overrides.items():
            if isinstance(value, dict) and isinstance(spec.get(key), dict):
                spec[key].update(value)
            else:
                spec[key] = value
        (work / "job.json").write_text(json.dumps(spec), encoding="utf-8")
        return spec

    def status(self, work: pathlib.Path) -> str:
        return (work / "STATUS").read_text(encoding="utf-8")

    # --- Skip-Logik ---------------------------------------------------------
    def test_vorhandener_datensatz_wird_uebersprungen(self) -> None:
        # Die URL zeigt auf einen geschlossenen Port: WÜRDE geladen, waere der Lauf
        # Exit 3. Dass er durchläuft, beweist den übersprungenen Download.
        work = self.tmp / "work1"
        work.mkdir()
        self.spec(work)
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = self.status(work)
        self.assertIn("uebersprungen: Datensatz", status)
        self.assertIn("1 Bilder liegen schon", status)

    def test_gewichte_werden_erkannt_wenn_der_hf_cache_name_stimmt(self) -> None:
        """Regression 2026-09-24: die Vorstaging-Pruefung baute den Cache-Namen mit
        `tr '/' '-'`, also mit EINEM Bindestrich. HuggingFace legt ein Modell aber als
        `models--<org>--<name>` an - mit ZWEI. Die Pruefung schlug damit IMMER fehl: sie
        meldete "nicht vorstaged", obwohl die Gewichte auf dem Volume lagen, und der
        GPU-Pod lud die ~24 GB ein zweites Mal - zu GPU-Preisen statt zu CPU-Preisen.
        Hier liegt der Ordner mit dem RICHTIGEN Namen, also muss der Lauf ihn finden."""
        work = self.tmp / "work-gewichte"
        work.mkdir()
        hf_home = work / "hf-cache"
        modell = "black-forest-labs/FLUX.1-dev"
        richtig = "models--" + modell.replace("/", "--")       # ZWEI Bindestriche
        falsch = "models--" + modell.replace("/", "-")         # EIN Bindestrich
        self.assertNotEqual(richtig, falsch)
        (hf_home / "hub" / richtig).mkdir(parents=True)
        self.spec(work, train={"hf_home": str(hf_home), "base_model": modell})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = self.status(work)
        self.assertIn("uebersprungen: Gewichte", status)
        self.assertNotIn("Gewichte NICHT vorstaged", status)

    def test_ohne_wiederverwendung_wird_geladen_und_scheitert_sichtbar(self) -> None:
        work = self.tmp / "work2"
        work.mkdir()
        self.spec(work, dataset={"reuse_existing": False})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("Datensatz-Download fehlgeschlagen", result.stderr)

    # --- Resume -------------------------------------------------------------
    def test_erster_abschnitt_startet_frisch(self) -> None:
        work = self.tmp / "work3"
        work.mkdir()
        self.spec(work)
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        trainer_log = (work / "trainer.log").read_text(encoding="utf-8")
        self.assertIn("resume=<leer>", trainer_log)
        self.assertIn("max_steps=1000", trainer_log)
        self.assertIn("every=250", trainer_log)
        self.assertIn("seg=1 start=0 end=1000", trainer_log)
        self.assertTrue(list((work / "ckpt").glob("*.safetensors")))
        self.assertIn("Checkpoint: ", self.status(work))

    def test_zweiter_abschnitt_resumiert_aus_dem_checkpoint(self) -> None:
        work = self.tmp / "work4"
        (work / "ckpt").mkdir(parents=True)
        alt = work / "ckpt" / "ckpt-1000.safetensors"
        alt.write_bytes(b"x" * 4096)
        old = time.time() - 3600
        os.utime(alt, (old, old))  # aus dem VORIGEN Abschnitt
        self.spec(work, train={"max_steps": 2000, "segment": {"index": 2, "start_step": 1000, "end_step": 2000,
                                                             "total_steps": 2000, "steps": 1000, "is_last": True}})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        trainer_log = (work / "trainer.log").read_text(encoding="utf-8")
        self.assertIn("ckpt-1000.safetensors", trainer_log)
        self.assertIn("seg=2 start=1000 end=2000", trainer_log)
        zweite_zeile = trainer_log.strip().splitlines()[-1]
        self.assertNotIn("resume=<leer>", zweite_zeile)
        # Der neue Checkpoint dieses Abschnitts liegt danach ebenfalls da.
        self.assertTrue((work / "ckpt" / "ckpt-2000.safetensors").is_file())

    def test_folgeabschnitt_ohne_checkpoint_bricht_laut_ab(self) -> None:
        work = self.tmp / "work5"
        work.mkdir()
        self.spec(work, train={"max_steps": 2000, "segment": {"index": 2, "start_step": 1000, "end_step": 2000,
                                                             "total_steps": 2000, "steps": 1000, "is_last": True}})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("kein Checkpoint gefunden", result.stderr)
        self.assertFalse((work / "trainer.log").exists(), "ohne Resume darf nicht trainiert werden")

    def test_expliziter_resume_pfad_wird_geprueft(self) -> None:
        work = self.tmp / "work6"
        work.mkdir()
        self.spec(work, train={"resume_from": str(work / "gibtsnicht.safetensors")})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("nicht gefunden oder leer", result.stderr)

    # --- Checkpoint-Upload + Marker-Reihenfolge -----------------------------
    def test_checkpoint_upload_vor_segment_done_marker(self) -> None:
        work = self.tmp / "work7"
        work.mkdir()
        self.spec(work)
        spec_path = work / "job.json"
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        spec["train"]["checkpoint_upload_url"] = f"{self.base_url}/r2/checkpoint.safetensors"
        spec["progress"]["upload_url"] = f"{self.base_url}/r2/progress.jsonl"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        paths = [record["path"] for record in PutRecorder.records]
        self.assertIn("/r2/checkpoint.safetensors", paths)
        self.assertIn("/r2/progress.jsonl", paths)
        # REIHENFOLGE: der Checkpoint muss VOR dem SEGMENT_DONE-Marker liegen –
        # sonst terminiert der Starter den Pod, bevor der Abschnitt gesichert ist.
        # (Der laufende RUNNING-Marker von Trainingsbeginn liegt naturgemaess
        # davor; entscheidend ist der Marker MIT SEGMENT_DONE.)
        ckpt_index = paths.index("/r2/checkpoint.safetensors")
        done_indexes = [
            index for index, record in enumerate(PutRecorder.records)
            if record["path"] == "/r2/progress.jsonl" and '"SEGMENT_DONE"' in record["body"]
        ]
        self.assertTrue(done_indexes, "kein SEGMENT_DONE-Marker hochgeladen")
        self.assertGreater(done_indexes[-1], ckpt_index)
        marker_body = PutRecorder.records[done_indexes[-1]]["body"]
        marker = json.loads(marker_body.splitlines()[-1])
        self.assertEqual(marker["state"], "SEGMENT_DONE")
        self.assertEqual(marker["step"], 1000)
        self.assertIn("checkpoint_url", marker)
        # Der lokale Marker enthaelt auch den Zwischenstand des Trainers.
        local = json.loads((work / "progress.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(local["step"], 1000)

    def test_fehlender_checkpoint_ist_exit_5(self) -> None:
        work = self.tmp / "work8"
        work.mkdir()
        stub = work / "trainer-ohne-ckpt.sh"
        stub.write_text("#!/usr/bin/env bash\necho 'nichts gespeichert'\n", encoding="utf-8")
        self.spec(work, train={"command": f"bash {stub}"})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 5, result.stdout + result.stderr)
        self.assertIn("kein Checkpoint unter", result.stderr)

    def test_zwischenabschnitt_ohne_lora_ist_kein_fehler(self) -> None:
        # is_last=False: der Checkpoint IST das Ergebnis, das LoRA kommt spaeter.
        work = self.tmp / "work9"
        work.mkdir()
        stub = work / "trainer-nur-ckpt.sh"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            'mkdir -p "$LORA_CHECKPOINT_DIR"\n'
            'dd if=/dev/zero of="$LORA_CHECKPOINT_DIR/ckpt-1000.safetensors" bs=1024 count=4 status=none\n'
            'echo TRAIN_DONE\n',
            encoding="utf-8",
        )
        self.spec(work, train={"command": f"bash {stub}"})
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Zwischenabschnitt: Ergebnis ist der Checkpoint", self.status(work))
        self.assertNotIn("keine Ergebnisdatei", self.status(work))

    def test_letzter_abschnitt_verlangt_das_lora(self) -> None:
        work = self.tmp / "work10"
        work.mkdir()
        stub = work / "trainer-nur-ckpt.sh"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            'mkdir -p "$LORA_CHECKPOINT_DIR"\n'
            'dd if=/dev/zero of="$LORA_CHECKPOINT_DIR/ckpt-2000.safetensors" bs=1024 count=4 status=none\n'
            'echo TRAIN_DONE\n',
            encoding="utf-8",
        )
        self.spec(work, train={"command": f"bash {stub}",
                               "segment": {"index": 2, "start_step": 1000, "end_step": 2000,
                                           "total_steps": 2000, "steps": 1000, "is_last": True},
                               "resume_from": "auto"})
        # Der Resume-Check braucht einen Checkpoint aus dem Vorgaengerabschnitt.
        (work / "ckpt").mkdir(parents=True, exist_ok=True)
        vorher = work / "ckpt" / "ckpt-1000.safetensors"
        vorher.write_bytes(b"x" * 4096)
        old = time.time() - 3600
        os.utime(vorher, (old, old))
        result = self.run_script(BOOTSTRAP, env=self.bootstrap_env(work))
        self.assertEqual(result.returncode, 5, result.stdout + result.stderr)
        self.assertIn("keine Ergebnisdatei", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

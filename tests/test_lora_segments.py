"""Tests für den Abschnittsbetrieb des LoRA-Trainings (VISUAL-P1-007, 2026-09-22).

Kein Netz, keine GPU, keine Kosten – und VOR ALLEM: kein Pod. Alles läuft gegen
Temp-Dateien, lokale `file://`-Marker und ein **gefälschtes `runpod`-SDK**, das
jeden Kontakt in eine Logdatei schreibt. Damit ist belegbar, was das Skript tut
und was es NICHT tut:

  * die VORAB-RECHNUNG bricht ab, wenn der Abschnitt nicht ins Laufzeitfenster
    passt (genau das fehlte beim ersten Lauf: 3700 Schritte x 2,0 s = 123 min
    gegen eine 90-min-Grenze → 90,4 min Lauf, 0,74 USD, kein LoRA) – und zwar
    VOR dem Gate, ohne SDK-Import, ohne HTTP-Aufruf,
  * Abschnitte werden geplant (1000er-Raster), aus dem Fortschrittsmarker
    fortgesetzt und aus dem Checkpoint resumiert,
  * der Fortschrittsmarker (Schritt, Loss, Zeitstempel) wird im Starter ANGEZEIGT
    statt nur „Pod läuft" – und der Pod wird beendet, wenn der Marker den
    Abschnitt als fertig meldet (`SEGMENT_DONE`, gesetzt nach dem Upload),
  * der In-Pod-Runner (`scripts/lora/bootstrap.sh`) überspringt, was schon im
    Network Volume liegt („uebersprungen: …"), lädt den Checkpoint vor dem
    SEGMENT_DONE-Marker hoch und bricht LAUT ab, wenn ein Folgeschritt ohne
    Resume-Checkpoint starten sollte,
  * `scripts/lora/vorstaging.sh` füllt das Volume idempotent (zweiter Lauf:
    alles übersprungen) und rechnet die Monatskosten des Volumens aus.

Lauf: python3 tests/test_lora_segments.py
"""
from __future__ import annotations

import contextlib
import http.server
import importlib.util
import io
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
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

ROOT = pathlib.Path(__file__).resolve().parent.parent
TRAIN = ROOT / "scripts" / "runpod-lora-train.py"
BOOTSTRAP = ROOT / "scripts" / "lora" / "bootstrap.sh"
VORSTAGING = ROOT / "scripts" / "lora" / "vorstaging.sh"
PROGRESS_CLI = ROOT / "scripts" / "lora" / "lora-progress.py"

#: Env-Datei, die es nicht gibt – die Tests sollen NICHT von der lokalen .env
#: des Entwicklerrechners abhängen.
NO_ENV_FILE = "/nonexistent/audiomonastry-lora-segments.env"

#: Gefälschtes runpod-SDK: protokolliert jeden Kontakt in LORA_FAKE_SDK_LOG.
#: `LORA_FAKE_STATES` steuert die Zustandsfolge von get_pod (der letzte Wert
#: wiederholt sich), `LORA_FAKE_PODS` die Pod-Liste.
FAKE_SDK = '''"""Gefälschtes runpod-SDK für Tests (schreibt alles in LORA_FAKE_SDK_LOG)."""
import json
import os

_LOG = os.environ.get("LORA_FAKE_SDK_LOG", "")


def _record(event, **payload):
    if not _LOG:
        return
    with open(_LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event, "payload": payload}, ensure_ascii=False) + "\\n")


api_key = None
_states = [s for s in os.environ.get("LORA_FAKE_STATES", "RUNNING,EXITED").split(",") if s]
_calls = {"get_pod": 0}
_terminated = set()


def get_pods():
    _record("get_pods")
    return json.loads(os.environ.get("LORA_FAKE_PODS", "[]"))


def create_pod(**kwargs):
    _record("create_pod", kwargs=kwargs)
    return {"id": os.environ.get("LORA_FAKE_POD_ID", "pod-fake-1")}


def get_pod(pod_id):
    if pod_id in _terminated:
        # Nach dem Terminieren meldet RunPod einen terminalen Zustand – die
        # Terminierung wird vom Skript nachgeprueft.
        _record("get_pod", pod_id=pod_id, state="TERMINATED")
        return {"id": pod_id, "desiredStatus": "TERMINATED"}
    _calls["get_pod"] += 1
    index = min(_calls["get_pod"] - 1, len(_states) - 1) if _states else 0
    state = _states[index] if _states else "RUNNING"
    _record("get_pod", pod_id=pod_id, state=state)
    return {"id": pod_id, "desiredStatus": state}


def terminate_pod(pod_id):
    _terminated.add(pod_id)
    _record("terminate_pod", pod_id=pod_id)
    return {"id": pod_id, "desiredStatus": "TERMINATED"}
'''


def load_module(name: str, path: pathlib.Path) -> Any:
    """Skript per importlib laden (Bindestrich im Dateinamen = kein Modulpfad)."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


train = load_module("runpod_lora_train_segments", TRAIN)


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

    # --- Fake-SDK -----------------------------------------------------------
    def prepare_fake_sdk(self, states: str = "RUNNING,EXITED", pods: str = "[]") -> Dict[str, str]:
        sdk_root = self.tmp / "fakesdk"
        package = sdk_root / "runpod"
        package.mkdir(parents=True, exist_ok=True)
        (package / "__init__.py").write_text(FAKE_SDK, encoding="utf-8")
        self.sdk_log = self.tmp / f"sdk-calls-{time.time_ns()}.jsonl"
        return {
            "PYTHONPATH": str(sdk_root),
            "LORA_FAKE_SDK_LOG": str(self.sdk_log),
            "LORA_FAKE_STATES": states,
            "LORA_FAKE_PODS": pods,
            "LORA_FAKE_POD_ID": "pod-fake-1",
        }

    def sdk_events(self) -> List[Dict[str, Any]]:
        if not self.sdk_log.exists():
            return []
        return [json.loads(line) for line in self.sdk_log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def train_env(self, **extra: str) -> Dict[str, str]:
        env = self.prepare_fake_sdk()
        env.update({
            "RP_API_KEY": "fake-key-fuer-tests",
            # Stundensatz als Betreiber-Eingabe (das Skript erfindet keinen).
            "LORA_GPU_PRICE_PER_H": "0.49",
            "LORA_POD_TEMPLATE_ID": "runpod-torch-v280",
            "LORA_POD_DOCKER_ARGS": 'bash -c "bash /workspace/lora/bootstrap.sh"',
            "LORA_TRAIN_COMMAND": "python3 /workspace/lora/train_style_lora.py",
            "LORA_REPORT_DIR": str(self.tmp / "runs"),
        })
        env.update(extra)
        return env

    def write_markers(self, lines: List[Dict[str, Any]]) -> pathlib.Path:
        """Markerdatei (JSONL) schreiben und als file://-URL zurückgeben."""
        path = self.tmp / "progress.jsonl"
        path.write_text("".join(json.dumps(line, ensure_ascii=False) + "\n" for line in lines), encoding="utf-8")
        return path

    def marker_url(self, path: pathlib.Path) -> str:
        return "file://" + str(path)


# ---------------------------------------------------------------------------
# Abschnittsplanung (rein)
# ---------------------------------------------------------------------------
class SegmentPlanungTest(unittest.TestCase):
    def test_zwei_abschnitte_aus_2000_schritten(self) -> None:
        erste = train.resolve_segment(2000, 1000, segment_index=1)
        self.assertEqual((erste["start_step"], erste["end_step"], erste["steps"]), (0, 1000, 1000))
        self.assertEqual(erste["count"], 2)
        self.assertFalse(erste["is_last"])
        self.assertFalse(erste["finished"])

        letzte = train.resolve_segment(2000, 1000, segment_index=2)
        self.assertEqual((letzte["start_step"], letzte["end_step"]), (1000, 2000))
        self.assertTrue(letzte["is_last"])
        self.assertFalse(letzte["finished"])

    def test_angebrochener_letzter_abschnitt(self) -> None:
        # 3700 Schritte in 1000er-Abschnitten: der vierte Abschnitt ist kuerzer.
        vierter = train.resolve_segment(3700, 1000, segment_index=4)
        self.assertEqual((vierter["start_step"], vierter["end_step"], vierter["steps"]), (3000, 3700, 700))
        self.assertTrue(vierter["is_last"])

    def test_abschnitt_hinter_dem_ende_ist_fertig(self) -> None:
        # Kein stiller Neustart: wenn alle Schritte erreicht sind, ist nichts zu tun.
        fertig = train.resolve_segment(2000, 1000, segment_index=3)
        self.assertTrue(fertig["finished"])
        self.assertEqual(fertig["steps"], 0)

    def test_marker_setzt_den_laufenden_abschnitt_fort(self) -> None:
        # Abbruch bei Schritt 250 (Checkpoint liegt dort): die ARBEIT geht ab 250
        # weiter, aber nur bis zum Ende des Rasters (1000) – es wird kein neuer
        # Abschnitt begonnen und nichts wiederholt.
        teil = train.resolve_segment(2000, 1000, resume_step=250)
        self.assertEqual((teil["start_step"], teil["end_step"]), (250, 1000))
        self.assertEqual(teil["steps"], 750)
        self.assertEqual(teil["index"], 1)
        self.assertEqual(teil["source"], "marker")

        naechster = train.resolve_segment(2000, 1000, resume_step=1000)
        self.assertEqual((naechster["start_step"], naechster["end_step"]), (1000, 2000))
        self.assertTrue(naechster["is_last"])

    def test_alle_schritte_erreicht_ist_finished(self) -> None:
        self.assertTrue(train.resolve_segment(2000, 1000, resume_step=2000)["finished"])

    def test_explizite_nummer_schlaegt_den_marker(self) -> None:
        segment = train.resolve_segment(2000, 1000, segment_index=2, resume_step=0)
        self.assertEqual((segment["start_step"], segment["end_step"]), (1000, 2000))
        self.assertEqual(segment["source"], "cli")

    def test_segment_label_ist_lesbar(self) -> None:
        self.assertIn("Abschnitt 1/2", train.segment_label(train.resolve_segment(2000, 1000, segment_index=1)))
        self.assertIn("nichts mehr zu tun", train.segment_label(train.resolve_segment(2000, 1000, segment_index=9)))


class ResumeQuelleTest(unittest.TestCase):
    def cfg(self, resume_from: Any = "auto") -> Dict[str, Any]:
        return {"resume_from": resume_from, "segment": {"start_step": 1000}}

    def test_cli_schlaegt_marker(self) -> None:
        resume = train.resolve_resume(self.cfg("/pfad/ckpt.safetensors"), {"checkpoint_url": "https://r2/x"})
        self.assertEqual(resume["mode"], "cli")
        self.assertEqual(resume["resume_from"], "/pfad/ckpt.safetensors")

    def test_marker_gewinnt_gegen_auto(self) -> None:
        resume = train.resolve_resume(self.cfg("auto"), {"checkpoint_url": "https://r2/x", "step": 1000})
        self.assertEqual(resume["mode"], "marker")
        self.assertEqual(resume["resume_from"], "https://r2/x")
        self.assertEqual(resume["marker_step"], 1000)

    def test_ohne_marker_bleibt_auto(self) -> None:
        resume = train.resolve_resume(self.cfg(), None)
        self.assertEqual(resume["mode"], "auto")
        self.assertEqual(resume["resume_from"], "auto")


class FortschrittsmarkerTest(unittest.TestCase):
    def test_marker_roundtrip(self) -> None:
        marker = train.build_marker(step=250, total_steps=2000, loss=0.0812, state="RUNNING",
                                    segment={"index": 1, "start_step": 0, "end_step": 1000})
        text = train.marker_line(marker)
        back = train.parse_marker(text)
        self.assertEqual(back["step"], 250)
        self.assertEqual(back["total_steps"], 2000)
        self.assertAlmostEqual(back["loss"], 0.0812, places=4)
        self.assertEqual(back["segment"]["end_step"], 1000)
        self.assertEqual(back["schema"], "visual-lora-progress/1")

    def test_letzte_gueltige_zeile_gewinnt(self) -> None:
        text = (
            '{"step": 250, "state": "RUNNING", "ts": "2026-09-22T10:00:00+00:00"}\n'
            "keine json zeile\n"
            "\n"
            '{"step": 500, "state": "RUNNING", "ts": "2026-09-22T10:10:00+00:00"}\n'
        )
        marker = train.parse_marker(text)
        self.assertEqual(marker["step"], 500)

    def test_kaputte_datei_ist_none(self) -> None:
        self.assertIsNone(train.parse_marker("quatsch\n{\"ohne\": \"step\"}\n"))

    def test_alter_des_markers_wird_gerechnet(self) -> None:
        jetzt = datetime.now(timezone.utc)
        marker = {"step": 1, "ts": (jetzt - timedelta(minutes=42)).isoformat()}
        age = train.marker_age_minutes(marker, now=jetzt.timestamp())
        self.assertAlmostEqual(age, 42.0, places=1)

    def test_anzeige_zeigt_schritt_loss_und_stand(self) -> None:
        segment = train.resolve_segment(2000, 1000, segment_index=1)
        marker = train.build_marker(step=500, total_steps=2000, loss=0.1234, state="RUNNING",
                                    segment=segment, ts=datetime.now(timezone.utc).isoformat())
        text = "\n".join(train.format_progress_lines(marker, segment=segment, stale_minutes=15))
        self.assertIn("Schritt 500/2000", text)
        self.assertIn("25.0%", text)
        self.assertIn("Loss 0.1234", text)
        self.assertIn("Abschnitt 1/2", text)
        self.assertNotIn("WARNUNG", text)

    def test_veralteter_marker_warnt_laut(self) -> None:
        alt = (datetime.now(timezone.utc) - timedelta(minutes=44)).isoformat()
        marker = train.build_marker(step=500, loss=0.2, ts=alt)
        text = "\n".join(train.format_progress_lines(marker, stale_minutes=15))
        self.assertIn("WARNUNG: seit 44", text)
        self.assertIn("--terminate", text)

    def test_fehlender_marker_ist_kein_stiller_fortschritt(self) -> None:
        text = "\n".join(train.format_progress_lines(None, detail="nicht lesbar: URLError"))
        self.assertIn("kein Fortschrittsmarker lesbar", text)
        self.assertIn("nicht lesbar", text)

    def test_segment_done_erst_wenn_marker_es_meldet(self) -> None:
        segment = train.resolve_segment(2000, 1000, segment_index=1)
        # Schritt >= Ziel, aber ohne Abschlussmeldung: NICHT fertig (Checkpoint-Upload
        # laeuft noch – ein Pod-Abbruch hier wuerde den Abschnitt verlieren).
        offen = train.build_marker(step=1000, state="RUNNING")
        self.assertFalse(train.segment_complete(offen, segment))
        fertig = train.build_marker(step=1000, state="SEGMENT_DONE")
        self.assertTrue(train.segment_complete(fertig, segment))
        # Marker eines FRUEHEREN Abschnitts darf den laufenden nicht beenden.
        self.assertFalse(train.segment_complete(fertig, train.resolve_segment(2000, 1000, segment_index=2)))

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
        marker = train.parse_marker(local.read_text(encoding="utf-8"))
        self.assertEqual((marker["step"], marker["state"]), (250, "RUNNING"))
        self.assertIn("ts", marker)
        # Der Upload ist angekommen (Datei-HTTP-Stub via file://).
        self.assertEqual(train.parse_marker(ziel.read_text(encoding="utf-8"))["step"], 250)

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
        self.assertEqual(train.parse_marker(local.read_text(encoding="utf-8"))["step"], 1)


# ---------------------------------------------------------------------------
# VORAB-RECHNUNG
# ---------------------------------------------------------------------------
class VorabRechnungTest(BaseCase):
    #: Der verbrannte Lauf: 3700 Schritte x 2,0 s/Schritt = 123,3 min Training
    #: plus 20 min Kaltstart gegen eine 90-min-Grenze (Ergebnis: 90,4 min Lauf,
    #: 0,74 USD, kein LoRA).
    BURN_ARGS = ("--steps", "3700", "--segment-steps", "3700", "--seconds-per-step", "2.0",
                 "--startup-minutes", "20", "--max-runtime-minutes", "90")

    def test_reine_rechnung(self) -> None:
        ok = train.runtime_check(startup_minutes=20, train_minutes=33.33, max_runtime_minutes=90,
                                 steps=1000, seconds_per_step=2.0)
        self.assertTrue(ok["ok"])
        self.assertAlmostEqual(ok["margin_minutes"], 36.67, places=2)
        self.assertTrue(ok["seconds_per_step_is_assumption"])

        ueber = train.runtime_check(startup_minutes=20, train_minutes=123.33, max_runtime_minutes=90,
                                    steps=3700, seconds_per_step=2.0)
        self.assertFalse(ueber["ok"])
        self.assertAlmostEqual(ueber["overrun_minutes"], 53.33, places=2)

    def test_abbruch_vor_gate_und_ohne_sdk_kontakt(self) -> None:
        env = self.train_env(LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="5")
        result = self.run_script(TRAIN, "--train", *self.BURN_ARGS, "--env-file", NO_ENV_FILE, env=env)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ABBRUCH (VORAB-RECHNUNG)", result.stderr)
        self.assertIn("UEBERSCHREITUNG", result.stderr)
        self.assertIn("143.33 min", result.stderr)
        self.assertIn("--segment-steps", result.stderr)
        self.assertIn("ANNAHME, kein Messwert", result.stderr)
        self.assertNotIn("Freigabe erteilt", result.stdout)
        # Der Kern: kein SDK-Kontakt, kein Pod, keine Kosten.
        self.assertEqual(self.sdk_events(), [])

    def test_trockenlauf_bricht_ebenfalls_ab(self) -> None:
        result = self.run_script(TRAIN, "--plan", *self.BURN_ARGS, "--env-file", NO_ENV_FILE,
                                 env=self.script_env())
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ABBRUCH (VORAB-RECHNUNG)", result.stderr)

    def test_3700_schritte_werden_in_abschnitte_geteilt_statt_zu_verbrennen(self) -> None:
        # Die eigentliche Lehre: nicht abbrechen, sondern aufteilen. Jeder Abschnitt
        # passt ins Fenster, der Gesamtlauf steht als Summe der Obergrenzen da.
        result = self.run_script(
            TRAIN, "--plan", "--steps", "3700", "--segment-steps", "1000", "--seconds-per-step", "2.0",
            "--startup-minutes", "20", "--max-runtime-minutes", "90", "--price-per-hour", "0.49",
            "--env-file", NO_ENV_FILE, env=self.script_env(),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Abschnitt 1/4: Schritte 0-1000", result.stdout)
        self.assertIn("VORAB-RECHNUNG: passt ins Laufzeitfenster", result.stdout)
        self.assertIn("Obergrenze ALLER 4 Abschnitte zusammen", result.stdout)

    def test_override_erzwingt_den_lauf_aber_nicht_das_gate(self) -> None:
        env = self.train_env()
        # Ohne Freigabe bleibt es beim Gate-Abbruch (Exit 3) – --allow-overrun
        # ueberspringt nur die VORAB-RECHNUNG, nicht die Kostenfreigabe.
        result = self.run_script(TRAIN, "--train", *self.BURN_ARGS, "--allow-overrun",
                                 "--env-file", NO_ENV_FILE, env=env)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("Freigabe fehlt", result.stdout + result.stderr)
        self.assertEqual(self.sdk_events(), [])

    def test_train_minutes_ohne_schritte_wird_ebenfalls_geprueft(self) -> None:
        result = self.run_script(
            TRAIN, "--plan", "--train-minutes", "120", "--startup-minutes", "20",
            "--max-runtime-minutes", "90", "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE,
            env=self.script_env(),
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ABBRUCH (VORAB-RECHNUNG)", result.stderr)
        self.assertIn("vom Betreiber vorgegebene Trainingsdauer", result.stderr)

    def test_default_schritte_sind_2000(self) -> None:
        result = self.run_script(TRAIN, "--plan", "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE,
                                 env=self.script_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Schritte: 2000", result.stdout)
        self.assertIn("Abschnitt 1/2", result.stdout)


# ---------------------------------------------------------------------------
# Starter: Fortschrittsanzeige + Abschnittsende
# ---------------------------------------------------------------------------
class StarterFortschrittTest(BaseCase):
    def test_fortschritt_wird_angezeigt_und_abschnittsende_beendet_den_pod(self) -> None:
        segment_done = train.build_marker(step=1000, total_steps=1000, loss=0.0412, state="SEGMENT_DONE",
                                          checkpoint_url="https://r2.example/ckpt-1000.safetensors")
        laufend = train.build_marker(step=250, total_steps=1000, loss=0.0812, state="RUNNING")
        marker_path = self.write_markers([laufend, segment_done])
        env = self.train_env(
            LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="5",
            LORA_POLL_SECONDS="0.02",
            LORA_PROGRESS_GET_URL=self.marker_url(marker_path),
        )
        env["LORA_FAKE_STATES"] = "RUNNING"  # der Pod bleibt an, wenn niemand terminiert
        result = self.run_script(
            TRAIN, "--train", "--steps", "1000", "--segment-steps", "1000", "--segment", "1",
            "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Fortschritt: Schritt 1000/1000", result.stdout)
        self.assertIn("Loss 0.0412", result.stdout)
        self.assertIn("ABSCHNITT FERTIG", result.stdout)
        self.assertIn("Abschnittsziel erreicht", result.stdout)
        events = [entry["event"] for entry in self.sdk_events()]
        self.assertIn("create_pod", events)
        self.assertIn("terminate_pod", events)
        self.assertLess(events.index("create_pod"), events.index("terminate_pod"))
        # Der Report haelt Abschnitt, Marker und Resume-Quelle fest.
        reports = sorted((self.tmp / "runs").glob("*.json"))
        report = json.loads(reports[-1].read_text(encoding="utf-8"))
        self.assertEqual(report["segment"]["end_step"], 1000)
        self.assertTrue(report["progress"]["segment_done"])
        self.assertEqual(report["progress"]["last_marker"]["step"], 1000)
        self.assertEqual(report["status"], "ok")

    def test_veralteter_marker_warnt_im_starter(self) -> None:
        alt = (datetime.now(timezone.utc) - timedelta(minutes=40)).isoformat()
        marker_path = self.write_markers([train.build_marker(step=100, total_steps=1000, loss=0.4, ts=alt)])
        env = self.train_env(
            LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="5",
            LORA_POLL_SECONDS="0.02", LORA_MAX_RUNTIME_MINUTES="0.02",
            LORA_PROGRESS_GET_URL=self.marker_url(marker_path),
        )
        env["LORA_FAKE_STATES"] = "RUNNING"
        result = self.run_script(
            TRAIN, "--train", "--steps", "1000", "--segment-steps", "1000", "--segment", "1",
            "--price-per-hour", "0.49", "--allow-overrun", "--env-file", NO_ENV_FILE, env=env,
        )
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        self.assertIn("WARNUNG: seit", result.stdout)
        self.assertIn("harte Laufzeitgrenze", result.stdout)
        self.assertIn("terminate_pod", [entry["event"] for entry in self.sdk_events()])

    def test_nicht_lesbarer_marker_ist_ehrlich(self) -> None:
        env = self.train_env(
            LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="5", LORA_POLL_SECONDS="0.05",
            LORA_PROGRESS_GET_URL="file:///nonexistent/kein-marker.jsonl",
        )
        result = self.run_script(
            TRAIN, "--train", "--steps", "1000", "--segment-steps", "1000", "--segment", "1",
            "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("kein Fortschrittsmarker lesbar", result.stdout)
        self.assertIn("nicht lesbar", result.stdout)

    def test_alle_schritte_erreicht_startet_keinen_pod(self) -> None:
        marker_path = self.write_markers([train.build_marker(step=2000, total_steps=2000, state="SEGMENT_DONE")])
        env = self.train_env(
            LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="5",
            LORA_PROGRESS_GET_URL=self.marker_url(marker_path),
        )
        result = self.run_script(
            TRAIN, "--train", "--steps", "2000", "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("NICHTS ZU TUN", result.stdout)
        self.assertEqual(self.sdk_events(), [])

    def test_zweiter_abschnitt_resumiert_aus_dem_marker(self) -> None:
        marker_path = self.write_markers([
            train.build_marker(step=1000, total_steps=2000, state="SEGMENT_DONE",
                               checkpoint_url="https://r2.example/ckpt-1000.safetensors",
                               checkpoint_step=1000),
        ])
        env = self.train_env(
            LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="5", LORA_POLL_SECONDS="0.05",
            LORA_PROGRESS_GET_URL=self.marker_url(marker_path),
        )
        result = self.run_script(
            TRAIN, "--train", "--steps", "2000", "--segment-steps", "1000", "--segment", "auto",
            "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Abschnitt 2/2: Schritte 1000-2000", result.stdout)
        create = next(entry for entry in self.sdk_events() if entry["event"] == "create_pod")
        spec = json.loads(
            __import__("base64").b64decode(create["payload"]["kwargs"]["env"]["LORA_JOB_SPEC_B64"]).decode("utf-8")
        )
        self.assertEqual(spec["train"]["max_steps"], 2000)
        self.assertEqual(spec["train"]["resume_from"], "https://r2.example/ckpt-1000.safetensors")
        self.assertEqual(spec["train"]["save_every_steps"], 250)
        self.assertEqual(spec["train"]["segment"]["index"], 2)


# ---------------------------------------------------------------------------
# Volume-Kosten (Kostenhinweis im --print-config)
# ---------------------------------------------------------------------------
class VolumeKostenTest(BaseCase):
    def test_reine_rechnung(self) -> None:
        cost = train.volume_cost(100, 0.05, 0.92)
        self.assertEqual(cost["usd_per_month"], 5.0)
        self.assertAlmostEqual(cost["eur_per_month"], 4.6, places=2)
        self.assertTrue(cost["known"])
        self.assertFalse(train.volume_cost(None, 0.05, 0.0)["known"])

    def test_print_config_nennt_groesse_monatskosten_und_loeschbefehl(self) -> None:
        result = self.run_script(
            TRAIN, "--print-config", "--steps", "2000", "--price-per-hour", "0.49",
            "--volume-id", "vol-test-1", "--volume-size-gb", "100", "--env-file", NO_ENV_FILE,
            env=self.script_env(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("100 GB x 0.05 USD/GB/Monat = 5.00 USD/Monat", result.stdout)
        self.assertIn("runpodctl network-volume delete vol-test-1", result.stdout)
        self.assertIn("Abschnitt 1/2: Schritte 0-1000", result.stdout)
        self.assertIn("Konfiguration (--print-config", result.stdout)

    def test_print_config_gibt_keine_bearer_tokens_aus(self) -> None:
        geheim = "https://r2.example/obj?X-Amz-Signature=TOPSECRET123"
        result = self.run_script(
            TRAIN, "--print-config", "--steps", "1000", "--price-per-hour", "0.49",
            "--progress-read-url", geheim, "--checkpoint-upload-url", geheim,
            "--result-url", geheim, "--env-file", NO_ENV_FILE, env=self.script_env(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("TOPSECRET123", result.stdout + result.stderr)
        self.assertIn("gesetzt (Wert wird nicht ausgegeben)", result.stdout)

    def test_ohne_volume_werden_die_kaltstartkosten_beziffert(self) -> None:
        result = self.run_script(
            TRAIN, "--print-config", "--steps", "2000", "--segment-steps", "1000",
            "--price-per-hour", "0.49", "--env-file", NO_ENV_FILE, env=self.script_env(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("KEINES gesetzt", result.stdout)
        self.assertIn("2 Abschnitte x ~0.50 h Kaltstart", result.stdout)
        self.assertIn("vorstaging.sh", result.stdout)

    def test_fehlende_volumengroesse_wird_benannt_statt_geraten(self) -> None:
        result = self.run_script(
            TRAIN, "--print-config", "--steps", "1000", "--price-per-hour", "0.49",
            "--volume-id", "vol-test-2", "--env-file", NO_ENV_FILE, env=self.script_env(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Groesse unbekannt", result.stdout)
        self.assertIn("nicht berechenbar", result.stdout)


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
        marker = train.parse_marker(marker_body)
        self.assertEqual(marker["state"], "SEGMENT_DONE")
        self.assertEqual(marker["step"], 1000)
        self.assertIn("checkpoint_url", marker)
        # Der lokale Marker enthaelt auch den Zwischenstand des Trainers.
        local = train.parse_marker((work / "progress.jsonl").read_text(encoding="utf-8"))
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

"""Tests für die VISUAL-P1-007-Pipeline (Kuration, Dataset, Freigabe-Gate).

Kein Netz, keine GPU, keine Kosten: alles läuft gegen Temp-Dateien und ein
**gefälschtes `runpod`-SDK**. Das SDK wird dabei erst NACH dem Gate importiert –
der Test belegt das, indem er ein Fake-Modul bereitstellt, das jede Benutzung in
eine Logdatei schreibt: nach einem abgelehnten Lauf ist diese Datei leer bzw.
existiert gar nicht („der Client wurde gar nicht konstruiert“).

Lauf: python3 tests/test_visual_lora_pipeline.py
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

ROOT = pathlib.Path(__file__).resolve().parent.parent
CURATE = ROOT / "scripts" / "visual-lora-curate.py"
DATASET = ROOT / "scripts" / "visual-lora-dataset.py"
TRAIN = ROOT / "scripts" / "runpod-lora-train.py"
BOOTSTRAP = ROOT / "scripts" / "lora" / "bootstrap.sh"

#: Fake-RunPod-SDK: protokolliert jeden Kontakt in LORA_FAKE_SDK_LOG und liefert
#: plausible Antworten. `LORA_FAKE_STATES` steuert die Zustandsfolge von get_pod.
FAKE_SDK = '''"""Gefälschtes runpod-SDK für Tests (schreibt alles in LORA_FAKE_SDK_LOG)."""
import json
import os

_LOG = os.environ.get("LORA_FAKE_SDK_LOG", "")


def _record(event, **payload):
    if not _LOG:
        return
    with open(_LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event, "payload": payload}, ensure_ascii=False) + "\\n")


def _touch(event, **payload):
    """Erster Kontakt überhaupt – auch das blosse Importieren wird erfasst."""
    _record(event, **payload)


api_key = None
_states = [s for s in os.environ.get("LORA_FAKE_STATES", "RUNNING,EXITED").split(",") if s]
_calls = {"get_pod": 0}


def get_pods():
    _record("get_pods")
    return json.loads(os.environ.get("LORA_FAKE_PODS", "[]"))


def create_pod(**kwargs):
    _record("create_pod", kwargs=kwargs)
    return {"id": os.environ.get("LORA_FAKE_POD_ID", "pod-fake-1")}


def get_pod(pod_id):
    _calls["get_pod"] += 1
    index = min(_calls["get_pod"] - 1, len(_states) - 1) if _states else 0
    state = _states[index] if _states else "RUNNING"
    _record("get_pod", pod_id=pod_id, state=state)
    return {"id": pod_id, "desiredStatus": state}


def terminate_pod(pod_id):
    _record("terminate_pod", pod_id=pod_id)
    return {"id": pod_id, "desiredStatus": "TERMINATED"}


def _unused(*args, **kwargs):  # pragma: no cover - Sicherheitsnetz
    _record("unexpected_call", args=list(args), kwargs=kwargs)
    raise AssertionError("unerwarteter SDK-Aufruf")
'''

#: Zusätzliches Modul, das beim Import sofort protokolliert. Damit ist belegbar,
#: ob das SDK auch nur geladen wurde (Import = Kontaktaufnahme-Vorbereitung).
FAKE_SDK_INIT = '''import os
if os.environ.get("LORA_FAKE_SDK_LOG"):
    with open(os.environ["LORA_FAKE_SDK_LOG"], "a", encoding="utf-8") as handle:
        handle.write('{"event": "import", "payload": {}}\\n')
'''


def write_fake_sdk(directory: pathlib.Path) -> None:
    package = directory / "runpod"
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text(FAKE_SDK_INIT + FAKE_SDK, encoding="utf-8")


class BaseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="lora-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env_file = self.tmp / "empty.env"
        self.env_file.write_text("# absichtlich leer – Tests sollen nichts aus .env ziehen\n", encoding="utf-8")

    def run_script(self, script: pathlib.Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        """Skript als Prozess starten (testet CLI, Exit-Codes und stdout/stderr)."""
        run_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
            "HOME": os.environ.get("HOME", str(self.tmp)),
            "LC_ALL": "C.UTF-8",
            "PYTHONIOENCODING": "utf-8",
        }
        run_env.update(env or {})
        return subprocess.run(
            [sys.executable, str(script), *args],
            capture_output=True, text=True, env=run_env, cwd=str(ROOT), timeout=180,
        )

    # --- Fixtures -----------------------------------------------------------
    def write_export(self, feedback: list, generations: list, name: str = "export.json") -> pathlib.Path:
        path = self.tmp / name
        path.write_text(json.dumps({"feedback": feedback, "generations": generations}), encoding="utf-8")
        return path

    def standard_export(self) -> pathlib.Path:
        """Drei Bilder: 4,5/5 (2 Stimmen), 5/5 (1), 2/5 (1) – plus eines ohne Bild."""
        feedback = [
            {"generation_id": "11111111-1111-1111-1111-111111111111", "rating": 5, "keep": True, "tags": ["noir", "kontrast"]},
            {"generation_id": "11111111-1111-1111-1111-111111111111", "rating": 4, "keep": True, "tags": ["noir"]},
            {"generation_id": "22222222-2222-2222-2222-222222222222", "rating": 5, "keep": True, "tags": ["cosmic"]},
            {"generation_id": "33333333-3333-3333-3333-333333333333", "rating": 2, "keep": False, "tags": []},
            {"generation_id": "44444444-4444-4444-4444-444444444444", "rating": 5, "keep": True, "tags": []},
        ]
        generations = [
            {"id": "11111111-1111-1111-1111-111111111111", "prompt": "noir street at night, rain, neon",
             "style": "noir", "seed": 42, "model": "flux-1-dev", "r2_url": "https://example.invalid/a.png",
             "r2_key": "vision/a.png", "created_at": "2026-09-18T10:00:00Z"},
            {"id": "22222222-2222-2222-2222-222222222222", "prompt": "cosmic dust nebula, deep space",
             "style": "cosmic", "seed": 7, "model": "flux-1-dev", "r2_url": "https://example.invalid/b.png",
             "r2_key": "vision/b.png", "created_at": "2026-09-18T11:00:00Z"},
            {"id": "33333333-3333-3333-3333-333333333333", "prompt": "blurry mess",
             "style": "abstract", "seed": 9, "model": "flux-1-dev", "r2_url": "https://example.invalid/c.png",
             "r2_key": "vision/c.png", "created_at": "2026-09-18T12:00:00Z"},
            # 5/5, aber ohne Bild-Referenz (R2-Ablage war nicht konfiguriert)
            {"id": "44444444-4444-4444-4444-444444444444", "prompt": "liquid geometry",
             "style": "geometry", "seed": 11, "model": "flux-1-dev", "r2_url": None, "r2_key": None,
             "created_at": "2026-09-18T13:00:00Z"},
        ]
        return self.write_export(feedback, generations)

    def write_image(self, target_dir: pathlib.Path, generation_id: str, payload: bytes = b"\x89PNG\r\n\x1a\n-fake-bytes") -> pathlib.Path:
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{generation_id}.png"
        path.write_bytes(payload)
        return path


class KurationTest(BaseCase):
    """Schritt 2: Auswahl der bestbewerteten Prompt/Bild-Paare."""

    def test_waehlt_nur_paare_ueber_der_rating_schwelle_und_ohne_bildfreie(self) -> None:
        export = self.standard_export()
        out = self.tmp / "curated.json"
        result = self.run_script(
            CURATE, "--from-json", str(export), "--out", str(out),
            "--min-rating", "4", "--env-file", str(self.env_file),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(out.read_text(encoding="utf-8"))
        ids = [pair["generation_id"][:8] for pair in payload["pairs"]]
        # 1111… (Ø4,5) und 2222… (5) bleiben; 3333… (2) und 4444… (kein Bild) fallen raus.
        self.assertEqual(ids, ["22222222", "11111111"])
        self.assertEqual(payload["stats"]["dropped"]["rating"], 1)
        self.assertEqual(payload["stats"]["dropped"]["ohne_bild"], 1)
        self.assertEqual(payload["schema"], "visual-lora-pairs/1")

    def test_keep_filter_und_include_unkept(self) -> None:
        export = self.standard_export()
        out = self.tmp / "curated.json"
        self.run_script(CURATE, "--from-json", str(export), "--out", str(out),
                        "--min-rating", "2", "--env-file", str(self.env_file))
        kept_ids = {p["generation_id"][:8] for p in json.loads(out.read_text())["pairs"]}
        self.assertNotIn("33333333", kept_ids)  # keep=false

        self.run_script(CURATE, "--from-json", str(export), "--out", str(out), "--min-rating", "2",
                        "--include-unkept", "--env-file", str(self.env_file))
        kept_ids = {p["generation_id"][:8] for p in json.loads(out.read_text())["pairs"]}
        self.assertIn("33333333", kept_ids)

    def test_stilfilter_und_limit(self) -> None:
        export = self.standard_export()
        out = self.tmp / "curated.json"
        result = self.run_script(CURATE, "--from-json", str(export), "--out", str(out),
                                 "--style", "noir", "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual([p["style"] for p in payload["pairs"]], ["noir"])

        self.run_script(CURATE, "--from-json", str(export), "--out", str(out), "--limit", "1",
                        "--env-file", str(self.env_file))
        self.assertEqual(len(json.loads(out.read_text(encoding="utf-8"))["pairs"]), 1)

    def test_null_paare_ist_exit3_mit_begruendung_und_datei(self) -> None:
        """Ehrliche Leermenge: kein stiller Erfolg, aber ein Beleg auf der Platte."""
        export = self.write_export(
            feedback=[],
            generations=[{"id": "aaaa", "prompt": "irgendwas", "style": "noir", "r2_url": "https://example.invalid/x.png"}],
        )
        out = self.tmp / "curated.json"
        result = self.run_script(CURATE, "--from-json", str(export), "--out", str(out),
                                 "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn("0 verwertbare Prompt/Bild-Paare", result.stderr)
        payload = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(payload["pairs"], [])
        self.assertIn("Bewertung", payload["reason"])

    def test_ohne_quelle_kein_netzaufruf_sondern_exit2(self) -> None:
        # Leere .env, keine Supabase-Variablen: das Skript muss mit Exit 2 enden
        # (Aufruf-/Konfigurationsfehler) und darf nichts erfinden.
        result = self.run_script(CURATE, "--env-file", str(self.env_file), "--out", str(self.tmp / "x.json"))
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("Supabase ist nicht konfiguriert", result.stderr)

    def test_kaputte_exportdatei_ist_exit2(self) -> None:
        broken = self.tmp / "broken.json"
        broken.write_text("{nicht json", encoding="utf-8")
        result = self.run_script(CURATE, "--from-json", str(broken), "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 2)

    def test_paarform_export_wird_akzeptiert(self) -> None:
        pairs = self.tmp / "pairs.json"
        pairs.write_text(json.dumps({"pairs": [
            {"generation_id": "aaaa1111-0000", "prompt": "noir", "rating": 4.5, "votes": 2,
             "keep": True, "r2_url": "https://example.invalid/x.png", "style": "noir"},
        ]}), encoding="utf-8")
        out = self.tmp / "curated.json"
        result = self.run_script(CURATE, "--from-json", str(pairs), "--out", str(out),
                                 "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(out.read_text(encoding="utf-8"))["pairs"]), 1)

    def test_diagnose_zaehlt_zeilen_und_verteilung(self) -> None:
        export = self.standard_export()
        result = self.run_script(CURATE, "--diagnose", "--from-json", str(export),
                                 "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout[: result.stdout.rindex("}") + 1])
        self.assertEqual(report["feedback_rows"], 5)
        self.assertEqual(report["generation_rows"], 4)
        self.assertEqual(report["rating_distribution"]["5"], 3)
        self.assertEqual(report["rating_distribution"]["2"], 1)
        self.assertEqual(report["generations_with_image"], 3)

    def test_diagnose_ohne_datenquelle_exit2(self) -> None:
        result = self.run_script(CURATE, "--diagnose", "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 2)
        self.assertIn("nicht konfiguriert", result.stderr)


class DatasetTest(BaseCase):
    """Schritt 3: Bilder + Captions + Metadaten in dokumentiertem Format."""

    def curated(self, count: int = 2) -> pathlib.Path:
        export = self.standard_export()
        out = self.tmp / "curated.json"
        result = self.run_script(CURATE, "--from-json", str(export), "--out", str(out),
                                 "--min-rating", "4", "--limit", str(count),
                                 "--env-file", str(self.env_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        return out

    def test_baut_bilder_captions_metadaten(self) -> None:
        pairs = self.curated()
        images = self.tmp / "bilder"
        self.write_image(images, "11111111-1111-1111-1111-111111111111")
        self.write_image(images, "22222222-2222-2222-2222-222222222222")
        out = self.tmp / "dataset"

        result = self.run_script(DATASET, "--pairs", str(pairs), "--images-dir", str(images),
                                 "--out", str(out), "--trigger", "monkstyle", "--tar")
        self.assertEqual(result.returncode, 0, result.stderr)

        manifest = json.loads((out / "dataset.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["counts"]["images_written"], 2)
        self.assertEqual(manifest["counts"]["pairs_in"], 2)

        images_out = sorted(p.name for p in (out / "images").glob("*.png"))
        captions_out = sorted(p.name for p in (out / "images").glob("*.txt"))
        self.assertEqual(len(images_out), 2)
        self.assertEqual(len(captions_out), 2)
        # Gleicher Basisname für Bild und Caption (kohya/ai-toolkit-Konvention)
        self.assertEqual([name[:-4] for name in images_out], [name[:-4] for name in captions_out])

        caption = (out / "images" / captions_out[0]).read_text(encoding="utf-8").strip()
        self.assertTrue(caption.startswith("monkstyle, "), caption)

        rows = [json.loads(line) for line in (out / "metadata.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertTrue((out / row["file_name"]).is_file())
            self.assertIn("generation_id", row)
            self.assertGreaterEqual(row["rating"], 4)
        self.assertTrue((out / "dataset_config.toml").is_file())
        self.assertTrue((out / "README.md").is_file())
        toml = (out / "dataset_config.toml").read_text(encoding="utf-8")
        self.assertIn("[[datasets.subsets]]", toml)
        self.assertIn('class_tokens = "monkstyle"', toml)

        # Prüfsummen im Manifest müssen zu den Dateien passen
        import hashlib  # lokal, damit der Test ohne Zusatzimports lesbar bleibt
        for entry in manifest["files"]:
            digest = hashlib.sha256((out / entry["path"]).read_bytes()).hexdigest()
            self.assertEqual(digest, entry["sha256"], entry["path"])
        archive = manifest["archive"]
        self.assertEqual(
            hashlib.sha256((out / archive["path"]).read_bytes()).hexdigest(),
            archive["sha256"],
        )

    def test_ohne_bilder_exit3_mit_grund(self) -> None:
        pairs = self.curated()
        out = self.tmp / "dataset"
        (self.tmp / "leer").mkdir(exist_ok=True)
        result = self.run_script(DATASET, "--pairs", str(pairs), "--out", str(out),
                                 "--images-dir", str(self.tmp / "leer"))
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn("0 Bilder geschrieben", result.stderr)
        manifest = json.loads((out / "dataset.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["counts"]["images_written"], 0)
        self.assertTrue(all(row["reason"] == "ohne_bilddatei" for row in manifest["skipped"]))

    def test_leere_bilddatei_wird_verworfen(self) -> None:
        pairs = self.curated(count=1)
        images = self.tmp / "bilder"
        self.write_image(images, "22222222-2222-2222-2222-222222222222", payload=b"")
        result = self.run_script(DATASET, "--pairs", str(pairs), "--images-dir", str(images),
                                 "--out", str(self.tmp / "dataset"))
        self.assertEqual(result.returncode, 3)
        self.assertIn("leere_bilddatei", result.stderr + result.stdout)

    def test_ohne_kurationsdatei_exit2(self) -> None:
        result = self.run_script(DATASET, "--pairs", str(self.tmp / "fehlt.json"), "--out", str(self.tmp / "d"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("Kurationsdatei", result.stderr)

    def test_image_map_schlaegt_die_suche(self) -> None:
        pairs = self.curated(count=1)  # bestes Paar: 2222… (Ø 5,0)
        weird = self.tmp / "krumm.bin"
        weird.write_bytes(b"\x89PNG-fake")
        image_map = self.tmp / "map.json"
        image_map.write_text(json.dumps({"22222222-2222-2222-2222-222222222222": str(weird)}), encoding="utf-8")
        out = self.tmp / "dataset"
        result = self.run_script(DATASET, "--pairs", str(pairs), "--image-map", str(image_map), "--out", str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        # Endung .bin ist keine Bildendung → das Skript benennt konservativ .png
        manifest = json.loads((out / "dataset.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["counts"]["images_written"], 1)


class GateTest(BaseCase):
    """Schritt 4: Kostenrechnung + hartes Freigabe-Gate (kein API-Aufruf ohne Freigabe)."""

    PLAN_ARGS = (
        "--price-per-hour", "0.69",
        "--images", "20", "--repeats", "10", "--epochs", "10", "--batch-size", "1",
        "--startup-minutes", "20", "--teardown-minutes", "5", "--max-runtime-minutes", "90",
    )

    def prepare_fake_sdk(self, states: str = "RUNNING,EXITED", pods: str = "[]") -> dict:
        sdk_root = self.tmp / "fakesdk"
        write_fake_sdk(sdk_root)
        log = self.tmp / "sdk-calls.jsonl"
        env = {
            "PYTHONPATH": str(sdk_root),
            "LORA_FAKE_SDK_LOG": str(log),
            "LORA_FAKE_STATES": states,
            "LORA_FAKE_PODS": pods,
            "LORA_FAKE_POD_ID": "pod-fake-1",
        }
        self.sdk_log = log
        return env

    #: Harte Obergrenze des Plan-Beispiels: 0,69 $/h × (20 + 90 + 5) min / 60 s
    #: = 1,3225 $ → der Betreiber muss sie nennen (oder mehr).
    COST_MAX = 0.69 * (20 + 90 + 5) / 60.0

    def sdk_events(self) -> list:
        if not self.sdk_log.exists():
            return []
        return [json.loads(line) for line in self.sdk_log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def train_env(self, **extra: str) -> dict:
        env = self.prepare_fake_sdk()
        env.update({
            "RP_API_KEY": "fake-key-fuer-tests",
            "LORA_POD_TEMPLATE_ID": "runpod-torch-v280",
            "LORA_POD_DOCKER_ARGS": 'bash -c "bash /workspace/lora/bootstrap.sh"',
            "LORA_TRAIN_COMMAND": "python3 /workspace/lora/train_style_lora.py",
            # Reports in den Temp-Ordner: die Tests schreiben NICHTS ins Repo.
            "LORA_REPORT_DIR": str(self.tmp / "runs"),
        })
        env.update(extra)
        return env

    def test_plan_modus_rechnet_ohne_api_aufruf(self) -> None:
        env = self.train_env()
        result = self.run_script(TRAIN, "--plan", *self.PLAN_ARGS, "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("HARTE OBERGRENZE", result.stdout)
        # 2000 Schritte / (10*10*20/1) = 2000 Schritte x 2 s = 66,67 min
        self.assertIn("2000 Schritte", result.stdout)
        self.assertEqual(self.sdk_events(), [])  # kein SDK-Kontakt, nicht mal ein Import

    def test_ohne_freigabe_exit3_und_kein_api_aufruf(self) -> None:
        env = self.train_env()
        result = self.run_script(TRAIN, "--train", *self.PLAN_ARGS, "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn("Freigabe fehlt", result.stderr + result.stdout)
        self.assertIn("ABBRUCH vor jedem API-Aufruf", result.stderr)
        # Der Kern dieses Tests: das SDK wurde nicht einmal importiert.
        self.assertEqual(self.sdk_events(), [])

    def test_zu_niedriger_bestaetigter_betrag_exit3(self) -> None:
        env = self.train_env(LORA_APPROVE_SPEND="1", KOSTENBESTAETIGUNG="0.01")
        result = self.run_script(TRAIN, "--train", *self.PLAN_ARGS, "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn("liegt unter der harten Obergrenze", result.stdout)
        self.assertEqual(self.sdk_events(), [])

    def test_freigabe_legt_pod_an_und_terminiert_ihn(self) -> None:
        env = self.train_env(
            LORA_APPROVE_SPEND="1",
            KOSTENBESTAETIGUNG=f"{self.COST_MAX:.4f}",
            LORA_POLL_SECONDS="0.05",
        )
        result = self.run_script(TRAIN, "--train", *self.PLAN_ARGS, "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = [entry["event"] for entry in self.sdk_events()]
        self.assertIn("create_pod", events)
        self.assertIn("terminate_pod", events)
        self.assertLess(events.index("create_pod"), events.index("terminate_pod"))
        create = next(entry for entry in self.sdk_events() if entry["event"] == "create_pod")
        kwargs = create["payload"]["kwargs"]
        self.assertEqual(kwargs["template_id"], "runpod-torch-v280")
        self.assertEqual(kwargs["gpu_count"], 1)
        self.assertIn("LORA_JOB_SPEC_B64", kwargs["env"])
        # Der Auftrag im Env muss der Job-Spezifikation entsprechen
        import base64
        spec = json.loads(base64.b64decode(kwargs["env"]["LORA_JOB_SPEC_B64"]).decode("utf-8"))
        self.assertEqual(spec["train"]["command"], "python3 /workspace/lora/train_style_lora.py")
        self.assertAlmostEqual(spec["limits"]["cost_max"], round(self.COST_MAX, 4), places=4)

    def test_ohne_preis_exit2_und_kein_api_aufruf(self) -> None:
        env = self.prepare_fake_sdk()
        env.update({"RP_API_KEY": "fake", "LORA_APPROVE_SPEND": "1", "KOSTENBESTAETIGUNG": "10"})
        result = self.run_script(TRAIN, "--train", "--images", "20", "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("Stundensatz", result.stderr)
        self.assertEqual(self.sdk_events(), [])

    def test_doppelter_podname_wird_abgelehnt(self) -> None:
        env = self.train_env(
            LORA_APPROVE_SPEND="1",
            KOSTENBESTAETIGUNG="5",
            LORA_FAKE_PODS=json.dumps([{"id": "pod-alt", "name": "audiomonastry-lora-test"}]),
        )
        result = self.run_script(TRAIN, "--train", "--pod-name", "audiomonastry-lora-test",
                                 *self.PLAN_ARGS, "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("bereits einen Pod", result.stderr)
        events = [entry["event"] for entry in self.sdk_events()]
        self.assertNotIn("create_pod", events)

    def test_max_runtime_terminiert_den_pod_auch_bei_haengendem_lauf(self) -> None:
        # get_pod bleibt für immer RUNNING → die harte Grenze muss greifen.
        # `--allow-overrun` ist hier ABSICHT: dieser Test prüft die Laufzeitgrenze
        # (Pod wird terminiert), nicht die VORAB-RECHNUNG. Ohne das Flag würde der
        # Lauf vorher abbrechen (1 min geplante Dauer in einem 0,02-min-Fenster) –
        # genau das prüft tests/test_lora_segments.py::VorabRechnungTest.
        env = self.prepare_fake_sdk(states="RUNNING")
        env.update({
            "RP_API_KEY": "fake-key-fuer-tests",
            "LORA_POD_TEMPLATE_ID": "runpod-torch-v280",
            "LORA_POD_DOCKER_ARGS": 'bash -c "bash /workspace/lora/bootstrap.sh"',
            "LORA_APPROVE_SPEND": "1",
            "KOSTENBESTAETIGUNG": "0.50",
            "LORA_POLL_SECONDS": "0.02",
            "LORA_REPORT_DIR": str(self.tmp / "runs"),
        })
        result = self.run_script(
            TRAIN, "--train", "--max-runtime-minutes", "0.02", "--startup-minutes", "0",
            "--price-per-hour", "0.69", "--train-minutes", "1", "--allow-overrun",
            "--env-file", str(self.env_file), env=env,
        )
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        events = [entry["event"] for entry in self.sdk_events()]
        self.assertIn("terminate_pod", events)
        self.assertIn("harte Laufzeitgrenze", result.stdout)

    def test_terminate_modus_raeumt_ohne_freigabe_auf(self) -> None:
        env = self.prepare_fake_sdk(states="TERMINATED")
        env["RP_API_KEY"] = "fake"
        result = self.run_script(TRAIN, "--terminate", "pod-alt-1", "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = [entry["event"] for entry in self.sdk_events()]
        self.assertIn("terminate_pod", events)
        self.assertNotIn("create_pod", events)

    def test_report_wird_geschrieben_mit_pod_id_und_gate(self) -> None:
        runs_dir = self.tmp / "runs"  # eigener Ort: der Test schreibt NICHTS ins Repo
        env = self.train_env(
            LORA_APPROVE_SPEND="1",
            KOSTENBESTAETIGUNG="1.33",
            LORA_POLL_SECONDS="0.05",
            LORA_REPORT_DIR=str(runs_dir),
        )
        result = self.run_script(TRAIN, "--train", *self.PLAN_ARGS, "--env-file", str(self.env_file), env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        reports = sorted(runs_dir.glob("*.json"))
        self.assertTrue(reports, "kein Lauf-Report geschrieben")
        report = json.loads(reports[-1].read_text(encoding="utf-8"))
        self.assertEqual(report["pod"]["id"], "pod-fake-1")
        self.assertTrue(report["gate"]["ok"])
        self.assertTrue(report["pod"]["terminated"])
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["job_spec"]["ticket"], "VISUAL-P1-007")


class BootstrapTest(BaseCase):
    """In-Pod-Runner (scripts/lora/bootstrap.sh) – ohne Netz und ohne GPU geprüft."""

    def test_bash_syntax_ok(self) -> None:
        result = subprocess.run(["bash", "-n", str(BOOTSTRAP)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dry_run_ohne_auftrag_ist_exit2(self) -> None:
        work = self.tmp / "work"
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LORA_WORK": str(work)}
        result = subprocess.run(["bash", str(BOOTSTRAP), "--dry-run"], capture_output=True,
                                text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 2)
        self.assertIn("kein Auftrag", result.stderr)

    def test_dry_run_mit_auftrag_zeigt_die_schritte(self) -> None:
        work = self.tmp / "work"
        work.mkdir()
        spec = {
            "dataset": {"url": None, "dir": str(work / "dataset")},
            "train": {"command": "echo train", "output_dir": str(work / "out"), "expected_glob": "*.safetensors"},
            "result": {"upload_url": None},
            "limits": {"max_runtime_minutes": 90},
        }
        (work / "job.json").write_text(json.dumps(spec), encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LORA_WORK": str(work)}
        result = subprocess.run(["bash", str(BOOTSTRAP), "--dry-run"], capture_output=True,
                                text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY-RUN", (work / "STATUS").read_text(encoding="utf-8"))

    def test_kompletter_lauf_mit_stub_trainer(self) -> None:
        """Echter Durchlauf mit einem Stub statt GPU-Training (kein Netz, keine Kosten)."""
        work = self.tmp / "work"
        dataset = self.tmp / "dataset-in"
        self.write_image(dataset, "11111111-1111-1111-1111-111111111111")
        spec = {
            "dataset": {"url": None, "dir": str(dataset)},
            "train": {
                "command": "dd if=/dev/zero of=\"$LORA_OUTPUT_DIR/monkstyle.safetensors\" bs=1024 count=2 status=none && echo 'TRAIN_DONE'",
                "output_dir": str(work / "out"),
                "expected_glob": "*.safetensors",
            },
            "result": {"upload_url": None},
            "limits": {"max_runtime_minutes": 90},
        }
        work.mkdir(parents=True, exist_ok=True)
        (work / "job.json").write_text(json.dumps(spec), encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LORA_WORK": str(work)}
        result = subprocess.run(["bash", str(BOOTSTRAP)], capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = (work / "STATUS").read_text(encoding="utf-8")
        self.assertIn('"step":"DONE"', status)
        self.assertTrue((work / "out" / "monkstyle.safetensors").is_file())

    def test_stub_trainer_ohne_ergebnis_ist_exit5(self) -> None:
        work = self.tmp / "work"
        dataset = self.tmp / "dataset-in"
        self.write_image(dataset, "11111111-1111-1111-1111-111111111111")
        spec = {
            "dataset": {"url": None, "dir": str(dataset)},
            "train": {"command": "echo 'nichts gespeichert'", "output_dir": str(work / "out"),
                      "expected_glob": "*.safetensors"},
            "result": {"upload_url": None},
            "limits": {"max_runtime_minutes": 90},
        }
        work.mkdir(parents=True, exist_ok=True)
        (work / "job.json").write_text(json.dumps(spec), encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LORA_WORK": str(work)}
        result = subprocess.run(["bash", str(BOOTSTRAP)], capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(result.returncode, 5, result.stdout + result.stderr)
        self.assertIn("keine Ergebnisdatei", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

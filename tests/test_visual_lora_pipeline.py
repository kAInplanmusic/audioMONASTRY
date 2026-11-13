"""Local existing-media curation and dataset tests.

The retired provider-specific training starter and its nine gate cases are
removed. Existing media and local stub-runner contracts remain covered.
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


if __name__ == "__main__":
    unittest.main(verbosity=2)

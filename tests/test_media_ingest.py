"""Tests für scripts/media-ingest.py – ohne Netz (Speicher-Stub).

Lauf: python3 tests/test_media_ingest.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("media_ingest", ROOT / "scripts" / "media-ingest.py")
ingest = importlib.util.module_from_spec(spec)
assert spec.loader
sys.modules["media_ingest"] = ingest
spec.loader.exec_module(ingest)


class Store:
    def __init__(self):
        self.objects = {}
        self.meta = {}
        self.heads = 0

    def head(self, key):
        self.heads += 1
        return {"content-length": "1"} if key in self.objects else None

    def put_file(self, key, path, content_type, meta=None):
        with open(path, "rb") as fh:
            self.objects[key] = fh.read()
        self.meta[key] = (content_type, meta)

    def put_bytes(self, key, data, content_type="", meta=None):
        self.objects[key] = data


def make_tree(base):
    files = {
        "Techno/track01.flac": b"flac-a",
        "Techno/track01-kopie.flac": b"flac-a",  # Duplikat
        "Hi-Res/album/01.dsf": b"dsd",
        "Fotos/IMG_0001.CR3": b"raw",
        "Fotos/urlaub.heic": b"heic",
        "Clips/loop.mov": b"mov",
        "Projekte/beat.mid": b"midi",
        "Looks/teal.cube": b"lut",
        "Docs/readme.txt": b"txt",
        "$RECYCLE.BIN/geloescht.wav": b"x",
        "Techno/._track01.flac": b"appledouble",
    }
    for rel, data in files.items():
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(data)


class IngestTest(unittest.TestCase):
    def run_main(self, store, *argv):
        ingest.s3lite.S3Target.from_b2_env = staticmethod(lambda env=None: store)
        ingest.s3lite.S3Target.from_r2_env = staticmethod(lambda env=None: store)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = ingest.main(list(argv))
        return code, out.getvalue()

    def test_klassifikation_inklusive_verlustfrei_raw_midi_lut(self):
        for name, kind in [("a.flac", "audio"), ("a.dsf", "audio"), ("a.wv", "audio"), ("a.ape", "audio"), ("a.w64", "audio"),
                           ("a.CR3", "image"), ("a.heic", "image"), ("a.mov", "video"), ("a.mxf", "video"),
                           ("a.mid", "midi"), ("a.cube", "lut")]:
            self.assertEqual(ingest.classify(name)[0], kind, name)
        self.assertIsNone(ingest.classify("readme.txt"))
        self.assertIsNone(ingest.classify("._x.flac"))
        self.assertIsNone(ingest.classify("Thumbs.db"))

    def test_ohne_yes_nur_zaehlen(self):
        store = Store()
        with tempfile.TemporaryDirectory() as tmp:
            make_tree(tmp)
            code, out = self.run_main(store, tmp, "--min-kb", "0")
        self.assertEqual(code, 3)
        self.assertEqual(store.objects, {})
        self.assertIn("audio", out)
        self.assertIn("Speicherkosten B2", out)
        self.assertIn(".txt", out)

    def test_hochladen_dedupe_index_und_fortsetzen(self):
        store = Store()
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home:
            make_tree(tmp)
            os.environ["HOME"] = home
            code, out = self.run_main(store, tmp, "--yes", "--min-kb", "0", "--tag", "Techno", "--workers", "2")
            self.assertEqual(code, 0, out)
            media = sorted(k for k in store.objects if k.startswith("media/") and not k.startswith("media/index/"))
            # 8 gültige Dateien, davon 1 Duplikat → 7 Objekte
            self.assertEqual(len(media), 7)
            self.assertTrue(any(k.startswith("media/audio/") and k.endswith(".dsf") for k in media))
            self.assertTrue(any(k.startswith("media/image/") and k.endswith(".cr3") for k in media))
            self.assertFalse(any("geloescht" in json.dumps(v) for v in store.meta.values()))
            index_key = next(k for k in store.objects if k.startswith("media/index/"))
            lines = [json.loads(x) for x in store.objects[index_key].decode().splitlines()]
            self.assertEqual(len(lines), 8)
            self.assertEqual(sum(1 for l in lines if l["state"] == "duplikat"), 1)
            self.assertTrue(all(l["tags"] == ["techno"] for l in lines))
            # Zweiter Lauf: nichts Neues, Hash-Cache greift
            code, out = self.run_main(store, tmp, "--yes", "--min-kb", "0")
            self.assertEqual(code, 0)
            self.assertIn("Fertig: 0 neu", out)
            self.assertTrue(os.path.exists(os.path.join(home, ".cache", "audiomonastry-ingest", "b2.json")))

    def test_nur_eine_art(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_tree(tmp)
            sc = ingest.scan(tmp, ["video"], 0)
        self.assertEqual([i.rel for i in sc.items], ["Clips/loop.mov"])

    def test_mini_dateien_werden_standardmaessig_uebersprungen(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_tree(tmp)
            self.assertEqual(ingest.scan(tmp, ingest.KINDS, 1024).items, [])

    def test_unbekannte_art_und_fehlender_ordner(self):
        self.assertEqual(self.run_main(Store(), "/gibt/es/nicht")[0], 2)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_main(Store(), tmp, "--kinds", "pdf")[0], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

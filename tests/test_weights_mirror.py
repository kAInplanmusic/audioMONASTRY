"""Gewichte-Spiegel ↔ Pod-Start, durchgehend ohne Netz.

Ein gefälschter Hugging-Face-Download erzeugt ein echtes HF-Cache-Layout (blobs +
Snapshot-Symlink). Der Spiegel packt es, legt Archiv + SHA-256 in einen Speicher-Stub;
pod_start.py lädt es per file://-URL, prüft den Hash und entpackt – der Snapshot-Link
zeigt danach auf die Datei.

Lauf: python3 tests/test_weights_mirror.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "services" / "audiomonastry-ai-runtime"))


def _load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


mirror = _load("weights_mirror", ROOT / "scripts" / "weights-mirror.py")
import pod_start  # noqa: E402


class Store:
    def __init__(self, present=()):
        self.objects = {k: b"x" for k in present}
        self.files = {}

    def head(self, key):
        return {"content-length": str(len(self.objects[key]))} if key in self.objects else None

    def put_file(self, key, path, content_type, meta=None):
        with open(path, "rb") as fh:
            self.objects[key] = fh.read()
        self.files[key] = meta

    def put_bytes(self, key, data, content_type="", meta=None):
        self.objects[key] = data


def fake_download(repo, revision, cache_dir, token):
    base = os.path.join(cache_dir, "models--" + repo.replace("/", "--"))
    os.makedirs(os.path.join(base, "blobs"), exist_ok=True)
    rev = revision or "0" * 40
    snap = os.path.join(base, "snapshots", rev)
    os.makedirs(snap, exist_ok=True)
    with open(os.path.join(base, "blobs", "b1"), "wb") as fh:
        fh.write(f"weights of {repo}".encode())
    os.symlink(os.path.join("..", "..", "blobs", "b1"), os.path.join(snap, "model.safetensors"))
    return snap


class MirrorTest(unittest.TestCase):
    def setUp(self):
        mirror.download = fake_download

    def run_main(self, store, *argv):
        mirror.s3lite.S3Target.from_r2_env = staticmethod(lambda env=None: store)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = mirror.main(list(argv))
        return code, out.getvalue()

    def test_ohne_yes_nur_auflisten(self):
        store = Store()
        code, out = self.run_main(store, "--only", "stems")
        self.assertEqual(code, 3)
        self.assertEqual(store.objects, {})
        self.assertIn("weights/htdemucs-6s/", out)

    def test_vorhandene_werden_uebersprungen(self):
        pods = mirror._pods_module()
        key = pods.weight_key("weights", "htdemucs-6s", pods.load_models()["htdemucs-6s"]["revision"])
        code, out = self.run_main(Store(present=[key]), "--only", "stems", "--yes")
        self.assertEqual(code, 0)
        self.assertIn("Alles gespiegelt", out)

    def test_spiegel_und_pod_start_passen_zusammen(self):
        store = Store()
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self.run_main(store, "--only", "stems", "--yes", "--workdir", tmp)
            self.assertEqual(code, 0, out)
            tar_key = next(k for k in store.objects if k.endswith(".tar"))
            sha = store.objects[tar_key[:-4] + ".sha256"].decode().split()[0]
            self.assertEqual(store.files[tar_key]["sha256"], sha)
            src = os.path.join(tmp, "dl.tar")
            with open(src, "wb") as fh:
                fh.write(store.objects[tar_key])
            entry = {"name": "m.tar", "url": pathlib.Path(src).as_uri(), "sha256": sha}
            hf = os.path.join(tmp, "hf")
            pod_start.fetch_weights([entry], hf, os.path.join(tmp, "w"), parallel=1)
            rev = mirror._pods_module().load_models()["htdemucs-6s"]["revision"]
            link = os.path.join(hf, "hub", "models--dokodesuka--htdemucs_ft", "snapshots", rev, "model.safetensors")
            with open(link, "rb") as fh:
                self.assertEqual(fh.read(), b"weights of dokodesuka/htdemucs_ft")

    def test_pyannote_bringt_abhaengige_repos_mit(self):
        seen = []
        mirror.download = lambda repo, rev, cache, tok: (seen.append(repo), fake_download(repo, rev, cache, tok))[1]
        with tempfile.TemporaryDirectory() as tmp:
            mirror.build_archive("pyannote-diarization", mirror._pods_module().load_models()["pyannote-diarization"], tmp, None)
        self.assertEqual(seen, ["pyannote/speaker-diarization-3.1", "pyannote/segmentation-3.0",
                                "pyannote/wespeaker-voxceleb-resnet34-LM"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

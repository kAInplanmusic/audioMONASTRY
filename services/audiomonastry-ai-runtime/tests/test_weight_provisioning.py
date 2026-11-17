"""Regression checks for auxiliary weight integrity and pinned loader contracts."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import weight_assets as wa
import handlers_stems as hs
import handlers_fleet2026 as fleet
from model_manager import ModelDefinition
from registry import read_manifest


def definition(model_id):
    return ModelDefinition.from_dict(next(m for m in read_manifest()["models"] if m["id"] == model_id))


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = b"original checkpoint"
        self.spec = {"path": "model.bin", "size": len(self.data),
                     "sha256": hashlib.sha256(self.data).hexdigest(), "url": "https://example.test/model"}
        self.lock = {"fixture": {"files": [self.spec]}}
        self.enterContext(patch.dict(os.environ, {"AI_WEIGHT_ASSET_ROOT": self.tmp.name}))
        self.enterContext(patch.object(wa, "read_lock", return_value=self.lock))

    def test_download_and_cached_reuse(self):
        with patch.object(wa.urllib.request, "urlopen", return_value=io.BytesIO(self.data)) as fetch:
            paths = wa.ensure_assets("fixture")
            wa.ensure_assets("fixture")
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(Path(paths["model.bin"]).read_bytes(), self.data)

    def test_corrupted_asset_is_rejected_offline(self):
        p = Path(self.tmp.name) / "fixture/model.bin"
        p.parent.mkdir()
        p.write_bytes(b"x" * len(self.data))
        with self.assertRaisesRegex(RuntimeError, "missing/corrupt"):
            wa.ensure_assets("fixture", download=False)

    def test_bad_download_never_replaces_existing_asset(self):
        p = Path(self.tmp.name) / "fixture/model.bin"
        p.parent.mkdir()
        p.write_bytes(b"previous")
        with patch.object(wa.urllib.request, "urlopen", return_value=io.BytesIO(b"x" * len(self.data))):
            with self.assertRaisesRegex(RuntimeError, "mismatch"):
                wa.ensure_assets("fixture")
        self.assertEqual(p.read_bytes(), b"previous")
        self.assertEqual(list(p.parent.iterdir()), [p])

    def test_modified_file_invalidates_verified_cache(self):
        p = Path(self.tmp.name) / "fixture/model.bin"
        p.parent.mkdir()
        p.write_bytes(self.data)
        self.assertTrue(wa.verify_file(p, self.spec))
        p.write_bytes(b"x" * len(self.data))
        self.assertFalse(wa.verify_file(p, self.spec))


class ModelContracts(unittest.TestCase):
    def test_manifest_and_auxiliary_pins_agree(self):
        manifest = read_manifest()
        self.assertEqual(len(manifest["models"]), 22)
        for model_id in ("mvsep-mega-53", "mel-roformer-bve", "mel-roformer-dereverb", "beat-this"):
            d = definition(model_id)
            entry = wa.read_lock()[model_id]
            self.assertEqual((d.repository, d.revision), (entry["repository"], entry["revision"]))
        component = manifest["weightComponents"]["yue2-vae"]
        self.assertEqual(component["revision"], wa.read_lock()["yue2-vae"]["revision"])
        self.assertEqual(len(component["revision"]), 40)

    def test_studio_specialists_dispatch_and_residuals(self):
        mix = np.full((2, 128), 0.75, dtype=np.float32)
        for model_id, target, keys in (("mel-roformer-bve", "Lead", ["lead", "back"]),
                                       ("mel-roformer-dereverb", "noreverb", ["noreverb", "reverb"])):
            sep = types.SimpleNamespace(repository="test/repo", revision="pin", sample_rate=44100,
                                        separate=lambda x, name=target: {name: x * 0.25})
            with patch.object(hs, "get_separator", return_value=sep), \
                 patch.object(hs, "decode_audio", return_value=(mix, 44100)), \
                 patch("handlers_native._audio_bytes", return_value=b"audio"), \
                 patch.object(hs, "encode_wav", side_effect=lambda x, *a: x):
                result = hs.msst_stem_separate(model_id, definition(model_id), {})
            self.assertEqual(result["stemSet"], keys)
            self.assertTrue(np.allclose(sum(result["stems"].values()), mix))
            self.assertTrue(result["complementIsResidual"])

    def test_mega_overlapping_children_are_not_added_twice(self):
        mix = np.full((2, 4096), 0.8, dtype=np.float32)
        raw = {k: mix * 0.1 for k in ("vocal", "bass", "drums", "guitar", "piano")}
        raw.update({"kick": mix * 100, "lead-vocal": mix * 100, "acoustic-guitar": mix * 100})
        sep = types.SimpleNamespace(repository="test/repo", revision="pin", sample_rate=44100,
                                    instruments=tuple(raw), separate=lambda x: raw)
        with patch.object(hs, "get_separator", return_value=sep), \
             patch.object(hs, "decode_audio", return_value=(mix, 44100)), \
             patch("handlers_native._audio_bytes", return_value=b"audio"), \
             patch.object(hs, "encode_wav", side_effect=lambda x, *a: x):
            result = hs.msst_stem_separate("mvsep-mega-53", definition("mvsep-mega-53"), {})
        self.assertTrue(np.allclose(result["stems"]["vocals"], raw["vocal"]))
        self.assertTrue(np.allclose(result["stems"]["melody"], raw["guitar"] + raw["piano"]))
        self.assertTrue(np.allclose(sum(result["stems"].values()), mix, atol=1e-5))

    def test_universr_forwards_exact_revision(self):
        calls = []
        def factory(*args, **kwargs):
            calls.append((args, kwargs))
            raise RuntimeError("stop after load")
        module = types.SimpleNamespace(UniverSR=types.SimpleNamespace(from_pretrained=factory))
        with patch.object(fleet, "_require", return_value=module), \
             patch.object(fleet, "_audio", return_value=(np.zeros(8), 8000)), \
             patch.object(fleet, "_cached", side_effect=lambda key, fn: fn()):
            with self.assertRaisesRegex(RuntimeError, "stop after load"):
                fleet.universr_enhance("universr", definition("universr"), {})
        self.assertEqual(calls[0][1]["revision"], definition("universr").revision)

    def test_yue_forwards_both_model_and_vae_revisions(self):
        calls = []
        def factory(*args, **kwargs):
            calls.append((args, kwargs))
            raise RuntimeError("stop after load")
        module = types.SimpleNamespace(YuE2Pipeline=types.SimpleNamespace(from_pretrained=factory))
        with patch.object(fleet, "_require", return_value=module), \
             patch.object(wa, "ensure_assets", return_value={}), \
             patch.object(fleet, "_cached", side_effect=lambda key, fn: fn()):
            with self.assertRaisesRegex(RuntimeError, "stop after load"):
                fleet.yue2_song("yue2-3b", definition("yue2-3b"), {"style": "bluegrass", "lyrics": "Hello"})
        self.assertEqual(calls[0][1]["revision"], definition("yue2-3b").revision)
        self.assertEqual(calls[0][1]["vae_revision"], read_manifest()["weightComponents"]["yue2-vae"]["revision"])

    def test_role_prepares_yue_component(self):
        with patch.object(wa, "ensure_assets", return_value={}) as ensure:
            prepared = wa.prepare_role_assets(["yue2-3b"])
        self.assertEqual(prepared, ["yue2-vae"])
        ensure.assert_called_once_with("yue2-vae")


class RuntimeRoleTests(unittest.TestCase):
    def test_all_selected_roles_are_accepted_and_configurable(self):
        import registry
        from model_manager import ModelManager
        pods = json.loads((Path(__file__).resolve().parents[3] / "deploy/gpu/pod-fleet.json").read_text())
        expected = {p["aiRole"] for p in pods["pods"]} | {pods["visPod"]["aiRole"]}
        self.assertEqual(set(registry.ROLE_IDS), expected)
        self.assertEqual(set(read_manifest()["roles"]), expected)
        for role in expected:
            with self.subTest(role=role):
                ModelManager().configure(registry.load_manifest(role))


if __name__ == "__main__":
    unittest.main()

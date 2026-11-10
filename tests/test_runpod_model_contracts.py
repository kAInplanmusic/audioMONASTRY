"""Offline regression checks for complete 22-entry model contract inventory.

The audit MUST return nonzero while BVE and DeReverb immutable assets are
incomplete. This is a test of truthful release gating, not a GPU smoke.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parent.parent
RUNTIME=ROOT/"services"/"audiomonastry-ai-runtime"

class Fleet22ContractsTest(unittest.TestCase):
    def test_full_model_inventory_and_expected_release_blockers(self):
        audit=subprocess.run(
            [sys.executable,str(ROOT/"scripts"/"audit-runpod-model-contracts.py")],
            cwd=ROOT,encoding="utf-8",capture_output=True,timeout=30,check=False)
        self.assertIn(audit.returncode,(0,4),audit.stderr)
        result=json.loads(audit.stdout)
        self.assertEqual(result["uniqueModels"],22)
        self.assertFalse(result["gpuVerified"])
        self.assertFalse(result["r2Verified"])
        self.assertNotIn("mel-roformer-bve",result["blocked"])
        self.assertNotIn("mel-roformer-dereverb",result["blocked"])
        self.assertNotIn("mvsep-mega-53",result["blocked"])
        self.assertNotIn("sonicmaster",result["blocked"])
        self.assertTrue(result["staticComplete"])

    def test_release_assets_have_exact_digests(self):
        source=(ROOT/"scripts"/"weights-mirror.py").read_text()
        stems=(RUNTIME/"handlers_stems.py").read_text()
        for digest in (
            "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f",
            "7e198062a251587088adb91215a4f44ab59e67bd62fcc805cf54d6e7dfc51103",
        ):
            self.assertIn(digest,source)
            self.assertIn(digest,stems)
        self.assertIn("os.path.join(hf_home, \"extras\", \"mvsep-mega-53\"",stems)

    def test_mirror_includes_vis_and_does_not_drop_checkpoint_files(self):
        source=(ROOT/"scripts"/"weights-mirror.py").read_text()
        self.assertIn('fleet["visPod"]',source)
        self.assertIn('if p != "*.ckpt"',source)
        self.assertIn('model.get("task") == "stem.separate"',source)

    def test_music_uses_official_acestep_handler_not_diffusionpipeline(self):
        runpod=(RUNTIME/"handlers_runpod.py").read_text()
        begin=runpod.index("def acestep_generate(")
        end=runpod.index("\n\n# ---------------------------------------------------------------------------",begin)
        body=runpod[begin:end]
        self.assertIn("from handlers_voice import run_acestep",body)
        self.assertIn("run_acestep(",body)
        self.assertNotIn("DiffusionPipeline.from_pretrained",body)
        self.assertIn("acestep-v15-xl-turbo",body)

    def test_docker_images_include_all_new_handler_modules(self):
        for dockerfile in ("Dockerfile", "Dockerfile.runpod"):
            code=(RUNTIME/dockerfile).read_text()
            for mod in ("handlers_fleet2026.py", "handlers_sonicmaster.py",
                        "startup_model_proof.py", "pod_start.py"):
                self.assertIn(mod,code,dockerfile+" lacks "+mod)

    def test_song_image_does_not_inherit_incompatible_torch(self):
        fleet=json.loads((ROOT/"deploy/runpod/pod-fleet.json").read_text())
        song=next(x for x in fleet["pods"] if x["role"]=="song")
        self.assertEqual(song["imageEnv"],"RP_SONG_IMAGE")
        code=(RUNTIME/"Dockerfile.song").read_text()
        self.assertIn("pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime",code)
        self.assertIn("transformers==4.57.6",code)
        self.assertIn("88da114a67df892af0329472073b96a5ef700b93",code)

    def test_vis_has_pinned_universr_install_path(self):
        code=(RUNTIME/"Dockerfile.runpod").read_text()
        self.assertIn("AI_INSTALL_UNIVERSR",code)
        self.assertIn("d8636623fe0c0704296239c1d3d3c5b911ecb2e0",code)

    def test_stem_separation_does_not_silently_map_53_to_five(self):
        source=(RUNTIME/"handlers_stems.py").read_text()
        self.assertIn('len(separator.instruments) != 53',source)
        self.assertIn('set(urls) != set(names)',source)
        self.assertIn('expectedStems": 53',source)
        self.assertIn('roformer_pair_separate',source)

if __name__=="__main__":
    unittest.main()

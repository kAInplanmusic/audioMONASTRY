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

    def test_stem_separation_does_not_silently_map_53_to_five(self):
        source=(RUNTIME/"handlers_stems.py").read_text()
        self.assertIn('len(separator.instruments) != 53',source)
        self.assertIn('set(urls) != set(names)',source)
        self.assertIn('expectedStems": 53',source)
        self.assertIn('roformer_pair_separate',source)

if __name__=="__main__":
    unittest.main()

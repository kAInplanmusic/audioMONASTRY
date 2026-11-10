"""Verify deterministic GPU-ready fixture generation without model weights/CUDA."""
from __future__ import annotations
import base64
import importlib.util
import json
import pathlib
import tempfile
import unittest
import wave
import io

RUNTIME=pathlib.Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location("generate_model_probes",RUNTIME/"generate_model_probes.py")
generator=importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

class ModelProbeFixturesTests(unittest.TestCase):
    def test_all_eight_roles_have_complete_direct_probes(self):
        manifest=json.loads((RUNTIME/"model_manifest.json").read_text())
        self.assertEqual(len(manifest["models"]),22)
        expected_roles=("brain","ears","voiceGen","music","studio","executor","song","vis")
        self.assertEqual(set(manifest["roles"]),set(expected_roles))
        with tempfile.TemporaryDirectory() as folder:
            for role in expected_roles:
                with self.subTest(role=role):
                    output=pathlib.Path(folder)/(role+".json")
                    ids=generator.generate(role,output)
                    probes=json.loads(output.read_text())["models"]
                    self.assertEqual(sorted(probes),ids)
                    self.assertEqual(set(probes),
                        set(manifest["roles"][role]["models"])-generator.DEPENDENCIES)
                    self.assertLess(output.stat().st_size,8*1024*1024)
                    self.assertEqual(output.stat().st_mode & 0o777,0o600)
                    for model_id,data in probes.items():
                        self.assertIn(data["kind"],{"audio","midi","structured","text"})
                        self.assertIsInstance(data["input"],dict)
                        self.assertTrue(data["requiredResultKeys"])
                        self.assertEqual(data["task"],
                            next(m["task"] for m in manifest["models"] if m["id"]==model_id))
                        source=data["input"].get("audioBase64")
                        if source:
                            with wave.open(io.BytesIO(base64.b64decode(source))) as wav:
                                self.assertEqual(wav.getnchannels(),1)
                                self.assertGreater(wav.getnframes(),0)

    def test_live_model_fixture_uses_strict_short_53_stem_probe(self):
        entry=generator.fixture("mvsep-mega-53",
            {"audioBase64":generator.synthetic_audio(16000,.8)})
        self.assertEqual(entry["input"]["inlineMaxSeconds"],1)
        self.assertIn("expectedStems",entry["requiredResultKeys"])

    def test_no_unknown_role_or_model_is_fabricated(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                generator.generate("fake",pathlib.Path(folder)/"fake.json")
        with self.assertRaises(ValueError):
            generator.fixture("not-a-model",{})

if __name__=="__main__":
    unittest.main()

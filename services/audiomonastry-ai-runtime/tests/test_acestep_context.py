"""LEGO-P1-001: ACE-Step-1.5-Kontext-Tasks (lego/extract/complete/repaint) ohne GPU.

    python3 services/audiomonastry-ai-runtime/tests/test_acestep_context.py

Geprueft wird der Vertrag, nicht die Inferenz (kein Live-GPU-Lauf moeglich):
* Abbildung unserer Argumente auf ACE-Step `GenerationParams` (task_type,
  instruction-Wortlaut, caption, repainting_*, Modus -> audio_cover_strength),
* Base-only-Regel fuer lego/extract/complete,
* ComfyUI-Worker lehnt Kontext-Tasks klar ab (kein stiller Text2Music-Song),
* Mischen der Kontext-Spuren (reihenfolge-unabhaengig, Headroom),
* Dispatch `song` + `aceTask` -> `acestep_context_task` (Mock).
"""
from __future__ import annotations

import pathlib
import sys
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import comfyui_adapter as adapter  # noqa: E402

CTX = [{"id": "drums-1", "audioBase64": "AAAA"}]


class AceStepParamsTest(unittest.TestCase):
    def test_lego_instruction_und_caption(self) -> None:
        params = adapter.build_acestep_task_params(
            {"aceTask": "lego", "track": "bass", "prompt": "deep rolling bass", "contextAudio": CTX, "bpm": 124, "keyscale": "A Minor"},
            "acestep-v15-xl-base",
        )
        self.assertEqual(params["task_type"], "lego")
        self.assertEqual(params["instruction"], "Generate the bass track based on the audio context:")
        self.assertEqual(params["caption"], "deep rolling bass")
        self.assertEqual(params["bpm"], 124)
        self.assertEqual(params["keyscale"], "A Minor")
        self.assertEqual(params["seed"], -1)

    def test_extract_ohne_caption(self) -> None:
        params = adapter.build_acestep_task_params({"aceTask": "extract", "track": "vocals", "contextAudio": CTX})
        self.assertEqual(params["instruction"], "Extract the vocals track from the audio:")
        self.assertNotIn("caption", params)

    def test_complete_listet_spuren(self) -> None:
        params = adapter.build_acestep_task_params(
            {"aceTask": "complete", "tracks": ["drums", "bass", "guitar"], "prompt": "indie", "contextAudio": CTX}
        )
        self.assertEqual(params["instruction"], "Complete the input track with drums, bass, guitar:")

    def test_repaint_modi(self) -> None:
        for mode, strength in (("conservative", 0.8), ("balanced", 0.5), ("aggressive", 0.2)):
            params = adapter.build_acestep_task_params(
                {"aceTask": "repaint", "prompt": "x", "contextAudio": CTX, "repaintStart": 4, "repaintEnd": 12, "repaintMode": mode},
                "acestep-v15-xl-turbo",
            )
            self.assertEqual(params["task_type"], "repaint")
            self.assertEqual(params["repainting_start"], 4.0)
            self.assertEqual(params["repainting_end"], 12.0)
            self.assertEqual(params["audio_cover_strength"], strength)
            self.assertEqual(params["chunk_mask_mode"], "explicit")

    def test_repaint_bis_dateiende(self) -> None:
        params = adapter.build_acestep_task_params(
            {"aceTask": "repaint", "prompt": "x", "contextAudio": CTX, "repaintStart": 4, "repaintEnd": -1}
        )
        self.assertEqual(params["repainting_end"], -1.0)

    def test_fehler_sind_klar(self) -> None:
        cases = [
            ({"aceTask": "dance", "contextAudio": CTX}, ""),
            ({"aceTask": "lego", "track": "kazoo", "prompt": "x", "contextAudio": CTX}, ""),
            ({"aceTask": "lego", "track": "bass", "prompt": "", "contextAudio": CTX}, ""),
            ({"aceTask": "lego", "track": "bass", "prompt": "x", "contextAudio": []}, ""),
            ({"aceTask": "lego", "track": "bass", "prompt": "x", "contextAudio": CTX * 9}, ""),
            ({"aceTask": "extract", "track": "bass", "contextAudio": CTX * 2}, ""),
            ({"aceTask": "repaint", "prompt": "x", "contextAudio": CTX, "repaintStart": 5, "repaintEnd": 2}, ""),
            ({"aceTask": "repaint", "prompt": "x", "contextAudio": CTX, "repaintStart": 0, "repaintEnd": 2, "repaintMode": "wild"}, ""),
            # Base-only: lego mit Turbo-Modell ist laut ACE-Step-Doku nicht moeglich.
            ({"aceTask": "lego", "track": "bass", "prompt": "x", "contextAudio": CTX}, "acestep-v15-xl-turbo"),
        ]
        for args, model in cases:
            with self.subTest(args=args, model=model), self.assertRaises(ValueError):
                adapter.build_acestep_task_params(args, model)

    def test_comfyui_worker_lehnt_kontext_tasks_ab(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            adapter.build_request(
                "music.lego", "music", "acestep-v15-xl-base",
                {"aceTask": "lego", "track": "bass", "prompt": "x", "contextAudio": CTX},
            )
        self.assertIn("acestep_context_task", str(ctx.exception))

    def test_spurnamen_entsprechen_ts_spiegel(self) -> None:
        ts = (RUNTIME_DIR.parent.parent / "src/core/ai/orchestrator/musicContextTools.ts").read_text(encoding="utf-8")
        for name in adapter.ACE_STEP_TRACK_NAMES:
            self.assertIn(f"'{name}'", ts)
        for mode, strength in adapter.REPAINT_MODE_COVER_STRENGTH.items():
            self.assertIn(f"{mode}: {strength}", ts)


try:
    import numpy as np  # noqa: F401

    HAS_NUMPY = True
except Exception:  # noqa: BLE001
    HAS_NUMPY = False


@unittest.skipUnless(HAS_NUMPY, "numpy fehlt")
class MixAndDispatchTest(unittest.TestCase):
    def setUp(self) -> None:
        import handlers_runpod

        self.hr = handlers_runpod

    def test_mischung_ist_reihenfolge_unabhaengig(self) -> None:
        import numpy as np

        a = (np.full(100, 0.2, dtype=np.float32), 48000)
        b = (np.full((50, 2), 0.3, dtype=np.float32), 48000)
        m1, sr1 = self.hr.mix_context_audio([a, b])
        m2, sr2 = self.hr.mix_context_audio([b, a])
        self.assertEqual(sr1, 48000)
        self.assertEqual(sr1, sr2)
        self.assertEqual(m1.shape, (100, 2))
        self.assertTrue(np.allclose(m1, m2))
        self.assertAlmostEqual(float(m1[0, 0]), 0.5, places=5)
        self.assertAlmostEqual(float(m1[99, 1]), 0.2, places=5)

    def test_mischung_normiert_ueberlauf(self) -> None:
        import numpy as np

        loud = (np.full(10, 0.9, dtype=np.float32), 44100)
        mix, _ = self.hr.mix_context_audio([loud, loud])
        self.assertLessEqual(float(np.max(np.abs(mix))), self.hr.ACESTEP_MIX_HEADROOM + 1e-6)

    def test_abweichende_abtastrate_wird_umgerechnet(self) -> None:
        import numpy as np

        mix, sr = self.hr.mix_context_audio([(np.zeros(480), 48000), (np.zeros(441), 44100)])
        self.assertEqual(sr, 48000)
        self.assertEqual(mix.shape[0], 480)

    def test_song_mit_aceTask_geht_an_kontext_handler(self) -> None:
        from unittest import mock

        try:
            import handlers
        except Exception as exc:  # noqa: BLE001 - schwere Abhaengigkeiten im Testsystem
            self.skipTest(f"handlers nicht importierbar: {exc}")
        from model_manager import ModelDefinition

        definition = ModelDefinition.from_dict(
            {"id": "acestep-v15-xl-base", "repository": "ACE-Step/acestep-v15-xl-base", "revision": "x", "task": "song"}
        )
        with mock.patch.object(handlers, "acestep_context_task", return_value={"ok": "ctx"}) as ctx, \
                mock.patch.object(handlers, "acestep_generate", return_value={"ok": "gen"}) as gen:
            self.assertEqual(handlers.generate_dispatch_runpod("acestep-v15-xl-base", definition, {"aceTask": "lego"}), {"ok": "ctx"})
            self.assertEqual(handlers.generate_dispatch_runpod("acestep-v15-xl-base", definition, {"prompt": "x"}), {"ok": "gen"})
        ctx.assert_called_once()
        gen.assert_called_once()

    def test_ungueltige_argumente_werden_model_unavailable(self) -> None:
        from model_manager import ModelDefinition, ModelUnavailableError

        definition = ModelDefinition.from_dict(
            {"id": "acestep-v15-xl-turbo", "repository": "ACE-Step/acestep-v15-xl-turbo", "revision": "x", "task": "song"}
        )
        with self.assertRaises(ModelUnavailableError):
            self.hr.acestep_context_task(
                "acestep-v15-xl-turbo", definition, {"aceTask": "lego", "track": "bass", "prompt": "x", "contextAudio": CTX}
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)

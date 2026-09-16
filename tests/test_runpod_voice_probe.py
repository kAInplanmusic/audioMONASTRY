"""Tests fuer scripts/runpod-voice-probe.py (Payload-Vertrag der Voice-Tasks).

Lauf: python3 tests/test_runpod_voice_probe.py
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import io
import pathlib
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "runpod-voice-probe.py"


def load_probe() -> Any:
    spec = importlib.util.spec_from_file_location("runpod_voice_probe", SCRIPT)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


probe = load_probe()


def _wav_bytes(samples: int = 100) -> bytes:
    """Minimales WAV (Header + Nullsamples) - reicht fuer die Base64-Strecke."""
    data = b"\x00\x00" * samples
    header = b"RIFF" + (36 + len(data)).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little")
    header += (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + (16000).to_bytes(4, "little")
    header += (32000).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
    header += b"data" + len(data).to_bytes(4, "little")
    return header + data


def _namespace(**kwargs: Any) -> argparse.Namespace:
    base = {
        "task": "tts",
        "model": "fish-speech-1.5",
        "text": "Hallo Welt",
        "reference": "",
        "reference_text": "",
        "source": "",
        "target": "",
        "tau": 0.3,
    }
    base.update(kwargs)
    return argparse.Namespace(**base)


class BuildPayloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = pathlib.Path(self._tmp.name)
        self.wav = self.dir / "ref.wav"
        self.wav.write_bytes(_wav_bytes())

    def test_tts_ohne_referenz_ist_reiner_text(self) -> None:
        payload = probe.build_payload(_namespace())
        self.assertEqual(payload["text"], "Hallo Welt")
        self.assertEqual(payload["task"], "tts")
        self.assertNotIn("referenceAudioBase64", payload)

    def test_tts_mit_referenz_klont(self) -> None:
        payload = probe.build_payload(_namespace(reference=str(self.wav), reference_text="Probe"))
        decoded = base64.b64decode(payload["referenceAudioBase64"])
        self.assertEqual(decoded[:4], b"RIFF")
        self.assertEqual(payload["referenceText"], "Probe")

    def test_convert_braucht_quelle_und_ziel(self) -> None:
        with self.assertRaises(SystemExit):
            probe.build_payload(_namespace(task="voice.convert", model="openvoice-v2", source=str(self.wav)))
        with self.assertRaises(SystemExit):
            probe.build_payload(_namespace(task="voice.convert", model="openvoice-v2", target=str(self.wav)))

    def test_convert_uebertraegt_tau_und_quelle(self) -> None:
        payload = probe.build_payload(
            _namespace(
                task="voice.convert",
                model="openvoice-v2",
                source=str(self.wav),
                target=str(self.wav),
                tau=0.45,
            )
        )
        self.assertEqual(payload["tau"], 0.45)
        self.assertIn("sourceAudioBase64", payload)
        self.assertIn("targetReferenceBase64", payload)

    def test_zu_kleine_datei_wird_abgelehnt(self) -> None:
        klein = self.dir / "klein.wav"
        klein.write_bytes(b"RIFF")
        with self.assertRaises(SystemExit):
            probe.build_payload(_namespace(reference=str(klein)))


class SummarizeTest(unittest.TestCase):
    def test_lange_nutzlast_wird_gekuerzt(self) -> None:
        summary = probe.summarize_output({"audioBase64": "A" * 5000, "sampleRate": 44100})
        self.assertIn("5000 Zeichen", summary)
        self.assertNotIn("A" * 300, summary)

    def test_kurze_werte_bleiben_lesbar(self) -> None:
        self.assertIn("sampleRate=44100", probe.summarize_output({"sampleRate": 44100}))


class EndpointResolutionTest(unittest.TestCase):
    def test_endpoint_kommt_aus_der_umgebung(self) -> None:
        with mock.patch.dict("os.environ", {"RP_ENDPOINT_ID_VOICE": "voice-ep"}):
            self.assertEqual(probe._endpoint_id(""), "voice-ep")

    def test_explizite_id_gewinnt(self) -> None:
        with mock.patch.dict("os.environ", {"RP_ENDPOINT_ID_VOICE": "voice-ep"}):
            self.assertEqual(probe._endpoint_id("andere"), "andere")

    def test_fehlende_id_ist_klar(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(SystemExit):
                probe._endpoint_id("")


if __name__ == "__main__":
    unittest.main(verbosity=2)

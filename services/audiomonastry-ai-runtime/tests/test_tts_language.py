"""Tests: Sprachangabe fuer Qwen3-TTS (Live-Regression vom 2026-09-17).

Der Worker brach mit `Unsupported languages: ['DE']` ab, weil der Aufrufer den
ISO-Code sendet, das Modell aber ausgeschriebene Namen erwartet. Der Aufrufer sah
`MODEL_UNAVAILABLE` und hielt es fuer einen Modellfehler - dabei war es eine
Schreibweise. Diese Tests halten die Zuordnung fest.

Lauf: python3 services/audiomonastry-ai-runtime/tests/test_tts_language.py
"""
from __future__ import annotations

import base64
import io
import pathlib
import sys
import unittest
from unittest import mock

RUNTIME = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))

import handlers  # noqa: E402
from model_manager import ModelDefinition, ModelUnavailableError  # noqa: E402


class NormalizeLanguageTest(unittest.TestCase):
    def test_iso_codes_werden_zu_sprachnamen(self) -> None:
        for value, expected in (
            ("DE", "german"),
            ("de", "german"),
            ("de-DE", "german"),
            ("de_DE", "german"),
            ("deu", "german"),
            ("ger", "german"),
            ("deutsch", "german"),
            ("EN", "english"),
            ("zh", "chinese"),
            ("  FR  ", "french"),
        ):
            with self.subTest(value=value):
                self.assertEqual(handlers.normalize_tts_language(value), expected)

    def test_modellnamen_bleiben_wie_sie_sind(self) -> None:
        for name in sorted(handlers.QWEN3_TTS_LANGUAGES):
            with self.subTest(language=name):
                self.assertEqual(handlers.normalize_tts_language(name), name)

    def test_leere_angabe_nutzt_den_standard(self) -> None:
        for value in ("", "   ", None):
            self.assertEqual(handlers.normalize_tts_language(value), "german")
        self.assertEqual(handlers.normalize_tts_language(None, "english"), "english")

    def test_unbekannte_sprache_ist_klar(self) -> None:
        with self.assertRaises(ModelUnavailableError) as ctx:
            handlers.normalize_tts_language("klingon")
        message = str(ctx.exception)
        self.assertIn("klingon", message)
        self.assertIn("german", message)  # die erlaubten Werte stehen drin


class HandlerUsesNormalizerTest(unittest.TestCase):
    """Der Handler darf den rohen Wert nicht mehr ans Modell durchreichen."""

    def _run(self, payload_language: object) -> str:
        captured: dict[str, object] = {}

        class _FakeModel:
            def generate_custom_voice(self, **kwargs: object):
                captured.update(kwargs)
                return [b"\x00\x01"], 16000

        fake_tts = mock.MagicMock()
        fake_tts.Qwen3TTSModel.from_pretrained.return_value = _FakeModel()
        # Der Handler importiert `Qwen3TTSModel` direkt (from qwen_tts import ...),
        # deshalb muss das Modul in sys.modules stehen - _require_lib allein reicht nicht.
        fake_tts_module = mock.MagicMock()
        fake_tts_module.Qwen3TTSModel = fake_tts.Qwen3TTSModel
        fake_scipy = mock.MagicMock()
        fake_scipy.io.wavfile.write.side_effect = lambda buf, sr, audio: buf.write(b"wav")
        fake_numpy = mock.MagicMock()
        fake_numpy.asarray.return_value = [0.0]

        libs = {
            "qwen_tts": fake_tts,
            "torch": mock.MagicMock(),
            "numpy": fake_numpy,
            "scipy": fake_scipy,
            "scipy.io.wavfile": fake_scipy.io.wavfile,
        }
        with mock.patch.dict(sys.modules, {"qwen_tts": fake_tts_module}), \
             mock.patch.object(handlers, "_require_lib", side_effect=lambda name, pip: libs.get(name, mock.MagicMock())), \
             mock.patch.object(handlers, "_cache_get", side_effect=lambda key, factory: factory()), \
             mock.patch.object(handlers, "_device", return_value=mock.MagicMock(type="cpu")):
            definition = ModelDefinition.from_dict(
                {
                    "id": "qwen3-tts-17b",
                    "repository": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
                    "revision": "0" * 40,
                    "task": "tts",
                }
            )
            result = handlers.qwen3_tts(
                "qwen3-tts-17b", definition, {"text": "Hallo", "language": payload_language}
            )
        self.assertTrue(base64.b64decode(result["audioBase64"]))
        return str(captured.get("language"))

    def test_iso_code_wird_normalisiert_weitergereicht(self) -> None:
        self.assertEqual(self._run("DE"), "german")

    def test_ohne_angabe_german(self) -> None:
        self.assertEqual(self._run(None), "german")


if __name__ == "__main__":
    unittest.main(verbosity=2)

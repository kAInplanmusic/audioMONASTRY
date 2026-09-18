"""Vertragstest: Qwen3-TTS-Handler der AI-Runtime (`handlers.qwen3_tts`).

Warum dieser Test: der Handler ist der einzige Ort, an dem `qwen-tts` wirklich
benutzt wird - und das Paket ist **optional** (der Image-Build aktiviert es mit
`--build-arg AI_INSTALL_VOICE_AI=1`, sonst bleibt ein schlankes Basis-Image).
Ohne Test haengt die gesamte voiceMONK-Kette an einem Pfad, den die Suite nie
ausfuehrt. Hier laeuft er mit **gestubbten** Abhaengigkeiten (`qwen_tts`, `torch`,
`numpy`, `scipy`) - stdlib only, kein pip-Install, in der CI lauffaehig.

Festgehalten wird:
  * der Rueckgabe-Vertrag (`{audioBase64, sampleRate}` mit dekodierbarem WAV),
  * dass Text/Sprache/Sprecher UNVERAENDERT an das Modell gehen (die deutsche
    Sprach-Normalisierung passiert davor im Node-Server, nicht hier),
  * die Sprach-Zuordnung ISO -> Name,
  * dass `instruct` nur beim 1.7B-Modell mitgeschickt wird (0.6B kann es nicht),
  * ehrliche Fehler: leerer Text und fehlendes Paket sind unterscheidbar.

Lauf: python3 services/audiomonastry-ai-runtime/tests/test_qwen3_tts_handler.py
"""
from __future__ import annotations

import base64
import io
import pathlib
import sys
import types
import unittest
import wave
from unittest import mock

RUNTIME = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))

import handlers  # noqa: E402
from model_manager import ModelDefinition, ModelUnavailableError  # noqa: E402


class FakeQwen3TTSModel:
    """Minimales Modell-Stand-in: merkt sich die Aufrufparameter, liefert WAV-Daten."""

    calls: list[dict] = []

    @classmethod
    def from_pretrained(cls, repository: str, **kwargs):  # noqa: ANN003, ANN206
        cls.calls.append({"from_pretrained": repository, **kwargs})
        return cls()

    def generate_custom_voice(self, **kwargs):  # noqa: ANN003
        type(self).calls.append(dict(kwargs))
        # 0.1 s "Audio" bei 24 kHz - reicht, um den Rueckgabevertrag zu pruefen.
        samples = [[0.0] * 2400]
        return samples, 24000


def _install_stubs() -> None:
    """Ersetzt qwen_tts/torch/numpy/scipy durch stdlib-taugliche Stubs."""
    qwen = types.ModuleType("qwen_tts")
    qwen.Qwen3TTSModel = FakeQwen3TTSModel

    torch = types.ModuleType("torch")
    torch.bfloat16 = "bfloat16"
    torch.float32 = "float32"

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def current_device() -> int:
            return 0

    torch.cuda = _Cuda()
    torch.device = lambda name: types.SimpleNamespace(type=name)

    numpy = types.ModuleType("numpy")
    numpy.float32 = "float32"
    numpy.asarray = lambda data, dtype=None: list(data)  # noqa: ARG005

    scipy = types.ModuleType("scipy")
    scipy_io = types.ModuleType("scipy.io")
    scipy_wavfile = types.ModuleType("scipy.io.wavfile")

    def _write(fh, rate, data):  # noqa: ANN001
        with wave.open(fh, "wb") as wav:  # type: ignore[arg-type]
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(int(rate))
            wav.writeframes(b"\x00\x00" * len(data))

    scipy_wavfile.write = _write
    scipy_io.wavfile = scipy_wavfile
    scipy.io = scipy_io

    sys.modules.update({
        "qwen_tts": qwen,
        "torch": torch,
        "numpy": numpy,
        "scipy": scipy,
        "scipy.io": scipy_io,
        "scipy.io.wavfile": scipy_wavfile,
    })


def _definition(repository: str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice") -> ModelDefinition:
    return ModelDefinition(
        id="qwen3-tts-test",
        repository=repository,
        revision="main",
        task="tts",
    )


class Qwen3TtsHandlerTest(unittest.TestCase):
    def setUp(self) -> None:
        FakeQwen3TTSModel.calls = []
        handlers._MODEL_CACHE.clear()
        _install_stubs()

    def tearDown(self) -> None:
        for name in ("qwen_tts", "torch", "numpy", "scipy", "scipy.io", "scipy.io.wavfile"):
            sys.modules.pop(name, None)

    def test_liefert_dekodierbares_wav_und_gibt_den_text_unveraendert_weiter(self) -> None:
        result = handlers.qwen3_tts(
            "qwen3-tts-test",
            _definition(),
            {"text": "Guten Abend, zwei Komma fuenf Dezibel.", "language": "DE", "speaker": "Ryan"},
        )
        self.assertIn("audioBase64", result)
        self.assertEqual(result["sampleRate"], 24000)

        with wave.open(io.BytesIO(base64.b64decode(result["audioBase64"])), "rb") as wav:
            self.assertEqual(wav.getframerate(), 24000)
            self.assertGreater(wav.getnframes(), 0)

        call = FakeQwen3TTSModel.calls[-1]
        # Die Normalisierung passiert im Node-Server VOR dem Aufruf - hier darf
        # nichts umgeschrieben werden, sonst gaebe es zwei Wahrheiten.
        self.assertEqual(call["text"], "Guten Abend, zwei Komma fuenf Dezibel.")
        self.assertEqual(call["language"], "german")  # ISO-Code -> Modell-Schreibweise
        self.assertEqual(call["speaker"], "Ryan")

    def test_instruct_nur_beim_1_7b_modell(self) -> None:
        handlers.qwen3_tts(
            "qwen3-tts-test",
            _definition("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
            {"text": "Hallo", "language": "german", "instruct": "freundlich"},
        )
        self.assertEqual(FakeQwen3TTSModel.calls[-1]["instruct"], "freundlich")

        handlers._MODEL_CACHE.clear()
        handlers.qwen3_tts(
            "qwen3-tts-test-06",
            _definition("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
            {"text": "Hallo", "language": "german", "instruct": "freundlich"},
        )
        self.assertNotIn("instruct", FakeQwen3TTSModel.calls[-1])

    def test_leerer_text_ist_ein_klarer_fehler(self) -> None:
        with self.assertRaises(ModelUnavailableError) as ctx:
            handlers.qwen3_tts("qwen3-tts-test", _definition(), {"text": "   "})
        self.assertIn("text required", str(ctx.exception))

    def test_fehlendes_paket_nennt_das_pip_paket(self) -> None:
        sys.modules.pop("qwen_tts", None)
        real_import = __import__

        def fake_import(name, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
            if name == "qwen_tts":
                raise ModuleNotFoundError("No module named 'qwen_tts'")
            return real_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=fake_import):
            with self.assertRaises(ModelUnavailableError) as ctx:
                handlers.qwen3_tts("qwen3-tts-test", _definition(), {"text": "Hallo"})
        self.assertIn("pip install qwen-tts", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()

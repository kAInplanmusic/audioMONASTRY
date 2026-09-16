"""Tests: Voice-Clone/-Convert (fish-speech + OpenVoice V2) ohne GPU und ohne venv.

Die schweren Abhaengigkeiten (torch/numpy/soundfile) liegen bewusst NICHT im
Test-Environment der CI. Geprueft wird deshalb, was ohne sie belastbar ist:

* die Bridges melden fehlende Abhaengigkeiten ehrlich (`MODEL_UNAVAILABLE`, Exit 12)
  statt zu crashen oder leere Ergebnisse zu liefern,
* sie lehnen ungueltige Anfragen ab (Exit 13),
* der Handler findet venv/Bridge nicht still, sondern mit klarer Meldung,
* das Dispatch schickt fish-speech/openvoice an den richtigen Pfad,
* das Manifest fuehrt beide Modelle gepinnt und mit Lizenzkennzeichnung.

Die echten Inferenzpfade werden im Image verifiziert (dort laufen venv und
Audio-Bibliotheken) und live auf dem voice-Endpoint - siehe
`Dockerfile.voicedeps` (Gates 1-4) und die Live-Belege in logs/.

Lauf: python3 services/audiomonastry-ai-runtime/tests/test_voice_bridges.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
RUNTIME = ROOT / "services" / "audiomonastry-ai-runtime"
sys.path.insert(0, str(RUNTIME))

import handlers  # noqa: E402  (Pfad muss vorher stehen)
from model_manager import ModelDefinition, ModelUnavailableError  # noqa: E402

MANIFEST = json.loads((RUNTIME / "model_manifest.json").read_text(encoding="utf-8"))

HAS_AUDIO_DEPS = all(importlib.util.find_spec(name) for name in ("numpy", "soundfile"))


def _bridge(script: str, *args: str, stdin: str = "") -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(RUNTIME / script), *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _definition(model_id: str) -> ModelDefinition:
    entry = next(item for item in MANIFEST["models"] if item["id"] == model_id)
    return ModelDefinition.from_dict(entry)


class BridgeContractTest(unittest.TestCase):
    """Beide Bridges melden ohne venv ehrlich - und crashen nicht."""

    def test_clone_bridge_meldet_fehlende_venv(self) -> None:
        proc = _bridge("voice_clone_bridge.py", "--selftest")
        self.assertEqual(proc.returncode, 12)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "MODEL_UNAVAILABLE")
        self.assertIn("voiceclone-venv", payload["error"])

    def test_convert_bridge_meldet_fehlende_venv(self) -> None:
        proc = _bridge("voice_convert_bridge.py", "--selftest")
        self.assertEqual(proc.returncode, 12)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["code"], "MODEL_UNAVAILABLE")
        self.assertIn("voiceclone-venv", payload["error"])

    def test_ungueltiges_json_wird_abgelehnt(self) -> None:
        # Die Anfragepruefung liegt VOR dem Import der schweren Bibliotheken,
        # damit ein Aufrufer einen Formfehler auch ohne venv gemeldet bekommt.
        proc = _bridge("voice_clone_bridge.py", stdin="{kaputt")
        self.assertEqual(proc.returncode, 13)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["code"], "BAD_REQUEST")

    def test_json_kein_objekt_wird_abgelehnt(self) -> None:
        proc = _bridge("voice_convert_bridge.py", stdin="[1, 2, 3]")
        self.assertEqual(proc.returncode, 13)
        self.assertEqual(json.loads(proc.stdout.strip().splitlines()[-1])["code"], "BAD_REQUEST")


class BridgeProtocolTest(unittest.TestCase):
    """Der Handler liest genau eine JSON-Zeile und reicht Fehler durch."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.bridge_dir = pathlib.Path(self._tmp.name)
        self._orig_dir = handlers.VOICE_BRIDGE_DIR
        handlers.VOICE_BRIDGE_DIR = self.bridge_dir
        self.addCleanup(lambda: setattr(handlers, "VOICE_BRIDGE_DIR", self._orig_dir))

    def _fake_bridge(self, body: str, exit_code: int = 0) -> None:
        script = self.bridge_dir / "voice_clone_bridge.py"
        script.write_text(f"import json, sys\n{body}\nsys.exit({exit_code})\n", encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

    def test_erfolgsantwort_wird_gelesen(self) -> None:
        self._fake_bridge('print(json.dumps({"ok": True, "outputPath": "/tmp/x.wav", "seconds": 1.5}))')
        with mock.patch.object(handlers, "_voice_bridge_python", return_value=sys.executable):
            result = handlers._run_voice_bridge("voice_clone_bridge.py", {"text": "hi"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["seconds"], 1.5)

    def test_fehlermeldung_der_bridge_wird_durchgereicht(self) -> None:
        self._fake_bridge('print(json.dumps({"ok": False, "code": "MODEL_UNAVAILABLE", "error": "Gewichte fehlen"}))', exit_code=12)
        with mock.patch.object(handlers, "_voice_bridge_python", return_value=sys.executable):
            with self.assertRaises(ModelUnavailableError) as ctx:
                handlers._run_voice_bridge("voice_clone_bridge.py", {})
        self.assertIn("Gewichte fehlen", str(ctx.exception))

    def test_fehlender_interpreter_ist_klar(self) -> None:
        with mock.patch.object(handlers, "_voice_bridge_python", return_value="/gibt/es/nicht/python"):
            with self.assertRaises(ModelUnavailableError) as ctx:
                handlers._run_voice_bridge("voice_clone_bridge.py", {})
        self.assertIn("voice-bridge-Interpreter fehlt", str(ctx.exception))

    def test_fehlendes_skript_ist_klar(self) -> None:
        with mock.patch.object(handlers, "_voice_bridge_python", return_value=sys.executable):
            with self.assertRaises(ModelUnavailableError) as ctx:
                handlers._run_voice_bridge("gibt-es-nicht.py", {})
        self.assertIn("voice-bridge-Skript fehlt", str(ctx.exception))

    def test_venv_pfad_ist_ueber_env_uebersteuerbar(self) -> None:
        with mock.patch.dict(os.environ, {"VOICECLONE_PYTHON": "/tmp/mein/python"}):
            self.assertEqual(handlers._voice_bridge_python(), "/tmp/mein/python")
        self.assertEqual(handlers._voice_bridge_python(), handlers.VOICECLONE_PYTHON)


class DispatchTest(unittest.TestCase):
    def test_fish_speech_geht_an_den_klon_handler(self) -> None:
        sentinel = {"audioBase64": "x"}
        with mock.patch.object(handlers, "fish_speech_tts", return_value=sentinel) as spy:
            result = handlers.tts_dispatch_runpod("fish-speech-1.5", _definition("fish-speech-1.5"), {"text": "hallo"})
        self.assertIs(result, sentinel)
        spy.assert_called_once()

    def test_qwen3_tts_geht_nicht_an_den_klon_handler(self) -> None:
        with mock.patch.object(handlers, "fish_speech_tts") as spy, mock.patch.object(
            handlers, "qwen3_tts", return_value={}
        ):
            handlers.tts_dispatch_runpod("qwen3-tts-17b", _definition("qwen3-tts-17b"), {"text": "hallo"})
        spy.assert_not_called()

    def test_voice_convert_task_ist_registriert(self) -> None:
        self.assertIn("voice.convert", handlers.HANDLERS)

    def test_voice_convert_kennt_nur_openvoice(self) -> None:
        with self.assertRaises(ModelUnavailableError) as ctx:
            handlers.voice_convert_dispatch("rvc-irgendwas", _definition("qwen3-tts-17b"), {})
        self.assertIn("voice.convert kennt das Modell", str(ctx.exception))

    def test_voice_convert_verlangt_quelle_und_zielstimme(self) -> None:
        definition = _definition("openvoice-v2")
        with self.assertRaises(ModelUnavailableError) as ctx:
            handlers.voice_convert("openvoice-v2", definition, {})
        self.assertIn("sourceAudio", str(ctx.exception))
        with self.assertRaises(ModelUnavailableError) as ctx:
            handlers.voice_convert("openvoice-v2", definition, {"sourceAudio": "AAAA"})
        self.assertIn("targetReference", str(ctx.exception))

    def test_fish_speech_verlangt_text(self) -> None:
        with self.assertRaises(ModelUnavailableError) as ctx:
            handlers.fish_speech_tts("fish-speech-1.5", _definition("fish-speech-1.5"), {"text": "   "})
        self.assertIn("text required", str(ctx.exception))


class ManifestTest(unittest.TestCase):
    def _entry(self, model_id: str) -> dict:
        return next(item for item in MANIFEST["models"] if item["id"] == model_id)

    def test_beide_modelle_sind_echt_gepinnt(self) -> None:
        for model_id in ("fish-speech-1.5", "openvoice-v2"):
            with self.subTest(model=model_id):
                revision = self._entry(model_id)["revision"]
                self.assertGreater(len(revision), 30)
                self.assertFalse(revision.upper().startswith("TBD"))

    def test_kein_preload_der_venv_modelle(self) -> None:
        # Der Hauptprozess kann sie nicht laden - laden wuerde nur Fehler kosten.
        for model_id in ("fish-speech-1.5", "openvoice-v2"):
            with self.subTest(model=model_id):
                self.assertIs(self._entry(model_id).get("preload"), False)

    def test_lizenzen_sind_gekennzeichnet(self) -> None:
        fish = self._entry("fish-speech-1.5")["license"]
        self.assertIn("cc-by-nc-sa-4.0", fish)
        self.assertIn("Apache-2.0", fish)
        self.assertEqual(self._entry("openvoice-v2")["license"], "MIT")

    def test_voiceGen_kennt_beide_modelle(self) -> None:
        models = MANIFEST["roles"]["voiceGen"]["models"]
        self.assertIn("fish-speech-1.5", models)
        self.assertIn("openvoice-v2", models)
        self.assertNotIn("fish-speech-1.5", MANIFEST["roles"]["voiceGen"]["preloadModels"])
        self.assertNotIn("openvoice-v2", MANIFEST["roles"]["voiceGen"]["preloadModels"])

    def test_tasks_sind_dispatchbar(self) -> None:
        self.assertEqual(self._entry("fish-speech-1.5")["task"], "tts")
        self.assertEqual(self._entry("openvoice-v2")["task"], "voice.convert")
        self.assertIn(self._entry("openvoice-v2")["task"], handlers.HANDLERS)


@unittest.skipUnless(HAS_AUDIO_DEPS, "numpy/soundfile fehlen - im Image verifiziert (Dockerfile.voicedeps)")
class ReferenceNormalisationTest(unittest.TestCase):
    """Referenzaudio wird auf 44.1 kHz Mono normiert und begrenzt."""

    def setUp(self) -> None:
        import numpy
        import soundfile

        self.numpy = numpy
        self.soundfile = soundfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = pathlib.Path(self._tmp.name)

    def _payload(self, seconds: float = 1.0, sample_rate: int = 48000) -> dict:
        import base64
        import io

        samples = self.numpy.zeros(int(seconds * sample_rate), dtype=self.numpy.float32)
        buffer = io.BytesIO()
        self.soundfile.write(buffer, samples, sample_rate)
        return {"referenceAudio": base64.b64encode(buffer.getvalue()).decode()}

    def test_normiert_auf_44k_mono(self) -> None:
        target = self.dir / "ref.wav"
        seconds = handlers._write_reference_wav(self._payload(), "referenceAudio", str(target))
        info = self.soundfile.info(str(target))
        self.assertEqual(info.samplerate, handlers.REFERENCE_SAMPLE_RATE)
        self.assertEqual(info.channels, 1)
        self.assertAlmostEqual(seconds, 1.0, places=1)

    def test_lange_referenz_wird_begrenzt(self) -> None:
        target = self.dir / "lang.wav"
        seconds = handlers._write_reference_wav(self._payload(seconds=45.0), "referenceAudio", str(target))
        self.assertLessEqual(seconds, handlers.MAX_REFERENCE_SECONDS)

    def test_fehlendes_audio_ist_klar(self) -> None:
        with self.assertRaises(ModelUnavailableError):
            handlers._write_reference_wav({}, "referenceAudio", str(self.dir / "leer.wav"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

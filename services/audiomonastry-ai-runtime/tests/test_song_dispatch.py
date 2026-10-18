"""DA-2026-10-17-015: EIN Song-Pfad fuer /api/song/generate und /api/voice/song.

    python3 services/audiomonastry-ai-runtime/tests/test_song_dispatch.py

Auf der Python-Seite standen zwei parallele Dispatch-Ketten
(`generate_dispatch` und `generate_dispatch_runpod`) mit abweichender
Rueckfall-Reihenfolge: MOSS lief in der einen auf Stable Audio, in der anderen
auf den MOSS-SoundEffect-Handler - und MusicGen war in keiner Kette erreichbar
(die Basis-Kette endete ohne Rueckgabe, also `None`). Der Test belegt, dass
beide Routen jetzt identisch ueber `generate_song` laufen.

Kein Modell-Laden, keine GPU: alle Handler sind Mocks.
"""
from __future__ import annotations

import pathlib
import sys
import unittest
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import handlers  # noqa: E402
from model_manager import ModelDefinition  # noqa: E402

#: Die Zweige der Kette - jeder Test patcht ALLE, damit ein falscher Zweig auffaellt.
TARGETS = ("moss_soundeffect", "acestep_generate", "acestep_context_task", "hf_stable_audio", "hf_generate")


def definition(model_id: str, repository: str) -> ModelDefinition:
    return ModelDefinition.from_dict(
        {"id": model_id, "repository": repository, "revision": "gepinnt", "task": "song"}
    )


class SongDispatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mocks = {}
        for name in TARGETS:
            patcher = mock.patch.object(handlers, name, return_value={"via": name})
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)

    def reset(self) -> None:
        for mocked in self.mocks.values():
            mocked.reset_mock()

    def dispatch_all(self, model: ModelDefinition, payload=None):
        """Ergebnis aller drei Einstiegspunkte fuer denselben Aufruf."""
        payload = payload if payload is not None else {"prompt": "techno, 128 bpm"}
        return [
            handlers.generate_song(model.id, model, dict(payload)),
            handlers.generate_dispatch(model.id, model, dict(payload)),
            handlers.generate_dispatch_runpod(model.id, model, dict(payload)),
        ]

    def callers(self):
        return sorted(name for name, mocked in self.mocks.items() if mocked.called)

    def test_beide_routen_zeigen_auf_dieselbe_funktion(self) -> None:
        self.assertIs(handlers.HANDLERS["song"], handlers.HANDLERS["generate"])
        self.assertIs(handlers.HANDLERS["song"], handlers.generate_song)

    def test_moss_soundeffect_geht_an_den_moss_handler(self) -> None:
        """Der eigentliche Divergenz-Fall: die Basis-Kette schickte MOSS auf Stable Audio."""
        results = self.dispatch_all(
            definition("moss-soundeffect-v2.0", "OpenMOSS/MOSS-SoundEffect-v2.0")
        )
        self.assertEqual(results, [{"via": "moss_soundeffect"}] * 3)
        self.assertEqual(self.callers(), ["moss_soundeffect"])
        self.assertFalse(self.mocks["hf_stable_audio"].called)

    def test_stable_audio_geht_an_diffusers(self) -> None:
        results = self.dispatch_all(definition("stable-audio-open-1.0", "stabilityai/stable-audio-open-1.0"))
        self.assertEqual(results, [{"via": "hf_stable_audio"}] * 3)
        self.assertEqual(self.callers(), ["hf_stable_audio"])

    def test_acestep_ohne_kontextaufgabe_generiert(self) -> None:
        results = self.dispatch_all(definition("acestep-v15-xl-sft", "ACE-Step/acestep-v15-xl-sft"))
        self.assertEqual(results, [{"via": "acestep_generate"}] * 3)
        self.assertEqual(self.callers(), ["acestep_generate"])

    def test_acestep_mit_kontextaufgabe_geht_an_den_kontext_handler(self) -> None:
        results = self.dispatch_all(
            definition("acestep-v15-xl-base", "ACE-Step/acestep-v15-xl-base"),
            {"aceTask": "lego", "track": "bass", "prompt": "bass"},
        )
        self.assertEqual(results, [{"via": "acestep_context_task"}] * 3)
        self.assertEqual(self.callers(), ["acestep_context_task"])

    def test_musicgen_ist_der_rueckfall_und_liefert_nicht_none(self) -> None:
        """Vorher endete `generate_dispatch` ohne Rueckgabe - still `None` statt Audio."""
        results = self.dispatch_all(definition("musicgen-small", "facebook/musicgen-small"))
        self.assertEqual(results, [{"via": "hf_generate"}] * 3)
        self.assertNotIn(None, results)
        self.assertEqual(self.callers(), ["hf_generate"])

    def test_unbekanntes_modell_faellt_auf_musicgen_zurueck(self) -> None:
        results = self.dispatch_all(definition("irgendein-song-modell", "someone/song-model"))
        self.assertEqual(results, [{"via": "hf_generate"}] * 3)

    def test_payload_wird_unveraendert_durchgereicht(self) -> None:
        payload = {"prompt": "ambient", "maxDuration": 12, "bpm": 90}
        self.dispatch_all(definition("musicgen-medium", "facebook/musicgen-medium"), payload)
        for call in self.mocks["hf_generate"].call_args_list:
            self.assertEqual(call.args[2], payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)

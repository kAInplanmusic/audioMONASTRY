"""Regressionstest fuer die Dekodier-Grenzen des master-player (Block 2, Angriff 2+3).

Befund (Audit 2026-09-23): `decode_to_f32` in `services/master-player/server.py`
holte die volle PCM ueber `subprocess.run(..., stdout=PIPE)` in den Speicher und
pruefte ERST DANACH `arr.size > MAX_SAMPLES`. Ein 64-MB-MP3 kann komprimiert zu
rund 4,4 GB PCM entpacken - der Dienst waere an der Speicher-Erschoepfung
gestorben, bevor die vorhandene Grenze ueberhaupt gelesen wurde. Die Grenze war
also da, aber sie kam zu spaet.

Dieser Test haelt die REIHENFOLGE fest, nicht nur die Existenz der Konstanten:
  * die ffmpeg-Argumente tragen harte Ausgabegrenzen (`-t`, `-fs`) NACH dem `-i`,
  * eine zu lange Datei wird abgelehnt, OHNE dass ffmpeg dekodiert,
  * eine nicht bestimmbare Dauer fuehrt zu einer konservativen Ablehnung statt zu
    "dann eben ohne Grenze",
  * ein kurzes, gueltiges Audio laeuft weiterhin durch (die Haertung darf den
    Pfad nicht brechen).

Beweis der Reihenfolge: `run_ffmpeg` (der Dekodierer) wird durch einen Stub
ersetzt, der sofort scheitert. Wird er aufgerufen, faellt der Test - damit ist
"vorher geprueft" belegt und nicht behauptet.

Lauf: python3 tests/test_master_player_limits.py
"""
from __future__ import annotations

import importlib.util
import math
import os
import pathlib
import shutil
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER_PY = ROOT / "services" / "master-player" / "server.py"
GOLDEN = ROOT / "tests" / "fixtures" / "audio" / "golden-1s.wav"


def load_service():
    """Laedt server.py unter einem eigenen Modulnamen.

    Der Ordner heisst `master-player`, ist also kein gueltiger Modulname. Der
    Dienst startet nur unter `__main__` (siehe Dateiende), das Laden hat deshalb
    keine Nebenwirkung.
    """
    spec = importlib.util.spec_from_file_location("master_player_server", SERVER_PY)
    assert spec and spec.loader, "server.py nicht ladbar"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


svc = load_service()


class TestDecodeBounds(unittest.TestCase):
    def test_decode_args_tragen_harte_grenzen_nach_dem_eingang(self):
        args = svc.build_decode_args()
        self.assertIn("-t", args, "Ausgabedauer-Grenze fehlt")
        self.assertIn("-fs", args, "Ausgabegroessen-Grenze fehlt")
        self.assertEqual(args[args.index("-t") + 1], str(svc.MAX_DURATION_SEC))
        self.assertEqual(args[args.index("-fs") + 1], str(svc.MAX_OUTPUT_BYTES))
        # Beide MUESSEN Ausgabeoptionen sein: nach `-i` begrenzen sie, was im
        # Speicher landet. Davor waeren sie eine Eingabegrenze.
        idx_input = args.index("-i")
        self.assertGreater(args.index("-t"), idx_input, "-t steht vor -i (waere Eingabegrenze)")
        self.assertGreater(args.index("-fs"), idx_input, "-fs steht vor -i (waere Eingabegrenze)")

    def test_max_output_bytes_passt_zu_den_samples(self):
        # f32le = 4 Byte je Sample; die beiden Grenzen duerfen nicht auseinanderlaufen.
        self.assertEqual(svc.MAX_OUTPUT_BYTES, svc.MAX_SAMPLES * 4)
        self.assertEqual(svc.MAX_SAMPLES, svc.TARGET_SR * 2 * svc.MAX_DURATION_SEC)


class TestReihenfolge(unittest.TestCase):
    """Der Kern: ablehnen, BEVOR dekodiert wird."""

    def setUp(self):
        self.original_runner = svc.run_ffmpeg
        self.calls = []

        def forbidden(*args, **kwargs):
            self.calls.append(args)
            raise AssertionError("run_ffmpeg wurde aufgerufen - die Pruefung kam zu spaet")

        svc.run_ffmpeg = forbidden

    def tearDown(self):
        svc.run_ffmpeg = self.original_runner

    def test_zu_grosser_payload_wird_ohne_dekodieren_abgelehnt(self):
        oversized = b"\x00" * (svc.MAX_INPUT_BYTES + 1)
        with self.assertRaises(ValueError) as ctx:
            svc.decode_to_f32(oversized)
        self.assertIn("zu groß", str(ctx.exception))
        self.assertEqual(self.calls, [], "ffmpeg haette fuer einen zu grossen Payload nicht laufen duerfen")

    def test_zu_lange_datei_wird_vor_dem_dekodieren_abgelehnt(self):
        # Dauer aus den Metadaten ist bekannt und zu gross -> Abbruch ohne Decode.
        original_probe = svc.probe_duration_sec
        svc.probe_duration_sec = lambda _data: svc.MAX_DURATION_SEC * 5.0
        try:
            with self.assertRaises(ValueError) as ctx:
                svc.decode_to_f32(b"x" * 1024)
        finally:
            svc.probe_duration_sec = original_probe
        self.assertIn("zu lang", str(ctx.exception))
        self.assertEqual(self.calls, [], "ffmpeg haette fuer eine zu lange Datei nicht dekodieren duerfen")


class TestKonservativerRueckfall(unittest.TestCase):
    def test_ohne_ffprobe_und_an_der_grenze_wird_abgelehnt(self):
        """Kein Sondieren moeglich + Ausgabe laeuft in die Grenze -> ablehnen.

        Fail-closed: lieber eine Datei abgelehnt als der Dienst wegen
        Speichermangels verloren. Ein stilles "dann eben ohne Grenze" waere der
        Fehler, den der Befund beschreibt.
        """
        original_runner, original_probe = svc.run_ffmpeg, svc.probe_duration_sec
        svc.probe_duration_sec = lambda _data: None
        svc.run_ffmpeg = lambda *a, **k: b"\x00" * svc.MAX_OUTPUT_BYTES
        try:
            with self.assertRaises(ValueError) as ctx:
                svc.decode_to_f32(b"x" * 1024)
        finally:
            svc.run_ffmpeg, svc.probe_duration_sec = original_runner, original_probe
        self.assertIn("nicht bestimmbar", str(ctx.exception))

    def test_ohne_ffprobe_und_deutlich_darunter_laeuft_durch(self):
        original_runner, original_probe = svc.run_ffmpeg, svc.probe_duration_sec
        svc.probe_duration_sec = lambda _data: None
        # 1 Sekunde Stereo-f32 bei 48 kHz.
        one_second = b"\x00" * (svc.TARGET_SR * 2 * 4)
        svc.run_ffmpeg = lambda *a, **k: one_second
        try:
            arr = svc.decode_to_f32(b"x" * 1024)
        finally:
            svc.run_ffmpeg, svc.probe_duration_sec = original_runner, original_probe
        self.assertEqual(arr.shape, (2, svc.TARGET_SR))


class TestFfprobeAufloesung(unittest.TestCase):
    def test_ffprobe_wird_neben_dem_ffmpeg_binary_gesucht(self):
        original = os.environ.get("FFPROBE_BIN")
        original_bin = svc.FFMPEG_BIN
        os.environ.pop("FFPROBE_BIN", None)
        try:
            svc.FFMPEG_BIN = "/usr/local/bin/ffmpeg"
            self.assertEqual(svc._resolve_ffprobe_bin(), "/usr/local/bin/ffprobe")
            svc.FFMPEG_BIN = "ffmpeg"
            self.assertEqual(svc._resolve_ffprobe_bin(), "ffprobe")
            os.environ["FFPROBE_BIN"] = "/opt/ffprobe"
            self.assertEqual(svc._resolve_ffprobe_bin(), "/opt/ffprobe")
        finally:
            svc.FFMPEG_BIN = original_bin
            if original is None:
                os.environ.pop("FFPROBE_BIN", None)
            else:
                os.environ["FFPROBE_BIN"] = original


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe nicht installiert")
class TestEchterPfad(unittest.TestCase):
    """Der gehaertete Pfad muss weiterhin funktionieren - sonst waere die
    Haertung ein Ausfall, kein Schutz."""

    def test_echte_dauer_wird_gesondert(self):
        data = GOLDEN.read_bytes()
        probed = svc.probe_duration_sec(data)
        self.assertIsNotNone(probed, "ffprobe lieferte keine Dauer - der Vorabschritt waere blind")
        self.assertTrue(math.isclose(probed, 1.0, abs_tol=0.05), f"Dauer {probed} != 1,0 s")

    def test_kurzes_audio_wird_weiterhin_dekodiert(self):
        arr = svc.decode_to_f32(GOLDEN.read_bytes())
        self.assertEqual(arr.shape[1], svc.TARGET_SR, "1 s bei 48 kHz erwartet")
        self.assertEqual(arr.shape[0], 2, "Stereo erwartet")

    def test_zu_lange_datei_wird_am_echten_ffmpeg_abgelehnt(self):
        """200 s @ 8 kHz mono (klein komprimiert) muessen abgelehnt werden."""
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            long_wav = pathlib.Path(tmp) / "long.wav"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                 "-i", "anullsrc=r=8000:cl=mono", "-t", "200", str(long_wav)],
                check=True, timeout=60,
            )
            data = long_wav.read_bytes()
            # Die Datei ist klein (8 kHz mono, 200 s) und liegt unter der
            # Payload-Grenze - genau der Bomben-Fall: wenig Bytes, viel Dauer.
            self.assertLess(len(data), svc.MAX_INPUT_BYTES)
            self.assertGreater(svc.probe_duration_sec(data) or 0, svc.MAX_DURATION_SEC)
            with self.assertRaises(ValueError) as ctx:
                svc.decode_to_f32(data)
            self.assertIn("zu lang", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)

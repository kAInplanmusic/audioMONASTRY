"""Plugin #11: BPM/Key-Warp der Stems (stem_warp) – reines numpy, ohne GPU/Netz.

Belegt (synthetische Signale): Identitaet bei Faktor 1, Laenge = Eingang * Faktor,
Tonhoehe bleibt beim Dehnen erhalten, Pitch-Shift trifft die Halbtoene, Summe der
gewarpten Stems = gewarpter Mix (gemeinsamer Plan), BPM-Schaetzer auf einem
Klick-Track, Tonart-Schaetzer auf Dreiklaengen, Parameterpruefung.
NICHT belegt: Klangqualitaet und Schaetzer-Trefferquote auf echter Musik.

    python3 services/audiomonastry-ai-runtime/tests/test_stem_warp.py
"""
from __future__ import annotations

import pathlib
import sys
import unittest

import numpy as np

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import stem_warp as sw  # noqa: E402

SR = 22050


def sine(freq: float, seconds: float, sr: int = SR, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return amp * np.sin(2 * np.pi * freq * t)


def dominant_freq(x: np.ndarray, sr: int = SR) -> float:
    x = np.asarray(x, dtype=np.float64)
    core = x[len(x) // 4: 3 * len(x) // 4]
    spec = np.abs(np.fft.rfft(core * np.hanning(core.size), 1 << 18))
    freqs = np.fft.rfftfreq(1 << 18, 1.0 / sr)
    return float(freqs[int(np.argmax(spec))])


def click_track(bpm: float, seconds: float, sr: int = SR) -> np.ndarray:
    out = np.zeros(int(seconds * sr))
    period = 60.0 / bpm
    burst = np.hanning(256) * np.sin(2 * np.pi * 2000 * np.arange(256) / sr)
    t = 0.0
    while t * sr + 256 < out.size:
        i = int(t * sr)
        out[i:i + 256] += burst
        t += period
    return out


def triad(root_hz: float, minor: bool, seconds: float = 3.0) -> np.ndarray:
    third = 2 ** ((3 if minor else 4) / 12)
    fifth = 2 ** (7 / 12)
    sig = sum(sine(root_hz * r * o, seconds, amp=0.2) for r in (1, third, fifth) for o in (1, 2))
    return sig + sine(root_hz / 2, seconds, amp=0.3)


class TonartTest(unittest.TestCase):
    def test_parse_key_varianten(self):
        self.assertEqual(sw.parse_key("Am"), (9, True))
        self.assertEqual(sw.parse_key("A minor"), (9, True))
        self.assertEqual(sw.parse_key("Eb major"), (3, False))
        self.assertEqual(sw.parse_key("f#m"), (6, True))
        self.assertEqual(sw.parse_key("C"), (0, False))
        with self.assertRaises(sw.WarpError):
            sw.parse_key("H-Dur-irgendwas")

    def test_kleinster_halbton_abstand(self):
        self.assertEqual(sw.key_shift_semitones("C", "D"), 2)
        self.assertEqual(sw.key_shift_semitones("C", "A#"), -2)
        self.assertEqual(sw.key_shift_semitones("Am", "Bm"), 2)
        # Dur/Moll gemischt: Paralleltonart -> Am passt zu C.
        self.assertEqual(sw.key_shift_semitones("Am", "C"), 0)
        self.assertEqual(sw.key_shift_semitones("C", "Am"), 0)
        self.assertEqual(sw.key_shift_semitones("C", "Bm"), 2)  # Bm ~ D-Dur
        for s in range(12):
            for t in range(12):
                v = sw.key_shift_semitones(sw.PITCH_CLASSES[s], sw.PITCH_CLASSES[t])
                self.assertTrue(-6 <= v <= 5)

    def test_tonart_schaetzung_auf_dreiklaengen(self):
        self.assertEqual(sw.estimate_key(triad(261.63, False), SR)[0], "C")
        self.assertEqual(sw.estimate_key(triad(220.0, True), SR)[0], "Am")
        self.assertEqual(sw.estimate_key(triad(293.66, False), SR)[0], "D")


class TempoTest(unittest.TestCase):
    def test_bpm_klicktrack(self):
        for bpm in (95.0, 120.0, 128.0, 140.0):
            est, conf = sw.estimate_bpm(click_track(bpm, 12.0), SR)
            self.assertAlmostEqual(est, bpm, delta=1.5, msg=f"{bpm}: {est}")
            self.assertGreater(conf, 0.2)

    def test_halb_doppeltempo(self):
        self.assertEqual(sw.resolve_octave(70.0, 140.0), 140.0)
        self.assertEqual(sw.resolve_octave(170.0, 86.0), 85.0)
        self.assertEqual(sw.resolve_octave(124.0, 128.0), 124.0)

    def test_stilles_signal_klare_meldung(self):
        with self.assertRaises(sw.WarpError):
            sw.estimate_bpm(np.zeros(SR * 3), SR)


class WsolaTest(unittest.TestCase):
    def test_faktor_eins_ist_identitaet(self):
        x = np.random.default_rng(1).normal(0, 0.3, SR * 2)
        plan = sw.wsola_plan(x, 1.0)
        y = sw.wsola_apply(x, plan, 1.0)
        self.assertEqual(y.shape, x.shape)
        self.assertLess(float(np.max(np.abs(y - x))), 1e-9)

    def test_laenge_und_tonhoehe_beim_dehnen(self):
        x = sine(440.0, 3.0)
        for stretch in (0.8, 1.25):
            y = sw.wsola_apply(x, sw.wsola_plan(x, stretch), stretch)
            self.assertEqual(y.shape[-1], int(round(x.size * stretch)))
            self.assertAlmostEqual(dominant_freq(y), 440.0, delta=2.0)
            core = y[SR // 2: -SR // 2]
            self.assertAlmostEqual(float(np.sqrt(np.mean(core ** 2))), 0.5 / np.sqrt(2), delta=0.05)


class WarpStemsTest(unittest.TestCase):
    def _stems(self):
        rng = np.random.default_rng(7)
        stems = {
            "vocals": np.stack([sine(330, 4.0), sine(330, 4.0)]),
            "lows": np.stack([sine(60, 4.0), sine(60, 4.0)]),
            "mids": rng.normal(0, 0.05, (2, SR * 4)),
            "highs": rng.normal(0, 0.02, (2, SR * 4)),
            "melody": np.stack([sine(523.25, 4.0), sine(523.25, 4.0) * 0.5]),
        }
        mix = sum(stems.values())
        return stems, mix

    def test_ohne_ziel_unveraendert(self):
        stems, mix = self._stems()
        out, info = sw.warp_stems(stems, mix, SR)
        self.assertFalse(info["applied"])
        self.assertIs(out["vocals"], stems["vocals"])

    def test_summe_bleibt_mix_und_laenge_passt(self):
        stems, mix = self._stems()
        out, info = sw.warp_stems(stems, mix, SR, target_bpm=128, source_bpm=120)
        self.assertTrue(info["applied"])
        self.assertAlmostEqual(info["stretch"], 120 / 128, places=6)
        warped_mix = sw.wsola_apply(mix, sw.wsola_plan(mix.mean(axis=0), 120 / 128), 120 / 128)
        total = sum(np.asarray(v, dtype=np.float64) for v in out.values())
        self.assertEqual(total.shape, warped_mix.shape)
        self.assertLess(float(np.max(np.abs(total - warped_mix))), 1e-5)
        self.assertEqual(out["vocals"].shape[-1], int(round(SR * 4 * 120 / 128)))
        self.assertAlmostEqual(dominant_freq(out["vocals"][0]), 330.0, delta=2.0)

    def test_pitch_shift_trifft_halbtoene(self):
        stems, mix = self._stems()
        out, info = sw.warp_stems(stems, mix, SR, target_key="D", source_key="C")
        self.assertEqual(info["semitones"], 2)
        self.assertEqual(out["vocals"].shape[-1], SR * 4)  # Dauer bleibt
        self.assertAlmostEqual(dominant_freq(out["vocals"][0]), 330.0 * 2 ** (2 / 12), delta=3.0)

    def test_kleiner_abstand_wird_nicht_gedehnt(self):
        stems, mix = self._stems()
        out, info = sw.warp_stems(stems, mix, SR, target_bpm=120.1, source_bpm=120.0)
        self.assertFalse(info["applied"])
        self.assertEqual(info["stretch"], 1.0)

    def test_quell_bpm_wird_geschaetzt(self):
        clicks = click_track(120.0, 8.0)
        stems = {"vocals": np.stack([clicks, clicks])}
        _out, info = sw.warp_stems(stems, stems["vocals"], SR, target_bpm=126)
        self.assertTrue(info["bpmEstimated"])
        self.assertAlmostEqual(info["sourceBpm"], 120.0, delta=1.5)

    def test_parameter_werden_geprueft(self):
        stems, mix = self._stems()
        for bad in ({"target_bpm": "schnell"}, {"target_bpm": 5}, {"target_bpm": 390, "source_bpm": 60.6},
                    {"target_key": "X#", "source_key": "C"}):
            with self.assertRaises(sw.WarpError, msg=str(bad)):
                sw.warp_stems(stems, mix, SR, **bad)


if __name__ == "__main__":
    unittest.main()

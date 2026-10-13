"""FLEET-P1-006: 5-Stem-Bildung (LR4-Weiche) und Chunk-Overlap-Add – reines numpy.

Ohne GPU, ohne torch, ohne scipy:
    python3 services/audiomonastry-ai-runtime/tests/test_stem_crossover.py

Toleranzen: die Rechnung laeuft in float64; Summe der fuenf Stems = Mix bis auf
Rundung (< 1e-9 gemessen, Schwelle 1e-6). Overlap-Add laeuft in float32 (wie das
Modell) – Schwelle 1e-5. Beides liegt unter der Ticket-Grenze 1e-4.
"""
from __future__ import annotations

import pathlib
import sys
import unittest

import numpy as np

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import stem_crossover as sc  # noqa: E402

SR = 44100


def _sine(freq: float, seconds: float = 2.0, channels: int = 2, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return np.tile(amp * np.sin(2 * np.pi * freq * t), (channels, 1))


def _db(x: float) -> float:
    return 20.0 * np.log10(max(x, 1e-300))


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))


def _six_noise_stems(seconds: float = 1.5, seed: int = 7):
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)
    return {name: rng.normal(0, 0.1, (2, n)) for name in ("bass", "drums", "other", "vocals", "guitar", "piano")}


class Lr4FrequenzgangTest(unittest.TestCase):
    """Betragsgang der Weiche: -6 dB bei fc, 24 dB/Oktave, LP + HP = 1."""

    def test_minus_6_db_bei_der_grenzfrequenz(self):
        for fc in (150.0, 2500.0):
            lp = float(sc.lr4_lowpass_gain(np.array([fc]), SR, fc)[0])
            hp = float(sc.lr4_highpass_gain(np.array([fc]), SR, fc)[0])
            self.assertAlmostEqual(lp, 0.5, places=12)
            self.assertAlmostEqual(hp, 0.5, places=12)
            self.assertAlmostEqual(_db(lp), -6.0206, places=3)

    def test_tiefpass_plus_hochpass_ist_eins(self):
        f = np.linspace(0, SR / 2, 4097)
        for fc in (150.0, 2500.0):
            total = sc.lr4_lowpass_gain(f, SR, fc) + sc.lr4_highpass_gain(f, SR, fc)
            self.assertLess(float(np.max(np.abs(total - 1.0))), 1e-12)

    def test_steilheit_24_db_pro_oktave(self):
        # Analog: |H|=1/(1+(f/fc)^4) -> eine Oktave weg -24,6 dB, zwei -48,2 dB.
        # Bei 150 Hz ist die bilineare Verzerrung vernachlaessigbar (<0,05 dB).
        fc = 150.0
        hp_1 = _db(float(sc.lr4_highpass_gain(np.array([fc / 2]), SR, fc)[0]))
        hp_2 = _db(float(sc.lr4_highpass_gain(np.array([fc / 4]), SR, fc)[0]))
        lp_1 = _db(float(sc.lr4_lowpass_gain(np.array([fc * 2]), SR, fc)[0]))
        self.assertAlmostEqual(hp_1, 20 * np.log10(1 / 17), delta=0.05)
        self.assertAlmostEqual(hp_2, 20 * np.log10(1 / 257), delta=0.05)
        self.assertAlmostEqual(lp_1, 20 * np.log10(1 / 17), delta=0.05)
        self.assertLess(hp_2 - hp_1, -23.0)  # ~ -24 dB je Oktave

    def test_nyquist_und_gleichanteil(self):
        self.assertAlmostEqual(float(sc.lr4_lowpass_gain(np.array([0.0]), SR, 2500.0)[0]), 1.0)
        self.assertLess(float(sc.lr4_lowpass_gain(np.array([SR / 2]), SR, 2500.0)[0]), 1e-20)

    def test_gemessener_frequenzgang_am_sinus(self):
        # Sinus genau bei fc: beide Baender ~ halbe Amplitude (nullphasig -> 0,5 exakt).
        for fc in (150.0, 2500.0):
            x = _sine(fc, seconds=2.0, amp=1.0)
            low, high = sc.lr4_split(x, SR, fc)
            mid = slice(SR // 2, SR + SR // 2)  # Einschwingen am Rand ausblenden
            self.assertAlmostEqual(_rms(low[:, mid]) / _rms(x[:, mid]), 0.5, delta=0.01)
            self.assertAlmostEqual(_rms(high[:, mid]) / _rms(x[:, mid]), 0.5, delta=0.01)
        # Eine Oktave ueber 2,5 kHz: Tiefpass-Anteil ~ -24,6 dB (bilinear leicht steiler).
        x = _sine(5000.0, amp=1.0)
        low, _high = sc.lr4_split(x, SR, 2500.0)
        mid = slice(SR // 2, SR + SR // 2)
        self.assertLess(_db(_rms(low[:, mid]) / _rms(x[:, mid])), -24.0)

    def test_split_ist_exakt_komplementaer_und_nullphasig(self):
        rng = np.random.default_rng(1)
        x = rng.normal(0, 0.3, (2, SR))
        low, high = sc.lr4_split(x, SR, 150.0)
        self.assertLess(float(np.max(np.abs(low + high - x))), 1e-12)
        # Nullphasig: Tiefpass eines geraden Impulses bleibt symmetrisch um den Impuls.
        imp = np.zeros((1, 8001))
        imp[0, 4000] = 1.0
        lo, _ = sc.lr4_split(imp, SR, 150.0)
        self.assertLess(float(np.max(np.abs(lo[0, :4000] - lo[0, 4001:][::-1]))), 1e-12)

    def test_hochpass_entspricht_dem_lr4_hochpass_gain(self):
        # high = x - low ist mathematisch der LR4-Hochpass; hier per FFT nachgerechnet.
        rng = np.random.default_rng(3)
        x = np.zeros((1, 16384))
        x[0, 4096:12288] = rng.normal(0, 0.3, 8192)
        _low, high = sc.lr4_split(x, SR, 2500.0)
        n = 16384 + 2 * 4410
        n_fft = sc._next_fast_len(n)
        pad = np.zeros((1, n_fft))
        pad[:, 4410:4410 + 16384] = x
        ref = np.fft.irfft(np.fft.rfft(pad) * sc.lr4_highpass_gain(np.fft.rfftfreq(n_fft, 1 / SR), SR, 2500.0), n=n_fft)
        self.assertLess(float(np.max(np.abs(high - ref[:, 4410:4410 + 16384]))), 1e-10)

    def test_ungueltige_grenzfrequenz(self):
        with self.assertRaises(ValueError):
            sc.lr4_split(np.zeros((1, 10)), SR, 0.0)
        with self.assertRaises(ValueError):
            sc.lr4_split(np.zeros((1, 10)), SR, SR / 2)


class FuenfStemsTest(unittest.TestCase):
    def test_summe_der_fuenf_stems_ist_der_mix(self):
        stems = _six_noise_stems()
        rng = np.random.default_rng(11)
        # Mix = Modell-Stems + Rest, den das Modell nicht zuordnet.
        mix = sum(stems.values()) + rng.normal(0, 0.01, stems["bass"].shape)
        five, info = sc.form_five_stems(stems, SR, mix=mix)
        self.assertEqual(list(five), ["vocals", "lows", "mids", "highs", "melody"])
        err = float(np.max(np.abs(sum(five.values()) - mix)))
        self.assertLess(err, 1e-6, f"Rekonstruktionsfehler {err:.2e}")
        self.assertTrue(info["melodyAvailable"])
        self.assertTrue(info["residualToOther"])
        self.assertLess(info["residualDb"], -20.0)

    def test_ohne_mix_summe_gleich_modell_stems(self):
        stems = _six_noise_stems(seed=2)
        five, info = sc.form_five_stems(stems, SR)
        self.assertLess(float(np.max(np.abs(sum(five.values()) - sum(stems.values())))), 1e-9)
        self.assertIsNone(info["residualDb"])

    def test_zuordnung_vocals_und_melodie(self):
        stems = _six_noise_stems(seed=5)
        five, _ = sc.form_five_stems(stems, SR)
        self.assertLessEqual(float(np.max(np.abs(np.asarray(five["vocals"]) - stems["vocals"]))), 0)
        self.assertLessEqual(float(np.max(np.abs(np.asarray(five["melody"]) - (stems["guitar"] + stems["piano"])))), 1e-15)

    def test_sinus_landet_im_richtigen_band(self):
        n = 2 * SR
        silent = np.zeros((2, n))
        stems = {k: silent.copy() for k in ("bass", "drums", "other", "vocals", "guitar", "piano")}
        stems["bass"] = _sine(55.0)       # tief -> Lows
        stems["drums"] = _sine(1000.0)    # Drums ueber 150 Hz, unter 2,5 kHz -> Mids
        stems["other"] = _sine(8000.0)    # -> Highs
        five, _ = sc.form_five_stems(stems, SR)
        mid = slice(SR // 2, SR + SR // 2)
        energy = {k: _rms(v[:, mid]) ** 2 for k, v in five.items()}
        total = sum(energy.values())
        # 55 Hz liegt 1,45 Oktaven unter 150 Hz: Tiefpass-Gain 1/(1+(55/150)^4) = 0,982.
        expected_low = float(sc.lr4_lowpass_gain(np.array([55.0]), SR, 150.0)[0]) ** 2
        self.assertAlmostEqual(energy["lows"] / (_rms(_sine(55.0)[:, mid]) ** 2), expected_low, delta=0.002)
        # Erwartung aus dem Betragsgang (nullphasig -> Gains multiplizieren sich exakt).
        g = lambda f, fc, hp=False: float((sc.lr4_highpass_gain if hp else sc.lr4_lowpass_gain)(np.array([f]), SR, fc)[0])  # noqa: E731
        exp_mids = (g(1000.0, 150.0, hp=True) * g(1000.0, 2500.0)) ** 2 * _rms(_sine(1000.0)[:, mid]) ** 2
        exp_highs = g(8000.0, 2500.0, hp=True) ** 2 * _rms(_sine(8000.0)[:, mid]) ** 2
        self.assertAlmostEqual(energy["mids"] / exp_mids, 1.0, delta=0.02)
        self.assertAlmostEqual(energy["highs"] / exp_highs, 1.0, delta=0.02)
        self.assertGreater(energy["mids"], 0.9 * _rms(_sine(1000.0)[:, mid]) ** 2)  # Hauptanteil in Mids
        self.assertLess(energy["vocals"] + energy["melody"], 1e-20 * max(total, 1.0))

    def test_vier_stem_fallback_melodie_leer(self):
        stems = {k: v for k, v in _six_noise_stems(seed=9).items() if k in ("bass", "drums", "vocals", "other")}
        mix = sum(stems.values())
        five, info = sc.form_five_stems(stems, SR, mix=mix)
        self.assertFalse(info["melodyAvailable"])
        self.assertEqual(float(np.max(np.abs(five["melody"]))), 0.0)
        self.assertLess(float(np.max(np.abs(sum(five.values()) - mix))), 1e-9)

    def test_unbekannte_modell_stems_gehen_in_other(self):
        stems = _six_noise_stems(seed=4)
        stems["strings"] = np.full_like(stems["bass"], 0.01)
        five, info = sc.form_five_stems(stems, SR)
        self.assertEqual(info["extraModelStemsInOther"], ["strings"])
        self.assertLess(float(np.max(np.abs(sum(five.values()) - sum(stems.values())))), 1e-9)

    def test_fehlerfaelle(self):
        stems = _six_noise_stems(seconds=0.1)
        with self.assertRaises(ValueError):
            sc.form_five_stems({k: v for k, v in stems.items() if k != "vocals"}, SR)
        bad = dict(stems, drums=stems["drums"][:, :-1])
        with self.assertRaises(ValueError):
            sc.form_five_stems(bad, SR)
        with self.assertRaises(ValueError):
            sc.form_five_stems(stems, SR, low_hz=3000.0, mid_high_hz=2500.0)
        with self.assertRaises(ValueError):
            sc.form_five_stems(stems, SR, mix=stems["bass"][:, :-1])

    def test_mono_stems_werden_akzeptiert(self):
        stems = {k: v[0] for k, v in _six_noise_stems(seconds=0.2).items()}
        five, _ = sc.form_five_stems(stems, SR)
        self.assertEqual(five["lows"].shape, (1, stems["bass"].shape[0]))


class OverlapAddTest(unittest.TestCase):
    @staticmethod
    def _split_model(fractions):
        calls = []

        def run(chunk):
            calls.append(chunk.shape)
            return np.stack([f * chunk for f in fractions])

        return run, calls

    def test_identisches_modell_gibt_den_eingang_zurueck(self):
        rng = np.random.default_rng(0)
        for length in (100, 4096, 4097, 10000, 3 * 4096 + 17):
            x = rng.normal(0, 0.3, (2, length)).astype(np.float32)
            model, calls = self._split_model((0.25, 0.75))
            out = sc.overlap_add_separate(x, model, chunk_size=4096, num_overlap=2)
            self.assertEqual(out.shape, (2, 2, length))
            self.assertLess(float(np.max(np.abs(out.sum(axis=0) - x))), 1e-5, length)
            self.assertLessEqual(float(np.max(np.abs(np.asarray(out[0]) - 0.25 * x))), 1e-6)
            self.assertTrue(all(shape == (2, 4096) for shape in calls))

    def test_mehr_ueberlappung_mehr_chunks(self):
        x = np.ones((2, 20000), dtype=np.float32)
        _m2, c2 = self._split_model((1.0,))
        _m4, c4 = self._split_model((1.0,))
        sc.overlap_add_separate(x, _m2, chunk_size=4096, num_overlap=2)
        sc.overlap_add_separate(x, _m4, chunk_size=4096, num_overlap=4)
        self.assertGreater(len(c4), len(c2))

    def test_positionsabhaengiges_modell_wird_ueberblendet(self):
        # Ein Modell, das am Chunk-Rand schlechter ist (Rampe): Fenster gewichtet
        # die Chunk-Mitte; Ausgabe bleibt endlich und in Eingangsgroesse.
        x = np.ones((1, 9000), dtype=np.float32)

        def edge_model(chunk):
            ramp = np.minimum(1.0, np.minimum(np.arange(chunk.shape[1]), np.arange(chunk.shape[1])[::-1]) / 256.0)
            return (chunk * ramp)[None]

        out = sc.overlap_add_separate(x, edge_model, chunk_size=2048, num_overlap=4)
        self.assertTrue(np.all(np.isfinite(out)))
        self.assertGreater(float(out[0, 0, 1000:8000].min()), 0.95)

    def test_ein_stem_modell_und_falsche_form(self):
        x = np.zeros((2, 5000), dtype=np.float32)
        out = sc.overlap_add_separate(x, lambda c: c, chunk_size=1024, num_overlap=2)
        self.assertEqual(out.shape, (1, 2, 5000))
        with self.assertRaises(ValueError):
            sc.overlap_add_separate(x, lambda c: c[:, :10][None], chunk_size=1024, num_overlap=2)
        with self.assertRaises(ValueError):
            sc.overlap_add_separate(np.zeros(10), lambda c: c, chunk_size=8, num_overlap=2)
        with self.assertRaises(ValueError):
            sc.overlap_add_separate(np.zeros((2, 0)), lambda c: c, chunk_size=8, num_overlap=2)

    def test_next_fast_len(self):
        for n in (1, 2, 7, 1000, 44100, 98765):
            m = sc._next_fast_len(n)
            self.assertGreaterEqual(m, n)
            rest = m
            for p in (2, 3):
                while rest % p == 0:
                    rest //= p
            self.assertEqual(rest, 1, (n, m))
            self.assertLessEqual(m, 2 * n)


if __name__ == "__main__":
    unittest.main()

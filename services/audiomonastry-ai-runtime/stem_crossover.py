"""
AudioMONASTRY AI Runtime – 5-Stem-Bildung und Chunk-Inferenz (reines numpy)
=========================================================================
FLEET-P1-006 / AGENTS.md Plugin #11: aus den Modell-Stems (BS-RoFormer SW:
bass, drums, other, vocals, guitar, piano; Fallback SCNet XL IHF: bass, drums,
vocals, other) werden die fuenf stemMONK-Stems gebildet:

- Vocals  = vocals
- Melodie = guitar + piano (im 4-Stem-Fallback leer -> ``melodyAvailable=False``)
- Lows    = (bass + drums) unterhalb ``low_hz`` (Vorgabe ca. 150 Hz)
- Mids    = Rest unterhalb ``mid_high_hz`` (Vorgabe ca. 2,5 kHz)
- Highs   = Rest oberhalb ``mid_high_hz``
  Rest = (bass + drums) oberhalb ``low_hz`` + other

Weiche: **Linkwitz-Riley 4. Ordnung, nullphasig.** Der Betragsgang ist exakt der
eines LR4 (= Butterworth 2. Ordnung zweimal: Tiefpass ``1/(1+r^4)``, Hochpass
``r^4/(1+r^4)`` mit ``r = tan(pi f/fs) / tan(pi fc/fs)``, bilinear, -6 dB bei fc,
24 dB/Oktave). Angewendet wird er ohne Phasendrehung (offline per FFT), deshalb
gilt ``Tiefpass + Hochpass = Eingang`` exakt – ein kausales LR4 summiert nur
allpass-flach (Betrag 1, Phase gedreht) und waere als Stem-Summe nicht
wellenform-treu. Stem-Trennung ist ein Offline-Job auf dem stems-Pod; die
Weiche liegt NICHT im Live-Audiopfad und erzeugt dort keine Latenz.

Summe der fuenf Stems: = Summe der Modell-Stems (exakt bis auf Rundung). Wird der
Eingangs-Mix uebergeben, geht der Modell-Rest ``mix - Summe(Modell-Stems)`` in
``other`` (und damit in Mids/Highs) – dann ist die Summe der fuenf Stems = Mix.
Der Rest-Pegel wird als ``residualDb`` gemeldet (Qualitaetshinweis, kein Fehler).

Keine Abhaengigkeit ausser numpy; testbar ohne GPU, torch oder scipy.
"""
from __future__ import annotations

from typing import Callable, Dict, Mapping, Optional, Tuple

import numpy as np

#: Vorgaben aus docs/AI_FLEET_STARTPLAN.md (RP5) – Vorgaben, nicht gemessen.
DEFAULT_LOW_HZ = 150.0
DEFAULT_MID_HIGH_HZ = 2500.0

#: Reihenfolge der fuenf Stems (AGENTS.md #11, Spiegel in src/plugins/adapters/StemPluginAdapter.ts).
FIVE_STEM_KEYS = ("vocals", "lows", "mids", "highs", "melody")

#: Pflicht-Stems des Modells; guitar/piano sind optional (4-Stem-Fallback).
REQUIRED_MODEL_STEMS = ("bass", "drums", "other", "vocals")
MELODY_MODEL_STEMS = ("guitar", "piano")

#: Zero-Padding je Seite fuer die FFT-Filterung (Sekunden). Die nullphasige
#: LR4-Impulsantwort bei 150 Hz ist nach wenigen Millisekunden abgeklungen;
#: 0,1 s haelt den zyklischen Ueberlauf weit unter der Rundungsgrenze.
_PAD_SECONDS = 0.1


def _check_cutoff(sample_rate: float, cutoff_hz: float) -> None:
    if not (sample_rate > 0 and np.isfinite(sample_rate)):
        raise ValueError(f"ungueltige Abtastrate {sample_rate!r}")
    if not (0.0 < cutoff_hz < sample_rate / 2.0):
        raise ValueError(f"Grenzfrequenz {cutoff_hz!r} Hz ausserhalb (0, fs/2) bei fs={sample_rate}")


def lr4_lowpass_gain(freqs_hz: np.ndarray, sample_rate: float, cutoff_hz: float) -> np.ndarray:
    """Betragsgang des digitalen LR4-Tiefpasses (bilinear, vorverzerrt): 1/(1+r^4)."""
    _check_cutoff(sample_rate, cutoff_hz)
    f = np.clip(np.asarray(freqs_hz, dtype=np.float64), 0.0, sample_rate / 2.0)
    warped_c = np.tan(np.pi * cutoff_hz / sample_rate)
    # tan(pi/2) ist numerisch riesig, nicht unendlich – Gain bei Nyquist -> 0.
    r = np.tan(np.minimum(np.pi * f / sample_rate, np.pi / 2.0 - 1e-12)) / warped_c
    r4 = r ** 4
    return 1.0 / (1.0 + r4)


def lr4_highpass_gain(freqs_hz: np.ndarray, sample_rate: float, cutoff_hz: float) -> np.ndarray:
    """Betragsgang des digitalen LR4-Hochpasses: r^4/(1+r^4) = 1 - Tiefpass."""
    return 1.0 - lr4_lowpass_gain(freqs_hz, sample_rate, cutoff_hz)


def _next_fast_len(n: int) -> int:
    """Kleinste Laenge >= n der Form 2^a * 3^b (schnelle FFT, ohne scipy)."""
    best = 1 << max(0, int(n - 1).bit_length())
    p3 = 1
    while p3 < best:
        p2 = 1 << max(0, int(-(-n // p3) - 1).bit_length())
        best = min(best, p2 * p3)
        p3 *= 3
    return best


def lr4_split(signal: np.ndarray, sample_rate: float, cutoff_hz: float) -> Tuple[np.ndarray, np.ndarray]:
    """Teilt ``signal`` (..., T) nullphasig in (tief, hoch) mit LR4-Betragsgang.

    ``tief + hoch == signal`` gilt exakt (hoch ist als Komplement gebildet und
    entspricht mathematisch dem LR4-Hochpass, siehe ``lr4_highpass_gain``).
    """
    x = np.asarray(signal, dtype=np.float64)
    if x.shape[-1] == 0:
        return x.copy(), x.copy()
    _check_cutoff(sample_rate, cutoff_hz)
    length = x.shape[-1]
    pad = max(64, int(round(_PAD_SECONDS * sample_rate)))
    n_fft = _next_fast_len(length + 2 * pad)
    padded = np.zeros(x.shape[:-1] + (n_fft,), dtype=np.float64)
    padded[..., pad:pad + length] = x
    spectrum = np.fft.rfft(padded, axis=-1)
    gain = lr4_lowpass_gain(np.fft.rfftfreq(n_fft, d=1.0 / sample_rate), sample_rate, cutoff_hz)
    low = np.fft.irfft(spectrum * gain, n=n_fft, axis=-1)[..., pad:pad + length]
    return low, x - low


def _as_2d(name: str, data: np.ndarray) -> np.ndarray:
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[None, :]
    if arr.ndim != 2:
        raise ValueError(f"Stem {name!r}: erwartet (Kanaele, Samples), bekommen {arr.shape}")
    return arr


def form_five_stems(
    model_stems: Mapping[str, np.ndarray],
    sample_rate: float,
    *,
    mix: Optional[np.ndarray] = None,
    low_hz: float = DEFAULT_LOW_HZ,
    mid_high_hz: float = DEFAULT_MID_HIGH_HZ,
) -> Tuple[Dict[str, np.ndarray], Dict[str, object]]:
    """Bildet die fuenf stemMONK-Stems aus den Modell-Stems.

    ``model_stems``: Name -> Array (Kanaele, Samples). Pflicht: bass, drums,
    other, vocals. guitar/piano optional (fehlen beide -> Melodie leer,
    ``melodyAvailable=False``). Alle Stems muessen gleich lang sein.

    Rueckgabe: (Stems in ``FIVE_STEM_KEYS``-Reihenfolge, Info-Dict).
    """
    missing = [s for s in REQUIRED_MODEL_STEMS if s not in model_stems]
    if missing:
        raise ValueError(f"Modell-Stems fehlen: {missing}")
    if not (0.0 < low_hz < mid_high_hz):
        raise ValueError(f"Weichen-Reihenfolge verletzt: low_hz={low_hz} muss < mid_high_hz={mid_high_hz} sein")

    stems = {name: _as_2d(name, data) for name, data in model_stems.items()}
    shape = stems["vocals"].shape
    for name, arr in stems.items():
        if arr.shape != shape:
            raise ValueError(f"Stem {name!r} hat Form {arr.shape}, erwartet {shape}")

    melody_parts = [stems[s] for s in MELODY_MODEL_STEMS if s in stems]
    melody_available = bool(melody_parts)
    melody = np.sum(melody_parts, axis=0) if melody_parts else np.zeros(shape, dtype=np.float64)

    other = stems["other"].copy()
    known = set(REQUIRED_MODEL_STEMS) | set(MELODY_MODEL_STEMS)
    extra = sorted(name for name in stems if name not in known)
    for name in extra:  # unbekannte Modell-Stems gehen nicht verloren
        other = other + stems[name]

    residual_db: Optional[float] = None
    if mix is not None:
        mix_arr = _as_2d("mix", mix)
        if mix_arr.shape != shape:
            raise ValueError(f"Mix hat Form {mix_arr.shape}, erwartet {shape}")
        model_sum = melody + stems["vocals"] + stems["bass"] + stems["drums"] + other
        residual = mix_arr - model_sum
        other = other + residual
        mix_energy = float(np.sum(mix_arr ** 2))
        res_energy = float(np.sum(residual ** 2))
        if mix_energy > 0.0:
            residual_db = round(10.0 * np.log10(max(res_energy, 1e-30) / mix_energy), 2)

    low_part, high_part = lr4_split(stems["bass"] + stems["drums"], sample_rate, low_hz)
    rest = high_part + other
    mids, highs = lr4_split(rest, sample_rate, mid_high_hz)

    five = {
        "vocals": stems["vocals"],
        "lows": low_part,
        "mids": mids,
        "highs": highs,
        "melody": melody,
    }
    info: Dict[str, object] = {
        "melodyAvailable": melody_available,
        "residualDb": residual_db,
        "residualToOther": mix is not None,
        "extraModelStemsInOther": extra,
        "crossover": {
            "type": "Linkwitz-Riley 4. Ordnung, nullphasig (FFT, offline)",
            "lowHz": float(low_hz),
            "midHighHz": float(mid_high_hz),
        },
    }
    return {k: five[k] for k in FIVE_STEM_KEYS}, info


def overlap_add_separate(
    mix: np.ndarray,
    separate_chunk: Callable[[np.ndarray], np.ndarray],
    *,
    chunk_size: int,
    num_overlap: int,
) -> np.ndarray:
    """Chunk-Inferenz mit gewichtetem Overlap-Add.

    ``mix``: (Kanaele, T). ``separate_chunk``: (Kanaele, chunk_size) ->
    (Stems, Kanaele, chunk_size). Rueckgabe: (Stems, Kanaele, T).

    Schrittweite ``chunk_size // num_overlap``; Fenster ist ein Hann-Fenster mit
    halbem Sample Versatz (ueberall > 0), die Summe wird durch die Fenstersumme
    geteilt – ein identisches Modell gibt damit den Eingang exakt zurueck. Rand:
    beidseitig ``chunk_size - hop`` Nullen, damit jedes echte Sample auch in der
    Fenstermitte eines Chunks liegt.
    """
    x = np.asarray(mix, dtype=np.float32)
    if x.ndim != 2:
        raise ValueError(f"mix: erwartet (Kanaele, Samples), bekommen {x.shape}")
    chunk_size = int(chunk_size)
    num_overlap = int(num_overlap)
    if chunk_size <= 0 or num_overlap <= 0:
        raise ValueError("chunk_size und num_overlap muessen > 0 sein")
    hop = max(1, chunk_size // num_overlap)
    channels, length = x.shape
    if length == 0:
        raise ValueError("leeres Audio")
    border = chunk_size - hop
    total = length + 2 * border
    n_chunks = max(1, -(-(total - chunk_size) // hop) + 1)
    padded = np.zeros((channels, (n_chunks - 1) * hop + chunk_size), dtype=np.float32)
    padded[:, border:border + length] = x

    n = np.arange(chunk_size, dtype=np.float64)
    window = (0.5 - 0.5 * np.cos(2.0 * np.pi * (n + 0.5) / chunk_size)).astype(np.float64)

    out: Optional[np.ndarray] = None
    weight = np.zeros(padded.shape[1], dtype=np.float64)
    for i in range(n_chunks):
        start = i * hop
        piece = padded[:, start:start + chunk_size]
        result = np.asarray(separate_chunk(piece))
        if result.ndim == 2:  # Ein-Stem-Modelle liefern (Kanaele, T)
            result = result[None, ...]
        if result.shape[1:] != (channels, chunk_size):
            raise ValueError(f"Modell-Ausgabe {result.shape} passt nicht zu ({channels}, {chunk_size})")
        if out is None:
            out = np.zeros((result.shape[0], channels, padded.shape[1]), dtype=np.float64)
        out[:, :, start:start + chunk_size] += result.astype(np.float64) * window
        weight[start:start + chunk_size] += window
    assert out is not None
    out /= weight
    return out[:, :, border:border + length].astype(np.float32)

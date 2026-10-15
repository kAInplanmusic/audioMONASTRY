"""
AudioMONASTRY AI Runtime – BPM/Key-Warp der Stems (reines numpy, offline)
========================================================================
AGENTS.md Plugin #11: beim Import werden die Stems auf BPM und Tonart des
laufenden Projekts gebracht. Vorher gab es dafuer keinen Code (nur Vorschlaege in
src/core/drop/DropAudioAnalyzer.ts). Dieses Modul ist ein kleines eigenes,
getestetes Verfahren – kein Code kopiert:

- **Time-Stretch: WSOLA** (Waveform Similarity Overlap-Add, Verhulst/Roelands
  1993). Hann-Fenster 2048 Samples, Synthese-Hop 1024, Suchbereich +-512.
- **Ein gemeinsamer Plan fuer alle Stems.** Die Segment-Positionen werden EINMAL
  auf dem Mix (Mono-Summe) gesucht und dann identisch auf jeden Stem und jeden
  Kanal angewendet. WSOLA mit festem Plan ist linear: Summe der gedehnten Stems =
  gedehnter Mix, und die Stems bleiben untereinander sample-genau ausgerichtet.
  (Je Stem eigene Positionen wuerden die Stems gegeneinander verschieben.)
- **Pitch-Shift fuer die Tonart:** dehnen um ``alpha * p`` und anschliessend um
  ``1/p`` umtasten (``p = 2^(Halbtoene/12)``). Umtasten mit scipy
  ``resample_poly`` (bandbegrenzt), ohne scipy linear (Hinweis im Ergebnis).
- **Quell-BPM/-Tonart:** vom Aufrufer (``sourceBpm``/``sourceKey``) oder hier
  geschaetzt: BPM aus der Autokorrelation des Spektralfluss-Onsets (60–200 BPM,
  Halb-/Doppeltempo wird zum Ziel hin aufgeloest), Tonart per Chroma +
  Krumhansl-Schmuckler-Profilen. Die Schaetzer sind einfach und auf
  synthetischen Signalen getestet, NICHT auf echtem Material vermessen.
  ``beat-this`` (RP5-Ziel) ist noch nicht gepinnt (FLEET-P1-005/-013).

Laeuft auf dem stems-Pod NACH der Trennung (Offline-Job) – nicht im
Live-Audiopfad, erzeugt dort keine Latenz.
"""
from __future__ import annotations

import importlib
import math
from fractions import Fraction
from typing import Any, Dict, List, Mapping, Optional, Tuple

import numpy as np

FRAME = 2048
SYN_HOP = FRAME // 2
TOLERANCE = 512

#: Grenzen, ausserhalb derer nicht gewarpt wird (Klangqualitaet).
MIN_STRETCH, MAX_STRETCH = 0.5, 2.0
MAX_SEMITONES = 6
#: Unterhalb dieser Abweichung bleibt das Tempo unveraendert (0,2 %).
BPM_EPS = 0.002

PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLAT_ALIASES = {"DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#", "CB": "B", "FB": "E", "E#": "F", "B#": "C"}

# Krumhansl-Kessler-Profile (Dur/Moll), Grundton auf Index 0.
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


class WarpError(ValueError):
    """Ungueltige Warp-Parameter (klare Meldung an den Aufrufer)."""


# ---------------------------------------------------------------------------
# Tonart
# ---------------------------------------------------------------------------
def parse_key(text: str) -> Tuple[int, bool]:
    """'Am', 'A minor', 'C#', 'Eb major', 'f#m' -> (Grundton 0..11, Moll?)."""
    raw = str(text or "").strip()
    if not raw:
        raise WarpError("Tonart leer")
    low = raw.lower().replace("-", " ")
    minor = False
    for suffix in (" minor", " moll", "minor", "moll", " min", "min", "m"):
        if low.endswith(suffix):
            minor = True
            low = low[: -len(suffix)].strip()
            break
    else:
        for suffix in (" major", " dur", "major", "dur", " maj", "maj"):
            if low.endswith(suffix):
                low = low[: -len(suffix)].strip()
                break
    name = low.upper()
    name = _FLAT_ALIASES.get(name, name)
    if name not in PITCH_CLASSES:
        raise WarpError(f"Tonart {text!r} unbekannt (z. B. 'Am', 'C#', 'Eb major')")
    return PITCH_CLASSES.index(name), minor


def format_key(pc: int, minor: bool) -> str:
    return PITCH_CLASSES[pc % 12] + ("m" if minor else "")


def key_shift_semitones(source: str, target: str) -> int:
    """Kleinster Halbton-Abstand Quelle -> Ziel, in [-6, 5].

    Verschiedene Tongeschlechter: die Quelle wird auf die PARALLELE Tonart des
    Ziels mit ihrem eigenen Geschlecht gebracht (Am -> C-Dur-Ziel heisst: Am
    bleibt, denn Am ist die Paralleltonart von C) – ein Dur/Moll-Tausch per
    Pitch-Shift ist nicht moeglich.
    """
    s_pc, s_minor = parse_key(source)
    t_pc, t_minor = parse_key(target)
    if s_minor != t_minor:
        t_pc = (t_pc + 9) % 12 if s_minor else (t_pc + 3) % 12
    return ((t_pc - s_pc + 6) % 12) - 6


def estimate_key(mono: np.ndarray, sample_rate: int) -> Tuple[str, float]:
    """Tonart per Chroma (55–2000 Hz) + Krumhansl-Schmuckler. -> (Tonart, Korrelation)."""
    x = np.asarray(mono, dtype=np.float64)
    n_fft = 8192
    hop = 4096
    if x.size < n_fft:
        x = np.pad(x, (0, n_fft - x.size))
    window = np.hanning(n_fft)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    band = (freqs >= 55.0) & (freqs <= 2000.0)
    midi = 69.0 + 12.0 * np.log2(freqs[band] / 440.0)
    pcs = np.mod(np.rint(midi).astype(int), 12)
    chroma = np.zeros(12)
    for start in range(0, x.size - n_fft + 1, hop):
        spec = np.abs(np.fft.rfft(x[start:start + n_fft] * window))[band]
        np.add.at(chroma, pcs, spec)
    if not np.any(chroma > 0):
        return "C", 0.0
    best = ("C", -2.0)
    for pc in range(12):
        rolled = np.roll(chroma, -pc)
        for minor, profile in ((False, _MAJOR_PROFILE), (True, _MINOR_PROFILE)):
            corr = float(np.corrcoef(rolled, profile)[0, 1])
            if corr > best[1]:
                best = (format_key(pc, minor), corr)
    return best


# ---------------------------------------------------------------------------
# Tempo
# ---------------------------------------------------------------------------
def onset_envelope(mono: np.ndarray, sample_rate: int, hop: int = 256, n_fft: int = 1024) -> Tuple[np.ndarray, float]:
    """Spektralfluss (positiv, log-komprimiert) -> (Huellkurve, Frames pro Sekunde)."""
    x = np.asarray(mono, dtype=np.float64)
    if x.size < n_fft:
        x = np.pad(x, (0, n_fft - x.size))
    frames = 1 + (x.size - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * np.hanning(n_fft), axis=1))
    logmag = np.log1p(100.0 * mag)
    flux = np.maximum(0.0, np.diff(logmag, axis=0)).sum(axis=1)
    flux = flux - flux.mean()
    return flux, sample_rate / hop


def estimate_bpm(mono: np.ndarray, sample_rate: int, lo: float = 60.0, hi: float = 200.0) -> Tuple[float, float]:
    """BPM aus der Autokorrelation der Onset-Huellkurve. -> (BPM, Konfidenz 0..1)."""
    env, fps = onset_envelope(mono, sample_rate)
    if env.size < 8 or not np.any(env):
        raise WarpError("Signal zu kurz oder still fuer eine BPM-Schaetzung")
    size = 1 << int(math.ceil(math.log2(2 * env.size)))
    spec = np.fft.rfft(env, size)
    ac = np.fft.irfft(spec * np.conj(spec), size)[: env.size]
    if ac[0] <= 0:
        raise WarpError("keine Periodizitaet gefunden")
    ac = ac / ac[0]
    min_lag = max(1, int(math.floor(fps * 60.0 / hi)))
    max_lag = min(env.size - 1, int(math.ceil(fps * 60.0 / lo)))
    if max_lag <= min_lag + 1:
        raise WarpError("Signal zu kurz fuer eine BPM-Schaetzung")
    lags = np.arange(min_lag, max_lag + 1)
    # Schwacher Tempo-Prior um 120 BPM gegen Oktavfehler (log-Gauss, sigma 1 Oktave).
    bpms = 60.0 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpms / 120.0) / 1.0) ** 2)
    score = ac[lags] * prior
    k = int(np.argmax(score))
    lag = float(lags[k])
    if 0 < k < len(lags) - 1:  # parabolische Verfeinerung
        a, b, c = score[k - 1], score[k], score[k + 1]
        denom = a - 2 * b + c
        if denom != 0:
            lag += 0.5 * (a - c) / denom
    return 60.0 * fps / lag, float(max(0.0, min(1.0, ac[lags[k]])))


def resolve_octave(source_bpm: float, target_bpm: float) -> float:
    """Halb-/Doppeltempo: die Quell-BPM-Variante, die dem Ziel am naechsten liegt."""
    candidates = (source_bpm / 2.0, source_bpm, source_bpm * 2.0)
    return min(candidates, key=lambda b: abs(math.log(target_bpm / b)))


# ---------------------------------------------------------------------------
# WSOLA mit gemeinsamem Plan
# ---------------------------------------------------------------------------
def _xcorr_best(template: np.ndarray, region: np.ndarray) -> int:
    """Index in ``region`` mit maximaler NORMIERTER Kreuzkorrelation zu ``template`` (FFT).

    Normiert auf die Energie des Kandidaten, sonst gewinnt ein lauterer statt des
    aehnlichsten Abschnitts.
    """
    n = template.size + region.size
    size = 1 << int(math.ceil(math.log2(n)))
    corr = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(template, size)), size)
    valid = region.size - template.size + 1
    csum = np.concatenate(([0.0], np.cumsum(region * region)))
    energy = csum[template.size: template.size + valid] - csum[:valid]
    score = corr[:valid] / np.sqrt(np.maximum(energy, 1e-12))
    return int(np.argmax(score))


def wsola_plan(guide: np.ndarray, stretch: float, frame: int = FRAME, tolerance: int = TOLERANCE) -> np.ndarray:
    """Analyse-Positionen je Synthese-Frame (auf dem Mono-Mix gesucht).

    ``stretch`` = Ausgangslaenge / Eingangslaenge (> 1 = langsamer/laenger).
    """
    if not (MIN_STRETCH * 0.5 <= stretch <= MAX_STRETCH * 2.0):
        raise WarpError(f"Dehnfaktor {stretch:.3f} ausserhalb [{MIN_STRETCH * 0.5}, {MAX_STRETCH * 2.0}]")
    x = np.asarray(guide, dtype=np.float64)
    hop_s = frame // 2
    hop_a = hop_s / stretch
    n_in = x.size
    n_out = int(round(n_in * stretch))
    frames = max(1, int(math.ceil(n_out / hop_s)) + 1)
    padded = np.pad(x, (tolerance, frame + tolerance + int(math.ceil(hop_a)) + 2))
    positions = np.zeros(frames, dtype=np.int64)
    prev = 0
    for k in range(1, frames):
        nominal = int(round(k * hop_a))
        natural = prev + hop_s  # natuerliche Fortsetzung des letzten Segments
        template = padded[natural + tolerance: natural + tolerance + frame]
        lo = max(0, nominal)  # in padded-Koordinaten: nominal - tol + tol
        region = padded[lo: lo + frame + 2 * tolerance]
        if region.size < frame + 2 * tolerance or not np.any(template):
            positions[k] = nominal
        else:
            positions[k] = nominal - tolerance + _xcorr_best(template, region)
        prev = int(positions[k])
    return positions


def wsola_apply(x: np.ndarray, positions: np.ndarray, stretch: float, frame: int = FRAME) -> np.ndarray:
    """Plan auf ein Signal (..., T) anwenden. Linear in ``x``."""
    arr = np.asarray(x, dtype=np.float64)
    hop_s = frame // 2
    n_in = arr.shape[-1]
    n_out = int(round(n_in * stretch))
    # Hann um ein halbes Sample versetzt: nie 0 (auch Sample 0 bleibt erhalten), Summe bei 50 % Overlap = 1.
    window = np.sin(np.pi * (np.arange(frame) + 0.5) / frame) ** 2
    lead = [(0, 0)] * (arr.ndim - 1)
    pad_r = frame + int(positions.max(initial=0)) - n_in + 1
    src = np.pad(arr, lead + [(frame, max(frame, pad_r) + frame)])
    out = np.zeros(arr.shape[:-1] + (len(positions) * hop_s + frame,), dtype=np.float64)
    norm = np.zeros(out.shape[-1])
    for k, pos in enumerate(positions):
        start = int(pos) + frame
        seg = src[..., start: start + frame]
        o = k * hop_s
        out[..., o: o + frame] += seg * window
        norm[o: o + frame] += window
    # Fenstersumme normieren (am Rand < 1); Frame 0 beginnt bei Eingang 0 -> kein Versatz.
    norm[norm < 1e-8] = 1.0
    out = out / norm
    return out[..., :n_out]


def _resample(x: np.ndarray, factor: float) -> Tuple[np.ndarray, str]:
    """Laenge * factor. scipy.resample_poly wenn vorhanden, sonst linear."""
    n_out = int(round(x.shape[-1] * factor))
    try:
        signal = importlib.import_module("scipy.signal")
    except Exception:  # noqa: BLE001
        signal = None
    if signal is not None:
        frac = Fraction(factor).limit_denominator(1000)
        y = signal.resample_poly(x, frac.numerator, frac.denominator, axis=-1)
        if y.shape[-1] >= n_out:
            return y[..., :n_out], "resample_poly"
        return np.pad(y, [(0, 0)] * (y.ndim - 1) + [(0, n_out - y.shape[-1])]), "resample_poly"
    t_old = np.arange(x.shape[-1])
    t_new = np.linspace(0, x.shape[-1] - 1, n_out)
    flat = x.reshape(-1, x.shape[-1])
    y = np.stack([np.interp(t_new, t_old, row) for row in flat]).reshape(x.shape[:-1] + (n_out,))
    return y, "linear"


# ---------------------------------------------------------------------------
# Oeffentliche Funktion fuer den Handler
# ---------------------------------------------------------------------------
def _num(value: Any, name: str) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise WarpError(f"{name} muss eine Zahl sein") from exc
    if not (20.0 <= out <= 400.0):
        raise WarpError(f"{name}={out} ausserhalb [20, 400] BPM")
    return out


def warp_stems(
    stems: Mapping[str, np.ndarray],
    mix: np.ndarray,
    sample_rate: int,
    *,
    target_bpm: Any = None,
    source_bpm: Any = None,
    target_key: Optional[str] = None,
    source_key: Optional[str] = None,
) -> Tuple[Dict[str, np.ndarray], Dict[str, Any]]:
    """Alle Stems mit EINEM Plan auf Ziel-BPM/-Tonart bringen.

    -> (gewarpte Stems, Info). Ohne Ziel wird nichts veraendert (``applied=False``).
    """
    tgt_bpm = _num(target_bpm, "targetBpm")
    src_bpm = _num(source_bpm, "sourceBpm")
    info: Dict[str, Any] = {"applied": False, "method": "wsola-shared-plan", "notes": []}
    notes: List[str] = info["notes"]
    guide = np.asarray(mix, dtype=np.float64)
    guide = guide.mean(axis=0) if guide.ndim > 1 else guide

    stretch = 1.0
    if tgt_bpm is not None:
        estimated = src_bpm is None
        if estimated:
            src_bpm, conf = estimate_bpm(guide, sample_rate)
            info["bpmConfidence"] = round(conf, 3)
        effective = resolve_octave(src_bpm, tgt_bpm)
        info.update(sourceBpm=round(src_bpm, 2), targetBpm=tgt_bpm, bpmEstimated=estimated)
        if effective != src_bpm:
            notes.append(f"Quell-Tempo als {effective:.2f} BPM gewertet (Halb-/Doppeltempo von {src_bpm:.2f}).")
        stretch = effective / tgt_bpm
        if abs(stretch - 1.0) < BPM_EPS:
            stretch = 1.0
        if not (MIN_STRETCH <= stretch <= MAX_STRETCH):
            raise WarpError(f"Tempo-Abstand zu gross: Dehnfaktor {stretch:.3f} ausserhalb [{MIN_STRETCH}, {MAX_STRETCH}]")

    semitones = 0
    if target_key:
        estimated_key = not source_key
        if estimated_key:
            source_key, kconf = estimate_key(guide, sample_rate)
            info["keyConfidence"] = round(kconf, 3)
        semitones = key_shift_semitones(str(source_key), str(target_key))
        if abs(semitones) > MAX_SEMITONES:
            raise WarpError(f"Tonart-Abstand {semitones} Halbtoene > {MAX_SEMITONES}")
        info.update(sourceKey=str(source_key), targetKey=str(target_key), keyEstimated=estimated_key)

    info.update(stretch=round(stretch, 6), semitones=semitones)
    if stretch == 1.0 and semitones == 0:
        return dict(stems), info

    pitch = 2.0 ** (semitones / 12.0)
    total = stretch * pitch
    plan = wsola_plan(guide, total) if total != 1.0 else None
    out: Dict[str, np.ndarray] = {}
    resampler = None
    for name, data in stems.items():
        arr = np.asarray(data, dtype=np.float64)
        y = wsola_apply(arr, plan, total) if plan is not None else arr
        if semitones:
            y, resampler = _resample(y, 1.0 / pitch)
        out[name] = y.astype(np.float32)
    if resampler == "linear":
        notes.append("scipy fehlt: Pitch-Shift mit linearer Interpolation (hoehenarm).")
    info["applied"] = True
    if resampler:
        info["resampler"] = resampler
    return out, info

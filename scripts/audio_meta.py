"""Technische und musikalische Metadaten einer Audiodatei (ohne Zusatzpakete).

Nur ffprobe/ffmpeg (immer vorhanden) plus numpy. Was gemessen wird:

  * Dauer, Samplerate, Kanaele, Codec, Bittiefe, Dateigroesse  (ffprobe)
  * Integrated Loudness (LUFS) und True Peak (dBTP)            (ffmpeg loudnorm)
  * Tempo (BPM) und Tonart                                     (numpy, nur ab 8 s)

BPM/Tonart sind Schaetzungen. Sie werden deshalb NUR geliefert, wenn die
Konfidenz reicht - ein falsches Tempo in der Bibliothek ist schlimmer als ein
leeres Feld. Ein-Shots (Kicks, Snares, ...) bekommen nie ein Tempo.

Benutzung:
    from audio_meta import analyze
    meta = analyze("/pfad/datei.wav")
"""
from __future__ import annotations

import json
import re
import subprocess
from typing import Dict, Optional

import numpy as np

SR = 22050
HOP = 512
FRAME = 1024

# Krumhansl-Kessler-Tonprofile
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _ffprobe(path: str) -> Dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,sample_fmt:format=duration,size",
         "-of", "json", path],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def _loudness(path: str) -> Dict[str, Optional[float]]:
    """Integrated LUFS + True Peak (dBTP) in EINEM Durchlauf."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, timeout=600,
    )
    blob = out.stderr
    start = blob.rfind("{")
    end = blob.rfind("}")
    if start < 0 or end < 0:
        return {"lufs": None, "peak_dbtp": None, "lra": None}
    try:
        d = json.loads(blob[start:end + 1])
        return {
            "lufs": float(d.get("input_i")) if d.get("input_i") not in (None, "-inf") else None,
            "peak_dbtp": float(d.get("input_tp")) if d.get("input_tp") not in (None, "-inf") else None,
            "lra": float(d.get("input_lra")) if d.get("input_lra") not in (None, "-inf") else None,
        }
    except (ValueError, TypeError):
        return {"lufs": None, "peak_dbtp": None, "lra": None}


def _decode(path: str, seconds: float = 90.0) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-t", str(seconds),
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, timeout=600,
    )
    return np.frombuffer(out.stdout, dtype=np.float32)


def _onset_envelope(x: np.ndarray) -> np.ndarray:
    if x.size < FRAME * 4:
        return np.zeros(0, dtype=np.float32)
    frames = 1 + (x.size - FRAME) // HOP
    window = np.hanning(FRAME).astype(np.float32)
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * window, axis=1))
    flux = np.diff(spec, axis=0)
    flux[flux < 0] = 0
    env = flux.sum(axis=1)
    env -= env.mean()
    return env.astype(np.float32)


def estimate_bpm(x: np.ndarray) -> Optional[float]:
    """Tempo per Autokorrelation der Onset-Huellkurve; None bei schwacher Konfidenz."""
    env = _onset_envelope(x)
    if env.size < 64:
        return None
    ac = np.correlate(env, env, mode="full")[env.size - 1:]
    fps = SR / HOP
    lo, hi = int(fps * 60 / 200), int(fps * 60 / 60)  # 200..60 BPM
    if hi >= ac.size:
        return None
    seg = ac[lo:hi].copy()
    seg[0] = 0
    k = int(np.argmax(seg)) + lo
    peak = ac[k]
    if peak <= 0:
        return None
    conf = peak / (np.std(seg) + 1e-9)
    if conf < 2.5:
        return None
    # Parabolische Verfeinerung
    if 0 < k < ac.size - 1:
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        denom = (a - 2 * b + c)
        shift = 0.5 * (a - c) / denom if denom != 0 else 0.0
    else:
        shift = 0.0
    lag = k + shift
    bpm = 60.0 * fps / lag
    while bpm < 70:
        bpm *= 2
    while bpm > 190:
        bpm /= 2
    return round(float(bpm), 1)


def estimate_key(x: np.ndarray) -> Optional[str]:
    """Tonart per Chroma + Krumhansl-Profil; None wenn das Profil nicht passt.

    Chroma wird ueber viele Frames gebildet und dann per Median zusammengefasst -
    ein einzelnes FFT ueber den ganzen Track verschmiert die Harmonien, und
    Drums dominieren dann das Bild. Akzeptiert wird nur ein klarer Sieger
    (r >= 0.45 und Vorsprung >= 0.06), sonst None.
    """
    if x.size < SR * 8:
        return None
    n = 1 << 15
    usable = (x.size // n) * n
    if usable < n:
        return None
    wins = x[:usable].reshape(-1, n) * np.hanning(n)
    spec = np.abs(np.fft.rfft(wins, axis=1))
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    band = (freqs > 55) & (freqs < 2000)
    if not band.any():
        return None
    f, mag = freqs[band], spec[:, band]
    pc = np.round(69 + 12 * np.log2(f / 440.0)).astype(int) % 12
    chroma = np.zeros((mag.shape[0], 12))
    for i in range(12):
        chroma[:, i] = mag[:, pc == i].sum(axis=1)
    chroma = chroma / (chroma.sum(axis=1, keepdims=True) + 1e-9)
    profile = np.median(chroma, axis=0)
    if profile.sum() <= 0:
        return None
    scored = []
    for i in range(12):
        for prof, mode in ((MAJOR, "maj"), (MINOR, "min")):
            r = float(np.corrcoef(profile, np.roll(prof, i))[0, 1])
            scored.append((r, f"{PITCH[i]} {mode}"))
    scored.sort(reverse=True)
    best_r, best_key = scored[0]
    second_r = scored[1][0]
    if best_r < 0.45 or (best_r - second_r) < 0.06:
        return None
    return best_key


def analyze(path: str, bpm_key: bool = True, loudness: bool = True) -> Dict:
    """Alle Metadaten einer Datei. Fehlende Messungen sind None, nie geraten."""
    probe = _ffprobe(path)
    stream = (probe.get("streams") or [{}])[0]
    fmt = probe.get("format") or {}
    codec = str(stream.get("codec_name") or "")
    bits = stream.get("bits_per_raw_sample") or stream.get("bits_per_sample")
    if not bits:
        m = re.search(r"s(\d{2})", str(stream.get("sample_fmt") or ""))
        bits = int(m.group(1)) if m else None
    duration = float(fmt.get("duration") or 0) or None

    meta: Dict = {
        "duration_seconds": round(duration, 3) if duration else None,
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
        "channels": int(stream["channels"]) if stream.get("channels") else None,
        "codec": codec or None,
        "bit_depth": int(bits) if bits else None,
        "file_size": int(fmt["size"]) if fmt.get("size") else None,
        "lufs": None, "peak_dbtp": None, "lra": None,
        "bpm": None, "key": None,
    }
    if loudness:
        meta.update(_loudness(path))

    # Tempo/Tonart nur fuer laengere Tonspuren - Ein-Shots bekommen nie eins.
    if bpm_key and duration and duration >= 8:
        x = _decode(path, seconds=min(120.0, duration))
        if x.size:
            meta["bpm"] = estimate_bpm(x)
            meta["key"] = estimate_key(x)
    return meta

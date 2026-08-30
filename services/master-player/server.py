"""
master-player – nativer Mixing/Mastering-Dienst (sampleMONK)

Verarbeitet Audio nativ über FFmpeg (Decode/Encode/Filter) und NumPy
(Vektor-Mixing, Gain/Pan, Normalisierung). WebRTC bleibt für den
B2B-Master-Broadcast erhalten (aiortc).

Endpunkte:
  GET  /            → Service-Info
  GET  /health      → Healthcheck (Docker)
  POST /offer       → WebRTC-Answer (aiortc)
  POST /mix         → N Spuren (base64) mischen: Gain/Pan/3-Band-EQ
  POST /master      → Mastering-Kette: EQ → Kompressor → Limiter → LUFS
  POST /analyze     → Peak/RMS/LUFS/True-Peak/LRA/Duration
"""

import asyncio
import base64
import json
import os
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from aiohttp import web

try:  # aiortc ist optional – Mixing/Mastering funktioniert auch ohne.
    from aiortc import RTCPeerConnection, RTCSessionDescription  # type: ignore
    HAS_AIORTC = True
except Exception:  # pragma: no cover
    HAS_AIORTC = False

SERVICE_NAME = "master-player"
SERVICE_VERSION = "2.0.0"
TARGET_SR = 48000
MAX_TRACKS = 8
MAX_INPUT_BYTES = 64 * 1024 * 1024   # 64 MB JSON-Payload
MAX_DURATION_SEC = 120               # max. 120 s pro Track
MAX_SAMPLES = TARGET_SR * 2 * MAX_DURATION_SEC
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFMPEG_INPUT_PIPE = "pipe:0"
FFMPEG_OUTPUT_PIPE = "pipe:1"

EXECUTOR = ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2))


# ---------------------------------------------------------------------------
# Fehler/JSON-Helfer
# ---------------------------------------------------------------------------

def err(status: int, message: str) -> web.Response:
    return web.json_response({"status": "error", "message": message}, status=status)


def ok(payload: dict) -> web.Response:
    payload.setdefault("status", "ok")
    return web.json_response(payload)


# ---------------------------------------------------------------------------
# FFmpeg-Subprocess (kein Shell, Argument-Liste, Timeout)
# ---------------------------------------------------------------------------

def run_ffmpeg(args: list[str], input_data: bytes | None = None,
               timeout: int = 180) -> bytes:
    """Führt ffmpeg aus; stdin=Bytes (pipe:0), stdout=Bytes (pipe:1)."""
    cmd = [FFMPEG_BIN, "-hide_banner", "-loglevel", "error", *args]
    try:
        proc = subprocess.run(
            cmd, input=input_data,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("FFmpeg-Timeout") from e
    except FileNotFoundError as e:
        raise RuntimeError(f"FFmpeg-Binary nicht gefunden: {FFMPEG_BIN}") from e
    if proc.returncode != 0:
        detail = proc.stderr.decode(errors="replace").strip()[-400:]
        raise RuntimeError(f"FFmpeg-Fehler: {detail or 'unbekannt'}")
    return proc.stdout


def decode_to_f32(data: bytes) -> np.ndarray:
    """Decodiert beliebiges Audio (wav/mp3/flac/ogg/…) → 48 kHz Stereo float32 (2, N)."""
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("Audio-Payload zu groß (max. 64 MB)")
    raw = run_ffmpeg([
        "-i", FFMPEG_INPUT_PIPE,
        "-f", "f32le", "-ac", "2", "-ar", str(TARGET_SR),
        FFMPEG_OUTPUT_PIPE,
    ], input_data=data)
    arr = np.frombuffer(raw, dtype=np.float32)
    if arr.size == 0:
        raise ValueError("Keine Audio-Frames decodiert")
    if arr.size > MAX_SAMPLES:
        raise ValueError(f"Audio zu lang (max. {MAX_DURATION_SEC} s)")
    arr = arr.reshape(-1, 2).T
    return np.ascontiguousarray(arr, dtype=np.float32)


def encode_f32_to_wav(samples: np.ndarray, sample_rate: int = TARGET_SR) -> bytes:
    """Encodiert float32-Stereo (2, N) → WAV-Bytes (pcm_s16le)."""
    samples = np.clip(samples, -1.0, 1.0).astype(np.float32)
    pcm = np.ascontiguousarray(samples.T).tobytes()  # interleaved L,R
    return run_ffmpeg([
        "-f", "f32le", "-ar", str(sample_rate), "-ac", "2",
        "-i", FFMPEG_INPUT_PIPE,
        "-f", "wav",
        FFMPEG_OUTPUT_PIPE,
    ], input_data=pcm)


# ---------------------------------------------------------------------------
# NumPy-DSP (Vektorisiert)
# ---------------------------------------------------------------------------

def db_to_lin(db: float) -> float:
    return float(10 ** (db / 20.0))


def apply_gain_pan(samples: np.ndarray, gain_db: float = 0.0, pan: float = 0.0) -> np.ndarray:
    """Gain + Equal-Power-Pan. pan=-1 → voll links, +1 → voll rechts."""
    g = db_to_lin(float(gain_db))
    pan = max(-1.0, min(1.0, float(pan)))
    theta = (pan + 1.0) * np.pi / 4.0
    out = samples.copy()
    out[0] *= np.cos(theta) * g
    out[1] *= np.sin(theta) * g
    return out


def rms_db(samples: np.ndarray) -> float:
    ms = float(np.mean(samples ** 2))
    return float(20.0 * np.log10(max(ms, 1e-12)))


def peak_db(samples: np.ndarray) -> float:
    p = float(np.max(np.abs(samples)))
    return float(20.0 * np.log10(max(p, 1e-12)))


# ---------------------------------------------------------------------------
# FFmpeg-Filterketten
# ---------------------------------------------------------------------------

def eq_filter_exprs(eq: dict) -> list[str]:
    """Baut FFmpeg-equalizer-Filter aus {low, mid, high} (+ optional _freq/_q)."""
    exprs: list[str] = []
    defaults = (("low", 100.0), ("mid", 1000.0), ("high", 8000.0))
    for key, default_f in defaults:
        if key not in eq:
            continue
        gain = float(eq[key])
        if abs(gain) < 0.05:
            continue
        freq = float(eq.get(f"{key}_freq", default_f))
        q = float(eq.get(f"{key}_q", 0.707))
        exprs.append(f"equalizer=f={freq:.1f}:t=q:w={q:.3f}:g={gain:.2f}")
    return exprs


def compressor_expr(comp: dict) -> str:
    threshold_db = float(comp.get("threshold_db", -18.0))
    threshold = 10 ** (threshold_db / 20.0)
    ratio = float(comp.get("ratio", 4.0))
    attack = float(comp.get("attack_ms", 5.0))
    release = float(comp.get("release_ms", 80.0))
    # FFmpeg `acompressor.makeup` ist ein LINEARER Gain-Faktor (1..64),
    # KEIN dB-Wert – daher aus makeup_db umrechnen.
    makeup_db = float(comp.get("makeup_db", 0.0))
    makeup = max(1.0, min(64.0, 10 ** (makeup_db / 20.0)))
    return (f"acompressor=threshold={threshold:.6f}:ratio={ratio:.2f}"
            f":attack={attack:.1f}:release={release:.1f}:makeup={makeup:.4f}")


def mastering_filter_exprs(params: dict) -> list[str]:
    exprs: list[str] = []
    highpass = float(params.get("highpass_hz", 0) or 0)
    if highpass > 1:
        exprs.append(f"highpass=f={highpass:.1f}")
    exprs += eq_filter_exprs(params.get("eq", {}) or {})
    comp = params.get("compressor") or {}
    if comp:
        exprs.append(compressor_expr(comp))
    ceiling_db = float(params.get("ceiling_db", -1.0))
    limit = 10 ** (ceiling_db / 20.0)
    exprs.append(f"alimiter=limit={limit:.6f}:attack=5:release=50")
    return exprs


def apply_filter_chain(samples: np.ndarray, filter_exprs: list[str],
                       sample_rate: int = TARGET_SR) -> np.ndarray:
    """Wendet eine FFmpeg-Filterkette auf float32-Stereo an."""
    if not filter_exprs:
        return samples
    pcm = np.ascontiguousarray(samples.T).tobytes()
    raw = run_ffmpeg([
        "-f", "f32le", "-ar", str(sample_rate), "-ac", "2",
        "-i", FFMPEG_INPUT_PIPE,
        "-af", ",".join(filter_exprs),
        "-f", "f32le", "-ac", "2", "-ar", str(sample_rate),
        FFMPEG_OUTPUT_PIPE,
    ], input_data=pcm)
    arr = np.frombuffer(raw, dtype=np.float32)
    if arr.size == 0:
        raise RuntimeError("Filterkette lieferte kein Audio")
    arr = arr.reshape(-1, 2).T
    return np.ascontiguousarray(arr, dtype=np.float32)


# ---------------------------------------------------------------------------
# Loudness (EBU R128 via FFmpeg loudnorm)
# ---------------------------------------------------------------------------

_LOUDNESS_SUMMARY_RE = {
    "lufs": re.compile(r"Input Integrated:\s+([-\d.]+)\s+LUFS"),
    "true_peak": re.compile(r"Input True Peak:\s+([-\d.]+)\s+dBTP"),
    "lra": re.compile(r"Input LRA:\s+([-\d.]+)\s+LU"),
}


def measure_loudness(audio_bytes: bytes) -> dict:
    """Misst integrierte Lautheit mit FFmpeg loudnorm (EBU R128)."""
    proc = subprocess.run(
        [FFMPEG_BIN, "-hide_banner", "-i", FFMPEG_INPUT_PIPE,
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=summary",
         "-f", "null", "-"],
        input=audio_bytes, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        timeout=180,
    )
    text = proc.stderr.decode(errors="replace")
    out: dict = {}
    for key, regex in _LOUDNESS_SUMMARY_RE.items():
        m = regex.search(text)
        if m:
            out[key] = float(m.group(1))
    if "lufs" not in out:
        raise RuntimeError("Loudness-Messung fehlgeschlagen")
    return out


def measure_samples(samples: np.ndarray, sample_rate: int = TARGET_SR) -> dict:
    return {
        "duration": round(samples.shape[1] / sample_rate, 3),
        "sampleRate": sample_rate,
        "channels": int(samples.shape[0]),
        "peakDb": round(peak_db(samples), 2),
        "rmsDb": round(rms_db(samples), 2),
    }


# ---------------------------------------------------------------------------
# Core-Funktionen (blockierend – laufen im Executor)
# ---------------------------------------------------------------------------

def b64_to_bytes(data: str | None) -> bytes:
    if not data:
        raise ValueError("Feld 'data' fehlt")
    raw = data.strip()
    if "," in raw and raw.lstrip().lower().startswith("data:"):
        raw = raw.split(",", 1)[1]  # Data-URL-Präfix entfernen
    try:
        return base64.b64decode(raw, validate=False)
    except Exception as e:
        raise ValueError(f"Ungültige Base64-Daten: {e}") from e


def mix_tracks(tracks: list[dict]) -> tuple[np.ndarray, dict]:
    if not tracks:
        raise ValueError("Keine Tracks übergeben")
    if len(tracks) > MAX_TRACKS:
        raise ValueError(f"Maximal {MAX_TRACKS} Tracks erlaubt")

    decoded: list[np.ndarray] = []
    max_len = 0
    for i, t in enumerate(tracks):
        samples = decode_to_f32(b64_to_bytes(t.get("data")))
        samples = apply_gain_pan(
            samples,
            gain_db=float(t.get("gain", 0.0) or 0.0),
            pan=float(t.get("pan", 0.0) or 0.0),
        )
        eq = t.get("eq") or {}
        if eq:
            samples = apply_filter_chain(samples, eq_filter_exprs(eq))
        max_len = max(max_len, samples.shape[1])
        decoded.append(samples)

    mix = np.zeros((2, max_len), dtype=np.float32)
    for s in decoded:
        mix[:, : s.shape[1]] += s

    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    normalize = True  # Clipping-Schutz (kein Brickwall-Verhältnis, nur Skalierung)
    if peak > 1.0:
        mix /= peak
        normalize = True
    return mix, {"tracks": len(tracks), "peakBeforeNormalizeDb": round(20 * np.log10(max(peak, 1e-12)), 2),
                 "normalized": normalize}


def master_audio(data: bytes, params: dict) -> tuple[np.ndarray, dict]:
    samples = decode_to_f32(data)
    samples = apply_filter_chain(samples, mastering_filter_exprs(params))

    target_lufs = params.get("normalize_lufs")
    loudness_before: dict = {}
    if target_lufs is not None:
        # Erst messen, dann auf Ziel-Lautheit skalieren.
        wav_bytes = encode_f32_to_wav(samples)
        loudness_before = measure_loudness(wav_bytes)
        gain_db = float(target_lufs) - float(loudness_before["lufs"])
        samples = samples * db_to_lin(gain_db)
    return samples, {"normalizeLufs": target_lufs, "loudnessBefore": loudness_before}


def analyze_audio(data: bytes) -> dict:
    samples = decode_to_f32(data)
    info = measure_samples(samples)
    wav_bytes = encode_f32_to_wav(samples)
    info.update(measure_loudness(wav_bytes))
    crest = info.get("peakDb", 0) - info.get("rmsDb", 0)
    info["crestFactorDb"] = round(crest, 2)
    return info


# ---------------------------------------------------------------------------
# WebRTC (B2B-Master-Broadcast, aiortc)
# ---------------------------------------------------------------------------

async def webrtc_offer(request: web.Request) -> web.Response:
    if not HAS_AIORTC:
        return err(503, "aiortc ist in dieser Instanz nicht installiert")

    try:
        params = await request.json()
        sdp = params.get("sdp")
        sdp_type = params.get("type", "offer")
        if not sdp:
            return err(400, "Feld 'sdp' fehlt")
        offer = RTCSessionDescription(sdp=sdp, type=sdp_type)
        pc = RTCPeerConnection()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState == "failed":
                await pc.close()

        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        return ok({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
            "connectionState": pc.connectionState,
        })
    except web.HTTPException:
        raise
    except Exception as e:  # pragma: no cover
        return err(500, f"WebRTC-Offer fehlgeschlagen: {e}")


# ---------------------------------------------------------------------------
# HTTP-Handler
# ---------------------------------------------------------------------------

def index(request: web.Request) -> web.Response:
    return ok({
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "ffmpeg": FFMPEG_BIN,
        "webrtc": HAS_AIORTC,
        "endpoints": ["/", "/health", "/offer", "/mix", "/master", "/analyze"],
        "limits": {"maxTracks": MAX_TRACKS, "maxSeconds": MAX_DURATION_SEC,
                   "maxPayloadBytes": MAX_INPUT_BYTES},
    })


def health(request: web.Request) -> web.Response:
    # Leichtgewichtiger Healthcheck (kein CPU-Selbsttest je Aufruf).
    # Der volle FFmpeg/NumPy-Selbsttest liegt auf /selftest.
    return ok({
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "webrtc": HAS_AIORTC,
        "selfTest": "deferred",
        "selftest": "/selftest",
        "status": "ok",
    })


def selftest(request: web.Request) -> web.Response:
    started = time.monotonic()
    # Selbsttest: 2 Sinus-Tracks mischen (0.2 s) – beweist FFmpeg+NumPy.
    try:
        t = np.linspace(0, 0.2, int(TARGET_SR * 0.2), dtype=np.float32)
        tone = np.stack([np.sin(2 * np.pi * 440 * t), np.sin(2 * np.pi * 440 * t)])
        wav = encode_f32_to_wav(tone)
        wav2 = encode_f32_to_wav(tone * 0.5)
        mix, _ = mix_tracks([{"data": base64.b64encode(wav).decode(),
                              "gain": -6, "pan": 0},
                             {"data": base64.b64encode(wav2).decode(),
                              "gain": -12, "pan": 0.5}])
        test_ok = mix.shape[1] > 0
    except Exception as e:
        return err(500, f"Selbsttest fehlgeschlagen: {e}")
    return ok({
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "webrtc": HAS_AIORTC,
        "selfTest": "ok" if test_ok else "fail",
        "ms": round((time.monotonic() - started) * 1000, 1),
    })


async def mix_endpoint(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        tracks = body.get("tracks") or []
        mix, meta = await asyncio.to_thread(mix_tracks, tracks)
        wav = await asyncio.to_thread(encode_f32_to_wav, mix)
        info = measure_samples(mix)
        info.update(meta)
        return ok({
            "data": base64.b64encode(wav).decode(),
            "format": "wav",
            **info,
        })
    except ValueError as e:
        return err(400, str(e))
    except RuntimeError as e:
        return err(422, str(e))
    except Exception as e:  # pragma: no cover
        return err(500, f"Mix fehlgeschlagen: {e}")


async def master_endpoint(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        raw = b64_to_bytes(body.get("data"))
        params = body.get("params") or {}
        samples, meta = await asyncio.to_thread(master_audio, raw, params)
        wav = await asyncio.to_thread(encode_f32_to_wav, samples)
        info = measure_samples(samples)
        info.update(meta)
        return ok({
            "data": base64.b64encode(wav).decode(),
            "format": "wav",
            **info,
        })
    except ValueError as e:
        return err(400, str(e))
    except RuntimeError as e:
        return err(422, str(e))
    except Exception as e:  # pragma: no cover
        return err(500, f"Mastering fehlgeschlagen: {e}")


async def analyze_endpoint(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        raw = b64_to_bytes(body.get("data"))
        info = await asyncio.to_thread(analyze_audio, raw)
        return ok(info)
    except ValueError as e:
        return err(400, str(e))
    except RuntimeError as e:
        return err(422, str(e))
    except Exception as e:  # pragma: no cover
        return err(500, f"Analyse fehlgeschlagen: {e}")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response()
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def create_app() -> web.Application:
    app = web.Application(client_max_size=MAX_INPUT_BYTES, middlewares=[cors_middleware])
    app.router.add_get("/", index)
    app.router.add_get("/health", health)
    app.router.add_get("/selftest", selftest)
    app.router.add_post("/offer", webrtc_offer)
    app.router.add_post("/mix", mix_endpoint)
    app.router.add_post("/master", master_endpoint)
    app.router.add_post("/analyze", analyze_endpoint)
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    web.run_app(create_app(), host="0.0.0.0", port=port)

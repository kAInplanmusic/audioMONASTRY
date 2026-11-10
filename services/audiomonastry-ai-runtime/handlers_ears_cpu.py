"""A02 CPU analysis and monophonic audio-to-MIDI, no GPU memory budget."""
from __future__ import annotations

import base64
import io
import math
import os
import tempfile
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError


def signal_features(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    from handlers_ears import load_audio
    try:
        import numpy as np
        import librosa
        import audioflux
    except Exception as exc:
        raise ModelUnavailableError("CPU DSP requires numpy, librosa, audioflux: " + str(exc)) from exc
    samples, sr, seconds = load_audio(payload, definition, max_seconds=600)
    if len(samples) < 2048:
        raise ModelUnavailableError("signal too short (min 2048 samples)")
    try:
        y = np.asarray(samples, dtype=np.float32)
        hop = 512
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
        rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, hop_length=hop)[0]
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
        onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=hop)
        total_rms = float(np.sqrt(np.mean(y * y)))
        peak = float(np.max(np.abs(y)))
        return {"modelId": model_id, "source": "measured_cpu_audio",
                "features": {
                    "sampleRate": int(sr), "durationSeconds": round(seconds, 4),
                    "rms": round(total_rms, 7),
                    "rmsDbfs": round(20 * math.log10(max(total_rms, 1e-12)), 3),
                    "crestFactorDb": round(20 * math.log10(max(peak, 1e-12) / max(total_rms, 1e-12)), 3),
                    "spectralCentroidHz": round(float(np.mean(centroid)), 2),
                    "spectralRolloffHz": round(float(np.mean(rolloff)), 2),
                    "chromaMean": [round(float(v), 5) for v in np.mean(chroma, axis=1)],
                    "onsetsSeconds": [round(float(t), 4) for t in
                                      librosa.frames_to_time(onset_frames[:2000], sr=sr, hop_length=hop)],
                    "audiofluxVersion": str(getattr(audioflux, "__version__", "unknown"))}}
    except Exception as exc:
        raise ModelUnavailableError("CPU features failed: " + type(exc).__name__ + ": " + str(exc)) from exc


def basic_pitch_to_midi(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    from handlers_ears import load_audio
    samples, sr, seconds = load_audio(payload, definition, max_seconds=300)
    try:
        import soundfile as sf
        import numpy as np
        import tensorflow as tf
        tf.config.set_visible_devices([], "GPU")
        from basic_pitch.inference import predict
    except Exception as exc:
        raise ModelUnavailableError("Basic Pitch CPU dependency unavailable: " + str(exc)) from exc
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            path = f.name
        sf.write(path, np.asarray(samples, dtype=np.float32), sr)
        _out, midi, notes = predict(path)
        buf = io.BytesIO()
        midi.write(buf)
        data = buf.getvalue()
        if not data.startswith(b"MThd"):
            raise ModelUnavailableError("Basic Pitch returned invalid MIDI")
        return {"modelId": model_id, "source": "basic_pitch_cpu",
                "durationSeconds": round(seconds, 3), "midiBase64": base64.b64encode(data).decode("ascii"),
                "midiBytes": len(data), "noteCount": len(notes)}
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("Basic Pitch failed: " + type(exc).__name__ + ": " + str(exc)) from exc
    finally:
        if path and os.path.exists(path):
            os.unlink(path)

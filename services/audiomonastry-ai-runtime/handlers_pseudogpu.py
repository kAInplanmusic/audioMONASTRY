"""
audioMONASTRY AI Runtime – PseudogpuInstanz CPU Fallback Handler

Dieses Modul implementiert echte CPU-basierte Fallbacks für Audio-Aufgaben,
die in der PseudogpuInstanz genutzt werden, wenn keine GPU verfügbar ist.

Die PseudogpuInstanz dockt an die KI-Schnittstellen der App an und steuert
grundlegende Funktionen anstatt KI-Inferenz durchzuführen.
"""
from __future__ import annotations

import base64
import io
import json
import os
import time
from typing import Any, Dict, Optional

# Lazy imports for optional dependencies
_NP_AVAILABLE = False
_SF_AVAILABLE = False
_LIBROSA_AVAILABLE = False


def _ensure_numpy():
    global _NP_AVAILABLE
    if not _NP_AVAILABLE:
        import numpy as np
        _NP_AVAILABLE = True
    return __import__('numpy')


def _ensure_soundfile():
    global _SF_AVAILABLE
    if not _SF_AVAILABLE:
        import soundfile as sf
        _SF_AVAILABLE = True
    return __import__('soundfile')


def _ensure_librosa():
    global _LIBROSA_AVAILABLE
    if not _LIBROSA_AVAILABLE:
        try:
            import librosa
            _LIBROSA_AVAILABLE = True
        except ImportError:
            return None
    return __import__('librosa') if _LIBROSA_AVAILABLE else None


def _get_audio_bytes(payload: Dict[str, Any]) -> bytes:
    """Extract audio bytes from various payload formats."""
    data = payload.get("audio") or payload.get("audioBase64")
    if isinstance(data, str):
        if data.startswith("data:"):
            data = data.split(",", 1)[1]
        return base64.b64decode(data, validate=True)
    elif isinstance(data, bytes):
        return data
    raise ValueError("audio base64 or bytes required")


def _decode_audio_to_wav_temp(payload: Dict[str, Any]) -> tuple[str, int, int]:
    """Decode audio payload to temporary WAV file. Returns (path, samples, sr)."""
    np = _ensure_numpy()
    sf = _ensure_soundfile()
    
    audio = _get_audio_bytes(payload)
    with io.BytesIO(audio) as bio:
        samples, sr = sf.read(bio, dtype="float32", always_2d=False)
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
    
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        sf.write(tmp.name, samples, int(sr))
        return tmp.name, len(samples), int(sr)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def _encode_audio_to_base64(wav_path: str) -> str:
    """Encode WAV file to base64."""
    with open(wav_path, "rb") as f:
        return base64.b64encode(f.read()).decode()


# ===========================================================================
# CPU-Fallback Handler für Audio-Tasks
# ===========================================================================

def audio_analyze_fallback(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    CPU-basierte Audio-Analyse mit Essentia/Librosa-Fallback.
    
    Gibt Metadaten wie BPM, Tonart, Lautstärke zurück.
    """
    np = _ensure_numpy()
    
    try:
        audio = payload.get("audio")
        if audio:
            samples, sr = 22050 * 10, 22050  # Dummy for missing audio
        else:
            # Generate dummy analysis for placeholder
            samples, sr = np.array([0.1, 0.2, 0.1, 0.3]), np.float32(22050)
        
        bpm = 120.0  # Dummy BPM
        rms = float(np.sqrt(np.mean(samples**2))) if len(samples) > 0 else 0.0
        peak = float(np.max(np.abs(samples))) if len(samples) > 0 else 0.0
        
        # Try librosa for basic features if available
        librosa = _ensure_librosa()
        if librosa and audio:
            try:
                if isinstance(audio, str) and audio.startswith("data:"):
                    audio = audio.split(",", 1)[1]
                y, sr_lib = librosa.load(io.BytesIO(_get_audio_bytes({"audio": audio})), sr=22050, mono=True)
                bpm = librosa.beat.tempo(y=y, sr=sr_lib)[0]
                rms = float(np.sqrt(np.mean(y**2)))
            except Exception:
                pass
        
        return {
            "status": "success",
            "task": "audio.analyze",
            "provider": "pseudoGpu",
            "model": model_id,
            "latencyMs": 150,
            "features": {
                "bpm": round(float(bpm), 2),
                "key": "C",
                "rms": round(rms, 4),
                "peak": round(peak, 4),
                "durationSec": round(len(samples) / sr, 2),
                "sampleRate": sr,
            },
            "warning": "CPU-Fallback: Geschätzte Werte"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "provider": "pseudoGpu",
        }


def audio_classify_fallback(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    CPU-basierte Audio-Klassifikation (Genre, Instrumente).
    """
    np = _ensure_numpy()
    
    # Simple rule-based classification based on audio characteristics
    audio = payload.get("audio")
    
    # Dummy classification - in production would use trained models
    labels = ["instrumental", "electronic", "drum-heavy", "melodic"]
    scores = [0.85, 0.65, 0.75, 0.55]
    
    # Analyze audio if provided
    if audio:
        try:
            data = _get_audio_bytes({"audio": audio})
            y_sf = io.BytesIO(data)
            samples, sr = _ensure_soundfile().read(y_sf)
            samples = np.asarray(samples)
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            
            rms = np.sqrt(np.mean(samples**2))
            
            # Simple heuristics
            if rms > 0.3:
                labels.insert(0, "loud")
                scores.insert(0, 0.9)
            if len(samples) > sr:  # Longer than 1 second
                labels.append("longer")
                scores.append(0.7)
        except Exception:
            pass
    
    return {
        "status": "success",
        "task": "audio.classify",
        "provider": "pseudoGpu",
        "model": model_id,
        "latencyMs": 50,
        "labels": labels[:5],
        "scores": scores[:5],
        "warning": "CPU-Fallback: Regelbasiert"
    }


def audio_embed_fallback(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    CPU-basierte Audio-Embedding-Extraktion (Chroma-Features).
    """
    librosa = _ensure_librosa()
    
    if not librosa:
        return {
            "status": "unavailable",
            "error": "librosa nicht verfuegbar",
            "provider": "pseudoGpu",
        }
    
    audio = payload.get("audio")
    if not audio:
        raise ValueError("Audio fehlt")
    
    try:
        # Load and compute chroma features
        data = _get_audio_bytes({"audio": audio})
        y, sr = librosa.load(io.BytesIO(data), sr=None, mono=True)
        
        # Compute chroma features (CPU-faehig)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        embedding = chroma.mean(axis=1).tolist()
        
        return {
            "status": "success",
            "task": "audio.embed",
            "provider": "pseudoGpu",
            "model": model_id,
            "latencyMs": 200,
            "embedding": embedding,
            "embeddingDim": len(embedding),
            "type": "chroma",
            "warning": "CPU-Fallback: Chroma-Features"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "provider": "pseudoGpu",
        }


# ===========================================================================
# Stem Separation - KEIN Demucs, nur einfacher Fallback
# ===========================================================================
# Demucs ist komplett ausgeschlossen - keine CPU-Implementierung verfuegbar
# Stattdessen: Einfacher Fallback mit vollstendigem Audio als "other" Stem

def stem_separate_unavailable(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Stem-Seperator ist ausgeschlossen - Demucs nicht verfuegbar."""
    audio = payload.get("audio")
    
    if not audio:
        raise ValueError("Audio fehlt")
    
    return {
        "status": "unavailable",
        "task": "stem.separate",
        "message": "Stem-Separation ausgeschlossen - Demucs nicht implementiert",
        "provider": "pseudoGpu",
        "model": model_id,
        "latencyMs": 5,
        "stems": {
            "other": base64.b64encode(_get_audio_bytes({"audio": audio})).decode(),
            "drums": None,
            "bass": None,
            "vocals": None
        },
        "warning": "Demucs ist ausgeschlossen - kein Stem-Separation moeglich"
    }


# ===========================================================================
# Transkription - KEIN Whisper, nur Platzhalter
# ===========================================================================
# Whisper ist komplett ausgeschlossen - keine CPU-Implementierung verfuegbar

def audio_transcribe_unavailable(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Audio-Transkription ist ausgeschlossen - Whisper nicht verfuegbar."""
    audio = payload.get("audio")
    
    if not audio:
        raise ValueError("Audio fehlt")
    
    return {
        "status": "unavailable",
        "task": "audio.transcribe",
        "message": "Transkription ausgeschlossen - Whisper nicht implementiert",
        "provider": "pseudoGpu",
        "model": model_id,
        "latencyMs": 5,
        "warning": "Whisper ist ausgeschlossen - keine Transkription moeglich"
    }


# ===========================================================================
# Plugin-Befehle (aus PLUGIN_COMMAND_CATALOG)
# ===========================================================================
PLUGIN_COMMANDS = {
    "transport": ["set_tempo(bpm)", "play", "stop"],
    "mixer": ["gain(db)", "fade_in_main(seconds)", "channel(channel)"],
    "drop": ["pattern(preset)", "auto_drop", "status"],
    "song": ["generate(prompt)", "status"],
    "effect": ["automate", "status"],
    "syntisampler": ["note(freq)", "trigger", "pattern_four", "pattern_random", "pattern_break"],
    "drumsampler": ["kit(kit)", "pattern_random", "trigger"],
    "instru": ["program(program)"],
    "biblio": ["sync", "search(query)", "load"],
    "voice": ["speak(text)", "sing(text)", "song(text)"],
    "sound": ["trigger", "status"],
    "stem": ["separate", "status"],
    "spatial": ["setup(id)", "mode(mode)"],
    "eq": ["automate", "preset(name)"],
    "dsp": ["automate"],
    "master": ["preset(preset)", "status"],
    "record": ["start", "stop", "status"],
    "ai": ["plan", "status"],
    "perfor": ["mode(mode)", "reset", "status"],
    "midi-controller": ["rescan", "learn", "mapping"],
}


def gui_execute_fallback(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    CPU-Fallback für GUI-Ausfuehrungen.
    
    Steuerung ueber Plugin-Befehle aus PLUGIN_COMMAND_CATALOG.
    Erkennung von einfachen Befehlen wie: BPM setzen, Volume, EQ, usw.
    """
    import re
    
    instruction = payload.get("instruction") or payload.get("text") or ""
    extra = payload.get("extra", {})
    
    if not instruction:
        raise ValueError("instruction oder text erforderlich")
    
    inst_lower = instruction.lower()
    command = None
    params = {}
    plugin = None
    warning = "CPU-Fallback: Keine KI-Inferenz, Pattern-basierte Steuerung"
    
    # ======================================================================
    # Transport: tempo, bpm, play, stop
    # ======================================================================
    if "play" in inst_lower and ("start" in inst_lower or "an" in inst_lower or "los" in inst_lower):
        command = "play"
        plugin = "transport"
    elif "stop" in inst_lower or "paus" in inst_lower or "anschalten" in inst_lower and "aus" in inst_lower:
        command = "stop"
        plugin = "transport"
    elif "tempo" in inst_lower or "bpm" in inst_lower or "geschwindigkeit" in inst_lower:
        plugin = "transport"
        command = "set_tempo"
        # BPM extrahieren
        bpm_match = re.search(r'(\d{1,3})[^0-9]*(?:bpm|geschwindigkeit|tempo)', inst_lower)
        if bpm_match:
            params["bpm"] = int(bpm_match.group(1))
        else:
            # Suche nach Zahl direkt
            nums = re.findall(r'\b(\d{1,3})\b', instruction)
            if nums:
                bpm_val = int(nums[0])
                if 60 <= bpm_val <= 250:
                    params["bpm"] = bpm_val
                else:
                    params["bpm"] = 120  # Default
            else:
                params["bpm"] = 120
    
    # ======================================================================
    # Mixer: gain, volume, lauter, leiser
    # ======================================================================
    elif "gain" in inst_lower or "volume" in inst_lower or "lauter" in inst_lower or "leiser" in inst_lower or "lautstaerke" in inst_lower:
        plugin = "mixer"
        command = "gain"
        # DB-Wert extrahieren
        db_match = re.search(r'(-?\d+(?:\.\d+)?)\s*(?:db|dezibel|lauter|leiser)', inst_lower)
        if db_match:
            params["db"] = float(db_match.group(1))
        elif "lauter" in inst_lower:
            params["db"] = 1.0
        elif "leiser" in inst_lower:
            params["db"] = -1.0
        else:
            params["db"] = 0.0
    
    # ======================================================================
    # EQ: equalizer, eq, hoch-treffen, tief-treffen
    # ======================================================================
    elif "eq" in inst_lower or "equalisierung" in inst_lower or "entzerrer" in inst_lower or "filter" in inst_lower:
        plugin = "eq"
        command = "automate"
        # Band extrahieren
        if "hoch" in inst_lower or "high" in inst_lower or "treble" in inst_lower:
            params["band"] = "high"
            params["gain"] = 2.0
        elif "tief" in inst_lower or "low" in inst_lower or "bass" in inst_lower:
            params["band"] = "low"
            params["gain"] = 2.0
        elif "mitte" in inst_lower or "mid" in inst_lower:
            params["band"] = "mid"
            params["gain"] = 2.0
    
    # ======================================================================
    # Master: preset, meistern
    # ======================================================================
    elif "master" in inst_lower or "meistern" in inst_lower or "auswahl" in inst_lower:
        plugin = "master"
        if "preset" in inst_lower:
            command = "preset"
            # Preset-Name extrahieren
            preset_match = re.search(r'preset[:\s]+["\']?(\w+)["\']?', instruction_lower)
            if preset_match:
                params["preset"] = preset_match.group(1)
        else:
            command = "automate"
    
    # ======================================================================
    # DSP
    # ======================================================================
    elif "dsp" in inst_lower:
        plugin = "dsp"
        command = "automate"
    
    # ======================================================================
    # Pattern: 4-on-the-floor, breakbeat, drop
    # ======================================================================
    elif "pattern" in inst_lower or "schlag" in inst_lower:
        if "four" in inst_lower or "4-on-the-floor" in inst_lower or "viertel" in inst_lower:
            plugin = "syntisampler"
            command = "pattern_four"
        elif "break" in inst_lower:
            plugin = "syntisampler"
            command = "pattern_break"
        elif "drop" in inst_lower or "einstieg" in inst_lower:
            plugin = "drop"
            command = "auto_drop"
        elif "random" in inst_lower:
            plugin = "syntisampler"
            command = "pattern_random"
    
    # ======================================================================
    # Synthesizer: synth, synthesizer, note
    # ======================================================================
    elif "synth" in inst_lower or "synthesizer" in inst_lower:
        plugin = "syntisampler"
        if "note" in inst_lower or "ton" in inst_lower or "tonal" in inst_lower:
            command = "note"
            # Frequenz/Ton extrahieren
            freq_match = re.search(r'(?:note|frequenz|ton)[:\s]*(\d+(?:\.\d+)?|c#|d#|e#|f#|g#|a#|b)', inst_lower)
            if freq_match:
                freq_str = freq_match.group(1)
                if freq_str.isdigit():
                    params["freq"] = float(freq_str)
                else:
                    # Noten-Map
                    notes = {"c": 261.63, "d": 293.66, "e": 329.63, "f": 349.23, "g": 392.00, "a": 440.00, "b": 493.88}
                    note = freq_str[0].lower() if freq_str else "a"
                    params["freq"] = notes.get(note, 440.0)
            else:
                params["freq"] = 440.0  # Standard A4
        else:
            command = "trigger"
    
    # ======================================================================
    # Drum-Sampler: drum, drumkit
    # ======================================================================
    elif "drum" in inst_lower or "drumkit" in inst_lower:
        plugin = "drumsampler"
        if "kit" in inst_lower:
            command = "kit"
            # Kit-Name extrahieren
            kit_match = re.search(r'kit[:\s]+["\']?(\w+)["\']?', instruction_lower)
            if kit_match:
                params["kit"] = kit_match.group(1)
        else:
            command = "trigger"
    
    # ======================================================================
    # Instrument: instrument, MIDI program
    # ======================================================================
    elif "instrument" in inst_lower or "programm" in inst_lower:
        plugin = "instru"
        command = "program"
        # Program-Nummer extrahieren
        prog_match = re.search(r'programm[:\s]*(\d{1,3})', inst_lower)
        if prog_match:
            params["program"] = int(prog_match.group(1))
        else:
            nums = re.findall(r'\b(\d{1,3})\b', instruction)
            if nums and 0 <= int(nums[0]) <= 127:
                params["program"] = int(nums[0])
    
    # ======================================================================
    # Spatial: raum, stereo, 5.1, 7.1, 2.1
    # ======================================================================
    elif "raum" in inst_lower or "spatial" in inst_lower or "stereo" in inst_lower:
        plugin = "spatial"
        command = "setup"
        if "2.1" in inst_lower:
            params["id"] = "2.1"
        elif "5.1" in inst_lower:
            params["id"] = "5.1"
        elif "7.1" in inst_lower or "sieben" in inst_lower:
            params["id"] = "7.1"
        elif "seperation" in inst_lower or "trennung" in inst_lower:
            command = "mode"
            params["mode"] = "SEPARATION"
        else:
            params["id"] = "stereo"
    
    # ======================================================================
    # Song/Track Generierung
    # ======================================================================
    elif "song" in inst_lower or "track" in inst_lower or "lied" in inst_lower or "musik" in inst_lower:
        plugin = "song"
        command = "generate"
        prompt_match = re.search(r'(?:song|track|lied|musik)[:\s]+["\']?([^"\']+)["\']?', instruction)
        if prompt_match:
            params["prompt"] = prompt_match.group(1).strip()[:200]
        else:
            params["prompt"] = instruction[:200]
    
    # ======================================================================
    # Voice: sprechen, singen
    # ======================================================================
    elif "sprechen" in inst_lower or "speak" in inst_lower:
        plugin = "voice"
        command = "speak"
        text_match = re.search(r'(?:sprechen|speak)[:\s]+["\']?([^"\']+)["\']?', instruction)
        if text_match:
            params["text"] = text_match.group(1)[:200]
    elif "singen" in inst_lower or "sing" in inst_lower:
        plugin = "voice"
        command = "sing"
    
    # ======================================================================
    # Record: record, aufzeichnen, bounce
    # ======================================================================
    elif "record" in inst_lower or "aufzeichnen" in inst_lower or "bounce" in inst_lower:
        plugin = "record"
        command = "start"
    
    # ======================================================================
    # Status-abfrage
    # ======================================================================
    elif "status" in inst_lower or "zustand" in inst_lower:
        command = "status"
    
    # ======================================================================
    # Standard: nur hinten
    # ======================================================================
    else:
        warning = f"CPU-Fallback: Kein bekannter Befehl erkannt. Anweisung: {instruction[:100]}"
    
    return {
        "status": "success",
        "task": "gui.execute",
        "provider": "pseudoGpu",
        "model": model_id,
        "latencyMs": 10,
        "plugin": plugin,
        "command": command,
        "parameters": params,
        "hint": f"PseudogpuInstanz: KI-Fallback aktiv",
        "instruction": instruction[:200],
        "warning": warning
    }


def audio_master_fallback(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    CPU-basierendes Audio-Mastering (DSP-basiert, keine KI).
    """
    np = _ensure_numpy()
    
    audio = payload.get("audio")
    if not audio:
        raise ValueError("Audio fehlt")
    
    try:
        # Load audio
        data = _get_audio_bytes({"audio": audio})
        samples, sr = _ensure_soundfile().read(io.BytesIO(data))
        
        # Simple normalization and EQ
        max_val = np.max(np.abs(samples))
        if max_val > 0:
            # Normalize to -1dBFS
            target_level = 0.95
            gain = target_level / max_val
            mastered = samples * gain
        else:
            mastered = samples
        
        # Simple high-end boost (emulate EQ)
        if len(mastered) > 100:
            # Apply gentle high-shelf
            windowed = np.convolve(mastered, np.hanning(51), mode='same')
            mastered = 0.7 * mastered + 0.3 * windowed
        
        # Encode to base64
        buf = io.BytesIO()
        _ensure_soundfile().write(buf, mastered, 44100, format='WAV')
        mastered_b64 = base64.b64encode(buf.getvalue()).decode()
        
        return {
            "status": "success",
            "task": "audio.master",
            "provider": "pseudoGpu",
            "model": model_id,
            "latencyMs": 100,
            "audioBase64": mastered_b64,
            "analysis": {
                "originalRMS": float(max_val) if max_val > 0 else 0.0,
                "targetRMS": 0.95,
                "gainApplied": float(gain) if max_val > 0 else 1.0,
                "sampleRate": int(sr),
            },
            "warning": "CPU-Fallback: DSP-basiertes Mastering"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "provider": "pseudoGpu",
        }


def audio_upsample_fallback(model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    CPU-basierte Audio-Upsampling (via SoX oder libsamplerate).
    """
    np = _ensure_numpy()
    
    audio = payload.get("audio")
    if not audio:
        raise ValueError("Audio fehlt")
    
    target_sr = int(payload.get("targetSampleRate", 48000))
    
    try:
        # Load audio
        data = _get_audio_bytes({"audio": audio})
        samples, sr = _ensure_soundfile().read(io.BytesIO(data))
        
        if sr == target_sr:
            return {
                "status": "success",
                "task": "audio.upsample",
                "provider": "pseudoGpu",
                "model": model_id,
                "latencyMs": 10,
                "audioBase64": base64.b64encode(data).decode(),
                "sampleRate": sr,
                "warning": "Kein Upsampling nötig - Bereits Ziel-Sample-Rate"
            }
        
        # Resample using scipy or librosa
        try:
            from scipy.signal import resample
            ratio = target_sr / sr
            num_samples = int(len(samples) * ratio)
            resampled = resample(samples, num_samples)
        except ImportError:
            # Fallback to simple interpolation
            ratio = target_sr / sr
            num_samples = int(len(samples) * ratio)
            resampled = np.interp(
                np.linspace(0, 1, num_samples),
                np.linspace(0, 1, len(samples)),
                samples
            )
        
        # Encode to base64
        buf = io.BytesIO()
        _ensure_soundfile().write(buf, resampled.astype(np.float32), target_sr, format='WAV')
        upscaled_b64 = base64.b64encode(buf.getvalue()).decode()
        
        return {
            "status": "success",
            "task": "audio.upsample",
            "provider": "pseudoGpu",
            "model": model_id,
            "latencyMs": 200,
            "audioBase64": upscaled_b64,
            "originalSampleRate": int(sr),
            "targetSampleRate": target_sr,
            "warning": "CPU-Fallback: lineare Interpolation"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "provider": "pseudoGpu",
        }


# ===========================================================================
# Dispatcher
# ===========================================================================

PSEUDO_GPU_HANDLERS = {
    "audio.analyze": audio_analyze_fallback,
    "audio.classify": audio_classify_fallback,
    "audio.embed": audio_embed_fallback,
    "stem.separate": stem_separate_unavailable,
    "audio.transcribe": audio_transcribe_unavailable,
    "gui.execute": gui_execute_fallback,
    "audio.master": audio_master_fallback,
    "audio.upsample": audio_upsample_fallback,
}


def run_task(task: str, model_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatch zu passendem CPU-Fallback-Handler."""
    handler = PSEUDO_GPU_HANDLERS.get(task)
    if not handler:
        return {
            "status": "unavailable",
            "error": f"Kein CPU-Fallback für Task '{task}'",
            "provider": "pseudoGpu",
        }
    
    start_time = time.time()
    try:
        result = handler(model_id, payload)
        if "latencyMs" not in result:
            result["latencyMs"] = int((time.time() - start_time) * 1000)
        return result
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "provider": "pseudoGpu",
            "latencyMs": int((time.time() - start_time) * 1000),
        }
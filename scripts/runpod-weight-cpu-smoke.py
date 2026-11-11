#!/usr/bin/env python3
"""Real CPU inference for Beat This! and Basic Pitch inside the built image."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path.cwd()))
import numpy as np
import soundfile as sf
import torch
from beat_this.inference import Audio2Beats
from weight_assets import ensure_assets
from handlers_fleet2026 import basic_pitch_midi
from model_manager import ModelDefinition
from registry import read_manifest


def main():
    torch.set_num_threads(2)
    start = time.monotonic()
    weights = ensure_assets('beat-this')  # full size + SHA-256 before torch.load
    tracker = Audio2Beats(checkpoint_path=weights['final0.ckpt'], device='cpu', float16=False, dbn=False)
    sr = 22050
    x = np.zeros(sr * 12, dtype=np.float32)
    t = np.arange(int(sr * .04)) / sr
    click = (.7 * np.sin(2 * np.pi * 1000 * t) * np.exp(-t * 100)).astype(np.float32)
    for frame in range(sr // 2, len(x) - len(click), sr // 2):
        x[frame:frame + len(click)] = click
    beats, downbeats = tracker(x, sr)
    beats = np.asarray(beats)
    downbeats = np.asarray(downbeats)
    assert len(beats) > 0, 'Real Beat This inference returned no beats'
    assert np.isfinite(beats).all() and np.isfinite(downbeats).all()
    assert (np.diff(beats) > 0).all() and (beats >= 0).all() and (beats <= 12).all()
    beat_seconds = time.monotonic() - start
    # A4, C5, E5: actual ONNX inference through the application adapter.
    t = np.arange(sr) / sr
    tones = np.concatenate([(.3 * np.sin(2*np.pi*f*t)).astype(np.float32) for f in (440, 523.251, 659.255)])
    wav = io.BytesIO()
    sf.write(wav, tones, sr, format='WAV', subtype='PCM_16')
    definition = ModelDefinition.from_dict(next(m for m in read_manifest()['models'] if m['id'] == 'basic-pitch'))
    result = basic_pitch_midi('basic-pitch', definition, {'audioBase64': base64.b64encode(wav.getvalue()).decode()})
    midi = base64.b64decode(result['midiBase64'])
    assert midi.startswith(b'MThd') and result['noteCount'] > 0
    report = {'device': 'cpu', 'syntheticFixturesOnly': True, 'gpuValidated': False,
              'beatThis': {'seconds': round(beat_seconds, 3), 'inputSeconds': 12,
                           'beatCount': len(beats), 'downbeatCount': len(downbeats),
                           'beats': beats.tolist(), 'downbeats': downbeats.tolist()},
              'basicPitch': {'noteCount': result['noteCount'], 'midiBytes': len(midi)},
              'totalSeconds': round(time.monotonic()-start, 3)}
    output = Path(os.environ.get('CPU_SMOKE_OUT', '/tmp/weight-cpu-smoke.json'))
    output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()

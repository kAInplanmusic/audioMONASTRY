"""Deterministic Fake Agent responses for the local Vast simulator."""
import base64
import io
import json
import math
import re
import struct
import wave
from functools import lru_cache

SAMPLE_RATE = 48000
NATIVE_STEMS = {'vocals': 440, 'drums': 180, 'bass': 80, 'guitar': 330, 'piano': 660, 'other': 880}
APP_STEMS = {'vocals': 440, 'lows': 80, 'mids': 220, 'highs': 880, 'melody': 660}
SPECIALIST_STEMS = {
    'mel-roformer-bve': {'lead': 440, 'back': 550},
    'mel-roformer-dereverb': {'noreverb': 440, 'reverb': 660},
}
AUDIO_FIXTURES = {
    'tts': (440, 1), 'song': (330, 2), 'sing': (392, 2), 'audio.generate': (220, 2),
    'audio.master': (660, 2), 'audio.upsample': (880, 2),
}


# Fixed test data. These values describe fixtures, never the caller's audio.
ANALYSIS_FIXTURES = {
    ('audio.understand', 'moss-music-8b-instruct'): {
        'text': 'Testsignal: gleichmässiger Viertelpuls, zwei Abschnitte.',
        'sampleRate': SAMPLE_RATE, 'seconds': 4,
    },
    ('audio.classify', 'clap-music'): {'labels': ['electronic', 'instrumental']},
    ('audio.analyze', 'beat-this'): {
        'analysis': 'beats', 'beats': [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
        'downbeats': [0, 2], 'bpm': 120, 'durationSeconds': 4,
    },
    ('audio.analyze', 'songformer'): {
        'analysis': 'structure', 'sections': [
            {'start': 0, 'end': 2, 'label': 'intro'},
            {'start': 2, 'end': 4, 'label': 'verse'},
        ], 'sampleRate': SAMPLE_RATE, 'durationSeconds': 4,
    },
    ('audio.analyze', 'dsp-analysis'): {
        'sampleRate': SAMPLE_RATE, 'durationSeconds': 4, 'rms': 0.125, 'peak': 0.25,
        'spectralCentroidHz': 440, 'chromaMean': [0] * 9 + [1, 0, 0],
        'onsetTimesSeconds': [0.5, 1, 1.5], 'measurementOnly': True,
    },
}

# Standard MIDI File, format 0, one quarter-note C4 at the default tempo.
MIDI_NOTE = bytes.fromhex('4d546864000000060000000101e04d54726b0000000d'
                          '00903c648360803c0000ff2f00')


@lru_cache(maxsize=32)
def tone_wav(freq, channels=2):
    """Adapt the export's faded sinusoid to a fixed 250 ms PCM16 fixture."""
    frames = SAMPLE_RATE // 4
    data = bytearray()
    for frame in range(frames):
        envelope = min(1, frame / 1200, (frames - frame) / 2400)
        value = round(math.sin(2 * math.pi * freq * frame / SAMPLE_RATE) * 8191 * envelope)
        data.extend(struct.pack('<h', value) * channels)
    with io.BytesIO() as buffer:
        with wave.open(buffer, 'wb') as wav:
            wav.setparams((channels, 2, SAMPLE_RATE, frames, 'NONE', 'not compressed'))
            wav.writeframes(data)
        return base64.b64encode(buffer.getvalue()).decode('ascii')


def simulate(task, model, payload):
    result = {'simulated': True}
    fixture = ANALYSIS_FIXTURES.get((task, model))
    if fixture is not None:
        return {**result, **fixture, 'model': model}
    if (task, model) == ('audio.transcribe', 'basic-pitch'):
        return {**result, 'midiBase64': base64.b64encode(MIDI_NOTE).decode('ascii'),
                'noteCount': 1, 'source': model, 'sampleRate': SAMPLE_RATE}
    if task in AUDIO_FIXTURES:
        freq, channels = AUDIO_FIXTURES[task]
        return {**result, 'audioBase64': tone_wav(freq, channels), 'sampleRate': SAMPLE_RATE,
                'format': 'wav', 'durationSec': 0.25}
    if task == 'stem.separate':
        stems = SPECIALIST_STEMS.get(model, APP_STEMS)
        result.update(stems={key: tone_wav(freq) for key, freq in stems.items()}, stemSet=list(stems),
                      sampleRate=SAMPLE_RATE, format='wav', sampleFormat='pcm16')
        if model == 'bs-roformer-sw-6stem':
            result.update(modelStems=list(NATIVE_STEMS), melodyAvailable=True)
            if payload.get('includeModelStems') is True:
                result['modelStemAudio'] = {key: tone_wav(freq) for key, freq in NATIVE_STEMS.items()}
        return result
    if task == 'gui.execute':
        commands = []
        catalog = payload.get('allowedPluginCommands')
        transport = catalog.get('transport', '') if isinstance(catalog, dict) else ''
        instruction = payload.get('instruction')
        tempo = re.search(r'\b([1-9][0-9]{1,2})\s*BPM\b', instruction, re.I) if isinstance(instruction, str) else None
        if (payload.get('format') == 'daw_commands' and isinstance(transport, str)
                and re.search(r'\bset_tempo\s*\(', transport) and tempo and 60 <= int(tempo[1]) <= 240):
            commands.append({'pluginId': 'transport', 'command': f'set_tempo({tempo[1]})'})
        return {**result, 'text': json.dumps({'commands': commands}), 'executed': False,
                'requiresAppPermissionCheck': True, 'requiresPluginLock': True}
    return {**result, 'text': f'simulated {task}/{model}', 'segments': [], 'labels': [], 'embedding': [0.0] * 8}

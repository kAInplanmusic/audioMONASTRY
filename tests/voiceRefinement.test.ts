import { describe, expect, it } from 'vitest';
import { getVoicePreset, VOICE_PRESETS } from '../src/core/voice/voicePresets';
import { midiToFrequency, renderMelodyWav } from '../src/core/voice/melody';

describe('VoiceMONK-Verfeinerung', () => {
  it('Voice-Presets liefern Optionen + HF-Modell', () => {
    const preset = getVoicePreset('dark-male-de');
    expect(preset?.options.gender).toBe('male');
    expect(preset?.options.character).toBe('dark');
    expect(preset?.hfModel).toBe('facebook/mms-tts-deu');
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(4);
  });

  it('midiToFrequency rechnet korrekt (A4 = 440 Hz)', () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 5);
  });

  it('renderMelodyWav erzeugt eine WAV-Datei aus Noten', () => {
    const blob = renderMelodyWav(
      [
        { lyric: 'Hal', midi: 60 },
        { lyric: 'lo', midi: 64, durationBeats: 2 },
      ],
      120,
    );
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBeGreaterThan(44);
  });
});

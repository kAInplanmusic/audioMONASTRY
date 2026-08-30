/**
 * audioMONASTRY · VoiceMONK Voice-Presets
 * ========================================
 * Benannte Stimmen mit Voice-Optionen, Sprache und bevorzugtem HF-TTS-Modell.
 */
import type { VoiceOptions } from './VoiceMonkService';

export interface VoicePreset {
  id: string;
  name: string;
  language: string;
  options: VoiceOptions;
  hfModel?: string;
}

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: 'dark-male-de',
    name: 'Dunkler Mann (de)',
    language: 'de',
    options: { gender: 'male', character: 'dark', loudness: 'soft' },
    hfModel: 'facebook/mms-tts-deu',
  },
  {
    id: 'bright-female-de',
    name: 'Helle Frau (de)',
    language: 'de',
    options: { gender: 'female', character: 'bright', loudness: 'normal' },
    hfModel: 'facebook/mms-tts-deu',
  },
  {
    id: 'neutral-female-en',
    name: 'Neutrale Frau (en)',
    language: 'en',
    options: { gender: 'female', character: 'neutral', loudness: 'normal' },
    hfModel: 'facebook/mms-tts-eng',
  },
  {
    id: 'dark-male-en',
    name: 'Dunkler Mann (en)',
    language: 'en',
    options: { gender: 'male', character: 'dark', loudness: 'soft' },
    hfModel: 'facebook/mms-tts-eng',
  },
];

export function getVoicePreset(id: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((p) => p.id === id);
}

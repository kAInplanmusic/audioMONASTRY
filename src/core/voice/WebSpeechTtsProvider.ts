/**
 * audioMONASTRY · Phase 4 – WebSpeech Live-TTS (kostenlos, Browser)
 * ================================================================
 * Nutzt die eingebaute SpeechSynthesis für Live-Vorschau. Erzeugt keine
 * Datei, sondern spricht direkt über das Browser-Audio-Device.
 */
import type { VoiceOptions } from './VoiceMonkService';

export interface ILiveSpeechProvider {
  readonly id: string;
  readonly available: boolean;
  speak(text: string, options: VoiceOptions): void;
}

export class WebSpeechTtsProvider implements ILiveSpeechProvider {
  readonly id = 'webspeech';

  get available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  speak(text: string, options: VoiceOptions): void {
    if (!this.available) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'de-DE';
    utterance.pitch = options.gender === 'female' ? 1.3 : options.character === 'dark' ? 0.7 : 1.0;
    utterance.rate = options.loudness === 'soft' ? 0.85 : 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }
}

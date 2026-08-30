/**
 * audioMONASTRY · Phase 4 – Singing Engine
 * =========================================
 * Lyrics/Melody/Pitch/Timing. Die lokale Engine delegiert an die echten
 * Synthese-Backends: Gesang über den Formant-Synth (bzw. HF Bark via
 * VoiceMonkService), Sprache über den VoiceMonkService.
 */

import { isTrustedMediaUrl } from '../../utils/mediaUrlGuard';

export interface VoiceModel {
  id: string;
  name: string;
  engine: 'tts' | 'singing';
  locale: string;
}

export interface SingingNote {
  lyric: string;
  midi: number;
  start: number; // Sekunden
  duration: number;
}

export interface SingingPhrase {
  notes: SingingNote[];
  bpm: number;
}

export interface ISingingEngine {
  loadModel(model: VoiceModel): Promise<void>;
  sing(phrase: SingingPhrase): Promise<void>;
  speak(text: string): Promise<void>;
  stop(): void;
}

/** Lokale Engine: nutzt die vorhandenen Synthese-Pfade (offline-first). */
export class LocalSingingEngine implements ISingingEngine {
  private model: VoiceModel | null = null;

  async loadModel(model: VoiceModel): Promise<void> {
    this.model = model;
  }

  async sing(phrase: SingingPhrase): Promise<void> {
    if (!this.model) throw new Error('Kein VoiceModel geladen');
    const { renderVocalWav } = await import('./melody');
    const beatSeconds = 60 / Math.max(20, phrase.bpm);
    const notes = phrase.notes.map((n) => ({
      lyric: n.lyric,
      midi: n.midi,
      durationBeats: Math.max(0.25, n.duration / beatSeconds),
    }));
    const blob = renderVocalWav(notes, phrase.bpm);
    await this.playBlob(blob);
  }

  async speak(text: string): Promise<void> {
    const { voiceMonkService } = await import('./VoiceMonkService');
    const result = await voiceMonkService.speak('localUser', text);
    await this.playUrl(result.audioUrl);
  }

  stop(): void {
    // Die aktive Wiedergabe läuft über die Service-Schicht; hier kein eigener Zustand.
  }

  private async playBlob(blob: Blob): Promise<void> {
    if (typeof URL === 'undefined' || typeof Audio === 'undefined') return;
    const url = URL.createObjectURL(blob);
    await this.playUrl(url);
  }

  private async playUrl(url: string): Promise<void> {
    if (typeof Audio === 'undefined') return;
    // F4-Fix: nur vertrauenswürdige URLs abspielen (blob:/data:/eigene Hosts).
    if (!isTrustedMediaUrl(url)) return;
    const audio = new Audio(url);
    try {
      await audio.play();
    } catch {
      // Autoplay-Policy: still ignorieren (Preview ist optional).
    }
  }
}

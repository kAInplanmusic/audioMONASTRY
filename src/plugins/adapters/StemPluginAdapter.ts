import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** Die fünf stemMONK-Stems (AGENTS.md #11). */
export type FiveStemKey = 'vocals' | 'lows' | 'mids' | 'highs' | 'melody';

/**
 * Reihenfolge, Anzeige und Bibliotheks-Kategorie der fünf Stems. Spiegel von
 * `FIVE_STEM_KEYS` in services/audiomonastry-ai-runtime/stem_crossover.py
 * (FLEET-P1-006: Vocals = vocals, Melodie = guitar + piano, Lows = bass + drums
 * unter ca. 150 Hz, Mids/Highs = Rest, LR4-Weiche bei ca. 2,5 kHz).
 */
export const FIVE_STEMS: ReadonlyArray<{ key: FiveStemKey; label: string; category: 'bass' | 'mids' | 'highs' }> = [
  { key: 'vocals', label: 'Vocals', category: 'mids' },
  { key: 'lows', label: 'Lows', category: 'bass' },
  { key: 'mids', label: 'Mids', category: 'mids' },
  { key: 'highs', label: 'Highs', category: 'highs' },
  { key: 'melody', label: 'Melodie', category: 'mids' },
];

/** Ergebnis einer 5-Stem-Trennung (Server/RP5); `melodyAvailable=false` = 4-Stem-Fallback (SCNet). */
export interface FiveStemResult {
  stems: Partial<Record<FiveStemKey, string>>;
  melodyAvailable?: boolean;
  notes?: string[];
}

/** Ein Bibliotheks-Eintrag pro Stem (still im Hintergrund abgelegt, siehe StemExtractorTerminal). */
export interface FiveStemLibraryEntry {
  key: FiveStemKey;
  name: string;
  category: 'bass' | 'mids' | 'highs';
  description: string;
  url: string;
}

/**
 * Bibliotheks-Einträge für ein 5-Stem-Ergebnis. Leere Stems landen NICHT in der
 * Bibliothek – im 4-Stem-Fallback ist die Melodie leer und wird übersprungen.
 */
export function fiveStemLibraryEntries(sourceName: string, result: FiveStemResult): FiveStemLibraryEntry[] {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'stem';
  const fallback = result.melodyAvailable === false;
  return FIVE_STEMS.flatMap(({ key, label, category }) => {
    const url = result.stems[key];
    if (typeof url !== 'string' || url.length === 0) return [];
    return [{
      key,
      name: `${base}_${key}`,
      category,
      description: `${label}-Stem aus ${sourceName}${fallback ? ' (4-Stem-Fallback, Melodie leer)' : ''}`,
      url,
    }];
  });
}

/** stemMONK – Stem-Separation und -Analyse (kanonische ID `stem`). */
export class StemPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'stem',
    name: 'stemMONK',
    version: '1.0.0',
    kind: 'analysis',
    capabilities: ['ai', 'analysis', 'audio-processor'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(StemPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    // UI2-P0-003-F1: definierter Transport-Start für die SYNC-Taste (channel8 =
    // stem-Rolle); ohne SYNC sofort, mit SYNC taktgleich zu Main.
    if (command.name === 'play' || command.name === 'start') {
      const start = () => { this.context?.audio.triggerEvent('channel8', Number(command.payload?.velocity ?? 0.8)); };
      this.scheduleSyncStart(start);
      return { ok: true, track: 'channel8' };
    }
    if (command.name === 'separate') {
      // Datei-Picker-/Queue-Pfad: Progress, Abbruch und Provider-Fallbacks
      // liegen im StemExtractorTerminal bzw. stem-Router (async).
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:stem-pick-file', command.payload ?? {});
      return { ok: true };
    }
    if (command.name === 'status') {
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:stem-status', command.payload ?? {});
      return { ok: true };
    }
    return super.onCommand(command);
  }
}

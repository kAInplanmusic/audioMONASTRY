/**
 * audioMONASTRY – Signalkette (linearer Insert-Pfad)
 * ==================================================
 * EINE Quelle für die Reihenfolge, in der die 16 kanonischen Plugins im
 * Signalweg liegen:
 *
 *   erstelle­nde Plugins → Mixer → verarbeitende/DSP → Recorder → Main Out
 *
 * Die Reihenfolge ist **fest und unabhängig davon, wer welches Plugin hält**:
 * Wer den Mixer hat, ändert nicht den Pfad, sondern nur, wer ihn bedient. Das
 * ist der Unterschied zwischen der *Kopfreihenfolge* (Sortierung der Icons in
 * `plugins/registry.ts`, an der die Modulfarben hängen) und der **Signalkette**
 * hier – zwei getrennte Achsen, die bisher nirgends getrennt aufgeschrieben
 * waren.
 *
 * Die Stufen `sources`/`processing` entsprechen `docs/UI_SPEC.md`; der Recorder
 * steht dort noch in der Nachbearbeitung und ist hier bewusst eine eigene Stufe
 * vor dem Ausgang (Vorgabe 2026-10-05: … → recorder → main out).
 */

import type { CanonicalPluginId } from './plugin_interface';

export type SignalStageId = 'sources' | 'mixer' | 'processing' | 'recorder' | 'out';

export interface SignalStage {
  readonly id: SignalStageId;
  /** Anzeigename der Stufe (UI-Sprache). */
  readonly label: string;
  /** Plugins dieser Stufe – genau in dieser Reihenfolge. Leer = kein Plugin (Ausgang). */
  readonly plugins: readonly CanonicalPluginId[];
}

/**
 * Der Signalweg, von der Quelle bis zum Ausgang. Diese Liste ist bindend:
 * Wer die Reihenfolge ändert, ändert die Kette für alle – nicht für ein Modul.
 */
export const SIGNAL_CHAIN: readonly SignalStage[] = [
  {
    id: 'sources',
    label: 'Quellen',
    plugins: ['biblio', 'drop', 'song', 'drumsampler', 'syntisampler', 'instru', 'voice', 'sound', 'stem'],
  },
  { id: 'mixer', label: 'Mixer', plugins: ['mixer'] },
  { id: 'processing', label: 'Nachbearbeitung', plugins: ['effect', 'eq', 'dsp', 'spatial', 'master'] },
  { id: 'recorder', label: 'Recorder', plugins: ['record'] },
  { id: 'out', label: 'Main Out', plugins: [] },
];

/** Alle Plugins der Kette, in Signalweg-Reihenfolge (ohne die leere Ausgangsstufe). */
export const SIGNAL_CHAIN_ORDER: readonly CanonicalPluginId[] = SIGNAL_CHAIN.flatMap((s) => s.plugins);

/** Die Stufe, in der ein Plugin liegt – `null`, wenn es nicht im Signalweg liegt. */
export function signalStageOf(id: string): SignalStage | null {
  for (const stage of SIGNAL_CHAIN) {
    if (stage.plugins.includes(id as CanonicalPluginId)) return stage;
  }
  return null;
}

/** Position im Signalweg (0 = erste Quelle). `-1` = nicht im Signalweg. */
export function signalOrderIndex(id: string): number {
  return SIGNAL_CHAIN_ORDER.indexOf(id as CanonicalPluginId);
}

/** Kurzer, stabiler Pfad für Anzeigen: `biblio → … → master → record → Main Out`. */
export function signalChainPath(): string[] {
  const labels: string[] = [];
  for (const stage of SIGNAL_CHAIN) {
    if (stage.plugins.length === 0) {
      labels.push(stage.label);
      continue;
    }
    labels.push(...stage.plugins.map((p) => p));
  }
  return labels;
}

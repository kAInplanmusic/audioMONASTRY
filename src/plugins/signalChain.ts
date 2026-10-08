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
import { PLUGIN_CONTRACTS } from './pluginContract';

export type SignalStageId = 'sources' | 'mixer' | 'processing' | 'recorder' | 'out';

export interface SignalStage {
  readonly id: SignalStageId;
  /** Anzeigename der Stufe (UI-Sprache). */
  readonly label: string;
  /** Plugins dieser Stufe – genau in dieser Reihenfolge. Leer = kein Plugin (Ausgang). */
  readonly plugins: readonly CanonicalPluginId[];
}

/**
 * B1 (2026-10-07): Die Stufen-Zuordnung wird aus `pluginContract.ts` ABGELEITET
 * statt hier zweitgepflegt. Der Vertrag nennt je Plugin die Rolle; diese Liste
 * uebersetzt Rolle → Stufe.
 *
 * Die REIHENFOLGE innerhalb einer Stufe bleibt bewusst hier: sie ist eine
 * Signalweg-Entscheidung, keine Plugin-Eigenschaft. Wer sie ändert, ändert die
 * Kette für alle - nicht für ein Modul.
 */
const STAGE_OF_ROLE: Record<string, SignalStageId | null> = {
  source: 'sources',
  utility: 'sources', // biblio steht in der Quellen-Stufe, erzeugt aber keinen Ton
  channel: 'mixer',
  insert: 'processing',
  fxReturn: 'processing',
  recorder: 'recorder',
};

/** Signalweg-Reihenfolge je Stufe (bindend). */
const STAGE_ORDER: Record<SignalStageId, readonly string[]> = {
  sources: ['biblio', 'drop', 'song', 'drumsampler', 'syntisampler', 'instru', 'voice', 'sound', 'stem'],
  mixer: ['mixer'],
  processing: ['effect', 'eq', 'dsp', 'spatial', 'master'],
  recorder: ['record'],
  out: [],
};

const STAGE_LABELS: Record<SignalStageId, string> = {
  sources: 'Quellen',
  mixer: 'Mixer',
  processing: 'Nachbearbeitung',
  recorder: 'Recorder',
  out: 'Main Out',
};

const STAGE_SEQUENCE: readonly SignalStageId[] = ['sources', 'mixer', 'processing', 'recorder', 'out'];

/**
 * Der Signalweg, von der Quelle bis zum Ausgang. Diese Liste ist bindend.
 *
 * Die Zuordnung Rolle→Stufe kommt aus dem Vertrag; nur die Reihenfolge ist hier
 * festgeschrieben. Ein Plugin ohne Vertrag (oder mit Rolle ohne Stufe) taucht
 * hier nicht auf - genau das ist gewollt und wird im Test geprueft.
 */
export const SIGNAL_CHAIN: readonly SignalStage[] = STAGE_SEQUENCE.map((stageId) => {
  const plugins = STAGE_ORDER[stageId].filter((id) => {
    const role = PLUGIN_CONTRACTS.find((c) => c.id === id)?.role;
    return role !== undefined && STAGE_OF_ROLE[role] === stageId;
  }) as CanonicalPluginId[];
  return { id: stageId, label: STAGE_LABELS[stageId], plugins };
});

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

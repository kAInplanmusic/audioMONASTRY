/**
 * audioMONASTRY · Capture → drumsamplerMONK-Pattern (IDEA-2026-10-07-A-F1)
 * =========================================================================
 * „In Sequencer übernehmen“ schreibt die Drum-Schläge eines Capture-Takts in
 * DIESELBE Quelle, aus der die Pattern-Ansicht des drumsamplerMONK liest:
 * die Patterns `${bank}:${kit}:${sound}` (Plugin-Settings `drumsampler`,
 * serverseitig in der Session, vom Halter geschrieben → alle 4 Nutzer sehen
 * denselben Stand).
 *
 * Weg zur Ansicht:
 *   1. CaptureControl feuert `CAPTURE_DRUM_MERGE_EVENT` (synchron).
 *   2. Ist das drumsamplerMONK-Terminal offen, übernimmt es die Schläge in
 *      seine aktuelle Bank (sofort sichtbar) und setzt `detail.handled = true`;
 *      sein Persistenz-Effekt schreibt den Stand in die Session.
 *   3. Sonst schreibt CaptureControl direkt in die Plugin-Settings (Bank A);
 *      das Terminal startet beim nächsten Öffnen mit genau diesem Stand.
 *
 * Übernahme = ODER (ergänzt, löscht nichts); der Takt landet auf Step 1–16.
 * Rein (keine Plattform-APIs), direkt testbar.
 */
import type { CaptureDrumHit } from './quantizeCapture';

/** Window-Event für das offene drumsamplerMONK-Terminal. */
export const CAPTURE_DRUM_MERGE_EVENT = 'monk:capture-drum-merge';

export interface CaptureDrumMergeDetail {
  /** Schläge EINES Takts (Step 0–15). */
  hits: CaptureDrumHit[];
  /** Vom Terminal auf `true` gesetzt, wenn es die Übernahme selbst angewendet hat. */
  handled: boolean;
  /** Vom Terminal gemeldete Ziel-Bank (Anzeige). */
  bank?: 'A' | 'B';
}

/** Schlüssel wie in `DrumMachineTerminal` (`${bank}:${kit}:${sound}`). */
export function drumPatternKey(bank: string, kitId: string, soundId: string): string {
  return `${bank}:${kitId}:${soundId}`;
}

export interface DrumMergeResult {
  patterns: Record<string, boolean[]>;
  /** Anzahl neu gesetzter Steps (vorher aus). */
  added: number;
}

/**
 * ODER-Verknüpfung der Schläge mit den Drum-Patterns. Liefert eine neue Map;
 * die Eingabe bleibt unverändert. Fehlende Patterns werden mit `stepCount`
 * Steps angelegt, bestehende behalten ihre Länge (16/32).
 */
export function mergeCaptureDrumHits(
  patterns: Readonly<Record<string, readonly boolean[]>>,
  hits: readonly CaptureDrumHit[],
  bank: string,
  stepCount: number,
): DrumMergeResult {
  const out: Record<string, boolean[]> = {};
  for (const k of Object.keys(patterns)) out[k] = [...patterns[k]];
  const len = stepCount === 32 ? 32 : 16;
  let added = 0;
  for (const h of hits) {
    if (!h.kitId || !h.soundId || h.step < 0 || h.step > 15) continue;
    const key = drumPatternKey(bank, h.kitId, h.soundId);
    const arr = out[key] ?? (out[key] = new Array<boolean>(len).fill(false));
    if (h.step >= arr.length) continue;
    if (!arr[h.step]) { arr[h.step] = true; added++; }
  }
  return { patterns: out, added };
}

/** Schläge eines Takts (Step 0–15) aus allen Schlägen eines Capture. */
export function drumHitsOfBar(hits: readonly CaptureDrumHit[], bar: number): CaptureDrumHit[] {
  return hits.filter((h) => h.bar === bar);
}

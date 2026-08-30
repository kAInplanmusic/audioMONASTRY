/**
 * audioMONASTRY · WebAudio Worklet Bridge (Live-Pfad)
 * ===================================================
 * Verdrahtet die echten AudioWorkletNodes (itSynth → EQ → Mastering) mit der
 * WebAudio-Destination. Läuft NUR im Browser-Kontext; in Node/jsdom ist die
 * Funktion ein sicherer No-Op.
 */

export interface WorkletNodeSet {
  source: AudioNode;
  itSynth?: AudioNode;
  eq?: AudioNode;
  mastering?: AudioNode;
  destination: AudioNode;
}

export class WebAudioWorkletBridge {
  /** Verbindet die vorhandenen Worklet-Nodes in Reihe zur Destination. */
  connect(set: WorkletNodeSet): boolean {
    if (typeof AudioContext === 'undefined') return false;
    try {
      let previous: AudioNode = set.source;
      for (const node of [set.itSynth, set.eq, set.mastering]) {
        if (!node) continue;
        previous.connect(node);
        previous = node;
      }
      previous.connect(set.destination);
      return true;
    } catch {
      return false;
    }
  }

  /** Trennt die Kette wieder (idempotent, für sauberes Re-Wiring). */
  disconnect(set: WorkletNodeSet): void {
    try {
      let previous: AudioNode = set.source;
      for (const node of [set.itSynth, set.eq, set.mastering]) {
        if (!node) continue;
        previous.disconnect(node);
        previous = node;
      }
      previous.disconnect(set.destination);
    } catch {
      // Nicht verbunden – ignorieren.
    }
  }
}

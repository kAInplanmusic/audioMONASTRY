/**
 * audioMONASTRY · V2-PDC (Phase 2)
 * =================================
 * PDC-Werte für den V2-Pfad. Der Mastering-Lookahead (5 ms) verzögert das
 * Hauptsignal; andere Pfade (Cue/Monitor, Scheduler-Referenz) müssen um
 * denselben Betrag kompensiert werden, damit nichts phasenverschoben/verfrüht
 * ankommt.
 *
 * RT-AUDIT-P0-004: Der Wert ist jetzt die ECHTE Latenz des `MasteringNode`
 * (Delay-Line des Lookahead-Limiters, `src/core/dsp/masteringDynamics.ts`
 * liest genau diese Funktion). Vorher rechnete die PDC 5 ms ein, die der
 * V2-Pfad nicht hatte. Kompensiert wird im V2-Pfad der Cue-Weg zum Monitor
 * (`V2MonitorGraph.cuePdc`); die Step-Clock kann es über
 * `pdcCompensationSamples` (`V2SampleClock`).
 */

export const V2_MASTERING_LOOKAHEAD_SEC = 0.005;

/** Lookahead-Tiefe in Samples bei gegebener Sample-Rate (Default 48 kHz). */
export function v2MasteringLookaheadSamples(sampleRate = 48000): number {
  return Math.max(16, Math.round(V2_MASTERING_LOOKAHEAD_SEC * sampleRate));
}

/**
 * Kompensiert einen Step-Frame um den Mastering-Lookahead.
 * Der Scheduler feuert damit so viele Samples früher, wie der spätere
 * Lookahead-Mastering-Knoten das Signal verzögert – das hörbare Ereignis
 * landet wieder exakt auf dem musikalischen Raster.
 */
export function compensateV2StepFrame(frame: number, sampleRate = 48000): number {
  return frame - v2MasteringLookaheadSamples(sampleRate);
}

/**
 * audioMONASTRY · Capture – Quantisierung Events → Takte (IDEA-2026-10-07-A)
 * ==========================================================================
 * Macht aus den aufgezeichneten Eingaben (`EventCaptureLog.snapshot`) ein
 * 16tel-Raster in 4/4-Takten (16 Steps je Takt, 8 Spuren channel1..8).
 *
 * RASTER-REGEL
 * ------------
 * Step-Länge = 60 / BPM / 4 Sekunden (16tel).
 *  1. Ist eine Transport-Startzeit bekannt (AudioContext-Sekunden) und liegt
 *     sie nicht mehr als ein halbes 16tel nach dem ersten Event, wird das Raster
 *     an ihr ausgerichtet: Ursprung ist der letzte Taktanfang
 *     (Transport-Start + k · Taktlänge) vor bzw. auf dem ersten Event (ein um
 *     weniger als ein halbes 16tel verfrühtes Event zählt zum folgenden Takt).
 *     Takt 1 im Vorschlag ist dann ein echter Takt des laufenden Transports.
 *     IDEA-2026-10-07-A-F1: Die Startzeit ist der EXAKTE Worklet-Frame des
 *     ersten Step 0 (`transport-started` aus dem v2SinkProcessor, hörbarer
 *     Frame inkl. PDC) / sampleRate – keine `ctx.currentTime`-Näherung mehr.
 *  2. Sonst (Transport läuft nicht / Start unbekannt) ist der Ursprung das erste
 *     Event, auf das 16tel-Raster der AudioContext-Uhr ABGERUNDET
 *     (floor(t / Step) · Step). Der erste Treffer landet so auf Step 1 (Index 0)
 *     eines Takts oder knapp dahinter.
 * Jedes Event wird auf den NÄCHSTEN Step gerundet: index = round((t − Ursprung) / Step),
 * Takt = floor(index / 16), Step = index mod 16. Ergeben sich mehr als
 * `maxBars` Takte, bleiben die letzten `maxBars`.
 *
 * Vorschlag = der letzte Takt mit mindestens einem Treffer (sonst −1).
 * `notes` enthält nur Note-On-Events (mit Tonhöhe); Pad-Trigger erscheinen nur
 * im Raster.
 *
 * IDEA-2026-10-07-A-F1: drumsamplerMONK-Eingaben (`drum-pad`/`drum-step`)
 * landen NICHT im 8-Spur-Engine-Raster (sonst spielte der Engine-Kanal sie ein
 * zweites Mal), sondern in `drumHits` (Takt, Step, Kit, Sound). Sie zählen für
 * den Vorschlag mit.
 *
 * Rein (keine Plattform-APIs), direkt testbar.
 */
import { ALL_TRACKS, type TrackType } from '../../types';
import { CAPTURE_BARS, barSeconds, isDrumCaptureKind, type CaptureEvent } from './eventCaptureLog';

export const CAPTURE_STEPS_PER_BAR = 16;

export type CaptureBar = Record<TrackType, boolean[]>;

export interface CaptureNote {
  bar: number;
  step: number;
  track: TrackType;
  note: number;
  velocity: number;
}

/** IDEA-2026-10-07-A-F1: quantisierter drumsamplerMONK-Schlag. */
export interface CaptureDrumHit {
  bar: number;
  step: number;
  kitId: string;
  soundId: string;
  velocity: number;
}

export interface QuantizedCapture {
  bars: CaptureBar[];
  notes: CaptureNote[];
  /** drumsamplerMONK-Schläge (nicht im Engine-Raster `bars`). */
  drumHits: CaptureDrumHit[];
  /** Index des vorgeschlagenen Takts in `bars` (−1 = keine Treffer). */
  suggestedBarIndex: number;
  /** Raster-Ursprung (AudioContext-Sekunden) des ersten Takts in `bars`. */
  gridStartSec: number;
  /** Länge eines 16tels in Sekunden. */
  stepSec: number;
}

export interface QuantizeOptions {
  /** AudioContext-Zeit des Transport-Starts (oder null/undefiniert). */
  transportStartSec?: number | null;
  maxBars?: number;
}

export function emptyCaptureBar(): CaptureBar {
  const bar = {} as CaptureBar;
  for (const t of ALL_TRACKS) bar[t] = new Array<boolean>(CAPTURE_STEPS_PER_BAR).fill(false);
  return bar;
}

/** Hat der Takt mindestens einen aktiven Step? */
export function barHasHits(bar: CaptureBar): boolean {
  return ALL_TRACKS.some((t) => bar[t].some(Boolean));
}

/** Raster-Ursprung nach der Regel im Kopfkommentar. */
export function captureGridOrigin(firstEventSec: number, bpm: number, transportStartSec?: number | null): number {
  const bar = barSeconds(bpm);
  const step = bar / CAPTURE_STEPS_PER_BAR;
  const half = step / 2;
  if (typeof transportStartSec === 'number' && Number.isFinite(transportStartSec) && transportStartSec <= firstEventSec + half) {
    const k = Math.floor((firstEventSec + half - transportStartSec) / bar + 1e-9);
    return transportStartSec + k * bar;
  }
  return Math.floor(firstEventSec / step + 1e-9) * step;
}

export function quantizeCapture(events: readonly CaptureEvent[], bpm: number, options: QuantizeOptions = {}): QuantizedCapture {
  const maxBars = Math.max(1, Math.floor(options.maxBars ?? CAPTURE_BARS));
  const stepSec = barSeconds(bpm) / CAPTURE_STEPS_PER_BAR;
  if (events.length === 0) {
    return { bars: [], notes: [], drumHits: [], suggestedBarIndex: -1, gridStartSec: 0, stepSec };
  }
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const origin = captureGridOrigin(sorted[0].time, bpm, options.transportStartSec);

  const indexed = sorted.map((e) => ({ e, index: Math.max(0, Math.round((e.time - origin) / stepSec)) }));
  const lastBar = Math.floor(indexed[indexed.length - 1].index / CAPTURE_STEPS_PER_BAR);
  const firstBar = Math.max(0, lastBar - maxBars + 1);

  const bars: CaptureBar[] = [];
  for (let b = firstBar; b <= lastBar; b++) bars.push(emptyCaptureBar());
  const notes: CaptureNote[] = [];
  const drumHits: CaptureDrumHit[] = [];
  const drumBarHit = new Array<boolean>(bars.length).fill(false);
  const drumSeen = new Set<string>();
  for (const { e, index } of indexed) {
    const absBar = Math.floor(index / CAPTURE_STEPS_PER_BAR);
    if (absBar < firstBar) continue;
    const bar = absBar - firstBar;
    const step = index % CAPTURE_STEPS_PER_BAR;
    if (isDrumCaptureKind(e.kind)) {
      // Ein Treffer je (Takt, Step, Kit, Sound) – lauteste Velocity gewinnt.
      const kitId = e.kitId ?? '';
      const soundId = e.soundId ?? '';
      if (!kitId || !soundId) continue;
      const key = `${bar}|${step}|${kitId}|${soundId}`;
      if (drumSeen.has(key)) {
        const prev = drumHits.find((h) => h.bar === bar && h.step === step && h.kitId === kitId && h.soundId === soundId);
        if (prev && e.velocity > prev.velocity) prev.velocity = e.velocity;
      } else {
        drumSeen.add(key);
        drumHits.push({ bar, step, kitId, soundId, velocity: e.velocity });
      }
      drumBarHit[bar] = true;
      continue;
    }
    bars[bar][e.track][step] = true;
    if (e.kind === 'note-on' && e.note >= 0) {
      notes.push({ bar, step, track: e.track, note: e.note, velocity: e.velocity });
    }
  }

  let suggestedBarIndex = -1;
  for (let b = bars.length - 1; b >= 0; b--) {
    if (drumBarHit[b] || barHasHits(bars[b])) { suggestedBarIndex = b; break; }
  }
  return {
    bars,
    notes,
    drumHits,
    suggestedBarIndex,
    gridStartSec: origin + firstBar * barSeconds(bpm),
    stepSec,
  };
}

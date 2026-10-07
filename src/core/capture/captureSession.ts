/**
 * audioMONASTRY · Capture – ein Klick, ein Ergebnis (IDEA-2026-10-07-A)
 * =====================================================================
 * Setzt Audio-Ring und Eingabe-Log zu einem `CaptureResult` zusammen. Läuft im
 * Main-Thread nur beim Capture-Klick (Allokation erlaubt). Die Engine liefert
 * Uhr, Tempo und Transport-Start herein; hier gibt es keine Plattform-APIs.
 */
import { ALL_TRACKS, type TrackType } from '../../types';
import { CAPTURE_BARS, type EventCaptureLog } from './eventCaptureLog';
import { quantizeCapture, type CaptureBar, type CaptureNote } from './quantizeCapture';
import type { AudioCaptureHandle } from './audioCapture';

export interface CaptureAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  /** Länge des Ausschnitts in Sekunden. */
  seconds: number;
}

export interface CaptureResult {
  /** `null`, wenn kein Abgriff läuft (Grund in `audioUnavailable`). */
  audio: CaptureAudio | null;
  audioUnavailable?: 'unsupported' | 'not-running';
  bars: CaptureBar[];
  suggestedBarIndex: number;
  bpm: number;
  notes: CaptureNote[];
  /** AudioContext-Zeit des Klicks. */
  capturedAtSec: number;
}

export interface CaptureInputs {
  log: EventCaptureLog;
  handle: AudioCaptureHandle | null;
  supported: boolean;
  nowSec: number;
  bpm: number;
  transportStartSec: number | null;
  bars?: number;
}

export function buildCaptureResult(input: CaptureInputs): CaptureResult {
  const bpm = Number.isFinite(input.bpm) && input.bpm > 0 ? input.bpm : 120;
  const bars = input.bars ?? CAPTURE_BARS;
  const events = input.log.snapshot(input.nowSec, bpm, bars);
  const q = quantizeCapture(events, bpm, { transportStartSec: input.transportStartSec, maxBars: bars });

  let audio: CaptureAudio | null = null;
  let audioUnavailable: CaptureResult['audioUnavailable'];
  if (input.handle) {
    const [left, right] = input.handle.read();
    audio = { left, right, sampleRate: input.handle.sampleRate, seconds: left.length / input.handle.sampleRate };
  } else {
    audioUnavailable = input.supported ? 'not-running' : 'unsupported';
  }
  return {
    audio,
    ...(audioUnavailable ? { audioUnavailable } : {}),
    bars: q.bars,
    suggestedBarIndex: q.suggestedBarIndex,
    bpm,
    notes: q.notes,
    capturedAtSec: input.nowSec,
  };
}

/**
 * ODER-Verknüpfung eines vorgeschlagenen Takts mit einem bestehenden Pattern
 * (der Capture ergänzt das laufende Pattern, statt es zu löschen). Liefert ein
 * neues Pattern derselben Länge (16 oder 32 Steps; Takt landet auf Step 1–16).
 */
export function mergeCaptureBar(current: Readonly<Record<TrackType, readonly boolean[]>>, bar: CaptureBar): Record<TrackType, boolean[]> {
  const out = {} as Record<TrackType, boolean[]>;
  for (const t of ALL_TRACKS) {
    const base = current[t] ? [...current[t]] : new Array<boolean>(16).fill(false);
    const steps = bar[t] ?? [];
    for (let i = 0; i < steps.length && i < base.length; i++) if (steps[i]) base[i] = true;
    out[t] = base;
  }
  return out;
}

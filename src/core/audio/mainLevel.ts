/**
 * Main-Pegel – EIN Abgriff am hörbaren Ausgang für die ganze Oberfläche
 * ==========================================================================
 * Mastergraph, Mixer und die Mini-Pegel der Plugin-Streifen lesen denselben
 * Wert. Die Quelle ist seit RT-AUDIT-P0-005 das Mess-SAB des V2-Sinks
 * (`audioEngine.readMeterValues`), in das der AudioWorklet Peak/True-Peak/RMS/
 * LUFS/Korrelation schreibt – kein Analyser-Knoten mehr, keine 60-ms-Abfrage
 * mit Sample-Verlust.
 *
 * Abfrage per requestAnimationFrame (folgt der Anzeige, kein fester 60-ms-Takt).
 * Der abgelesene Wert ist der Peak-Hold über ~20 ms, damit zwischen zwei Frames
 * kein Spitzenwert verloren geht.
 */
import { useSyncExternalStore } from 'react';
import { audioEngine } from '../../utils/audioEngine';

export interface MainLevel {
  /** 0..1 (−48 dB … 0 dB) */
  level: number;
  /** Spitzenwert mit langsamem Abfall, 0..1 */
  peak: number;
  /** linearer Spitzenwert des letzten ~20 ms (0..1) – für Wellenform-Verläufe */
  raw: number;
}

const SILENT: MainLevel = { level: 0, peak: 0, raw: 0 };
let current: MainLevel = SILENT;
const listeners = new Set<() => void>();
let raf = 0;

function tick(): void {
  raf = window.requestAnimationFrame(tick);
  const v = audioEngine.readMeterValues();
  if (!v) return;
  // Wellenform-Ring des Sinks in den gemeinsamen Puffer (Anzeige liest ihn direkt).
  audioEngine.readWaveform();
  // Peak-Hold über ~20 ms (beide Kanäle) – kein Sample-Verlust zwischen Frames.
  const p = Math.max(v.peakHoldL, v.peakHoldR);
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(p, 1e-5)) + 48) / 48));
  const peak = Math.max(level, current.peak - 0.02);
  if (level === current.level && peak === current.peak && p === current.raw) return;
  current = { level, peak, raw: Math.min(1, p) };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!raf) raf = window.requestAnimationFrame(tick);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.cancelAnimationFrame(raf);
      raf = 0;
      current = SILENT;
    }
  };
}

const get = () => current;

export function useMainLevel(): MainLevel {
  return useSyncExternalStore(subscribe, get, get);
}

/** Für Canvas-Zeichner außerhalb von React (liest nur, startet nichts). */
export function readMainLevel(): MainLevel {
  return current;
}

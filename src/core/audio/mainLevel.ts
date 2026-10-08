/**
 * Main-Pegel – EIN Analyser-Abgriff am hörbaren Ausgang für die ganze Oberfläche
 * ==========================================================================
 * Mastergraph, Mixer und die Mini-Pegel der Plugin-Streifen lesen denselben
 * Wert. Der Abgriff ist ein reiner Fan-out (`audioEngine.createVisualAnalyser`),
 * er verändert den Ton nicht und läuft nur, solange jemand zuhört.
 * Abfrage im UI-Takt (~60 ms), nie im Audio-Thread.
 */
import { useSyncExternalStore } from 'react';
import { audioEngine } from '../../utils/audioEngine';

export interface MainLevel {
  /** 0..1 (−48 dB … 0 dB) */
  level: number;
  /** Spitzenwert mit langsamem Abfall, 0..1 */
  peak: number;
  /** linearer Spitzenwert des letzten Blocks (0..1) – für Wellenform-Verläufe */
  raw: number;
}

const SILENT: MainLevel = { level: 0, peak: 0, raw: 0 };
let current: MainLevel = SILENT;
const listeners = new Set<() => void>();
let timer = 0;
let analyser: AnalyserNode | null = null;
let buf: Float32Array<ArrayBuffer> | null = null;

function tick(): void {
  if (!analyser) {
    try { analyser = audioEngine.createVisualAnalyser(1024); } catch { analyser = null; }
    if (analyser) buf = new Float32Array(analyser.fftSize);
  }
  let p = 0;
  if (analyser && buf) {
    analyser.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i += 2) p = Math.max(p, Math.abs(buf[i]));
  }
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(p, 1e-5)) + 48) / 48));
  const peak = Math.max(level, current.peak - 0.02);
  if (level === current.level && peak === current.peak && p === current.raw) return;
  current = { level, peak, raw: Math.min(1, p) };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!timer) timer = window.setInterval(tick, 60);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = 0;
      if (analyser) try { audioEngine.disconnectVisualAnalyser(analyser); } catch { /* noop */ }
      analyser = null;
      buf = null;
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

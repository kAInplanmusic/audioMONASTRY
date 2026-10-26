/**
 * Audio-Probe für das UI-Audit (NUR im Dev-Build).
 * ================================================
 * Warum: „Ein Regler beeinflusst das MAIN-Signal" lässt sich nur beweisen, wenn
 * (1) das Signal messbar ist und (2) sichtbar ist, welchen Engine-Aufruf ein
 * Bedienelement auslöst. Beides fehlte von außen.
 *
 * Dieses Modul legt in DEV einen schmalen Haken auf `window.__amProbe`:
 *   - `calls()`   Ringpuffer der letzten Engine-Aufrufe (Verkabelungs-Beweis)
 *   - `measure()` numerische Analyse des gerenderten MAIN-Blocks (Signal-Beweis)
 *   - `tone()`    Testton an/aus (deterministische Quelle)
 *
 * Bewusst NICHT im Produktions-Bundle: main.tsx importiert nur hinter
 * `if (import.meta.env.DEV)`. Kein Netzwerk, kein UI, keine Persistenz.
 */
import { audioEngine } from '../utils/audioEngine';

export interface ProbeCall {
  /** Methodenname auf audioEngine. */
  m: string;
  /** Argumente (flach, Zahlen/Strings/Bools; Objekte als JSON-Kurzform). */
  a: unknown[];
  t: number;
}

export interface ProbeBlock {
  rms: number;
  peak: number;
  /** Momentary-LUFS aus dem Mess-SAB (0 = keine Messung). */
  lufsM: number;
  bands: { low: number; mid: number; high: number };
}

/** Methoden, deren Aufruf als „erreicht die Engine" gilt. */
const TRACKED = [
  'setChannelGain', 'setChannelEQ', 'setChannelPan', 'setMasterVolume', 'setMasterVolumeDb',
  'setEqBand', 'setDspParam', 'setEffectParam', 'setEffectParams', 'setOptionalReverb',
  'automateEffect', 'setSpatialPosition', 'setSpatialSetup', 'setSpatialMode', 'setSpatialWidth',
  'setBpm', 'play', 'stop', 'triggerEvent', 'readMeterValues',
  'updateMasterMe', 'updateToneShiftEQ', 'setMasteringParams', 'setMonitorSource',
  'captureNow', 'mergeCapturedBar', 'playV2TestTone', 'stopV2TestTone', 'renderV2Block',
] as const;

export interface AudioProbe {
  ready: () => boolean;
  tone: (on: boolean, freq?: number, amplitude?: number) => Promise<boolean>;
  measure: (ms?: number) => Promise<ProbeBlock | null>;
  calls: (sinceIdx?: number) => { total: number; calls: ProbeCall[] };
  clearCalls: () => void;
  snapshot: () => Record<string, number>;
  /**
   * Setzt die Kette auf einen bekannten Neutralzustand zurück, BEVOR ein
   * Bedienelement gemessen wird. Ohne das verfälscht der Stand des vorherigen
   * Reglers (und jeder frühere Audit-Lauf, der im Session-Store liegt) die
   * Messung: gemessen wurde sonst „Delta gegen irgendetwas".
   */
  resetBaseline: () => void;
}

export function installAudioProbe(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __amProbe?: AudioProbe; __amProbeCalls?: ProbeCall[] };
  if (w.__amProbe) return;

  const log: ProbeCall[] = [];
  const engine = audioEngine as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of TRACKED) {
    const orig = engine[name];
    if (typeof orig !== 'function') continue;
    engine[name] = function patched(this: unknown, ...args: unknown[]) {
      log.push({
        m: name,
        a: args.map((v) => (typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v)),
        t: Date.now(),
      });
      if (log.length > 2000) log.splice(0, log.length - 2000);
      return orig.apply(this, args);
    };
  }
  w.__amProbeCalls = log;

  w.__amProbe = {
    ready: () => audioEngine.initialized,
    tone: async (on, freq = 440, amplitude = 0.2) => {
      if (on) return audioEngine.playV2TestTone(freq, amplitude);
      audioEngine.stopV2TestTone();
      return true;
    },
    // MAIN-Messung über das Mess-SAB des V2-Sinks: das sind die echten Werte aus
    // dem Audio-Thread (Peak/RMS/True-Peak/LUFS). renderV2Block() rendert eine
    // ANDERE Graph-Instanz (v2Studio) als der hörbare Sink – deshalb unbrauchbar.
    measure: async (ms = 350) => {
      const t0 = performance.now();
      let peakL = 0;
      let peakR = 0;
      let rmsL = 0;
      let rmsR = 0;
      let lufsM = -Infinity;
      let n = 0;
      while (performance.now() - t0 < ms) {
        const mv = audioEngine.readMeterValues();
        if (mv) {
          peakL = Math.max(peakL, mv.peakL);
          peakR = Math.max(peakR, mv.peakR);
          rmsL += mv.rmsL;
          rmsR += mv.rmsR;
          if (Number.isFinite(mv.lufsM)) lufsM = Math.max(lufsM, mv.lufsM);
          n += 1;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (n === 0) return null;
      const rms = (rmsL / n + rmsR / n) * 0.5;
      return {
        rms,
        peak: Math.max(peakL, peakR),
        bands: {
          // Das SAB liefert keine Spektren; low/mid/high bleiben für die
          // Vergleichbarkeit 0 – die Pegel/Peak-Werte tragen die Aussage.
          low: 0,
          mid: 0,
          high: 0,
        },
        lufsM: Number.isFinite(lufsM) ? lufsM : 0,
      };
    },
    calls: (sinceIdx = 0) => ({ total: log.length, calls: log.slice(sinceIdx) }),
    clearCalls: () => { log.length = 0; },
    snapshot: () => {
      const mv = audioEngine.readMeterValues();
      return {
        peakL: mv?.peakL ?? 0,
        peakR: mv?.peakR ?? 0,
        rmsL: mv?.rmsL ?? 0,
        lufsM: mv?.lufsM ?? 0,
      };
    },
    // Neutralzustand: Master offen, alle Kanäle 0 dB / Mitte, FX trocken,
    // Master-EQ flach, DSP-Bypass, Mastering aus. Damit ist jedes gemessene
    // Delta wirklich dem Bedienelement zuzuordnen (kein Reststand aus dem Store).
    resetBaseline: () => {
      try {
        audioEngine.setMasterVolume(1);
        // Master-EQ über die vorhandene Band-API flach stellen.
        audioEngine.setEqBand('low', 0);
        audioEngine.setEqBand('mid', 0);
        audioEngine.setEqBand('high', 0);
        audioEngine.setDspParam({ filterCutoff: 20000, resonance: 0.5, depth: 0, drive: 0 });
        audioEngine.setEffectParams({ wet: 0, feedback: 0, rate: 0.5, depth: 0 });
        audioEngine.setOptionalReverb({ enabled: false });
        audioEngine.setMasteringParams({ threshold: 0, ratio: 1, makeup: 0, ceiling: 1 });
        const channels = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'] as const;
        for (const ch of channels) {
          try { audioEngine.setChannelGain(ch, 1); } catch { /* Signatur variiert */ }
          try { audioEngine.setChannelPan(ch, 0); } catch { /* noop */ }
        }
      } catch { /* Engine nicht bereit */ }
    },
  };
}

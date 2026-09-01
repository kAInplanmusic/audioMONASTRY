/**
 * spatialProcessor – spatialMONK AudioWorklet (MVP)
 * ==================================================
 * WhitePaper „spatialMONK“: realistische räumliche Platzierung als
 * AudioWorklet. MVP-Pfad (low CPU):
 *   - equal-power Stereo-Panning aus Azimut
 *   - ITD über zirkuläre Delay-Buffer (≤ 1 ms)
 *   - Distanz-Dämpfung 1/(1+dist) + Distanz-Lowpass (1-Pol)
 *   - sample-genaue Rampen (Azimut/Gain), keine Allokationen in process()
 *
 * Port-Protokoll (Main <-> Worklet):
 *   addSource    { cmd:'addSource', id, az, el?, dist?, gain?, name? }
 *   removeSource { cmd:'removeSource', id }
 *   setPos       { cmd:'setPos', id, az, el?, dist?, gain?, rampTime? }
 *   setGlobal    { cmd:'setGlobal', quality, listenerRot?, masterGain? }
 *   loadHRTF     { cmd:'loadHRTF', url } (Preload-Hook; DSP-Conv folgt)
 *   metricsRequest { cmd:'metricsRequest' } → { cmd:'metrics', cpuEstimate, activeSources }
 *   reset        { cmd:'reset' }
 *
 * Erweiterbar auf Medium/High (partitioned FFT / WASM-HRTF) – siehe
 * WhitePaper Abschnitt 4. Dieser Prozessor liefert den deterministischen
 * Low-CPU-Pfad, der für Tests importierbar bleibt.
 */

export type SpatialQuality = 'low' | 'medium' | 'high';

export interface SpatialProcessorSource {
  id: number;
  name: string;
  az: number; // Grad, -90 links / 0 vorne / +90 rechts
  el: number;
  dist: number;
  gain: number;
  muted: boolean;
  active: boolean;
  // Rampen (sample-genau)
  azCurrent: number;
  azTarget: number;
  azDelta: number;
  azRampRemain: number;
  gainCurrent: number;
  gainTarget: number;
  gainDelta: number;
  gainRampRemain: number;
  // Delay-Line (ITD)
  delay: Float32Array;
  delayWrite: number;
  // Distanz-Lowpass (1-Pol)
  lpCoef: number;
  lpState: number;
}

/** Equal-Power-Stereo-Gains aus Azimut (inkl. Listener-Rotation). */
export function azToStereoGains(azDeg: number, listenerRotDeg = 0): { left: number; right: number } {
  const az = azDeg - listenerRotDeg;
  const rad = (az * Math.PI) / 180;
  const left = Math.cos((rad + Math.PI / 2) / 2);
  const right = Math.sin((rad + Math.PI / 2) / 2);
  return { left, right };
}

/** ITD in Samples (positiv = Signal rechts, rechtes Ohr führt → links verzögert). */
export function itdSamples(azDeg: number, sampleRate: number, listenerRotDeg = 0): number {
  const az = azDeg - listenerRotDeg;
  const maxItdSec = 0.00063; // Woodworth-Näherung (Kopfradius ~0.09 m)
  return Math.round(Math.sin((az * Math.PI) / 180) * maxItdSec * sampleRate);
}

/** Distanz-Dämpfung: 1/(1+dist), minimal -60 dB vermeidbar. */
export function distanceGain(dist: number): number {
  const d = Math.max(0, Number.isFinite(dist) ? dist : 1);
  return 1 / (1 + d);
}

/** Einfacher Distanz-Lowpass-Koeffizient (1-Pol) – weiter weg = dumpfer. */
export function distanceLowpassCoef(dist: number, sampleRate: number): number {
  const d = Math.max(0, Number.isFinite(dist) ? dist : 1);
  const cutoff = Math.max(350, Math.min(18000, 16000 / (1 + d * 2.5)));
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
}

const MAX_DELAY_SAMPLES = 256; // ~5,3 ms bei 48 kHz – ITD braucht ≤ 1 ms

// Worklet-Global in Node-Tests nicht vorhanden → harmloser Fallback,
// damit die puren DSP-Funktionen unit-testbar bleiben.
const WorkletBase: typeof AudioWorkletProcessor =
  (typeof AudioWorkletProcessor !== 'undefined' ? AudioWorkletProcessor : class {}) as any;

class SpatialProcessor extends WorkletBase {
  private sources: SpatialProcessorSource[] = [];
  private maxSources = 8;
  private quality: SpatialQuality = 'low';
  private listenerRot = 0;
  private masterGain = 1;
  private blockCounter = 0;

  constructor() {
    super();
    for (let i = 0; i < this.maxSources; i++) {
      this.sources.push({
        id: -1,
        name: '',
        az: 0,
        el: 0,
        dist: 1,
        gain: 1,
        muted: false,
        active: false,
        azCurrent: 0,
        azTarget: 0,
        azDelta: 0,
        azRampRemain: 0,
        gainCurrent: 1,
        gainTarget: 1,
        gainDelta: 0,
        gainRampRemain: 0,
        delay: new Float32Array(MAX_DELAY_SAMPLES),
        delayWrite: 0,
        lpCoef: 0,
        lpState: 0,
      });
    }
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
  }

  private sourceById(id: number): SpatialProcessorSource | null {
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      if (s.active && s.id === id) return s;
    }
    return null;
  }

  private freeSlot(): SpatialProcessorSource | null {
    for (let i = 0; i < this.sources.length; i++) {
      if (!this.sources[i].active) return this.sources[i];
    }
    return null;
  }

  private startAzRamp(s: SpatialProcessorSource, target: number, rampMs: number): void {
    const steps = Math.max(1, Math.round((Number(rampMs) || 0) / 1000 * sampleRate));
    s.azTarget = target;
    s.azRampRemain = steps;
    s.azDelta = (target - s.azCurrent) / steps;
  }

  private startGainRamp(s: SpatialProcessorSource, target: number, rampMs: number): void {
    const steps = Math.max(1, Math.round((Number(rampMs) || 0) / 1000 * sampleRate));
    s.gainTarget = target;
    s.gainRampRemain = steps;
    s.gainDelta = (target - s.gainCurrent) / steps;
  }

  private handleMessage(m: any): void {
    if (!m || typeof m !== 'object') return;
    switch (m.cmd) {
      case 'addSource': {
        const slot = this.freeSlot();
        if (!slot) { this.postMetrics(); return; }
        const id = Number(m.id);
        slot.id = id;
        slot.name = String(m.name ?? `S${id}`);
        slot.az = Number(m.az) || 0;
        slot.el = Number(m.el) || 0;
        slot.dist = Math.max(0, Number(m.dist) || 1);
        slot.gain = Math.max(0, Math.min(1.5, Number(m.gain) ?? 1));
        slot.muted = false;
        slot.active = true;
        slot.azCurrent = slot.az;
        slot.azTarget = slot.az;
        slot.gainCurrent = slot.gain;
        slot.gainTarget = slot.gain;
        slot.lpCoef = distanceLowpassCoef(slot.dist, sampleRate);
        slot.lpState = 0;
        slot.delay.fill(0);
        slot.delayWrite = 0;
        break;
      }
      case 'removeSource': {
        const s = this.sourceById(Number(m.id));
        if (s) { s.active = false; s.delay.fill(0); }
        break;
      }
      case 'setPos': {
        const s = this.sourceById(Number(m.id));
        if (!s) return;
        const rampMs = Number(m.rampTime ?? 0);
        if (typeof m.az === 'number') this.startAzRamp(s, Math.max(-180, Math.min(180, m.az)), rampMs);
        if (typeof m.dist === 'number') {
          s.dist = Math.max(0, m.dist);
          s.lpCoef = distanceLowpassCoef(s.dist, sampleRate);
        }
        if (typeof m.gain === 'number') this.startGainRamp(s, Math.max(0, Math.min(1.5, m.gain)), rampMs);
        if (typeof m.muted === 'boolean') s.muted = m.muted;
        break;
      }
      case 'setGlobal': {
        if (typeof m.quality === 'string' && (m.quality === 'low' || m.quality === 'medium' || m.quality === 'high')) {
          this.quality = m.quality;
        }
        if (typeof m.listenerRot === 'number') this.listenerRot = Math.max(-180, Math.min(180, m.listenerRot));
        if (typeof m.masterGain === 'number') this.masterGain = Math.max(0, Math.min(2, m.masterGain));
        break;
      }
      case 'loadHRTF': {
        // Preload-Hook. Low/Medium nutzen aktuell den analytischen ITD/ILD-Pfad;
        // High/WASM-Convolution wird hier später geladen (ArrayBuffer-Transfer).
        break;
      }
      case 'metricsRequest': {
        this.postMetrics();
        break;
      }
      case 'reset': {
        for (const s of this.sources) {
          s.active = false;
          s.delay.fill(0);
        }
        break;
      }
      default:
        break;
    }
  }

  private postMetrics(): void {
    const active = this.sources.reduce((n, s) => n + (s.active ? 1 : 0), 0);
    const cpuEstimate = Math.min(1, 0.02 + active * 0.03 + (this.quality === 'high' ? 0.25 : this.quality === 'medium' ? 0.1 : 0.02));
    this.port.postMessage({ cmd: 'metrics', cpuEstimate, activeSources: active, quality: this.quality });
  }

  // Rampen pro Sample (keine Allokation).
  private stepRamps(s: SpatialProcessorSource): void {
    if (s.azRampRemain > 0) {
      s.azRampRemain -= 1;
      s.azCurrent = s.azRampRemain <= 0 ? s.azTarget : s.azCurrent + s.azDelta;
    }
    if (s.gainRampRemain > 0) {
      s.gainRampRemain -= 1;
      s.gainCurrent = s.gainRampRemain <= 0 ? s.gainTarget : s.gainCurrent + s.gainDelta;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL || !outR) return true;
    const n = outL.length;
    outL.fill(0);
    outR.fill(0);

    this.blockCounter += 1;
    if (this.blockCounter >= 100) {
      this.blockCounter = 0;
      this.postMetrics();
    }

    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      if (!s.active || s.muted) continue;
      const input = inputs[i];
      if (!input || input.length === 0) continue;
      const inCh = input[0];
      if (!inCh) continue;

      for (let j = 0; j < n; j++) {
        this.stepRamps(s);
        const x = inCh[j] ?? 0;

        // ITD-Delay-Line (mono in, zwei Taps)
        s.delay[s.delayWrite] = x;
        const itd = itdSamples(s.azCurrent, sampleRate, this.listenerRot);
        const leftDelay = Math.max(0, itd);
        const rightDelay = Math.max(0, -itd);
        const leftIdx = (s.delayWrite - leftDelay + MAX_DELAY_SAMPLES) % MAX_DELAY_SAMPLES;
        const rightIdx = (s.delayWrite - rightDelay + MAX_DELAY_SAMPLES) % MAX_DELAY_SAMPLES;
        s.delayWrite = (s.delayWrite + 1) % MAX_DELAY_SAMPLES;

        // Distanz-Lowpass (1-Pol)
        s.lpState += s.lpCoef * (s.delay[leftIdx] - s.lpState);
        const wet = s.lpState;

        // Equal-Power-Gains + Distanz + Quell-Gain
        const gains = azToStereoGains(s.azCurrent, this.listenerRot);
        const g = s.gainCurrent * distanceGain(s.dist) * this.masterGain;
        outL[j] += wet * gains.left * g;
        outR[j] += s.delay[rightIdx] * gains.right * g;
      }
    }
    return true;
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('spatial-processor', SpatialProcessor as any);
}

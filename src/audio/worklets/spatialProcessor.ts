/**
 * spatialProcessor – spatialMONK AudioWorklet (MVP → Medium/High)
 * ================================================================
 * WhitePaper „spatialMONK“ Abschnitt 4:
 *   low    = equal-power Panning + ITD + Distanz-Lowpass (analytisch, low CPU)
 *   medium = zusätzlich kurze HRTF-artige FIR-Kernel (8 Taps, built-in)
 *   high   = geladene HRTF-Kernel (≤ 64 Taps) via loadHRTF, sonst 16-Tap-built-in
 *
 * Port-Protokoll (Main <-> Worklet):
 *   addSource    { cmd:'addSource', id, az, el?, dist?, gain?, name? }
 *   removeSource { cmd:'removeSource', id }
 *   setPos       { cmd:'setPos', id, az, el?, dist?, gain?, rampTime? }
 *   setGlobal    { cmd:'setGlobal', quality, listenerRot?, masterGain? }
 *   loadHRTF     { cmd:'loadHRTF', left:number[], right:number[] }
 *   metricsRequest { cmd:'metricsRequest' } → { cmd:'metrics', cpuEstimate, activeSources }
 *   reset        { cmd:'reset' }
 *
 * Alle Puffer sind voralloziert; process() allokiert nichts. Die puren
 * DSP-Funktionen bleiben für Unit-/Regressions-Tests importierbar.
 */

export type SpatialQuality = 'low' | 'medium' | 'high';

export interface SpatialProcessorSource {
  id: number;
  name: string;
  az: number;
  el: number;
  dist: number;
  gain: number;
  muted: boolean;
  active: boolean;
  // Rampen
  azCurrent: number;
  azTarget: number;
  azDelta: number;
  azRampRemain: number;
  gainCurrent: number;
  gainTarget: number;
  gainDelta: number;
  gainRampRemain: number;
  // ITD-Delay-Line (low)
  delay: Float32Array;
  delayWrite: number;
  // Distanz-Lowpass
  lpCoef: number;
  lpState: number;
  lpL: number;
  lpR: number;
  // FIR-History (medium/high)
  hist: Float32Array;
  histWrite: number;
}

/** Equal-Power-Stereo-Gains aus Azimut (inkl. Listener-Rotation). */
export function azToStereoGains(azDeg: number, listenerRotDeg = 0): { left: number; right: number } {
  const az = azDeg - listenerRotDeg;
  const rad = (az * Math.PI) / 180;
  const left = Math.cos((rad + Math.PI / 2) / 2);
  const right = Math.sin((rad + Math.PI / 2) / 2);
  return { left, right };
}

/** ITD in Samples (positiv = Signal rechts, links verzögert). */
export function itdSamples(azDeg: number, sampleRate: number, listenerRotDeg = 0): number {
  const az = azDeg - listenerRotDeg;
  const maxItdSec = 0.00063;
  return Math.round(Math.sin((az * Math.PI) / 180) * maxItdSec * sampleRate);
}

/** Distanz-Dämpfung: 1/(1+dist). */
export function distanceGain(dist: number): number {
  const d = Math.max(0, Number.isFinite(dist) ? dist : 1);
  return 1 / (1 + d);
}

/** Distanz-Lowpass-Koeffizient (1-Pol). */
export function distanceLowpassCoef(dist: number, sampleRate: number): number {
  const d = Math.max(0, Number.isFinite(dist) ? dist : 1);
  const cutoff = Math.max(350, Math.min(18000, 16000 / (1 + d * 2.5)));
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
}

/** Built-in HRTF-artige Kurz-Kernel (ipsi-/kontralateral, selbst erzeugt, lizenzfrei). */
export function buildDefaultHrtf(kind: 'medium' | 'high'): { left: number[]; right: number[] } {
  if (kind === 'medium') {
    return {
      left: [0.65, 0.35, 0.18, 0.08, 0.03, 0.01, 0, 0],
      right: [0.02, 0.08, 0.18, 0.4, 0.28, 0.12, 0.04, 0.01],
    };
  }
  const left: number[] = [0.5, 0.32, 0.2, 0.13, 0.08, 0.05, 0.03, 0.02, 0.01, 0, 0, 0, 0, 0, 0, 0];
  const right: number[] = [0.01, 0.03, 0.06, 0.11, 0.18, 0.26, 0.22, 0.14, 0.08, 0.05, 0.03, 0.02, 0.01, 0, 0, 0];
  return { left, right };
}

const MAX_DELAY_SAMPLES = 256;
const MAX_HRTF_TAPS = 64;

const MED_DEFAULT = buildDefaultHrtf('medium');
const HIGH_DEFAULT = buildDefaultHrtf('high');
// Vorkonvertierte Kernel – process() darf nicht allokieren.
const MED_LEFT_KERNEL = Float32Array.from(MED_DEFAULT.left);
const MED_RIGHT_KERNEL = Float32Array.from(MED_DEFAULT.right);
const HIGH_LEFT_KERNEL = Float32Array.from(HIGH_DEFAULT.left);
const HIGH_RIGHT_KERNEL = Float32Array.from(HIGH_DEFAULT.right);

// Worklet-Global in Node-Tests nicht vorhanden → Fallback mit Fake-Port,
// damit der Prozessor deterministisch instanziierbar bleibt (Regression).
const WorkletBase: typeof AudioWorkletProcessor =
  (typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class {
        port = {
          onmessage: null as any,
          postMessage: (msg: any) => { this.port.onmessage?.({ data: msg }); },
        };
      }) as any;

export class SpatialProcessor extends WorkletBase {
  private sources: SpatialProcessorSource[] = [];
  private maxSources = 8;
  private quality: SpatialQuality = 'low';
  private listenerRot = 0;
  private masterGain = 1;
  private blockCounter = 0;
  private hrtfLeft: Float32Array | null = null;
  private hrtfRight: Float32Array | null = null;
  private hrtfTaps = 0;

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
        lpL: 0,
        lpR: 0,
        hist: new Float32Array(MAX_HRTF_TAPS),
        histWrite: 0,
      });
    }
    this.port.onmessage = (e: any) => this.handleMessage(e?.data);
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
        slot.lpL = 0;
        slot.lpR = 0;
        slot.delay.fill(0);
        slot.delayWrite = 0;
        slot.hist.fill(0);
        slot.histWrite = 0;
        break;
      }
      case 'removeSource': {
        const s = this.sourceById(Number(m.id));
        if (s) { s.active = false; s.delay.fill(0); s.hist.fill(0); }
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
        const left = Array.isArray(m.left) ? m.left : m.left instanceof Float32Array ? Array.from(m.left) : null;
        const right = Array.isArray(m.right) ? m.right : m.right instanceof Float32Array ? Array.from(m.right) : null;
        if (left && right && left.length > 0 && left.length === right.length) {
          const taps = Math.min(MAX_HRTF_TAPS, left.length);
          this.hrtfLeft = new Float32Array(taps);
          this.hrtfRight = new Float32Array(taps);
          for (let i = 0; i < taps; i++) {
            this.hrtfLeft[i] = left[i];
            this.hrtfRight[i] = right[i];
          }
          this.hrtfTaps = taps;
        }
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
          s.hist.fill(0);
        }
        break;
      }
      default:
        break;
    }
  }

  private postMetrics(): void {
    const active = this.sources.reduce((n, s) => n + (s.active ? 1 : 0), 0);
    const cpuEstimate = Math.min(
      1,
      0.02 + active * (this.quality === 'low' ? 0.03 : this.quality === 'medium' ? 0.06 : 0.14),
    );
    this.port.postMessage({ cmd: 'metrics', cpuEstimate, activeSources: active, quality: this.quality });
  }

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

  private currentKernels(): { left: Float32Array; right: Float32Array; taps: number } {
    if (this.hrtfLeft && this.hrtfRight && this.hrtfTaps > 0) {
      return { left: this.hrtfLeft, right: this.hrtfRight, taps: this.hrtfTaps };
    }
    if (this.quality === 'medium') {
      return { left: MED_LEFT_KERNEL, right: MED_RIGHT_KERNEL, taps: MED_LEFT_KERNEL.length };
    }
    return { left: HIGH_LEFT_KERNEL, right: HIGH_RIGHT_KERNEL, taps: HIGH_LEFT_KERNEL.length };
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

    const useFir = this.quality !== 'low';
    const kernels = useFir ? this.currentKernels() : null;

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

        if (!useFir || !kernels) {
          // Low: ITD + analytisches Panning (beide Ohren durch den
          // Distanz-Lowpass, symmetrisch → kein ILD-Versatz durch Filterung)
          s.delay[s.delayWrite] = x;
          const itd = itdSamples(s.azCurrent, sampleRate, this.listenerRot);
          const leftDelay = Math.max(0, itd);
          const rightDelay = Math.max(0, -itd);
          const leftIdx = (s.delayWrite - leftDelay + MAX_DELAY_SAMPLES) % MAX_DELAY_SAMPLES;
          const rightIdx = (s.delayWrite - rightDelay + MAX_DELAY_SAMPLES) % MAX_DELAY_SAMPLES;
          s.delayWrite = (s.delayWrite + 1) % MAX_DELAY_SAMPLES;

          const leftTap = s.delay[leftIdx];
          const rightTap = s.delay[rightIdx];
          s.lpL += s.lpCoef * (leftTap - s.lpL);
          s.lpR += s.lpCoef * (rightTap - s.lpR);

          const gains = azToStereoGains(s.azCurrent, this.listenerRot);
          const g = s.gainCurrent * distanceGain(s.dist) * this.masterGain;
          outL[j] += s.lpL * gains.left * g;
          outR[j] += s.lpR * gains.right * g;
        } else {
          // Medium/High: kurze HRTF-FIR-Kernel (Kreuzohr-Anteile eingebettet)
          s.hist[s.histWrite] = x;
          s.histWrite = (s.histWrite + 1) % MAX_HRTF_TAPS;

          s.lpState += s.lpCoef * (x - s.lpState);
          const wet = s.lpState;

          let accL = 0;
          let accR = 0;
          const taps = kernels.taps;
          for (let k = 0; k < taps; k++) {
            const idx = (s.histWrite - 1 - k + MAX_HRTF_TAPS) % MAX_HRTF_TAPS;
            const h = s.hist[idx];
            accL += h * kernels.left[k];
            accR += h * kernels.right[k];
          }

          const gains = azToStereoGains(s.azCurrent, this.listenerRot);
          const g = s.gainCurrent * distanceGain(s.dist) * this.masterGain;
          outL[j] += wet * accL * gains.left * g;
          outR[j] += wet * accR * gains.right * g;
        }
      }
    }
    return true;
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('spatial-processor', SpatialProcessor as any);
}

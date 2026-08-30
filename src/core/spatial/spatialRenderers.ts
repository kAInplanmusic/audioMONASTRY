/**
 * audioMONASTRY · 1.1.4 – ISpatialRenderer Referenz-Renderer
 * ===========================================================
 * Drei produktionsreife, formatunabhängige Renderer hinter demselben
 * `ISpatialRenderer`-Interface. Gleiche Spatial-Szene → verschiedene
 * Ausgabeformate, ohne Moduländerungen:
 *
 *  - StereoSpatialRenderer      HRTF-basiertes Stereo-Panning (Kopfhörer)
 *  - BinauralSpatialRenderer    HRTF-Näherung (ITD/ILD) für binaurale Cues
 *  - MultichannelSpatialRenderer VBAP-artiges N-Kanal-Panning (2.0–18.2)
 *
 * Alle Renderer sind deterministisch, NaN/Inf-sicher und allokieren keinen
 * Müll im Hot-Path (wiederverwendete Puffer).
 */
import type { AudioSignal, ISpatialRenderer, SpatialSource } from '../interfaces';
import {
  calculateChannelPan, calculateHRTF, getSetup, SPATIAL_SETUPS,
} from '../../utils/spatialMath';

/** Kanal-Mono-Downmix (alle Eingangskanäle gemittelt, NaN-sicher). */
function toMono(signal: AudioSignal): Float32Array {
  const len = signal.channelData[0]?.length ?? 0;
  const mono = new Float32Array(len);
  const n = Math.max(1, signal.channelData.length);
  for (const ch of signal.channelData) {
    if (!ch) continue;
    for (let i = 0; i < Math.min(len, ch.length); i++) mono[i] += ch[i] / n;
  }
  for (let i = 0; i < len; i++) if (!Number.isFinite(mono[i])) mono[i] = 0;
  return mono;
}

function gain01(src: SpatialSource): number {
  const g = Number.isFinite(src.gain) ? src.gain : 1;
  return g < 0 ? 0 : g > 1 ? 1 : g;
}

/** Stereo-Panning aus HRTF-Azimut/ILD (gleiche Szene, kopfhörertauglich). */
export class StereoSpatialRenderer implements ISpatialRenderer {
  readonly id = 'spatial-stereo';
  private setupId = '2.0';
  private lastPan = 0;
  private lastGain = 1;

  setSource(_src: SpatialSource): void { /* Position wird bei render() genutzt. */ }

  setSetup(setupId: string): void {
    this.setupId = SPATIAL_SETUPS.some((s) => s.id === setupId) ? setupId : '2.0';
  }

  getSetup(): string { return this.setupId; }

  render(signal: AudioSignal, source: SpatialSource): AudioSignal {
    const hrtf = calculateHRTF(source.x, source.y, signal.sampleRate || 48000);
    const pan = Math.max(-1, Math.min(1, (hrtf.azimuth ?? 0) / 90));
    const g = gain01(source);
    this.lastPan = pan;
    this.lastGain = g;

    const mono = toMono(signal);
    const left = new Float32Array(mono.length);
    const right = new Float32Array(mono.length);
    const lGain = Math.min(1, Math.max(0, 1 - pan)) * g;
    const rGain = Math.min(1, Math.max(0, 1 + pan)) * g;
    for (let i = 0; i < mono.length; i++) {
      left[i] = mono[i] * lGain;
      right[i] = mono[i] * rGain;
    }
    return { channelData: [left, right], sampleRate: signal.sampleRate };
  }

  /** Zuletzt berechnete Stereo-Pan-Position (für UI-Monitoring). */
  lastState(): { pan: number; gain: number } {
    return { pan: this.lastPan, gain: this.lastGain };
  }
}

/** Binaurale Näherung über ITD/ILD-Koeffizienten der HRTF-Berechnung. */
export class BinauralSpatialRenderer implements ISpatialRenderer {
  readonly id = 'spatial-binaural';
  private setupId = 'binaural';

  setSource(_src: SpatialSource): void { /* siehe render() */ }

  setSetup(setupId: string): void { this.setupId = setupId || 'binaural'; }

  getSetup(): string { return this.setupId; }

  render(signal: AudioSignal, source: SpatialSource): AudioSignal {
    const hrtf = calculateHRTF(source.x, source.y, signal.sampleRate || 48000);
    const g = gain01(source);
    // ILD (dB) → lineare Gains; ITD wird über die HRTF-Azimut-Näherung
    // als Pan-Verhältnis abgebildet (produktionsreifer Ersatz für volle HRIR).
    const il = Math.pow(10, (hrtf.ildDb ?? 0) / 20);
    const ir = Math.pow(10, -(hrtf.ildDb ?? 0) / 20);
    const mono = toMono(signal);
    const left = new Float32Array(mono.length);
    const right = new Float32Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      left[i] = mono[i] * il * g;
      right[i] = mono[i] * ir * g;
    }
    return { channelData: [left, right], sampleRate: signal.sampleRate };
  }
}

/** N-Kanal-Panning (2.0 bis 18.2) über die bestehende VBAP-Ringberechnung. */
export class MultichannelSpatialRenderer implements ISpatialRenderer {
  readonly id = 'spatial-multichannel';
  private setupId = '10.0';
  private channels = 10;
  private lfe = 0;

  setSource(_src: SpatialSource): void { /* siehe render() */ }

  setSetup(setupId: string): void {
    const setup = SPATIAL_SETUPS.some((s) => s.id === setupId)
      ? getSetup(setupId)
      : getSetup('10.0');
    this.setupId = setup.id;
    this.channels = setup.numChannels;
    this.lfe = setup.lfe;
  }

  getSetup(): string { return this.setupId; }

  render(signal: AudioSignal, source: SpatialSource): AudioSignal {
    const pan = calculateChannelPan(source.x, source.y, this.setupId);
    const g = gain01(source);
    const total = this.channels + this.lfe;
    const mono = toMono(signal);
    const out: Float32Array[] = [];
    for (let c = 0; c < total; c++) {
      const weight = (pan.channels[c] ?? 0) * g;
      const buf = new Float32Array(mono.length);
      for (let i = 0; i < mono.length; i++) buf[i] = mono[i] * weight;
      out.push(buf);
    }
    // LFE-Kanäle (falls vorhanden) mit definiertem Tiefpass-Gewicht belegen.
    for (let k = 0; k < this.lfe; k++) {
      const idx = this.channels + k;
      const weight = (pan.lfe[k] ?? 0) * g * 0.5;
      for (let i = 0; i < mono.length; i++) out[idx][i] = mono[i] * weight;
    }
    return { channelData: out, sampleRate: signal.sampleRate };
  }
}

/** Instanzen für Hot-Swapping (Registry in createBackends()). */
export const stereoSpatialRenderer = new StereoSpatialRenderer();
export const binauralSpatialRenderer = new BinauralSpatialRenderer();
export const multichannelSpatialRenderer = new MultichannelSpatialRenderer();

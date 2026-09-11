/**
 * audioMONASTRY · Drum-Render (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * ========================================================================
 * Rendert einen einzelnen Drum-Sound (Kit-Preset) in einen `AudioBuffer`:
 * bevorzugt über einen `OfflineAudioContext`, sonst rein mathematisch.
 *
 * Bewusst ohne Engine-Zustand: Zufallsquelle und Buffer-Factory werden
 * hereingereicht (deterministischer seeded PRNG im Audio-Pfad), damit die
 * Funktionen isoliert testbar sind und `audioEngine` nur noch delegiert.
 */
import type { DrumSoundPreset } from '../data/drumKits';

export type RandomFn = () => number;

/** Weißer Rausch-AudioBuffer (deterministisch über `random`). */
export function makeNoiseBuffer(ctx: BaseAudioContext, seconds: number, sr: number, random: RandomFn): AudioBuffer {
  const len = Math.max(64, Math.ceil(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = random() * 2 - 1;
  return buf;
}

/** Baut den nativen WebAudio-Graph eines Drum-Sounds (Offline-Render). */
export function buildDrumGraph(
  off: OfflineAudioContext,
  out: GainNode,
  sound: DrumSoundPreset,
  sr: number,
  dur: number,
  random: RandomFn,
): void {
  const decay = Math.max(0.02, sound.decay ?? 0.25);

  switch (sound.type) {
    case 'kick':
    case 'tom': {
      const osc = off.createOscillator();
      osc.type = 'sine';
      const f0 = Math.max(20, sound.freqStart ?? (sound.freq ? sound.freq * 2.5 : 160));
      const f1 = Math.max(20, sound.freqEnd ?? sound.freq ?? 50);
      osc.frequency.setValueAtTime(f0, 0);
      osc.frequency.exponentialRampToValueAtTime(f1, Math.min(decay, dur * 0.8));
      const g = off.createGain();
      g.gain.setValueAtTime(1, 0);
      g.gain.exponentialRampToValueAtTime(0.001, decay);
      osc.connect(g); g.connect(out);
      osc.start(0); osc.stop(dur);
      break;
    }
    case 'hat': {
      const src = off.createBufferSource();
      src.buffer = makeNoiseBuffer(off, dur, sr, random);
      const bp = off.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = sound.noiseFilter ?? 8000;
      bp.Q.value = 1.2;
      const g = off.createGain();
      g.gain.setValueAtTime(1, 0);
      g.gain.exponentialRampToValueAtTime(0.001, decay);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(0);
      break;
    }
    case 'snare':
    case 'clap': {
      // Noise-Anteil (bandpass-gefiltert)
      const nsrc = off.createBufferSource();
      nsrc.buffer = makeNoiseBuffer(off, dur, sr, random);
      const bp = off.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = sound.noiseFilter ?? 1800;
      bp.Q.value = 0.8;
      const ng = off.createGain();
      ng.gain.setValueAtTime(1, 0);
      ng.gain.exponentialRampToValueAtTime(0.001, decay);
      nsrc.connect(bp); bp.connect(ng); ng.connect(out);
      nsrc.start(0);
      // Ton-Anteil (Körper)
      const osc = off.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = sound.freq ?? 180;
      const og = off.createGain();
      og.gain.setValueAtTime(0.6, 0);
      og.gain.exponentialRampToValueAtTime(0.001, decay * 0.6);
      osc.connect(og); og.connect(out);
      osc.start(0); osc.stop(dur);
      break;
    }
    case 'perc':
    default: {
      if (sound.noise) {
        const src = off.createBufferSource();
        src.buffer = makeNoiseBuffer(off, dur, sr, random);
        const hp = off.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = Math.min(sound.noiseFilter ?? 5000, sr * 0.45);
        const g = off.createGain();
        g.gain.setValueAtTime(1, 0);
        g.gain.exponentialRampToValueAtTime(0.001, decay);
        src.connect(hp); hp.connect(g); g.connect(out);
        src.start(0);
      } else {
        const osc = off.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = sound.freq ?? 1000;
        const g = off.createGain();
        g.gain.setValueAtTime(1, 0);
        g.gain.exponentialRampToValueAtTime(0.001, decay);
        osc.connect(g); g.connect(out);
        osc.start(0); osc.stop(dur);
      }
    }
  }
}

/** Fallback: Drum-Sound rein mathematisch in einen AudioBuffer rendern. */
export function renderDrumBufferMath(
  sound: DrumSoundPreset,
  sr: number,
  frames: number,
  createBuffer: (length: number, sampleRate: number) => AudioBuffer | null,
  random: RandomFn,
): AudioBuffer | null {
  try {
    const buf = createBuffer(frames, sr);
    if (!buf) return null;
    const d = buf.getChannelData(0);
    const decay = Math.max(0.02, sound.decay ?? 0.25);
    const env = (t: number, dec: number) => Math.exp((-t * 7) / dec);
    for (let i = 0; i < frames; i++) {
      const t = i / sr;
      let v = 0;
      switch (sound.type) {
        case 'kick':
        case 'tom': {
          const f0 = Math.max(20, sound.freqStart ?? (sound.freq ? sound.freq * 2.5 : 160));
          const f1 = Math.max(20, sound.freqEnd ?? sound.freq ?? 50);
          const r = f1 / f0;
          const sweep = Math.min(t / decay, 1);
          const phase = (2 * Math.PI * f0 * decay * (Math.pow(r, sweep) - 1)) / Math.log(r);
          v = Math.sin(phase) * env(t, decay);
          break;
        }
        case 'hat':
        case 'snare':
        case 'clap': {
          const n = random() * 2 - 1;
          v = n * env(t, decay) + Math.sin(2 * Math.PI * (sound.freq ?? 180) * t) * env(t, decay) * 0.5;
          break;
        }
        default: {
          if (sound.noise) v = (random() * 2 - 1) * env(t, decay);
          else v = Math.sin(2 * Math.PI * (sound.freq ?? 1000) * t) * env(t, decay);
        }
      }
      d[i] = v;
    }
    return buf;
  } catch (e) {
    console.warn('Math-Drum-Render fehlgeschlagen:', (e as Error).message);
    return null;
  }
}

export interface DrumRenderDeps {
  /** Deterministische Zufallsquelle (seeded PRNG im Audio-Pfad). */
  random: RandomFn;
  /** Buffer-Factory des echten Kontexts (Math-Fallback). */
  createBuffer?: (length: number, sampleRate: number) => AudioBuffer | null;
  /** Für Tests injizierbar; Default: globales `OfflineAudioContext`. */
  OfflineCtor?: typeof OfflineAudioContext;
}

/** Rendert einen Drum-Sound in einen AudioBuffer (Offline → Math-Fallback). */
export async function renderDrumBuffer(
  sound: DrumSoundPreset,
  sampleRate: number,
  deps: DrumRenderDeps,
): Promise<AudioBuffer | null> {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const dur = Math.max(0.08, Math.min(1.5, (sound.decay ?? 0.25) + 0.08));
  const frames = Math.max(64, Math.ceil(sr * dur));
  try {
    const Ctor = deps.OfflineCtor ?? (typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : undefined);
    if (!Ctor) throw new Error('OfflineAudioContext nicht verfügbar');
    const off = new Ctor(1, frames, sr);
    const out = off.createGain();
    out.gain.value = 1;
    out.connect(off.destination);
    buildDrumGraph(off as OfflineAudioContext, out, sound, sr, dur, deps.random);
    return await off.startRendering();
  } catch (e) {
    console.warn('Offline-Drum-Render nicht verfügbar – Math-Fallback:', (e as Error).message);
    return deps.createBuffer ? renderDrumBufferMath(sound, sr, frames, deps.createBuffer, deps.random) : null;
  }
}

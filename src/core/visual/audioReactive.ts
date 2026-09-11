/**
 * audioMONASTRY · VisualMONK – Audio → Visual (rein, deterministisch)
 * ===================================================================
 * Bildet die Audio-Features des laufenden Sets auf Shader-Parameter ab.
 * Bewusst ohne DOM/GPU, damit die Abbildung ohne Browser getestet werden kann.
 */
import type { AudioFeatures, VisualParams, VisualPreset } from './types';
import { IDLE_AUDIO_FEATURES } from './types';

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Winkel in 0..360 normalisieren. */
export function wrap360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Rohe Feature-Werte auf 0..1 (bzw. BPM ≥ 0) begrenzen. */
export function normalizeFeatures(raw: Partial<AudioFeatures>): AudioFeatures {
  return {
    bass: clamp01(raw.bass ?? 0),
    mid: clamp01(raw.mid ?? 0),
    treble: clamp01(raw.treble ?? 0),
    rms: clamp01(raw.rms ?? 0),
    onset: clamp01(raw.onset ?? 0),
    energy: clamp01(raw.energy ?? 0),
    bpm: Math.max(0, Number.isFinite(raw.bpm) ? (raw.bpm as number) : 0),
  };
}

/** Energie aus den Bändern ableiten, falls sie nicht gesetzt wurde. */
export function deriveEnergy(features: AudioFeatures): number {
  if (features.energy > 0) return features.energy;
  const mean = (features.bass + features.mid + features.treble) / 3;
  return clamp01(Math.max(mean, features.rms * 0.9));
}

/**
 * Kernabbildung: Audio + Preset + Zeit → Shader-Parameter.
 *
 * Die Formeln sind bewusst einfach und monoton: mehr Energie ⇒ mehr Bewegung,
 * mehr Bass ⇒ mehr Zoom/Displacement, mehr Höhen ⇒ mehr Rotation/Kontrast.
 * Damit bleibt das Verhalten vorhersagbar (und testbar).
 */
export function mapAudioToParams(
  features: AudioFeatures,
  preset: VisualPreset,
  timeSeconds: number,
): VisualParams {
  const f = normalizeFeatures(features);
  const energy = deriveEnergy(f);
  const m = preset.motion;
  const t = Number.isFinite(timeSeconds) ? timeSeconds : 0;

  const rotation = wrap360(m.baseSpin * t + f.treble * m.trebleSpin * t + f.onset * 8);
  const zoom = clamp(preset.base.zoom * (1 + f.bass * 0.6 + f.onset * 0.2), 0.05, 8);
  const warp = clamp01(f.mid * m.warp + f.bass * 0.3);
  const hue = wrap360(preset.palette.hueBase + energy * m.hueSpeed * t + f.mid * 30);
  const flow = clamp(m.flow * (0.2 + energy * 2.2), 0, 8);
  const brightness = clamp01(0.15 + f.rms * 0.9 + f.onset * 0.25);
  const contrast = clamp01(0.55 + f.treble * 0.6);
  const displacement = clamp01(f.bass * 0.85 + f.onset * 0.5);
  const glow = clamp01(preset.base.glow + f.rms * 0.5 + f.onset * 0.4);
  const symmetry = Math.max(1, Math.round(preset.base.symmetry));

  return { zoom, rotation, warp, hue, flow, brightness, contrast, displacement, glow, symmetry };
}

/** Lineare Überblendung zweier Parameter-Sätze (Preset-Wechsel, Damping). */
export function blendParams(a: VisualParams, b: VisualParams, t: number): VisualParams {
  const k = clamp01(t);
  if (k <= 0) return { ...a };
  if (k >= 1) return { ...b };
  const lerp = (x: number, y: number) => x + (y - x) * k;
  return {
    zoom: lerp(a.zoom, b.zoom),
    rotation: lerp(a.rotation, b.rotation),
    warp: lerp(a.warp, b.warp),
    hue: lerp(a.hue, b.hue),
    flow: lerp(a.flow, b.flow),
    brightness: lerp(a.brightness, b.brightness),
    contrast: lerp(a.contrast, b.contrast),
    displacement: lerp(a.displacement, b.displacement),
    glow: lerp(a.glow, b.glow),
    symmetry: k < 0.5 ? a.symmetry : b.symmetry,
  };
}

/** Ruhezustand (Stille) für ein Preset. */
export function idleParams(preset: VisualPreset): VisualParams {
  return mapAudioToParams(IDLE_AUDIO_FEATURES, preset, 0);
}

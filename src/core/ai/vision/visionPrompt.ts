/**
 * audioMONASTRY · VisualMONK – Prompt-Bau fuer die generative Bild-KI
 * ===================================================================
 * Baut aus Text, Stil und optionalen Audio-Features einen Prompt fuer den
 * FLUX-Worker. Bewusst **rein** (keine Netz-/KI-Aufrufe), damit die Abbildung
 * testbar ist und nicht von einem Modell abhaengt.
 */

export const VISION_STYLES = [
  'realism',
  'abstract',
  'noir',
  'comic',
  'psychedelic',
  'industrial',
  'cosmic',
  'fantasy',
  'dystopia',
  'geometry',
  'liquid',
  'fire',
] as const;

export type VisionStyle = (typeof VISION_STYLES)[number];

/** Stil-Zusatz (englisch, weil die Bildmodelle darauf trainiert sind). */
export const VISION_STYLE_SUFFIX: Record<VisionStyle, string> = {
  realism: 'hyperrealistic photograph, 35mm lens, shallow depth of field, natural film grain, cinematic lighting',
  abstract: 'abstract gestural painting, layered textures, bold color fields, museum quality',
  noir: 'film noir, high contrast black and white, rainy night, venetian blind shadows, 1940s',
  comic: 'graphic novel illustration, bold ink outlines, halftone shading, dynamic composition',
  psychedelic: 'psychedelic fractal mandala, kaleidoscopic symmetry, saturated colors, hypnotic',
  industrial: 'industrial dystopia, rusted steel, neon grid, heavy machinery, cold cyan light',
  cosmic: 'astral scene, nebula, planets, starfield, deep space, volumetric god rays',
  fantasy: 'epic fantasy landscape, floating mountains, magical glow, painterly detail',
  dystopia: 'dystopian megacity, smog, brutalist towers, lone figure, muted palette',
  geometry: 'impossible geometry, escher-like structures, wireframe, precise perspective',
  liquid: 'liquid water and ice, caustics, refraction, frozen waves, glossy surface',
  fire: 'fire and lightning, embers, plasma arcs, molten glow, dramatic energy',
};

export interface VisionPromptInput {
  /** Freitext (z. B. aus dem UI oder vom Brain formuliert). */
  text?: string;
  style?: VisionStyle;
  /** Tempo des laufenden Sets (fliesst als Bewegungs-Hinweis ein). */
  bpm?: number;
  /** Energie 0..1 (aus dem Audio-Feature-Bus). */
  energy?: number;
  /** Freie Mood-/Genre-Tags (z. B. aus CLAP/AST). */
  moodTags?: readonly string[];
}

const MAX_PROMPT = 1200;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function energyWord(energy: number): string {
  if (energy >= 0.75) return 'explosive high energy';
  if (energy >= 0.45) return 'driving energetic';
  if (energy >= 0.2) return 'steady grooving';
  return 'calm ambient';
}

/**
 * Erzeugt einen Prompt. Mindestens einer der Inputs sollte gesetzt sein;
 * ohne alles wird ein neutraler Ambient-Prompt gebaut (kein Fehler).
 */
export function buildVisionPrompt(input: VisionPromptInput): string {
  const parts: string[] = [];
  const text = (input.text ?? '').trim();
  if (text) parts.push(text);

  const tags = (input.moodTags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
  if (tags.length) parts.push(tags.join(', '));

  const energy = clamp01(input.energy ?? Number.NaN);
  if (Number.isFinite(input.energy)) parts.push(energyWord(energy));

  if (Number.isFinite(input.bpm) && (input.bpm ?? 0) > 0) {
    const bpm = Math.round(input.bpm as number);
    parts.push(bpm >= 140 ? `fast tempo ${bpm} bpm, frenetic motion` : bpm >= 110 ? `tempo ${bpm} bpm, rhythmic motion` : `slow tempo ${bpm} bpm, drifting motion`);
  }

  const style = input.style && VISION_STYLE_SUFFIX[input.style] ? VISION_STYLE_SUFFIX[input.style] : '';
  if (style) parts.push(style);

  const prompt = parts.join(', ').replace(/\s+/g, ' ').trim();
  const fallback = 'abstract ambient visual, soft gradients, subtle motion, dark background';
  return (prompt || fallback).slice(0, MAX_PROMPT);
}

/** Audio-Features, die den Stil automatisch waehlen (aus dem Feature-Bus). */
export interface StyleHintInput {
  bpm?: number;
  /** Energie 0..1. */
  energy?: number;
}

/**
 * Waehlt einen Stil aus dem laufenden Set (Energie zuerst, Tempo als Feinschliff).
 * Bewusst deterministisch und ohne KI – damit der Auto-Modus vorhersagbar ist.
 */
export function suggestVisionStyle(input: StyleHintInput): VisionStyle {
  const energy = clamp01(input.energy ?? 0.4);
  const bpm = Number.isFinite(input.bpm) ? (input.bpm as number) : 0;
  if (energy >= 0.75) return bpm >= 140 ? 'industrial' : 'fire';
  if (energy >= 0.45) return bpm >= 120 ? 'psychedelic' : 'cosmic';
  if (energy >= 0.2) return bpm >= 120 ? 'geometry' : 'liquid';
  return 'abstract';
}

/** Stil-eigene Bewegung (englisch, wie die Bild-/Videomodelle). */
const MOTION_STYLE_HINT: Partial<Record<VisionStyle, string>> = {
  realism: 'handheld camera with slight breathing',
  abstract: 'slow swirling paint flow',
  noir: 'drifting rain and smoke, slow dolly',
  comic: 'snappy parallax pan',
  psychedelic: 'kaleidoscopic pulsing motion',
  industrial: 'steam vents, slow crane move',
  cosmic: 'slow drift through nebula clouds',
  fantasy: 'floating particles, gentle rise',
  dystopia: 'smog rolling between towers, slow tracking shot',
  geometry: 'precise orbital rotation',
  liquid: 'flowing water and refraction',
  fire: 'rising embers and plasma arcs',
};

export interface MotionPromptInput {
  /** Motiv-Hinweis (derselbe Text wie beim Bild, nur als Bewegung). */
  text?: string;
  style?: VisionStyle;
  bpm?: number;
  /** Energie 0..1. */
  energy?: number;
}

/**
 * Baut den **Bewegungs**-Prompt fuer den image->video-Worker (Wan2.2). Der
 * Clip entsteht aus einem fertigen Bild – der Prompt beschreibt deshalb nur,
 * was sich bewegt, nicht was zu sehen ist.
 */
export function buildMotionPrompt(input: MotionPromptInput): string {
  const energy = clamp01(input.energy ?? Number.NaN);
  const hasEnergy = Number.isFinite(input.energy);
  const bpm = Number.isFinite(input.bpm) ? Math.round(input.bpm as number) : 0;

  const motion = !hasEnergy
    ? 'gentle camera push in, subtle motion'
    : energy >= 0.75
      ? 'fast push in, strong camera energy, rapid particle motion'
      : energy >= 0.45
        ? 'steady push in, rhythmic motion'
        : energy >= 0.2
          ? 'slow parallax drift'
          : 'very slow drift, almost still';

  const parts: string[] = [motion];
  const styleHint = input.style ? MOTION_STYLE_HINT[input.style] : undefined;
  if (styleHint) parts.push(styleHint);
  if (bpm >= 140) parts.push('motion pulsing with a fast beat');
  else if (bpm > 0 && bpm < 100) parts.push('motion following a slow beat');

  const text = (input.text ?? '').trim();
  if (text) parts.push(text.slice(0, 120));

  // Keine Bildinhalte neu erfinden: der Clip bleibt beim Eingangsbild.
  parts.push('keep the subject and composition identical, no cuts, no text');
  return parts.join(', ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

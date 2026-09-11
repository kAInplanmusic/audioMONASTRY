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

/**
 * audioMONASTRY · VisualMONK – Presets der Liveshow
 * =================================================
 * Jedes Preset ist ein reiner Parametersatz (Palette + Bewegung + Basiswerte).
 * Der Renderer (Shader) interpretiert ihn; die Audio→Visual-Abbildung liegt in
 * `audioReactive.ts`. So bleiben Presets testbar und der Renderer austauschbar
 * (WebGPU → WebGL-Fallback → Canvas2D).
 */
import type { VisualPreset } from './types';

export const VISUAL_PRESETS: readonly VisualPreset[] = [
  {
    id: 'fractal',
    label: 'Fractal Dive',
    description: 'Unendlicher Zoom durch ein selbstähnliches Feld, Bass öffnet die Tiefe.',
    palette: { colors: [[0.02, 0.02, 0.08], [0.1, 0.35, 0.9], [0.9, 0.3, 0.7], [1, 0.95, 0.7]], hueBase: 220 },
    motion: { baseSpin: 2, trebleSpin: 14, warp: 0.35, hueSpeed: 26, flow: 0.5 },
    base: { zoom: 0.6, glow: 0.5, saturation: 0.9, symmetry: 1 },
  },
  {
    id: 'plasma',
    label: 'Plasma Fields',
    description: 'Fließende Farbfelder, die mit den Mitten atmen.',
    palette: { colors: [[0.05, 0.0, 0.15], [0.9, 0.15, 0.5], [0.2, 0.8, 0.9], [0.95, 0.9, 0.3]], hueBase: 300 },
    motion: { baseSpin: 6, trebleSpin: 8, warp: 0.6, hueSpeed: 40, flow: 0.7 },
    base: { zoom: 0.5, glow: 0.6, saturation: 1, symmetry: 1 },
  },
  {
    id: 'starfield',
    label: 'Galaxies & Planets',
    description: 'Sternenfeld mit Nebeln und Planetenbahnen; Onsets lassen Sterne aufblitzen.',
    palette: { colors: [[0.0, 0.0, 0.03], [0.15, 0.2, 0.6], [0.7, 0.5, 0.9], [1, 1, 1]], hueBase: 240 },
    motion: { baseSpin: 0.6, trebleSpin: 3, warp: 0.15, hueSpeed: 12, flow: 0.9 },
    base: { zoom: 0.8, glow: 0.7, saturation: 0.8, symmetry: 1 },
  },
  {
    id: 'particles',
    label: 'Particle Storm',
    description: 'Partikelsturm, Geschwindigkeit und Streuung folgen der Energie.',
    palette: { colors: [[0.02, 0.02, 0.05], [0.2, 0.9, 0.6], [0.9, 0.7, 0.2], [1, 1, 1]], hueBase: 160 },
    motion: { baseSpin: 4, trebleSpin: 22, warp: 0.25, hueSpeed: 20, flow: 1.6 },
    base: { zoom: 0.4, glow: 0.55, saturation: 0.95, symmetry: 1 },
  },
  {
    id: 'geometry',
    label: 'Impossible Geometry',
    description: 'Rotierende Gitter und unmögliche Körper; Mitten verzerren die Kanten.',
    palette: { colors: [[0.03, 0.03, 0.05], [0.85, 0.85, 0.9], [0.2, 0.6, 0.8], [0.9, 0.4, 0.2]], hueBase: 200 },
    motion: { baseSpin: 9, trebleSpin: 10, warp: 0.5, hueSpeed: 8, flow: 0.4 },
    base: { zoom: 0.7, glow: 0.35, saturation: 0.6, symmetry: 4 },
  },
  {
    id: 'liquid',
    label: 'Water & Ice',
    description: 'Wasseroberfläche/Reflexe; Bass macht Wellen, Höhen funkeln.',
    palette: { colors: [[0.0, 0.05, 0.12], [0.1, 0.5, 0.8], [0.6, 0.95, 1], [1, 1, 1]], hueBase: 190 },
    motion: { baseSpin: 1, trebleSpin: 6, warp: 0.7, hueSpeed: 10, flow: 0.6 },
    base: { zoom: 0.55, glow: 0.5, saturation: 0.85, symmetry: 1 },
  },
  {
    id: 'inferno',
    label: 'Fire & Lightning',
    description: 'Feuer- und Blitzfeld; Onsets zünden Entladungen.',
    palette: { colors: [[0.05, 0.0, 0.0], [0.9, 0.2, 0.0], [1, 0.7, 0.1], [1, 1, 0.85]], hueBase: 20 },
    motion: { baseSpin: 3, trebleSpin: 18, warp: 0.8, hueSpeed: 14, flow: 1.2 },
    base: { zoom: 0.5, glow: 0.75, saturation: 1, symmetry: 1 },
  },
  {
    id: 'gradient',
    label: 'Color Gradients',
    description: 'Ruhige, weiche Farbverläufe – ideal für Ambient/Intro.',
    palette: { colors: [[0.05, 0.02, 0.1], [0.3, 0.4, 0.9], [0.9, 0.5, 0.6], [1, 0.95, 0.8]], hueBase: 330 },
    motion: { baseSpin: 1.5, trebleSpin: 3, warp: 0.3, hueSpeed: 18, flow: 0.3 },
    base: { zoom: 0.6, glow: 0.4, saturation: 0.9, symmetry: 1 },
  },
  {
    id: 'neongrid',
    label: 'Industrial Grid',
    description: 'Neon-Gitter, düster/industriell; Bass pumpt das Raster.',
    palette: { colors: [[0.02, 0.0, 0.03], [0.1, 0.9, 0.95], [0.95, 0.1, 0.6], [1, 1, 1]], hueBase: 285 },
    motion: { baseSpin: 5, trebleSpin: 12, warp: 0.2, hueSpeed: 24, flow: 1.1 },
    base: { zoom: 0.65, glow: 0.6, saturation: 1, symmetry: 2 },
  },
  {
    id: 'psy',
    label: 'Psychedelic',
    description: 'Hypnotische Fraktal-/Kaleidoskop-Muster, stark farbverschiebend.',
    palette: { colors: [[0.08, 0.0, 0.12], [0.95, 0.2, 0.8], [0.2, 0.95, 0.6], [1, 0.9, 0.2]], hueBase: 60 },
    motion: { baseSpin: 12, trebleSpin: 30, warp: 0.9, hueSpeed: 70, flow: 0.8 },
    base: { zoom: 0.45, glow: 0.7, saturation: 1, symmetry: 6 },
  },
  {
    id: 'noir',
    label: 'Film Noir',
    description: 'Strenges Schwarz-Weiß mit Regen/Schatten – nur wenige Akzentfarben.',
    palette: { colors: [[0.0, 0.0, 0.0], [0.25, 0.25, 0.28], [0.75, 0.75, 0.78], [1, 1, 1]], hueBase: 210 },
    motion: { baseSpin: 0.8, trebleSpin: 4, warp: 0.18, hueSpeed: 4, flow: 0.5 },
    base: { zoom: 0.7, glow: 0.25, saturation: 0.1, symmetry: 1 },
  },
  {
    id: 'wireframe',
    label: 'Wireframe',
    description: 'Reine Linien/Kanten (Strichmännchen-Look) auf dunklem Grund.',
    palette: { colors: [[0.02, 0.02, 0.04], [0.4, 0.9, 1], [0.9, 0.9, 0.9], [1, 0.6, 0.2]], hueBase: 180 },
    motion: { baseSpin: 7, trebleSpin: 14, warp: 0.4, hueSpeed: 10, flow: 0.6 },
    base: { zoom: 0.6, glow: 0.3, saturation: 0.4, symmetry: 3 },
  },
];

/** Sucht ein Preset per ID (Fallback: das erste). */
export function presetById(id: string): VisualPreset {
  return VISUAL_PRESETS.find((p) => p.id === id) ?? VISUAL_PRESETS[0];
}

/** Reihenfolge der Preset-IDs (für UI-Auswahl). */
export const VISUAL_PRESET_IDS: readonly string[] = VISUAL_PRESETS.map((p) => p.id);

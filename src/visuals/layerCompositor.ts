/**
 * VisualMONK · Schicht-Mischer (Layer Compositor) — Anschluss an den Live Main Out
 * =============================================================================
 * Bündelt die sieben Schichten der Show zu EINEM Parametersatz pro Frame und
 * hängt sich an den bestehenden Pfad: `VisualMonkOverlay` → `webglRenderer` /
 * `webgpuRenderer` / `canvasRenderer` → `canvas.captureStream(30)` → Live Main Out.
 *
 *   L0 Grund/Feld      Parameter kommen aus `mapAudioToParams` (Preset)
 *   L1 KI-Anker        Show-Szene (Bild/Clip) als Textur — `show.frame()`
 *   L2 Abstraktion     Feldwarp/Displacement aus den Mitten
 *   L3 Eigener Stoff   weitere Show-Szenen (Fotos/Videos) im selben Stapel
 *   L4 Text/Zitat      Textzeilen der Szene (Canvas-Textur, Overlay-Text)
 *   L5 Atmosphäre      Glow/Brightness/Kontrast — hier verstärkt
 *   L6 Takt            dieselben Audio-Features wie im Feature-Bus
 *
 * Bewusst rein (kein DOM, keine GPU): die Funktionen sind ohne Browser testbar
 * und deterministisch — dieselben Features ergeben dieselben Parameter.
 */
import type { AudioFeatures, VisualParams } from '../core/visual/types';

/** Clamp auf 0..1 (identisch zu `clamp01` aus audioReactive). */
function c01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Eine Schicht der Show (Beschreibung, keine Pixel). */
export interface ShowLayer {
  id: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  enabled: boolean;
  /** Deckkraft/Gewicht der Schicht 0..1. */
  weight: number;
}

/** Voreinstellung: alle sieben Schichten aktiv, L0/L1 am stärksten. */
export const DEFAULT_LAYERS: readonly ShowLayer[] = [
  { id: 'L0', enabled: true, weight: 1 },
  { id: 'L1', enabled: true, weight: 0.85 },
  { id: 'L2', enabled: true, weight: 0.6 },
  { id: 'L3', enabled: true, weight: 0.5 },
  { id: 'L4', enabled: true, weight: 0.9 },
  { id: 'L5', enabled: true, weight: 0.4 },
  { id: 'L6', enabled: true, weight: 1 },
];

/**
 * Mischt die Schichten L2–L5 auf die vom Preset gelieferten Parameter (L0).
 *
 * Jede Zeile hat eine Begründung statt eines Bauchgefühls:
 *  * `glow`         + Energie → die Fläche atmet mit der Gesamtenergie
 *  * `brightness`   + Onset   → der Schlag ist sichtbar, ohne zu blitzen
 *  * `contrast`     + Bass    → der Kick zieht das Bild auseinander
 *  * `displacement` + Mitten  → L2-Abstraktion kommt aus der Mitte
 *  * `flow`         × RMS     → Grundtempo folgt dem Pegel
 *
 * Alles bleibt in den Grenzen des Renderers (Glow/Brightness/Kontrast 0..1,
 * Displacement 0..1), damit keine Übersteuerung entsteht.
 */
export function composeLayers(
  features: AudioFeatures,
  base: VisualParams,
  layers: readonly ShowLayer[] = DEFAULT_LAYERS,
): VisualParams {
  const w = (id: ShowLayer['id']): number => {
    const layer = layers.find((l) => l.id === id);
    return layer && layer.enabled ? layer.weight : 0;
  };

  const energy = c01(features.energy);
  const onset = c01(features.onset);
  const bass = c01(features.bass);
  const mid = c01(features.mid);
  const rms = c01(features.rms);

  return {
    ...base,
    glow: c01(base.glow + w('L5') * (0.15 + 0.35 * energy)),
    brightness: c01(base.brightness + w('L5') * (0.1 * onset + 0.05 * bass)),
    contrast: c01(base.contrast + w('L5') * 0.2 * bass),
    displacement: c01(base.displacement + w('L2') * 0.35 * mid),
    flow: Number.isFinite(base.flow) ? base.flow * (0.7 + 0.6 * rms) : 0,
  };
}

/**
 * Bindet das Show-Canvas an den Live Main Out.
 *
 * Derselbe Weg, den `VisualMonkOverlay` schon für die Ghostuser/Beamer benutzt
 * (`canvas.captureStream`); hier nur explizit an einer Stelle benannt, damit der
 * Anschluss nicht über die Komponente verteilt ist.
 */
export function bindToMainOut(canvas: HTMLCanvasElement, fps = 30): MediaStream {
  return canvas.captureStream(fps);
}

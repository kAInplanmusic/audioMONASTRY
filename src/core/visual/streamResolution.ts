/**
 * Stream-Auflösung · jeder Ausgabe-Stream hat seine eigene Auflösung
 * ==================================================================
 * Betreiber 2026-10-06: „Ein eigener Stream kann eine eigene Auflösung haben."
 *
 * Bisher war der Visual-Stream an Ghostuser 6 (Beamer) genau so groß wie die
 * Zeichenfläche beim Sender – also Bildschirm × Pixeldichte des Geräts, das
 * gerade sendet. Ein Handy hochkant schickte ein schmales Hochkant-Bild an den
 * Beamer. Jetzt ist die Stream-Auflösung vom Sender-Format (Handy/Pad/PC,
 * src/core/ui/deviceLayout.ts) entkoppelt:
 *
 *   auto        → Auflösung, die der Empfänger (Beamer, /visual-out) meldet;
 *                 ohne Meldung 1920 × 1080
 *   720p … 4K   → feste Querformate 16:9
 *   9:16, 1:1   → Hochkant (Story/Social) und Quadrat
 *
 * Rein (kein window/document) – testbar in tests/streamResolution.test.ts.
 */

export type StreamPresetId = 'auto' | '720p' | '1080p' | '1440p' | '4k' | 'vertical-1080' | 'square-1080';
export type StreamFps = 30 | 60;

export interface StreamPreset {
  id: StreamPresetId;
  label: string;
  /** null = vom Empfänger bestimmt (auto). */
  width: number | null;
  height: number | null;
}

export const STREAM_PRESETS: readonly StreamPreset[] = [
  { id: 'auto', label: 'Auto (Empfänger)', width: null, height: null },
  { id: '720p', label: '720p · 1280×720', width: 1280, height: 720 },
  { id: '1080p', label: '1080p · 1920×1080', width: 1920, height: 1080 },
  { id: '1440p', label: '1440p · 2560×1440', width: 2560, height: 1440 },
  { id: '4k', label: '4K · 3840×2160', width: 3840, height: 2160 },
  { id: 'vertical-1080', label: 'Hochkant 9:16 · 1080×1920', width: 1080, height: 1920 },
  { id: 'square-1080', label: 'Quadrat 1:1 · 1080×1080', width: 1080, height: 1080 },
];

export const STREAM_FPS: readonly StreamFps[] = [30, 60];

/** Ohne Empfänger-Meldung: Beamer-Standard. */
export const DEFAULT_STREAM_SIZE = { width: 1920, height: 1080 } as const;
/** Obergrenze: 4K-Pixelmenge (Encoder und GPU des Senders). */
export const MAX_STREAM_PIXELS = 3840 * 2160;
/**
 * „Auto" übernimmt das Seitenverhältnis des Beamers, aber höchstens 1080p-
 * Pixelmenge – ein Handy soll nicht ungefragt 4K rendern. 1440p/4K gibt es nur
 * als ausdrückliche Wahl.
 */
export const AUTO_MAX_PIXELS = 1920 * 1080;
/** Untergrenze je Seite, damit der Stream lesbar bleibt. */
export const MIN_STREAM_SIDE = 360;
/** Obergrenze je Seite (auch Hochkant-4K). */
export const MAX_STREAM_SIDE = 3840;

/** Bildschirm, den ein Empfänger (Beamer/PA-Laptop) meldet. */
export interface OutputDisplay {
  /** CSS-Pixel des Bildschirms (screen.width/height). */
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface StreamSize {
  width: number;
  height: number;
  /** Woher die Größe kommt (Anzeige im Studio). */
  source: 'preset' | 'receiver' | 'default';
}

export function isStreamPresetId(v: unknown): v is StreamPresetId {
  return typeof v === 'string' && STREAM_PRESETS.some((p) => p.id === v);
}

export function isStreamFps(v: unknown): v is StreamFps {
  return v === 30 || v === 60;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/**
 * Begrenzt eine Wunschgröße auf das, was ein Stream tragen soll: Seiten
 * zwischen MIN und MAX, höchstens 4K-Pixelmenge, gerade Kantenlängen (Encoder).
 * Das Seitenverhältnis bleibt erhalten.
 */
export function clampStreamSize(width: number, height: number): { width: number; height: number } {
  let w = Number.isFinite(width) && width > 0 ? width : DEFAULT_STREAM_SIZE.width;
  let h = Number.isFinite(height) && height > 0 ? height : DEFAULT_STREAM_SIZE.height;
  const down = Math.min(1, MAX_STREAM_SIDE / Math.max(w, h), Math.sqrt(MAX_STREAM_PIXELS / (w * h)));
  w *= down;
  h *= down;
  const up = Math.max(1, MIN_STREAM_SIDE / Math.min(w, h));
  w *= up;
  h *= up;
  return { width: even(w), height: even(h) };
}

/** Physische Auflösung eines Empfängers (CSS × Pixeldichte), oder null bei Unsinn. */
export function receiverPixels(d: OutputDisplay | null | undefined): { width: number; height: number } | null {
  if (!d) return null;
  const dpr = Number.isFinite(d.devicePixelRatio) && d.devicePixelRatio > 0 ? d.devicePixelRatio : 1;
  if (!(d.width > 0 && d.height > 0)) return null;
  return { width: d.width * dpr, height: d.height * dpr };
}

/** Stream-Größe für eine Auswahl; `auto` folgt dem Empfänger. */
export function resolveStreamSize(preset: StreamPresetId, receiver?: OutputDisplay | null): StreamSize {
  const p = STREAM_PRESETS.find((x) => x.id === preset) ?? STREAM_PRESETS[0];
  if (p.width && p.height) return { ...clampStreamSize(p.width, p.height), source: 'preset' };
  const px = receiverPixels(receiver);
  if (px) {
    const k = Math.min(1, Math.sqrt(AUTO_MAX_PIXELS / (px.width * px.height)));
    return { ...clampStreamSize(px.width * k, px.height * k), source: 'receiver' };
  }
  return { ...DEFAULT_STREAM_SIZE, source: 'default' };
}

/**
 * Logische Zeichenfläche für den Canvas2D-Pfad: Die Zeichenfunktionen sind auf
 * ~960×540 CSS-Pixel ausgelegt. Der Faktor skaliert sie auf die Stream-Größe,
 * damit Linien und Schrift bei 720p wie bei 4K gleich wirken.
 */
export function logicalCanvas(stream: { width: number; height: number }): { width: number; height: number; scale: number } {
  const scale = Math.max(1, Math.min(4, Math.min(stream.width, stream.height) / 540));
  return { width: stream.width / scale, height: stream.height / scale, scale };
}

/** Bereinigt eine Empfänger-Meldung (Server und Client nutzen dieselbe Regel). */
export function sanitizeOutputDisplay(raw: unknown): OutputDisplay | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const width = Math.round(Number(r.width));
  const height = Math.round(Number(r.height));
  const dpr = Number(r.devicePixelRatio);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || height < 160 || width > 8192 || height > 8192) return null;
  const devicePixelRatio = Number.isFinite(dpr) && dpr >= 0.5 && dpr <= 4 ? Math.round(dpr * 100) / 100 : 1;
  return { width, height, devicePixelRatio };
}

export function streamSizeLabel(s: StreamSize): string {
  const src = s.source === 'receiver' ? 'vom Beamer' : s.source === 'default' ? 'Standard' : 'fest';
  return `${s.width}×${s.height} · ${src}`;
}

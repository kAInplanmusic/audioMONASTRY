import { describe, expect, it } from 'vitest';
import {
  AUTO_MAX_PIXELS,
  DEFAULT_STREAM_SIZE,
  MAX_STREAM_PIXELS,
  STREAM_PRESETS,
  clampStreamSize,
  isStreamFps,
  isStreamPresetId,
  logicalCanvas,
  receiverPixels,
  resolveStreamSize,
  sanitizeOutputDisplay,
  streamSizeLabel,
} from '../src/core/visual/streamResolution';
import { visualReceiverFrom } from '../src/hooks/useStreamResolution';

// ---------------------------------------------------------------------------
// Betreiber 2026-10-06: „Ein eigener Stream kann eine eigene Auflösung haben."
// Die Stream-Auflösung ist vom Gerät des Senders (Handy/Pad/PC) entkoppelt.
// ---------------------------------------------------------------------------

describe('resolveStreamSize', () => {
  it('feste Presets liefern genau ihre Größe – egal auf welchem Gerät gesendet wird', () => {
    expect(resolveStreamSize('720p')).toEqual({ width: 1280, height: 720, source: 'preset' });
    expect(resolveStreamSize('1080p')).toEqual({ width: 1920, height: 1080, source: 'preset' });
    expect(resolveStreamSize('1440p')).toEqual({ width: 2560, height: 1440, source: 'preset' });
    expect(resolveStreamSize('4k')).toEqual({ width: 3840, height: 2160, source: 'preset' });
    expect(resolveStreamSize('vertical-1080')).toEqual({ width: 1080, height: 1920, source: 'preset' });
    expect(resolveStreamSize('square-1080')).toEqual({ width: 1080, height: 1080, source: 'preset' });
  });

  it('Auto ohne Beamer: 1920×1080', () => {
    expect(resolveStreamSize('auto', null)).toEqual({ ...DEFAULT_STREAM_SIZE, source: 'default' });
  });

  it('Auto folgt dem Beamer (CSS × Pixeldichte)', () => {
    expect(resolveStreamSize('auto', { width: 1280, height: 720, devicePixelRatio: 1.5 })).toEqual({ width: 1920, height: 1080, source: 'receiver' });
    expect(resolveStreamSize('auto', { width: 1024, height: 768, devicePixelRatio: 1 })).toEqual({ width: 1024, height: 768, source: 'receiver' });
  });

  it('Auto übernimmt das Seitenverhältnis, rendert aber höchstens 1080p-Pixelmenge', () => {
    const uhd = resolveStreamSize('auto', { width: 3840, height: 2160, devicePixelRatio: 1 });
    expect(uhd).toEqual({ width: 1920, height: 1080, source: 'receiver' });
    const wuxga = resolveStreamSize('auto', { width: 1920, height: 1200, devicePixelRatio: 1 });
    expect(wuxga.width / wuxga.height).toBeCloseTo(1.6, 2);
    expect(wuxga.width * wuxga.height).toBeLessThanOrEqual(AUTO_MAX_PIXELS + 4000);
  });

  it('Hochkant-Bildschirm als Empfänger bekommt einen Hochkant-Stream', () => {
    const s = resolveStreamSize('auto', { width: 1080, height: 1920, devicePixelRatio: 1 });
    expect(s.height).toBeGreaterThan(s.width);
  });
});

describe('clampStreamSize', () => {
  it('begrenzt auf 4K-Pixelmenge, Seiten 360–3840, gerade Kanten', () => {
    const huge = clampStreamSize(7680, 4320);
    expect(huge.width * huge.height).toBeLessThanOrEqual(MAX_STREAM_PIXELS);
    expect(huge.width % 2).toBe(0);
    const tiny = clampStreamSize(200, 100);
    expect(Math.min(tiny.width, tiny.height)).toBeGreaterThanOrEqual(360);
    expect(clampStreamSize(1281, 721)).toEqual({ width: 1282, height: 722 });
    expect(clampStreamSize(Number.NaN, 0)).toEqual(DEFAULT_STREAM_SIZE);
  });

  it('jedes Preset liegt innerhalb der Grenzen', () => {
    for (const p of STREAM_PRESETS) {
      const s = resolveStreamSize(p.id);
      expect(s.width * s.height).toBeLessThanOrEqual(MAX_STREAM_PIXELS);
    }
  });
});

describe('Empfänger-Meldung', () => {
  it('bereinigt Meldungen (Server und Client nutzen dieselbe Regel)', () => {
    expect(sanitizeOutputDisplay({ width: 1920.4, height: 1080, devicePixelRatio: 1 })).toEqual({ width: 1920, height: 1080, devicePixelRatio: 1 });
    expect(sanitizeOutputDisplay({ width: 1280, height: 720, devicePixelRatio: 9 })).toEqual({ width: 1280, height: 720, devicePixelRatio: 1 });
    expect(sanitizeOutputDisplay({ width: 99999, height: 720 })).toBeNull();
    expect(sanitizeOutputDisplay({ width: 'x', height: 720 })).toBeNull();
    expect(sanitizeOutputDisplay(null)).toBeNull();
  });

  it('nimmt den Main-Ausgang Bild aus der Ausgänge-Liste des Servers', () => {
    const msg = { endpoints: [
      { socketId: 'u', userId: 'user-a', mode: 'member', report: { layout: 'desktop', width: 1440, height: 900, devicePixelRatio: 2 } },
      { socketId: 'a', userId: 'pa', mode: 'master-out', report: { state: 'live', sampleRate: 48000, channels: 2 } },
      { socketId: 'b', userId: 'beamer', mode: 'visual-out', report: { state: 'waiting', width: 1920, height: 1080, devicePixelRatio: 1 } },
    ] };
    expect(visualReceiverFrom(msg)).toEqual({ width: 1920, height: 1080, devicePixelRatio: 1 });
    expect(visualReceiverFrom({ endpoints: [] })).toBeNull();
    expect(visualReceiverFrom(undefined)).toBeNull();
  });

  it('rechnet physische Pixel', () => {
    expect(receiverPixels({ width: 1280, height: 720, devicePixelRatio: 2 })).toEqual({ width: 2560, height: 1440 });
    expect(receiverPixels({ width: 0, height: 720, devicePixelRatio: 2 })).toBeNull();
  });
});

describe('Zeichenfläche und Anzeige', () => {
  it('Canvas2D zeichnet logisch ~540 px hoch, skaliert auf die Stream-Größe', () => {
    expect(logicalCanvas({ width: 1920, height: 1080 })).toEqual({ width: 960, height: 540, scale: 2 });
    expect(logicalCanvas({ width: 3840, height: 2160 })).toEqual({ width: 960, height: 540, scale: 4 });
    expect(logicalCanvas({ width: 1080, height: 1920 }).width).toBe(540);
    expect(logicalCanvas({ width: 640, height: 360 }).scale).toBe(1);
  });

  it('Label nennt Größe und Herkunft', () => {
    expect(streamSizeLabel(resolveStreamSize('auto', { width: 1920, height: 1080, devicePixelRatio: 1 }))).toBe('1920×1080 · vom Beamer');
    expect(streamSizeLabel(resolveStreamSize('auto', null))).toBe('1920×1080 · Standard');
    expect(streamSizeLabel(resolveStreamSize('4k'))).toBe('3840×2160 · fest');
  });

  it('prüft Auswahlwerte', () => {
    expect(isStreamPresetId('4k')).toBe(true);
    expect(isStreamPresetId('8k')).toBe(false);
    expect(isStreamFps(60)).toBe(true);
    expect(isStreamFps(25)).toBe(false);
  });
});

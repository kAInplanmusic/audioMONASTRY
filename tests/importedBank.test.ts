import { describe, expect, it } from 'vitest';
import {
  ALL_BANK_SCENES,
  BANK_R2_SOURCES,
  IMPORTED_SCENES,
  VISUAL_BANK_SCENES,
} from '../src/visuals/visualBank';
import { ALL_POOL, IMPORTED_POOL, VISUAL_POOL } from '../src/visuals/poolManifest';
import { IMPORTED_CLIPS } from '../src/visuals/importedBank.generated';

describe('importierte Clip-Bank (MONASTRY/Visuals)', () => {
  it('bildet jeden importierten Clip als Szene ab', () => {
    expect(IMPORTED_SCENES.length).toBe(IMPORTED_CLIPS.length);
    expect(ALL_BANK_SCENES.length).toBe(VISUAL_BANK_SCENES.length + IMPORTED_CLIPS.length);
  });

  it('liefert Basis und jede Variante same-origin über die Bank-Route', () => {
    for (const clip of IMPORTED_CLIPS) {
      const base = IMPORTED_SCENES.find((s) => s.id === clip.id);
      expect(base, `Szene fehlt: ${clip.id}`).toBeTruthy();
      expect(base?.src).toBe(`/api/ai/vision/bank/${clip.id}`);
      expect(BANK_R2_SOURCES[clip.id], `Whitelist ohne ${clip.id}`).toBeTruthy();
      for (const v of clip.varianten) {
        const id = `${clip.id}_${v}`;
        expect(BANK_R2_SOURCES[id], `Variante fehlt in Whitelist: ${id}`).toBeTruthy();
        expect(BANK_R2_SOURCES[id]).toContain(`/visuals/bank/${id}.mp4`);
      }
    }
  });

  it('ergänzt den Pool um Basis plus Varianten', () => {
    const erwartet = IMPORTED_CLIPS.reduce((n, c) => n + 1 + c.varianten.length, 0);
    expect(IMPORTED_POOL.length).toBe(erwartet);
    expect(ALL_POOL.length).toBe(VISUAL_POOL.length + erwartet);
    for (const e of IMPORTED_POOL) {
      expect(e.src).toMatch(/^\/api\/ai\/vision\/bank\//);
      expect(['duester', 'cool', 'lustig', 'neutral']).toContain(e.mood);
      expect(['ruhig', 'mittel', 'hart']).toContain(e.energy);
      expect(e.durationS).toBeGreaterThan(0);
    }
  });

  it('führt Lizenz und Attribution mit (Nachweisbarkeit)', () => {
    for (const clip of IMPORTED_CLIPS) {
      expect(clip.license.length).toBeGreaterThan(0);
      expect(clip.category.length).toBeGreaterThan(0);
    }
  });

  it('hat eindeutige IDs (kein Clip kollidiert mit seiner Variante)', () => {
    const ids = IMPORTED_CLIPS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const whitelistIds = Object.keys(BANK_R2_SOURCES);
    // Varianten-ID und Clip-ID dürfen nie doppelt in der Whitelist stehen.
    expect(new Set(whitelistIds).size).toBe(whitelistIds.length);
  });

  it('setzt die Variantendauer realistisch (Loop doppelt, Slow gestreckt, Fast gerafft)', () => {
    const byVariant = (name: string) => IMPORTED_POOL.filter((e) => e.id.endsWith(`_${name}`));
    const loop = byVariant('loop');
    const slow = byVariant('slow');
    const fast = byVariant('fast');
    if (loop.length) expect(loop[0].durationS).toBeGreaterThan(6);
    if (slow.length) expect(slow[0].durationS).toBeGreaterThan(6);
    if (fast.length) expect(fast[0].durationS).toBeLessThan(6);
  });

  it('enthält keine Clips, deren Lizenz eine öffentliche Weitergabe verbietet', () => {
    const verboten = ['coverr license', 'unsplash license', 'mixkit free license'];
    const treffer = IMPORTED_CLIPS.filter((c) =>
      verboten.some((v) => c.license.toLowerCase().includes(v)));
    expect(treffer.map((c) => c.id)).toEqual([]);
  });

  it('meldet Startbilder same-origin (Poster ohne Canvas-Taint)', () => {
    for (const clip of IMPORTED_CLIPS) {
      const id = `${clip.id}_start`;
      expect(BANK_R2_SOURCES[id], `Startbild fehlt in Whitelist: ${id}`).toBeTruthy();
      expect(BANK_R2_SOURCES[id]).toContain(`/visuals/bank/${id}.jpg`);
    }
  });
});

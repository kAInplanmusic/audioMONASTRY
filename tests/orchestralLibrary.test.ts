import { describe, expect, it } from 'vitest';
import { ORCHESTRAL_CC0_CATALOG, orchestralSamples } from '../src/data/orchestralLibrary';

describe('Orchester-CC0-Metadaten-Katalog (VSCO 2 CE)', () => {
  it('enthält Streicher/Bläser/Holz mit gültigen Pfaden und Tags', () => {
    expect(ORCHESTRAL_CC0_CATALOG.length).toBeGreaterThanOrEqual(12);
    for (const m of ORCHESTRAL_CC0_CATALOG) {
      expect(m.file.endsWith('.wav')).toBe(true);
      expect(m.tags).toContain('cc0');
      expect(['Strings', 'Brass', 'Woodwinds']).toContain(m.type);
    }
  });

  it('orchestralSamples() konvertiert in AudioSample-Einträge', () => {
    const samples = orchestralSamples();
    expect(samples).toHaveLength(ORCHESTRAL_CC0_CATALOG.length);
    for (const s of samples) {
      expect(s.url).toMatch(/^\/data\/orchestral\//);
      expect(s.category).toMatch(/^(bass|mids|highs)$/);
    }
  });
});

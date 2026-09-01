import { describe, expect, it } from 'vitest';
import { SORTED_MUSIC_LIBRARY, sortMusicLibrary } from '../src/data/musicLibrary';

describe('P1-5: Lieder-Datenbank sortiert/gruppiert', () => {
  it('ist nach Artist → Name → BPM sortiert (localeCompare)', () => {
    for (let i = 1; i < SORTED_MUSIC_LIBRARY.length; i++) {
      const a = SORTED_MUSIC_LIBRARY[i - 1];
      const b = SORTED_MUSIC_LIBRARY[i];
      const artistCmp = String(a.artist ?? 'Unknown').localeCompare(String(b.artist ?? 'Unknown'));
      const nameCmp = a.name.localeCompare(b.name);
      const bpmCmp = (a.bpm ?? 0) - (b.bpm ?? 0);
      expect(artistCmp <= 0).toBe(true);
      if (artistCmp === 0) {
        expect(nameCmp <= 0).toBe(true);
        if (nameCmp === 0) expect(bpmCmp <= 0).toBe(true);
      }
    }
  });

  it('jeder Track hat eindeutige ID, Name und URL', () => {
    const ids = new Set(SORTED_MUSIC_LIBRARY.map((t) => t.id));
    expect(ids.size).toBe(SORTED_MUSIC_LIBRARY.length);
    for (const t of SORTED_MUSIC_LIBRARY) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.url.length).toBeGreaterThan(0);
    }
  });

  it('sortMusicLibrary ist stabil und klont das Array', () => {
    const out = sortMusicLibrary(SORTED_MUSIC_LIBRARY);
    expect(out).toEqual(SORTED_MUSIC_LIBRARY);
    expect(out).not.toBe(SORTED_MUSIC_LIBRARY);
  });
});

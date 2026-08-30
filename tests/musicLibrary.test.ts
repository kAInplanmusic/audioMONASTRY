import { describe, expect, it } from 'vitest';
import { MUSIC_ARTISTS, MUSIC_LIBRARY } from '../src/data/musicLibrary';

describe('musicLibrary', () => {
  it('enthält Titel und Künstler', () => {
    expect(MUSIC_LIBRARY.length).toBeGreaterThan(0);
    expect(MUSIC_ARTISTS.length).toBeGreaterThan(0);
  });

  it('Künstler sind alphabetisch sortiert', () => {
    const sorted = [...MUSIC_ARTISTS].sort((a, b) => String(a).localeCompare(String(b)));
    expect(MUSIC_ARTISTS).toEqual(sorted);
  });
});

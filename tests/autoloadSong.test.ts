// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';

import {
  AUTOLOAD_STORAGE_KEY,
  clearAutoloadSong,
  loadAutoloadSong,
  parseAutoloadSong,
  saveAutoloadSong,
} from '../src/core/session/autoloadSong';

describe('Autoload-Lied Kanal 1 (mixerMONK)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('liefert ohne Persistenz null (kein Autostart von allein)', () => {
    expect(loadAutoloadSong()).toBeNull();
  });

  it('speichert und laedt das Lied vollstaendig', () => {
    saveAutoloadSong({ url: '/music/Len Faki - Death by House.mp3', name: 'Len Faki - Death by House', artist: 'Len Faki' });
    expect(loadAutoloadSong()).toEqual({
      url: '/music/Len Faki - Death by House.mp3',
      name: 'Len Faki - Death by House',
      artist: 'Len Faki',
    });
    expect(localStorage.getItem(AUTOLOAD_STORAGE_KEY)).toContain('Death by House');
  });

  it('faellt bei kaputtem JSON auf null zurueck, statt zu werfen', () => {
    localStorage.setItem(AUTOLOAD_STORAGE_KEY, '{kaputt');
    expect(loadAutoloadSong()).toBeNull();
  });

  it('verwirft Eintraege ohne url oder name (kein Verweis auf fehlende Dateien)', () => {
    localStorage.setItem(AUTOLOAD_STORAGE_KEY, JSON.stringify({ name: 'ohne url', artist: 'x' }));
    expect(loadAutoloadSong()).toBeNull();
    localStorage.setItem(AUTOLOAD_STORAGE_KEY, JSON.stringify({ url: '/music/x.mp3' }));
    expect(loadAutoloadSong()).toBeNull();
    expect(parseAutoloadSong(null)).toBeNull();
    expect(parseAutoloadSong('nope')).toBeNull();
  });

  it('ergaenzt einen fehlenden Interpreten mit Unknown', () => {
    expect(parseAutoloadSong({ url: '/music/x.mp3', name: 'x' })).toEqual({
      url: '/music/x.mp3',
      name: 'x',
      artist: 'Unknown',
    });
  });

  it('loescht das Autoload wieder', () => {
    saveAutoloadSong({ url: '/music/x.mp3', name: 'x', artist: 'y' });
    clearAutoloadSong();
    expect(loadAutoloadSong()).toBeNull();
    expect(localStorage.getItem(AUTOLOAD_STORAGE_KEY)).toBeNull();
  });
});

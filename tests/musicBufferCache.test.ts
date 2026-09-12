import { describe, expect, it, vi } from 'vitest';
import { MusicBufferCache } from '../src/audio/musicBufferCache';

describe('MusicBufferCache', () => {
  it('dekodiert jede URL nur einmal und liefert danach den Cache', async () => {
    const create = vi.fn((_url: string, onload: (b: { id: string }) => void) => onload({ id: _url }));
    const cache = new MusicBufferCache<{ id: string }>({ create });
    expect(await cache.get('a.mp3')).toEqual({ id: 'a.mp3' });
    expect(await cache.get('a.mp3')).toEqual({ id: 'a.mp3' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('wirft einen sprechenden Fehler weiter', async () => {
    const cache = new MusicBufferCache<string>({ create: (_u, _ok, onerror) => onerror?.() });
    await expect(cache.get('kaputt.mp3')).rejects.toThrow(/Audio-Decode fehlgeschlagen: kaputt\.mp3/);
  });

  it('reicht einen konkreten Fehler durch und leert mit clear()', async () => {
    const boom = new Error('boom');
    const cache = new MusicBufferCache<string>({ create: (_u, _ok, onerror) => onerror?.(boom) });
    await expect(cache.get('x')).rejects.toBe(boom);
    const ok = new MusicBufferCache<string>({ create: (_u, onload) => onload('data') });
    await ok.get('y');
    ok.clear();
    expect(ok.size).toBe(0);
  });
});

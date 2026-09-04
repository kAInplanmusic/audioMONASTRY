import { describe, expect, it } from 'vitest';
import { planChunkRanges, SfzSampleCache } from '../src/core/sampler/sfzStreaming';

describe('SFZ/OPFS-Streaming (Task #3)', () => {
  it('planChunkRanges teilt eine Datei in Byte-Ranges', () => {
    const chunks = planChunkRanges(2_500_000, 1_000_000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ index: 0, start: 0, end: 999_999, bytes: 1_000_000 });
    expect(chunks[2]).toEqual({ index: 2, start: 2_000_000, end: 2_499_999, bytes: 500_000 });
    expect(planChunkRanges(0)).toEqual([]);
    expect(planChunkRanges(Number.NaN)).toEqual([]);
  });

  it('SfzSampleCache hält das Byte-Budget ein (LRU-Eviction)', () => {
    const cache = new SfzSampleCache<ArrayBuffer>(1000);
    const buf = (n: number) => new ArrayBuffer(n);
    cache.put('a', buf(400), 400);
    cache.put('b', buf(400), 400);
    cache.put('c', buf(400), 400); // 1200 > 1000 → ältester ('a') fliegt raus.
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.usedBytes).toBeLessThanOrEqual(1000);
  });

  it('Einzelner Eintrag größer als das Budget wird nicht gecacht', () => {
    const cache = new SfzSampleCache<ArrayBuffer>(500);
    cache.put('big', new ArrayBuffer(800), 800);
    expect(cache.size).toBe(0);
  });

  it('get aktualisiert die LRU-Reihenfolge', () => {
    const cache = new SfzSampleCache<ArrayBuffer>(1000);
    cache.put('a', new ArrayBuffer(400), 400);
    cache.put('b', new ArrayBuffer(400), 400);
    cache.get('a'); // 'a' zuletzt benutzt → 'b' ist jetzt ältester.
    cache.put('c', new ArrayBuffer(400), 400);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });
});

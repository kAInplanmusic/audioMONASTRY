// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTrustedMediaUrl } from '../src/utils/mediaUrlGuard';

describe('mediaUrlGuard (F4-Fix)', () => {
  it('erlaubt lokale Blob-/Data-URLs und relative Pfade', () => {
    expect(isTrustedMediaUrl('blob:http://localhost/abc')).toBe(true);
    expect(isTrustedMediaUrl('data:audio/wav;base64,AAAA')).toBe(true);
    expect(isTrustedMediaUrl('/music/track.mp3')).toBe(true);
    expect(isTrustedMediaUrl('/api/audio/123')).toBe(true);
  });

  it('erlaubt vertrauenswürdige Hosts', () => {
    expect(isTrustedMediaUrl('https://anunnakitools.de/music/x.mp3')).toBe(true);
    expect(isTrustedMediaUrl('https://bucket.123.r2.cloudflarestorage.com/x.wav')).toBe(true);
    expect(isTrustedMediaUrl('https://xyz.supabase.co/storage/v1/object/x.wav')).toBe(true);
  });

  it('blockt fremde Hosts und kaputte Werte', () => {
    expect(isTrustedMediaUrl('https://evil.example.com/x.wav')).toBe(false);
    expect(isTrustedMediaUrl('https://anunnakitools.de.evil.com/x.wav')).toBe(false);
    expect(isTrustedMediaUrl('')).toBe(false);
    expect(isTrustedMediaUrl(undefined)).toBe(false);
    expect(isTrustedMediaUrl('javascript:alert(1)')).toBe(false);
  });
});

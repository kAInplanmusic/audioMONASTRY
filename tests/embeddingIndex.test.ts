import { describe, expect, it } from 'vitest';
import {
  CLAP_DIMS,
  CLAP_MODEL,
  parseIndexLimit,
  pickIndexableSamples,
  resolveEarsPodUrl,
  resolveIndexerConfig,
  resolvePodToken,
} from '../scripts/embeddingIndex';

const SERVICE_KEY = 'x'.repeat(80);
const POD_TOKEN = 'fixture-pod-token-with-at-least-thirty-two-characters';

describe('native Vast inference preflight', () => {
  it('requires an HTTPS origin without credentials, path, query or fragment', () => {
    expect(resolveEarsPodUrl({ VAST_POD_URL_EARS: 'https://ears.example:1234/' })).toBe('https://ears.example:1234');
    for (const value of ['', 'http://ears.example', 'https://user:pass@ears.example', 'https://ears.example/api', 'https://ears.example?q=1', 'https://ears.example#x']) {
      expect(resolveEarsPodUrl({ VAST_POD_URL_EARS: value })).toBe('');
    }
  });
  it('accepts only a sufficiently long shared runtime token', () => {
    expect(resolvePodToken({ AI_POD_TOKEN: POD_TOKEN })).toBe(POD_TOKEN);
    expect(resolvePodToken({ AI_POD_TOKEN: 'too-short' })).toBe('');
    expect(resolvePodToken({ VAST_API_KEY: 'control-plane-is-not-runtime-auth' })).toBe('');
  });
  it('works with native runtime variables alone, without a provider control-plane key', () => {
    const resolved = resolveIndexerConfig({ SB_URL: 'https://example.supabase.co', SB_SERVICE_ROLE: SERVICE_KEY,
      VAST_POD_URL_EARS: 'https://ears.example', AI_POD_TOKEN: POD_TOKEN });
    expect(resolved.missing).toEqual([]);
    expect(resolved.config).toEqual({ supabaseUrl: 'https://example.supabase.co', supabaseKey: SERVICE_KEY,
      podUrl: 'https://ears.example', podToken: POD_TOKEN });
  });
  it('preserves Supabase aliases while rejecting legacy inference endpoint IDs/keys', () => {
    const resolved = resolveIndexerConfig({ SUPABASE_URL: 'https://legacy.supabase.co', SUPABASE_SERVICE_ROLE: SERVICE_KEY,
      VAST_ENDPOINT_ID_EARS: 'legacy-endpoint', VAST_API_KEY: 'legacy-key' });
    expect(resolved.config).toBeNull();
    expect(resolved.missing).toEqual(['VAST_POD_URL_EARS (HTTPS origin)', 'AI_POD_TOKEN (minimum 32 characters)']);
  });
  it('names every missing requirement', () => {
    const resolved = resolveIndexerConfig({});
    expect(resolved.config).toBeNull();
    expect(resolved.missing).toEqual(['SB_URL', 'SB_SERVICE_ROLE', 'VAST_POD_URL_EARS (HTTPS origin)', 'AI_POD_TOKEN (minimum 32 characters)']);
  });
});

describe('DB-P1-004 · Auswahl und Teillauf', () => {
  it('indexiert nur Eintraege mit renderbaren Parametern', () => {
    const samples = [
      { id: 'a', parameters: { waveform: 'sine' } },
      { id: 'b' },
      { id: 'c', parameters: null },
      { id: 'd', parameters: { waveform: 'saw' } },
    ];
    const { usable, skipped } = pickIndexableSamples(samples);
    expect(usable.map((s) => s.id)).toEqual(['a', 'd']);
    expect(skipped.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('behandelt INDEX_LIMIT 0/leer/ungueltig als "alles"', () => {
    expect(parseIndexLimit(undefined)).toBe(0);
    expect(parseIndexLimit('')).toBe(0);
    expect(parseIndexLimit('abc')).toBe(0);
    expect(parseIndexLimit('-5')).toBe(0);
    expect(parseIndexLimit('3')).toBe(3);
    expect(parseIndexLimit('2.9')).toBe(2);
  });

  it('haelt Modell und Dimensionen als Konstante', () => {
    expect(CLAP_MODEL).toBe('clap-music');
    expect(CLAP_DIMS).toBe(512);
  });
});

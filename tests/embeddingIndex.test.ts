import { describe, expect, it } from 'vitest';
import {
  CLAP_DIMS,
  CLAP_MODEL,
  VAST_API_KEY_ORDER,
  parseIndexLimit,
  pickIndexableSamples,
  resolveEarsEndpointId,
  resolveIndexerConfig,
  resolveVastApiKey,
} from '../scripts/embeddingIndex';

/**
 * DB-P1-004: Der Batch-Indexer brach mit dem dokumentierten Aufruf sofort ab
 * ("VAST_ENDPOINT_ID_EARS / VAST_API_KEY fehlen in der .env"), weil die
 * .env die Werte unter VAST_* fuehrt. Hier ist die Aufloesung festgenagelt -
 * dieselbe Ordnung wie endpointRegistry/vastProvider.
 */
const SERVICE_KEY = 'x'.repeat(80);

describe('DB-P1-004 · Vast-Zugangsdaten aufloesen', () => {
  it('liest die ears-Rolle in beiden Schreibweisen und den Fallback', () => {
    expect(resolveEarsEndpointId({ VAST_ENDPOINT_ID_EARS: 'vast-ears' })).toBe('vast-ears');
    // Wie im restlichen Code: eigene Rolle gewinnt vor dem gemeinsamen Fallback.
    expect(resolveEarsEndpointId({ VAST_ENDPOINT_ID_EARS: 'vast-ears', VAST_ENDPOINT_ID: 'legacy' })).toBe('vast-ears');
    expect(resolveEarsEndpointId({ VAST_ENDPOINT_ID: 'legacy' })).toBe('legacy');
    expect(resolveEarsEndpointId({})).toBe('');
    expect(resolveEarsEndpointId({ VAST_ENDPOINT_ID_EARS: '   ' })).toBe('');
  });

  it('nimmt den API-Key in der kanonischen Reihenfolge', () => {
    expect(VAST_API_KEY_ORDER).toEqual(['VAST_API_KEY']);
    expect(resolveVastApiKey({ VAST_API_KEY: 'vast-key' })).toBe('vast-key');
    expect(resolveVastApiKey({})).toBe('');
  });

  it('loest die reale .env-Konstellation auf (Regression)', () => {
    const resolved = resolveIndexerConfig({
      SB_URL: 'https://example.supabase.co',
      SB_SERVICE_ROLE: SERVICE_KEY,
      VAST_ENDPOINT_ID_EARS: 'ears-endpoint',
      VAST_API_KEY: 'vast-key',
    });
    expect(resolved.missing).toEqual([]);
    expect(resolved.config).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: SERVICE_KEY,
      endpointId: 'ears-endpoint',
      apiKey: 'vast-key',
    });
  });

  it('akzeptiert die Legacy-Namen der Vorarchitektur', () => {
    const resolved = resolveIndexerConfig({
      SUPABASE_URL: 'https://legacy.supabase.co',
      SUPABASE_SERVICE_ROLE: SERVICE_KEY,
      VAST_ENDPOINT_ID: 'legacy-ears',
      VAST_API_KEY: 'legacy-key',
    });
    expect(resolved.config).toMatchObject({ endpointId: 'legacy-ears', apiKey: 'legacy-key' });
  });

  it('nennt fehlende Variablen beim Namen, statt still zu scheitern', () => {
    const resolved = resolveIndexerConfig({});
    expect(resolved.config).toBeNull();
    expect(resolved.missing).toContain('SB_URL');
    expect(resolved.missing).toContain('SB_SERVICE_ROLE');
    expect(resolved.missing.join(' ')).toContain('VAST_ENDPOINT_ID_EARS');
    expect(resolved.missing.join(' ')).toContain('VAST_API_KEY');
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

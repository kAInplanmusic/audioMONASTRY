import { describe, expect, it } from 'vitest';
import {
  CLAP_DIMS,
  CLAP_MODEL,
  RUNPOD_API_KEY_ORDER,
  parseIndexLimit,
  pickIndexableSamples,
  resolveEarsEndpointId,
  resolveIndexerConfig,
  resolveRunpodApiKey,
} from '../scripts/embeddingIndex';

/**
 * DB-P1-004: Der Batch-Indexer brach mit dem dokumentierten Aufruf sofort ab
 * ("RUNPOD_ENDPOINT_ID_EARS / RUNPOD_API_KEY fehlen in der .env"), weil die
 * .env die Werte unter RP_* fuehrt. Hier ist die Aufloesung festgenagelt -
 * dieselbe Ordnung wie endpointRegistry/runpodProvider.
 */
const SERVICE_KEY = 'x'.repeat(80);

describe('DB-P1-004 · RunPod-Zugangsdaten aufloesen', () => {
  it('liest die ears-Rolle in beiden Schreibweisen und den Fallback', () => {
    expect(resolveEarsEndpointId({ RP_ENDPOINT_ID_EARS: 'rp-ears' })).toBe('rp-ears');
    expect(resolveEarsEndpointId({ RUNPOD_ENDPOINT_ID_EARS: 'legacy-ears' })).toBe('legacy-ears');
    // Wie im restlichen Code: eigene Rolle gewinnt vor dem gemeinsamen Fallback.
    expect(resolveEarsEndpointId({ RP_ENDPOINT_ID_EARS: 'rp-ears', RP_ENDPOINT_ID: 'legacy' })).toBe('rp-ears');
    expect(resolveEarsEndpointId({ RP_ENDPOINT_ID: 'legacy' })).toBe('legacy');
    expect(resolveEarsEndpointId({ RUNPOD_ENDPOINT_ID: 'legacy-runpod' })).toBe('legacy-runpod');
    expect(resolveEarsEndpointId({})).toBe('');
    expect(resolveEarsEndpointId({ RP_ENDPOINT_ID_EARS: '   ' })).toBe('');
  });

  it('nimmt den API-Key in der kanonischen Reihenfolge', () => {
    expect(RUNPOD_API_KEY_ORDER).toEqual(['RP_AGENT_KEY', 'RP_API_KEY', 'RUNPOD_API_KEY']);
    expect(resolveRunpodApiKey({ RP_AGENT_KEY: 'a', RP_API_KEY: 'b', RUNPOD_API_KEY: 'c' })).toBe('a');
    expect(resolveRunpodApiKey({ RP_API_KEY: 'b', RUNPOD_API_KEY: 'c' })).toBe('b');
    expect(resolveRunpodApiKey({ RUNPOD_API_KEY: 'c' })).toBe('c');
    expect(resolveRunpodApiKey({})).toBe('');
  });

  it('loest die reale .env-Konstellation auf (Regression)', () => {
    const resolved = resolveIndexerConfig({
      SB_URL: 'https://example.supabase.co',
      SB_SERVICE_ROLE: SERVICE_KEY,
      RP_ENDPOINT_ID_EARS: 'ears-endpoint',
      RP_API_KEY: 'rp-key',
    });
    expect(resolved.missing).toEqual([]);
    expect(resolved.config).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: SERVICE_KEY,
      endpointId: 'ears-endpoint',
      apiKey: 'rp-key',
    });
  });

  it('akzeptiert die Legacy-Namen der Vorarchitektur', () => {
    const resolved = resolveIndexerConfig({
      SUPABASE_URL: 'https://legacy.supabase.co',
      SUPABASE_SERVICE_ROLE: SERVICE_KEY,
      RUNPOD_ENDPOINT_ID_EARS: 'legacy-ears',
      RUNPOD_API_KEY: 'legacy-key',
    });
    expect(resolved.config).toMatchObject({ endpointId: 'legacy-ears', apiKey: 'legacy-key' });
  });

  it('nennt fehlende Variablen beim Namen, statt still zu scheitern', () => {
    const resolved = resolveIndexerConfig({});
    expect(resolved.config).toBeNull();
    expect(resolved.missing).toContain('SB_URL');
    expect(resolved.missing).toContain('SB_SERVICE_ROLE');
    expect(resolved.missing.join(' ')).toContain('RP_ENDPOINT_ID_EARS');
    expect(resolved.missing.join(' ')).toContain('RP_API_KEY');
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

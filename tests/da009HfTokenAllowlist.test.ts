/**
 * DA-2026-10-17-009 · HF_TOKEN nur an erlaubte Hosts
 * ==================================================
 * Der Befund: der Runtime-Aufruf fiel auf `HF_TOKEN` zurueck und schickte das
 * Cloud-Credential an JEDE Host aus `VOICE_AI_RUNTIME_URL` - also auch an einen
 * Tippfehler, einen Proxy oder einen Fremd-Pod.
 *
 * Geprueft wird hier die Entscheidungsstelle (`resolveRuntimeToken`), nicht die
 * Route: jeder Aufruf der Voice-Runtime geht durch sie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hfTokenAllowedHosts,
  maySendHfToken,
  resetHfTokenWarnings,
  resolveRuntimeToken,
} from '../src/core/ai/outboundSecrets';

const ENV_KEYS = [
  'HF_TOKEN',
  'VOICE_AI_RUNTIME_TOKEN',
  'VOICE_AI_RUNTIME_URL',
  'SONG_AI_ACE_STEP_URL',
  'SONG_AI_DIFF_RHYTHM_URL',
  'AI_SECRET_HOSTS',
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetHfTokenWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('DA-2026-10-17-009 · HF_TOKEN-Host-Allowlist', () => {
  it('nimmt immer den Runtime-Token, wenn er gesetzt ist', () => {
    process.env.HF_TOKEN = 'hf_geheim';
    const token = resolveRuntimeToken('https://fremder-host.example.com', {
      runtimeToken: 'runtime-token',
      hfToken: process.env.HF_TOKEN,
    });
    expect(token).toBe('runtime-token');
  });

  it('sendet HF_TOKEN NICHT an eine beliebige URL', () => {
    expect(maySendHfToken('https://fremder-host.example.com/infer')).toBe(false);
    expect(resolveRuntimeToken('https://fremder-host.example.com', { hfToken: 'hf_geheim' })).toBe('');
  });

  it('sendet HF_TOKEN NICHT an loopback/private Ziele (kein Cloud-Secret ins LAN)', () => {
    for (const url of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://10.1.2.3', 'http://[::1]:8000']) {
      expect(resolveRuntimeToken(url, { hfToken: 'hf_geheim' }), url).toBe('');
    }
  });

  it('sendet HF_TOKEN an einen ausdruecklich freigegebenen HF-Endpunkt', () => {
    // Hosts stehen bewusst NICHT im Code (statischer Waechter RT-AUDIT-P1-014),
    // sondern in AI_SECRET_HOSTS.
    process.env.AI_SECRET_HOSTS = 'abc.endpoints.huggingface.cloud';
    expect(hfTokenAllowedHosts()).toContain('abc.endpoints.huggingface.cloud');
    expect(resolveRuntimeToken('https://abc.endpoints.huggingface.cloud', { hfToken: 'hf_geheim' }))
      .toBe('hf_geheim');
    // Ein anderer HF-Endpunkt derselben Domain ist NICHT automatisch erlaubt.
    expect(maySendHfToken('https://andere.endpoints.huggingface.cloud')).toBe(false);
  });

  it('sendet HF_TOKEN an den konfigurierten Runtime-Host (Env-Allowlist)', () => {
    process.env.VOICE_AI_RUNTIME_URL = 'https://runtime.mona-stry.example:8443';
    expect(maySendHfToken('https://runtime.mona-stry.example:8443/infer')).toBe(true);
    expect(maySendHfToken('https://anderer-host.example:8443/infer')).toBe(false);
  });

  it('akzeptiert AI_SECRET_HOSTS mit Wildcard nur fuer eine Ebene', () => {
    process.env.AI_SECRET_HOSTS = '*.mona-stry.example';
    expect(maySendHfToken('https://pod-1.mona-stry.example')).toBe(true);
    // Zwei Ebenen daneben ist NICHT die Wildcard.
    expect(maySendHfToken('https://a.b.mona-stry.example')).toBe(false);
    expect(maySendHfToken('https://mona-stry.example')).toBe(false);
  });

  it('waehlt ohne jeden Token einen leeren Bearer (kein "undefined"-Header)', () => {
    expect(resolveRuntimeToken('https://runtime.mona-stry.example')).toBe('');
  });
});

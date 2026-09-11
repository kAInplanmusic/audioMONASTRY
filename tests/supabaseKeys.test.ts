import { describe, expect, it } from 'vitest';
import {
  SUPABASE_PUBLIC_KEY_ORDER,
  SUPABASE_SERVER_KEY_ORDER,
  isValidSupabaseKey,
  pickSupabaseServerKey,
  supabasePublicKey,
  supabaseServerKey,
  supabaseServerKeyLabel,
  supabaseServerKeySource,
} from '../src/config/supabaseKeys';

// Realistische Formen (keine echten Secrets):
const JWT_SERVICE_ROLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiYyIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.' +
  'c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXJlLXNpZ25hdHVyZQ';
const JWT_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiYyIsInJvbGUiOiJhbm9uIn0.' +
  'c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXJlLXNpZ25hdHVyZQ';
// Synthetische Werte in der richtigen FORM – bewusst KEINE echten Secrets im Repo:
const NEW_SECRET = `sb_secret_${'x'.repeat(32)}`;
const NEW_PUBLISHABLE = `sb_publishable_${'y'.repeat(32)}`;
const LEGACY_PAT = `sbp_${'z'.repeat(40)}`;

describe('Supabase-Schlüssel – Formatprüfung', () => {
  it('akzeptiert die drei echten Formate', () => {
    expect(isValidSupabaseKey(JWT_SERVICE_ROLE)).toBe(true);
    expect(isValidSupabaseKey(NEW_SECRET)).toBe(true);
    expect(isValidSupabaseKey(NEW_PUBLISHABLE)).toBe(true);
  });

  it('weist Platzhalter, Leerwerte und zu kurze Werte ab', () => {
    expect(isValidSupabaseKey('')).toBe(false);
    expect(isValidSupabaseKey(undefined)).toBe(false);
    expect(isValidSupabaseKey('   ')).toBe(false);
    expect(isValidSupabaseKey('dein-key.placeholder')).toBe(false);
    expect(isValidSupabaseKey('eyJzuKurz')).toBe(false);
    expect(isValidSupabaseKey('sb_secret_kurz')).toBe(false);
    expect(isValidSupabaseKey('1234567890')).toBe(false);
  });
});

describe('Supabase-Schlüssel – Prioritätsordnung (Regression 2026-09-11)', () => {
  it('nimmt den gültigen Service-Role-Key, auch wenn ein toter Legacy-PAT gesetzt ist', () => {
    // Genau der Live-Fehler: `LEGACY_PAT ?? SERVICE_ROLE` ließ den toten Key gewinnen.
    const env = {
      SUPABASE_LEGACY_PAT: 'sbp_abgelaufen-aber-gesetzt-1234567890ab',
      SUPABASE_SERVICE_ROLE: JWT_SERVICE_ROLE,
    };
    const picked = pickSupabaseServerKey(env);
    expect(picked?.source).toBe('SUPABASE_SERVICE_ROLE');
    expect(supabaseServerKey(env)).toBe(JWT_SERVICE_ROLE);
    expect(supabaseServerKeySource(env)).toBe('SUPABASE_SERVICE_ROLE');
    expect(supabaseServerKeyLabel(env)).toBe('service_role');
  });

  it('meldet den Legacy-PAT nur, wenn er der einzige gültige Kandidat ist', () => {
    const env = { SUPABASE_LEGACY_PAT: LEGACY_PAT };
    expect(supabaseServerKeySource(env)).toBe('SUPABASE_LEGACY_PAT');
    expect(supabaseServerKeyLabel(env)).toBe('legacy_pat');
  });

  it('fällt bei leerem/ungültigem Service-Role-Key auf JWT und Secret zurück', () => {
    expect(supabaseServerKeySource({ SUPABASE_SERVICE_ROLE: '   ', SUPABASE_SERVICE_ROLE_JWT: JWT_SERVICE_ROLE }))
      .toBe('SUPABASE_SERVICE_ROLE_JWT');
    expect(supabaseServerKeySource({ SUPABASE_SECRET: NEW_SECRET })).toBe('SUPABASE_SECRET');
    expect(supabaseServerKeyLabel({ SUPABASE_SECRET: NEW_SECRET })).toBe('secret (sb_secret_)');
  });

  it('gibt ohne gültigen Kandidaten leer/„none" zurück und sammelt die Abgewiesenen', () => {
    const env = { SUPABASE_LEGACY_PAT: 'zu-kurz', SUPABASE_SERVICE_ROLE: '' };
    expect(supabaseServerKey(env)).toBe('');
    expect(supabaseServerKeySource(env)).toBeNull();
    expect(supabaseServerKeyLabel(env)).toBe('none');
    expect(pickSupabaseServerKey(env)).toBeNull();
  });

  it('behält die dokumentierte Reihenfolge bei', () => {
    expect([...SUPABASE_SERVER_KEY_ORDER]).toEqual([
      'SUPABASE_SERVICE_ROLE',
      'SUPABASE_SERVICE_ROLE_JWT',
      'SUPABASE_SECRET',
      'SUPABASE_LEGACY_PAT',
    ]);
  });

  it('wählt öffentliche Schlüssel getrennt (anon → publishable)', () => {
    expect([...SUPABASE_PUBLIC_KEY_ORDER]).toEqual(['SUPABASE_ANON_PUB', 'SUPABASE_PUBLISHABLE']);
    expect(supabasePublicKey({ SUPABASE_ANON_PUB: JWT_ANON })).toBe(JWT_ANON);
    expect(supabasePublicKey({ SUPABASE_ANON_PUB: '', SUPABASE_PUBLISHABLE: NEW_PUBLISHABLE })).toBe(NEW_PUBLISHABLE);
    expect(supabasePublicKey({})).toBe('');
  });

  it('liest standardmäßig process.env (Aufrufer ohne Argument)', () => {
    const prev = process.env.SUPABASE_SERVICE_ROLE;
    process.env.SUPABASE_SERVICE_ROLE = JWT_SERVICE_ROLE;
    try {
      expect(supabaseServerKey()).toBe(JWT_SERVICE_ROLE);
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE;
      else process.env.SUPABASE_SERVICE_ROLE = prev;
    }
  });
});

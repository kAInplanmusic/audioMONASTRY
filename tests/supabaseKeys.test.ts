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
  supabaseUrl,
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
      SB_SERVICE_ROLE: JWT_SERVICE_ROLE,
    };
    const picked = pickSupabaseServerKey(env);
    expect(picked?.source).toBe('SB_SERVICE_ROLE');
    expect(supabaseServerKey(env)).toBe(JWT_SERVICE_ROLE);
    expect(supabaseServerKeySource(env)).toBe('SB_SERVICE_ROLE');
    expect(supabaseServerKeyLabel(env)).toBe('service_role');
  });

  it('bevorzugt das neue SB_-Prefix vor den alten SUPABASE_-Namen', () => {
    const env = {
      SB_SERVICE_ROLE: JWT_SERVICE_ROLE,
      SUPABASE_SERVICE_ROLE: LEGACY_PAT,
    };
    expect(supabaseServerKeySource(env)).toBe('SB_SERVICE_ROLE');
    expect(supabaseServerKey(env)).toBe(JWT_SERVICE_ROLE);
  });

  it('meldet den Legacy-PAT nur, wenn er der einzige gültige Kandidat ist', () => {
    const env = { SUPABASE_LEGACY_PAT: LEGACY_PAT };
    expect(supabaseServerKeySource(env)).toBe('SUPABASE_LEGACY_PAT');
    expect(supabaseServerKeyLabel(env)).toBe('legacy_pat');
  });

  it('meldet den neuen PAT (SB_PAT) korrekt', () => {
    const env = { SB_PAT: LEGACY_PAT };
    expect(supabaseServerKeySource(env)).toBe('SB_PAT');
    expect(supabaseServerKeyLabel(env)).toBe('pat (sbp_)');
  });

  it('fällt bei leerem/ungültigem Service-Role-Key auf Secret und Legacy zurück', () => {
    expect(supabaseServerKeySource({ SB_SERVICE_ROLE: '   ', SB_SECRET: NEW_SECRET }))
      .toBe('SB_SECRET');
    expect(supabaseServerKeyLabel({ SB_SECRET: NEW_SECRET })).toBe('secret (sb_secret_)');
    expect(supabaseServerKeySource({ SUPABASE_SERVICE_ROLE: '   ', SUPABASE_SERVICE_ROLE_JWT: JWT_SERVICE_ROLE }))
      .toBe('SUPABASE_SERVICE_ROLE_JWT');
    expect(supabaseServerKeySource({ SUPABASE_SECRET: NEW_SECRET })).toBe('SUPABASE_SECRET');
  });

  it('gibt ohne gültigen Kandidaten leer/„none" zurück und sammelt die Abgewiesenen', () => {
    const env = { SUPABASE_LEGACY_PAT: 'zu-kurz', SB_SERVICE_ROLE: '' };
    expect(supabaseServerKey(env)).toBe('');
    expect(supabaseServerKeySource(env)).toBeNull();
    expect(supabaseServerKeyLabel(env)).toBe('none');
    expect(pickSupabaseServerKey(env)).toBeNull();
  });

  it('behält die dokumentierte Reihenfolge bei', () => {
    // 2026-11-06: SUPABASE_SERVICE_ROLE_KEY ergaenzt - der Name, den Supabase
    // selbst dokumentiert und den .env/.env.deploy fuehren. Er steht direkt
    // hinter SUPABASE_SERVICE_ROLE, damit die SB_-Namen weiter gewinnen und der
    // Legacy-PAT weiter zuletzt kommt.
    expect([...SUPABASE_SERVER_KEY_ORDER]).toEqual([
      'SB_SERVICE_ROLE',
      'SB_SECRET',
      'SB_PAT',
      'SUPABASE_SERVICE_ROLE',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_ROLE_JWT',
      'SUPABASE_SECRET',
      'SUPABASE_LEGACY_PAT',
    ]);
  });

  it('wählt öffentliche Schlüssel getrennt (anon → publishable)', () => {
    expect([...SUPABASE_PUBLIC_KEY_ORDER]).toEqual(['SB_ANON_PUB', 'SB_PUBLISHABLE', 'SUPABASE_ANON_PUB', 'SUPABASE_PUBLISHABLE']);
    expect(supabasePublicKey({ SB_ANON_PUB: JWT_ANON })).toBe(JWT_ANON);
    expect(supabasePublicKey({ SB_ANON_PUB: '', SB_PUBLISHABLE: NEW_PUBLISHABLE })).toBe(NEW_PUBLISHABLE);
    expect(supabasePublicKey({ SUPABASE_ANON_PUB: JWT_ANON })).toBe(JWT_ANON);
    expect(supabasePublicKey({})).toBe('');
  });

  /**
   * Regression 2026-11-06 (Produktions-Smoke am gebauten Image): die .env hatte
   * `SB_SERVICE_ROLE=` (leer) und den kanonischen `SUPABASE_SERVICE_ROLE_KEY`.
   * pickSupabaseServerKey uebersprang Leerwerte korrekt - aber der kanonische
   * Name stand nicht in der Ordnung, also meldete /api/library
   * "supabase-not-configured", obwohl ein gueltiger Key vorhanden war.
   */
  it('findet den kanonischen SUPABASE_SERVICE_ROLE_KEY (Regression 2026-11-06)', () => {
    expect(SUPABASE_SERVER_KEY_ORDER).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(supabaseServerKey({ SUPABASE_SERVICE_ROLE_KEY: JWT_SERVICE_ROLE })).toBe(JWT_SERVICE_ROLE);
  });

  it('ein leerer SB_-Wert verdeckt den gueltigen Legacy-Namen nicht', () => {
    const picked = pickSupabaseServerKey({
      SB_SERVICE_ROLE: '',
      SUPABASE_SERVICE_ROLE_KEY: JWT_SERVICE_ROLE,
    });
    expect(picked?.key).toBe(JWT_SERVICE_ROLE);
    expect(picked?.source).toBe('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('supabaseUrl ignoriert ein leeres SB_URL und nimmt SUPABASE_URL', () => {
    // `??` wuerde hier den Leerstring zurueckgeben - genau der Fehler, der die
    // App "SB_URL fehlt" melden liess, obwohl SUPABASE_URL gesetzt war.
    expect(supabaseUrl({ SB_URL: '', SUPABASE_URL: 'https://x.supabase.co' })).toBe('https://x.supabase.co');
    expect(supabaseUrl({ SB_URL: '  ', SUPABASE_URL: 'https://x.supabase.co' })).toBe('https://x.supabase.co');
    expect(supabaseUrl({ SB_URL: 'https://sb.supabase.co', SUPABASE_URL: 'https://x.supabase.co' })).toBe('https://sb.supabase.co');
    expect(supabaseUrl({})).toBe('');
  });

  it('liest standardmäßig process.env (Aufrufer ohne Argument)', () => {
    const prev = process.env.SB_SERVICE_ROLE;
    process.env.SB_SERVICE_ROLE = JWT_SERVICE_ROLE;
    try {
      expect(supabaseServerKey()).toBe(JWT_SERVICE_ROLE);
    } finally {
      if (prev === undefined) delete process.env.SB_SERVICE_ROLE;
      else process.env.SB_SERVICE_ROLE = prev;
    }
  });
});

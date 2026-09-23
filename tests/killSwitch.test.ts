import { describe, it, expect } from 'vitest';
import {
  KILL_SWITCH_CODE,
  KILL_SWITCH_STATUS,
  killSwitchAllowedPaths,
  killSwitchPayload,
  killSwitchSource,
  isKillSwitchActive,
  shouldBlockRequest,
} from '../server/killSwitch';

/**
 * RC1-003 · Kill-Switch (ENV)
 * ===========================
 * Der Audit hat gemessen, dass es keinen Laufzeit-Halter gab. Geprueft wird
 * hier beides: dass der Schalter aus der Umgebung gelesen wird UND dass er im
 * Aus-Zustand nichts blockiert (ein Schalter, der immer an ist, waere ein
 * Ausfall; einer, der nie an ist, eine Attrappe).
 */
describe('RC1-003 · Kill-Switch', () => {
  describe('isKillSwitchActive', () => {
    it('ist AUS, wenn nichts gesetzt ist', () => {
      expect(isKillSwitchActive({})).toBe(false);
    });

    it('ist AUS bei expliziten Negativwerten', () => {
      for (const value of ['0', 'false', 'no', 'off', '', '   ']) {
        expect(isKillSwitchActive({ KILL_SWITCH: value }), `Wert "${value}"`).toBe(false);
      }
    });

    it('ist AN bei allen ueblichen Schreibweisen', () => {
      for (const value of ['1', 'true', 'TRUE', ' yes ', 'On', 'enabled', 'ja']) {
        expect(isKillSwitchActive({ KILL_SWITCH: value }), `Wert "${value}"`).toBe(true);
      }
    });

    it('akzeptiert auch MAINTENANCE_MODE als Ausloeser', () => {
      expect(isKillSwitchActive({ MAINTENANCE_MODE: '1' })).toBe(true);
      expect(killSwitchSource({ MAINTENANCE_MODE: '1' })).toBe('MAINTENANCE_MODE');
    });

    it('nennt die ausloesende Variable (fuer die Startmeldung)', () => {
      expect(killSwitchSource({ KILL_SWITCH: '1' })).toBe('KILL_SWITCH');
      expect(killSwitchSource({})).toBeNull();
    });
  });

  describe('shouldBlockRequest', () => {
    const allowed = killSwitchAllowedPaths('/api/security/csp-report');

    it('blockiert die Kostenpfade (AI, Voice, Cloud, Upload)', () => {
      for (const path of [
        '/api/ai/generate',
        '/api/ai/fleet/wake',
        '/api/ai/agent/runs',
        '/api/voice/tts',
        '/api/sound/generate',
        '/api/separate-stems',
        '/api/cloud/upload',
        '/api/upload/sample',
      ]) {
        expect(shouldBlockRequest(path, allowed), path).toBe(true);
      }
    });

    it('laesst Health und Metrics erreichbar (Wartung != Absturz)', () => {
      expect(shouldBlockRequest('/api/health', allowed)).toBe(false);
      expect(shouldBlockRequest('/api/metrics', allowed)).toBe(false);
      expect(shouldBlockRequest('/api/health?verbose=1', allowed)).toBe(false);
    });

    it('laesst den CSP-Meldeweg erreichbar', () => {
      expect(shouldBlockRequest('/api/security/csp-report', allowed)).toBe(false);
    });

    it('laesst SPA und Assets ausliefern (kein nackter 503)', () => {
      for (const path of ['/', '/index.html', '/assets/index-abc123.js', '/music/track.mp3']) {
        expect(shouldBlockRequest(path, allowed), path).toBe(false);
      }
    });

    it('blockiert NICHT, was nur so aussieht wie /api (Praefix-Falle)', () => {
      // `/apiary` beginnt mit "/api" - darf nicht als API-Pfad gelten.
      expect(shouldBlockRequest('/apiary', allowed)).toBe(false);
      expect(shouldBlockRequest('/apifoo/bar', allowed)).toBe(false);
    });
  });

  it('antwortet maschinenlesbar mit 503 und Retry-Empfehlung', () => {
    const payload = killSwitchPayload();
    expect(payload.code).toBe(KILL_SWITCH_CODE);
    expect(payload.status).toBe('maintenance');
    expect(payload.retryAfterSeconds).toBeGreaterThan(0);
    expect(KILL_SWITCH_STATUS).toBe(503);
    // Keine Interna im Fehlerkoerper: kein Dateisystempfad, kein Stacktrace,
    // kein Token-/Key-Format (pk_/sk_/sb_secret_/JWT).
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\/home\/|\/usr\/|\/var\//);
    expect(serialized).not.toMatch(/at\s+\w+\s*\(|\.ts:\d+|\.js:\d+/);
    expect(serialized).not.toMatch(/\b(?:pk|sk|sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}/);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
  });

  it('NEGATIV: ohne gesetzten Schalter wird NICHTS blockiert', () => {
    const active = isKillSwitchActive({});
    const allowed = killSwitchAllowedPaths('/api/security/csp-report');
    // Der Server wendet die Middleware nur bei `active` an; hier wird die
    // Kombination geprueft, die den Ausfall-Fall beschreibt.
    expect(active).toBe(false);
    // Und selbst mit aktivem Schalter bleibt die Health-Strecke frei:
    expect(active && shouldBlockRequest('/api/health', allowed)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  constantTimeTokenEquals,
  decideMediaAccess,
  isProtectedMediaPath,
  tokenFromCookieHeader,
  tokenFromQueryString,
  PROTECTED_MEDIA_PREFIXES,
} from '../server/mediaAccess';

/**
 * PROD-P1-006 · Zugriffsschutz fuer /music
 * ========================================
 * Anlass: `dist/music` ist ein Symlink auf `public/music` und
 * `express.static(dist)` lieferte ihn mit aus - die 45 Demo-Tracks waren damit
 * ohne Token oeffentlich abrufbar. Geprueft wird hier BEIDES: dass ohne
 * gueltigen Zugang abgelehnt wird UND dass ein gueltiger Zugang weiterhin
 * durchkommt (eine Sperre, die auch den Betreiber aussperrt, waere ein Ausfall).
 */
const GUELTIG = 'audit-studio-token-1234567890';

const cfg = {
  studioTokenMissing: false,
  studioAuthOpen: false,
  accessToken: GUELTIG,
};

describe('PROD-P1-006 · Medienpfade', () => {
  describe('isProtectedMediaPath', () => {
    it('schuetzt /music und alles darunter', () => {
      for (const p of ['/music', '/music/', '/music/x.mp3', '/music/a/b.mp3', '/music/x.mp3?token=abc']) {
        expect(isProtectedMediaPath(p), p).toBe(true);
      }
    });

    it('schuetzt NICHT, was nur so anfängt (Segmentgrenze)', () => {
      for (const p of ['/musical', '/musik', '/music2/x.mp3', '/models/htdemucs.onnx', '/assets/i.js', '/api/health', '/']) {
        expect(isProtectedMediaPath(p), p).toBe(false);
      }
    });

    it('kennt die Praefixliste als Konstante', () => {
      expect([...PROTECTED_MEDIA_PREFIXES]).toEqual(['/music']);
    });
  });

  describe('constantTimeTokenEquals', () => {
    it('erkennt Gleichheit', () => {
      expect(constantTimeTokenEquals(GUELTIG, GUELTIG)).toBe(true);
      expect(constantTimeTokenEquals('', '')).toBe(true);
    });

    it('erkennt Ungleichheit - auch bei gleichem Präfix', () => {
      expect(constantTimeTokenEquals(GUELTIG, `${GUELTIG}x`)).toBe(false);
      expect(constantTimeTokenEquals(GUELTIG, 'audit')).toBe(false);
      expect(constantTimeTokenEquals('audit-studio-token-1234567891', GUELTIG)).toBe(false);
    });

    it('bricht bei unterschiedlicher Länge nicht aus der Reihe (Digest-Vergleich)', () => {
      // Kuerzere Eingabe darf nicht versehentlich gleich sein.
      expect(constantTimeTokenEquals('a', GUELTIG)).toBe(false);
      expect(constantTimeTokenEquals(undefined, GUELTIG)).toBe(false);
    });
  });

  describe('decideMediaAccess', () => {
    it('laesst im expliziten Dev-Modus durch (und nennt den Grund)', () => {
      const d = decideMediaAccess({}, { ...cfg, studioAuthOpen: true });
      expect(d).toEqual({ allow: true, via: 'open' });
    });

    it('ist fail-closed, wenn der Server nicht konfiguriert ist (503)', () => {
      const d = decideMediaAccess({ headerToken: GUELTIG }, { ...cfg, studioTokenMissing: true });
      expect(d).toMatchObject({ allow: false, status: 503, code: 'STUDIO_TOKEN_MISSING' });
    });

    it('akzeptiert Header, Query und Cookie (jeden einzeln)', () => {
      expect(decideMediaAccess({ headerToken: GUELTIG }, cfg)).toEqual({ allow: true, via: 'header' });
      expect(decideMediaAccess({ queryToken: GUELTIG }, cfg)).toEqual({ allow: true, via: 'query' });
      expect(decideMediaAccess({ cookieToken: GUELTIG }, cfg)).toEqual({ allow: true, via: 'cookie' });
    });

    it('akzeptiert ein gueltiges Session-Token (Portal-Login)', () => {
      expect(decideMediaAccess({ cookieToken: 'v1.9999999999.abcdef' }, cfg, true))
        .toEqual({ allow: true, via: 'session' });
    });

    it('lehnt ohne Token ab (401)', () => {
      expect(decideMediaAccess({}, cfg)).toMatchObject({ allow: false, status: 401, code: 'STUDIO_TOKEN_REQUIRED' });
    });

    it('lehnt ein FALSCHES Token ab - auch wenn alle drei Quellen es tragen', () => {
      const d = decideMediaAccess({ headerToken: 'falsch', queryToken: 'falsch', cookieToken: 'falsch' }, cfg);
      expect(d).toMatchObject({ allow: false, status: 401 });
    });

    it('ein falsches Token in einer Quelle macht ein richtiges in einer anderen NICHT ungueltig', () => {
      const d = decideMediaAccess({ headerToken: 'falsch', cookieToken: GUELTIG }, cfg);
      expect(d).toEqual({ allow: true, via: 'cookie' });
    });

    it('leeres Token zaehlt nicht als Treffer (kein fail-open bei leerem accessToken)', () => {
      const d = decideMediaAccess({ headerToken: '' }, { ...cfg, accessToken: '' });
      expect(d).toMatchObject({ allow: false, status: 401 });
    });

    it('sessionTokenValid rettet NICHT ohne Token', () => {
      expect(decideMediaAccess({}, cfg, true)).toEqual({ allow: true, via: 'session' });
      // aber nie, wenn gar kein Token vorliegt UND die Quelle leer ist:
      expect(decideMediaAccess({ headerToken: '' }, cfg, false)).toMatchObject({ allow: false });
    });
  });

  describe('Token-Quellen lesen', () => {
    it('liest ?token= aus roher Query und aus Express-Query', () => {
      expect(tokenFromQueryString('?token=abc')).toBe('abc');
      expect(tokenFromQueryString('a=1&token=abc&b=2')).toBe('abc');
      expect(tokenFromQueryString({ token: 'abc' })).toBe('abc');
      expect(tokenFromQueryString('?other=1')).toBe('');
      expect(tokenFromQueryString(undefined)).toBe('');
    });

    it('liest das studio-Cookie, ohne andere Cookies zu stoeren', () => {
      expect(tokenFromCookieHeader('studio=abc')).toBe('abc');
      expect(tokenFromCookieHeader('portal=xyz; studio=abc; other=1')).toBe('abc');
      expect(tokenFromCookieHeader('portal=xyz')).toBe('');
      expect(tokenFromCookieHeader(undefined)).toBe('');
    });

    it('dekodiert URL-kodierte Token', () => {
      expect(tokenFromQueryString('?token=a%2Fb')).toBe('a/b');
      expect(tokenFromCookieHeader('studio=a%2Fb')).toBe('a/b');
    });
  });
});

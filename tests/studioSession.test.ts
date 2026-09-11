import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  STUDIO_SESSION_PREFIX,
  STUDIO_SESSION_TTL_S,
  buildStudioSessionToken,
  looksLikeStudioSession,
  signStudioSession,
  studioSessionSigningInput,
  studioTokenFromCookieHeader,
  verifyStudioSession,
} from '../src/core/session/studioSession';

const SECRET = 'test-secret-fuer-session-signaturen';
const NOW = 1_800_000_000; // feste Zeit → deterministisch

describe('Studio-Session-Token – Form und Signatur', () => {
  it('erzeugt ein Token mit Präfix, exp und 64-Hex-Signatur', async () => {
    const token = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60 });
    expect(token.startsWith(STUDIO_SESSION_PREFIX)).toBe(true);
    const [, exp, sig] = token.split('.');
    expect(Number(exp)).toBe(NOW + 60);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeStudioSession(token)).toBe(true);
  });

  it('akzeptiert ein gültiges Token und lehnt es nach Ablauf ab', async () => {
    const token = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60 });
    expect(await verifyStudioSession(token, SECRET, { nowSec: NOW })).toBe(true);
    expect(await verifyStudioSession(token, SECRET, { nowSec: NOW + 59 })).toBe(true);
    // exakt auf exp gilt als abgelaufen (kein Kulanzfenster)
    expect(await verifyStudioSession(token, SECRET, { nowSec: NOW + 60 })).toBe(false);
    expect(await verifyStudioSession(token, SECRET, { nowSec: NOW + 3600 })).toBe(false);
  });

  it('nutzt standardmäßig 15 Minuten (vorher: 24 h Cookie mit Master-Token)', async () => {
    expect(STUDIO_SESSION_TTL_S).toBe(900);
    const token = await signStudioSession(SECRET, { nowSec: NOW });
    const exp = Number(token.split('.')[1]);
    expect(exp - NOW).toBe(STUDIO_SESSION_TTL_S);
  });

  it('lehnt manipulierte Signaturen und fremde Secrets ab', async () => {
    const token = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60 });
    const [, exp, sig] = token.split('.');
    const flipped = sig.replace(sig[0], sig[0] === 'a' ? 'b' : 'a');

    expect(await verifyStudioSession(buildStudioSessionToken(Number(exp), flipped), SECRET, { nowSec: NOW })).toBe(false);
    expect(await verifyStudioSession(token, 'anderes-secret', { nowSec: NOW })).toBe(false);
  });

  it('lehnt ein nach oben manipuliertes exp ab (Signatur deckt exp ab)', async () => {
    const token = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60 });
    const sig = token.split('.')[2];
    // Angreifer verlängert die Laufzeit, kann aber nicht neu signieren.
    const extended = buildStudioSessionToken(NOW + 100_000, sig);
    expect(await verifyStudioSession(extended, SECRET, { nowSec: NOW })).toBe(false);
  });

  it('ist fail-closed ohne Secret und weist Unfug-Formate ab', async () => {
    const token = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60 });
    expect(await verifyStudioSession(token, '')).toBe(false);
    expect(await verifyStudioSession('', SECRET)).toBe(false);
    expect(await verifyStudioSession('v1.', SECRET)).toBe(false);
    expect(await verifyStudioSession('v1.abc.def', SECRET)).toBe(false);
    expect(await verifyStudioSession('v1.-5.' + 'a'.repeat(64), SECRET)).toBe(false);
    // Ein Master-Token hat kein Präfix → wird hier nie „zufällig“ gültig.
    expect(await verifyStudioSession('irgendein-master-token', SECRET)).toBe(false);
  });

  it('bindet ein optionales sub in die Signatur ein', async () => {
    const withSub = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60, sub: 'portal-4711' });
    expect(withSub).toContain('portal-4711');
    expect(await verifyStudioSession(withSub, SECRET, { nowSec: NOW })).toBe(true);
    // sub entfernen ⇒ Signatur passt nicht mehr
    const withoutSub = withSub.replace('.portal-4711', '');
    expect(await verifyStudioSession(withoutSub, SECRET, { nowSec: NOW })).toBe(false);
  });

  it('signiert exakt die dokumentierte Zeichenkette', () => {
    expect(studioSessionSigningInput(123)).toBe('v1.123');
    expect(studioSessionSigningInput(123, 'x')).toBe('v1.123.x');
  });
});

describe('Studio-Session-Token – Cookie-Auslesen', () => {
  it('liest das studio-Cookie aus einem Cookie-Header', () => {
    expect(studioTokenFromCookieHeader('a=1; studio=v1.123.abc; b=2')).toBe('v1.123.abc');
    expect(studioTokenFromCookieHeader('studio=erster; studio=zweiter')).toBe('erster');
    expect(studioTokenFromCookieHeader('portal=xyz')).toBe('');
    expect(studioTokenFromCookieHeader('')).toBe('');
  });

  it('dekodiert URL-kodierte Werte (Portal nutzt encodeURIComponent)', () => {
    expect(studioTokenFromCookieHeader('studio=v1.123.a%2Eb')).toBe('v1.123.a.b');
  });
});

describe('Studio-Session-Token – Wire-Format (Vertrag zwischen Portal und Server)', () => {
  it('Signatur ist exakt HMAC-SHA256(secret, `v1.<exp>`) als Hex', async () => {
    // Unabhängig mit Node-Crypto nachgerechnet: der Cloudflare-Worker
    // (services/portal-worker/src/index.js) signiert GENAU diese Zeichenkette.
    // Weicht eine Seite ab, schlägt dieser Test an, bevor es im Betrieb klemmt.
    const token = await signStudioSession(SECRET, { nowSec: NOW, ttlS: 60 });
    const expected = createHmac('sha256', SECRET).update(`v1.${NOW + 60}`).digest('hex');
    expect(token).toBe(`v1.${NOW + 60}.${expected}`);
    expect(await verifyStudioSession(token, SECRET, { nowSec: NOW })).toBe(true);
  });
});

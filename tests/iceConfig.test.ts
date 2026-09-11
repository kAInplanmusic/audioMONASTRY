import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildIceServers,
  hasRelayServer,
  parseIceConfigResponse,
  PUBLIC_STUN_URLS,
} from '../src/core/transport/iceConfig';
import {
  buildWebRtcConfigResponse,
  createTurnCredentials,
  DEFAULT_TURN_TTL_SECONDS,
  splitList,
} from '../server/webrtcConfig';

// ---------------------------------------------------------------------------
// COLLAB-P0-003: ICE/TURN-Konfiguration. Geprüft wird die Wirkung (welche
// Server kommen raus, sind TURN-Credentials kurzlebig und korrekt signiert),
// nicht nur „läuft".
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000; // ms

describe('buildIceServers', () => {
  it('setzt STUN immer, TURN nur mit vollständigen Credentials', () => {
    const stunOnly = buildIceServers({ stunUrls: [...PUBLIC_STUN_URLS], turnUrls: ['turn:turn.example:3478'] });
    expect(stunOnly).toHaveLength(1);
    expect(hasRelayServer(stunOnly)).toBe(false);

    const withTurn = buildIceServers({
      stunUrls: [...PUBLIC_STUN_URLS],
      turnUrls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349'],
      turnUsername: `${T0 / 1000 + 3600}:u1`,
      turnCredential: 'abc==',
    });
    expect(withTurn).toHaveLength(2);
    expect(hasRelayServer(withTurn)).toBe(true);
    expect(withTurn[1]).toEqual({
      urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349'],
      username: `${T0 / 1000 + 3600}:u1`,
      credential: 'abc==',
    });
  });

  it('verwirft leere, doppelte und falsche Schemata (kein stiller Müll)', () => {
    const servers = buildIceServers({
      stunUrls: ['  stun:stun.example  ', 'stun:stun.example', 'http://kein-stun', '', undefined as never],
      turnUrls: ['turn:turn.example'],
      turnUsername: 'u',
      turnCredential: 'c',
    });
    expect(servers[0]).toEqual({ urls: ['stun:stun.example'] });
  });
});

describe('parseIceConfigResponse', () => {
  it('normalisiert gültige Antworten inkl. Default-TTL', () => {
    const parsed = parseIceConfigResponse({
      iceServers: [
        { urls: ['stun:stun.example'] },
        { urls: 'turn:turn.example', username: 'u', credential: 'c' },
      ],
      generatedAt: T0,
    });
    expect(parsed.iceServers[0]).toEqual({ urls: ['stun:stun.example'] });
    expect(parsed.iceServers[1]).toEqual({ urls: ['turn:turn.example'], username: 'u', credential: 'c' });
    expect(parsed.ttlSeconds).toBe(0);
    expect(parsed.generatedAt).toBe(T0);
  });

  it('wirft bei fehlenden/ungültigen Servern', () => {
    expect(() => parseIceConfigResponse({})).toThrow(/iceServers/);
    expect(() => parseIceConfigResponse({ iceServers: [{ urls: 'http://x' }] })).toThrow(/keine valide ICE-URL/);
  });
});

describe('createTurnCredentials (coturn REST)', () => {
  it('erzeugt kurzlebige, korrekt signierte Credentials', () => {
    const secret = 'test-secret';
    const creds = createTurnCredentials(secret, 'user-7', 600, T0);
    const expectedExpiry = Math.floor(T0 / 1000) + 600;
    expect(creds.expiry).toBe(expectedExpiry);
    expect(creds.username).toBe(`${expectedExpiry}:user-7`);
    expect(creds.credential).toBe(createHmac('sha1', secret).update(creds.username).digest('base64'));
    // Deterministisch bei gleichem now.
    expect(createTurnCredentials(secret, 'user-7', 600, T0)).toEqual(creds);
  });

  it('nutzt die Default-TTL und wirft ohne Secret', () => {
    const creds = createTurnCredentials('s', 'u', 0, T0);
    expect(creds.expiry).toBe(Math.floor(T0 / 1000) + DEFAULT_TURN_TTL_SECONDS);
    expect(() => createTurnCredentials('', 'u', 60, T0)).toThrow(/TURN_STATIC_AUTH_SECRET/);
  });
});

describe('buildWebRtcConfigResponse', () => {
  it('liefert ohne TURN-Env nur STUN (ehrlich: kein Relay)', () => {
    const res = buildWebRtcConfigResponse({}, { now: T0 });
    expect(res.iceServers.every((s) => !hasRelayServer([s]))).toBe(true);
    expect(hasRelayServer(res.iceServers)).toBe(false);
    expect(res.generatedAt).toBe(T0);
    expect(res.iceServers[0].urls).toEqual(expect.arrayContaining([...PUBLIC_STUN_URLS]));
  });

  it('liefert mit TURN-Env ein Relay mit kurzlebigen Credentials', () => {
    const res = buildWebRtcConfigResponse(
      {
        TURN_URLS: 'turn:turn.example:3478, turns:turn.example:5349',
        TURN_STATIC_AUTH_SECRET: 's3cr3t',
        TURN_TTL_SECONDS: '120',
        ICE_STUN_URLS: 'stun:stun.internal:3478',
      },
      { userId: 'alice', now: T0 },
    );
    expect(hasRelayServer(res.iceServers)).toBe(true);
    expect(res.ttlSeconds).toBe(120);
    const relay = res.iceServers.find((s) => hasRelayServer([s]))!;
    expect(String(relay.username)).toBe(`${Math.floor(T0 / 1000) + 120}:alice`);
    expect(relay.credential).toBe(createHmac('sha1', 's3cr3t').update(String(relay.username)).digest('base64'));
    expect(res.iceServers[0].urls).toContain('stun:stun.internal:3478');
  });

  it('splitList trimmt und filtert leere Einträge', () => {
    expect(splitList('a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(splitList(undefined)).toEqual([]);
  });
});

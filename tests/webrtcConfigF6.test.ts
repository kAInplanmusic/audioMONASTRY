/**
 * F6 · /api/webrtc-config liefert TURN mit kurzlebigen Credentials und die
 * SFU-Adresse – oder sagt ehrlich, dass beides fehlt.
 * =====================================================================
 * Befund am 2026-09-20 (externe Instanz): `/api/webrtc-config` enthielt nur
 * STUN (Mozilla/Cloudflare), keinen `turn:`-Eintrag; `sfu-1` lief, aber der
 * Client verband die SFU-Signalisierung **same-origin** gegen den App-Knoten
 * (dort liefert die SPA HTML). Beides ohne Warnung.
 *
 * Diese Datei prüft drei Aussagen:
 *   1. Der Vertrag des Aufbaus: mit `TURN_URLS` + `TURN_STATIC_AUTH_SECRET`
 *      entstehen `turn:`-Einträge mit kurzlebigen, korrekt signierten
 *      Credentials (coturn-REST: HMAC-SHA1 ueber `<expiry>:<userId>`).
 *   2. Die Ehrlichkeit: ohne Secret (oder ohne URLs) gibt es KEINEN
 *      turn:-Eintrag, `turn.available=false` und einen Klartextgrund – ein
 *      stilles „alles gut" war genau der Fehler.
 *   3. Die Wirkung im laufenden Server: `GET /api/webrtc-config` liefert die
 *      TURN-Strecke UND die absolute SFU-Adresse (`sfu.url`), damit der Client
 *      nicht mehr auf den App-Ursprung ausweicht.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import {
  buildWebRtcConfigResponse,
  DEFAULT_SFU_SIGNALING_PATH,
  normalizeSfuSignalingPath,
  normalizeSfuSignalingUrl,
  resolveSfuSignaling,
  resolveTurnInfo,
} from '../server/webrtcConfig';

const T0 = 1_700_000_000_000;
const SECRET = 'test-turn-secret';
const SFU_URL = 'https://sfu.test.example';

const relayEntry = (res: ReturnType<typeof buildWebRtcConfigResponse>) =>
  res.iceServers.find((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u))));

describe('F6: buildWebRtcConfigResponse – TURN mit kurzlebigen Credentials', () => {
  it('liefert mit TURN-Env turn:-URLs samt username/credential', () => {
    const res = buildWebRtcConfigResponse(
      {
        TURN_URLS: 'turn:turn.test.example:3478?transport=udp,turn:turn.test.example:3478?transport=tcp',
        TURN_STATIC_AUTH_SECRET: SECRET,
        TURN_TTL_SECONDS: '600',
      },
      { userId: 'spieler-1', now: T0 },
    );
    const relay = relayEntry(res);
    expect(relay).toBeDefined();
    const expiry = Math.floor(T0 / 1000) + 600;
    expect(relay!.username).toBe(`${expiry}:spieler-1`);
    expect(relay!.credential).toBe(createHmac('sha1', SECRET).update(String(relay!.username)).digest('base64'));
    expect(res.turn).toEqual({
      available: true,
      urls: ['turn:turn.test.example:3478?transport=udp', 'turn:turn.test.example:3478?transport=tcp'],
      ttlSeconds: 600,
    });
  });

  it('ohne Secret: kein turn:-Eintrag, available=false und ein Grund (kein falsches ok)', () => {
    const res = buildWebRtcConfigResponse(
      { TURN_URLS: 'turn:turn.test.example:3478' },
      { userId: 'spieler-1', now: T0 },
    );
    expect(relayEntry(res)).toBeUndefined();
    expect(res.turn.available).toBe(false);
    expect(res.turn.urls).toEqual(['turn:turn.test.example:3478']);
    expect(res.turn.reason).toMatch(/TURN_STATIC_AUTH_SECRET fehlt/);
    // Die STUN-Fallbacks bleiben nutzbar - der Ausfall ist nur der Relay.
    expect(res.iceServers.length).toBeGreaterThan(0);
  });

  it('ohne TURN_URLS nennt der Grund die fehlende Konfiguration', () => {
    const info = resolveTurnInfo({ TURN_STATIC_AUTH_SECRET: SECRET }, 900);
    expect(info.available).toBe(false);
    expect(info.urls).toEqual([]);
    expect(info.reason).toMatch(/TURN_URLS nicht gesetzt/);
    expect(info.ttlSeconds).toBe(900);
  });

  it('verwirft Nicht-TURN-Schemata in TURN_URLS (keine stille Fehleingabe)', () => {
    const info = resolveTurnInfo({ TURN_URLS: 'stun:stun.test.example, turn:turn.test.example:3478', TURN_STATIC_AUTH_SECRET: SECRET });
    expect(info.urls).toEqual(['turn:turn.test.example:3478']);
    expect(info.available).toBe(true);
  });
});

describe('F6: SFU-Adresse im Server-Vertrag', () => {
  it('nimmt eine absolute http(s)-URL an und liefert Pfad + ready', () => {
    // GEAENDERT AM 2026-09-24. Hier stand `enabled: false` fuer ENABLE_SFU=0.
    // Das war die Vermischung zweier Fragen: ENABLE_SFU sagt, ob AUF DIESEM
    // KNOTEN eine SFU laeuft (der Kommentar an der Schnittstelle nannte das
    // selbst "nur informativ"), `enabled` sagt, ob der CLIENT eine benutzen
    // darf. Live gemessen war die Folge: der App-Knoten hat ENABLE_SFU=0, also
    // lieferte /api/webrtc-config enabled=false, der Client warf die SFU weg
    // und blieb auf P2P - obwohl unter SFU_SIGNALING_URL ein betriebsbereiter
    // SFU stand (92 RTP-Pakete in 2 s gemessen).
    // Wer eine URL konfiguriert, will sie benutzen - unabhaengig davon, welcher
    // Knoten die SFU hostet.
    const sfu = resolveSfuSignaling({ ENABLE_SFU: '0', SFU_SIGNALING_URL: SFU_URL });
    expect(sfu).toEqual({
      enabled: true,
      url: SFU_URL,
      path: DEFAULT_SFU_SIGNALING_PATH,
      ready: true,
    });
  });

  it('meldet ohne SFU_SIGNALING_URL ready=false mit Grund (nie same-origin raten)', () => {
    const sfu = resolveSfuSignaling({ ENABLE_SFU: '0' });
    expect(sfu.ready).toBe(false);
    expect(sfu.url).toBeNull();
    expect(sfu.reason).toMatch(/SFU_SIGNALING_URL nicht gesetzt/);
  });

  it('lehnt relative/kaputte Werte ab, statt sie als Ziel auszugeben', () => {
    for (const bad of ['/sfu-signaling', 'sfu.test.example', 'ws://sfu.test.example']) {
      const sfu = resolveSfuSignaling({ SFU_SIGNALING_URL: bad });
      expect(sfu.ready).toBe(false);
      expect(sfu.url).toBeNull();
      expect(sfu.reason).toMatch(/keine absolute http\(s\)-URL/);
    }
    expect(normalizeSfuSignalingUrl('https://sfu.test.example/')).toBe('https://sfu.test.example');
    expect(normalizeSfuSignalingUrl('')).toBeNull();
  });

  it('normalisiert den Signalisierungspfad (Default /sfu-signaling)', () => {
    expect(normalizeSfuSignalingPath(undefined)).toBe(DEFAULT_SFU_SIGNALING_PATH);
    expect(normalizeSfuSignalingPath('sfu-signaling')).toBe(DEFAULT_SFU_SIGNALING_PATH);
    expect(normalizeSfuSignalingPath('/sfu/')).toBe('/sfu');
    expect(normalizeSfuSignalingPath('//böse')).toBe(DEFAULT_SFU_SIGNALING_PATH);
  });

  it('ENABLE_SFU=1 auf demselben Knoten ist informativ, aber nicht die Adresse', () => {
    const sfu = resolveSfuSignaling({ ENABLE_SFU: '1', SFU_SIGNALING_URL: SFU_URL });
    expect(sfu.enabled).toBe(true);
    expect(sfu.url).toBe(SFU_URL);
  });
});

describe('F6: Wirkung im laufenden Server (Rest-API)', () => {
  let server: Server;
  let baseUrl = '';
  const token = 'f6-test-studio-token';

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.VITEST = 'true';
    process.env.STUDIO_ACCESS_TOKEN = token;
    process.env.API_RATE_LIMIT_MAX = '1000';
    // Produktionskonfiguration der RTC-Strecke (App-Knoten).
    process.env.ENABLE_SFU = '0';
    process.env.SFU_SIGNALING_URL = SFU_URL;
    process.env.TURN_URLS = 'turn:turn.test.example:3478?transport=udp,turn:turn.test.example:3478?transport=tcp';
    process.env.TURN_STATIC_AUTH_SECRET = SECRET;
    process.env.TURN_TTL_SECONDS = '600';
    const mod = await import('../server');
    server = mod.app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SFU_SIGNALING_URL;
    delete process.env.TURN_URLS;
    delete process.env.TURN_STATIC_AUTH_SECRET;
    delete process.env.TURN_TTL_SECONDS;
    delete process.env.STUDIO_ACCESS_TOKEN;
  });

  it('GET /api/webrtc-config liefert turn: mit Credentials und die SFU-Adresse', async () => {
    const res = await fetch(`${baseUrl}/api/webrtc-config?userId=kuenstler-7`, {
      headers: { 'x-studio-token': token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      iceServers: { urls: string | string[]; username?: string; credential?: string }[];
      turn: { available: boolean; urls: string[] };
      sfu: { ready: boolean; url: string | null; path: string };
      ttlSeconds: number;
    };
    const relay = body.iceServers.find((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith('turn:')),
    );
    expect(relay).toBeDefined();
    expect(relay!.username).toMatch(/^\d+:kuenstler-7$/);
    expect(relay!.credential).toBe(
      createHmac('sha1', SECRET).update(String(relay!.username)).digest('base64'),
    );
    expect(body.turn.available).toBe(true);
    expect(body.turn.urls.length).toBe(2);
    expect(body.sfu).toMatchObject({ ready: true, url: SFU_URL, path: '/sfu-signaling' });
    expect(body.ttlSeconds).toBe(600);
  });

  it('ohne Secret liefert dieselbe Route keinen turn:-Eintrag – und sagt warum', async () => {
    const saved = process.env.TURN_STATIC_AUTH_SECRET;
    delete process.env.TURN_STATIC_AUTH_SECRET;
    try {
      const res = await fetch(`${baseUrl}/api/webrtc-config`, { headers: { 'x-studio-token': token } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        iceServers: { urls: string | string[] }[];
        turn: { available: boolean; reason?: string };
      };
      const hasTurn = body.iceServers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith('turn:')),
      );
      expect(hasTurn).toBe(false);
      expect(body.turn.available).toBe(false);
      expect(String(body.turn.reason)).toMatch(/TURN_STATIC_AUTH_SECRET fehlt/);
    } finally {
      process.env.TURN_STATIC_AUTH_SECRET = saved;
    }
  });

  it('ohne SFU-Adresse meldet sfu.ready=false statt die SPA-Adresse zu erfinden', async () => {
    const saved = process.env.SFU_SIGNALING_URL;
    delete process.env.SFU_SIGNALING_URL;
    try {
      const res = await fetch(`${baseUrl}/api/webrtc-config`, { headers: { 'x-studio-token': token } });
      const body = (await res.json()) as { sfu: { ready: boolean; url: string | null; reason?: string } };
      expect(body.sfu.ready).toBe(false);
      expect(body.sfu.url).toBeNull();
      expect(String(body.sfu.reason)).toMatch(/SFU_SIGNALING_URL nicht gesetzt/);
    } finally {
      process.env.SFU_SIGNALING_URL = saved;
    }
  });
});

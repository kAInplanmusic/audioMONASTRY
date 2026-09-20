/**
 * F6 · Client-Auswahl der SFU-Adresse (kein same-origin-Raten mehr)
 * =====================================================================
 * Der Client verband die Mediasoup-Signalisierung bisher implizit **same-origin**
 * (`io({ path: '/sfu-signaling' })`). Auf dem App-Knoten (ENABLE_SFU=0) liefert
 * dieselbe Adresse die SPA – der Client bekam HTML statt Signalisierung und nur
 * ein generisches "xhr poll error".
 *
 * Geprüft wird deshalb:
 *   1. die Auflösungsreihenfolge Server (`/api/webrtc-config`) → `VITE_SFU_URL`,
 *      und dass ohne beide NICHT auf den App-Ursprung zurückgefallen wird,
 *   2. der Fetch-Vertrag (Server-Antwort ohne `sfu`, HTTP-Fehler, kaputte URL),
 *   3. die Wirkung im Transport: `io()` wird mit der KONFIGURIERTEN Adresse
 *      aufgerufen – und ohne Adresse scheitert `connect()` mit klarem Klartext
 *      statt mit einer HTML-Verbindung,
 *   4. Mixed Content (HTTPS-Seite + http://-Ziel) wird als Ursache benannt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioMock = vi.fn();
vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));
vi.mock('mediasoup-client', () => ({
  Device: class {
    rtpCapabilities = {};
    async load() { /* Testdouble */ }
    createSendTransport(dir: Record<string, unknown>) {
      return {
        id: 'send-1',
        ...dir,
        on: () => {},
        produce: async () => ({ id: 'prod-1' }),
        close: () => {},
      };
    }
    createRecvTransport(dir: Record<string, unknown>) {
      return { id: 'recv-1', ...dir, on: () => {}, close: () => {} };
    }
  },
}));

import {
  DEFAULT_SFU_SIGNALING_PATH,
  SfuSignalingNotConfiguredError,
  cacheServerSfuSignaling,
  fetchSfuSignalingTarget,
  isMixedContentBlocked,
  normalizeSfuPath,
  normalizeSfuUrl,
  resolveSfuSignalingTarget,
} from '../src/core/transport/sfuEndpoint';
import { MediasoupTransport } from '../src/core/transport/MediasoupTransport';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as unknown as Response;

beforeEach(() => {
  ioMock.mockReset();
  cacheServerSfuSignaling(null);
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('F6: resolveSfuSignalingTarget – Reihenfolge und kein same-origin', () => {
  it('nimmt die Server-Antwort zuerst (sie ist autoritativ)', () => {
    const res = resolveSfuSignalingTarget({
      serverUrl: 'https://sfu.test.example',
      viteUrl: 'https://vite.test.example',
      path: '/sfu-signaling',
    });
    expect(res.target).toEqual({ url: 'https://sfu.test.example', path: '/sfu-signaling', source: 'server' });
  });

  it('fällt auf VITE_SFU_URL zurück, wenn der Server nichts liefert', () => {
    const res = resolveSfuSignalingTarget({ serverUrl: null, viteUrl: 'https://vite.test.example' });
    expect(res.target?.source).toBe('vite');
    expect(res.target?.url).toBe('https://vite.test.example');
  });

  it('liefert OHNE Server- und Build-Wert kein Ziel (nicht der App-Ursprung)', () => {
    const res = resolveSfuSignalingTarget({ serverUrl: null, viteUrl: null });
    expect(res.target).toBeNull();
    expect(res.reason).toMatch(/SFU_SIGNALING_URL/);
    expect(res.reason).toMatch(/VITE_SFU_URL nicht gesetzt/);
  });

  it('lehnt relative/kaputte Werte ab und benennt sie', () => {
    const res = resolveSfuSignalingTarget({ serverUrl: '/sfu-signaling', viteUrl: 'nonsense' });
    expect(res.target).toBeNull();
    expect(res.reason).toMatch(/keine absolute http\(s\)-URL/);
  });

  it('normalisiert URL und Pfad', () => {
    expect(normalizeSfuUrl('https://sfu.test.example/')).toBe('https://sfu.test.example');
    expect(normalizeSfuUrl('https://sfu.test.example:8443/base/')).toBe('https://sfu.test.example:8443/base');
    expect(normalizeSfuUrl('')).toBeNull();
    expect(normalizeSfuPath(undefined)).toBe(DEFAULT_SFU_SIGNALING_PATH);
    expect(normalizeSfuPath('//x')).toBe(DEFAULT_SFU_SIGNALING_PATH);
    expect(normalizeSfuPath('/signal/')).toBe('/signal');
  });
});

describe('F6: fetchSfuSignalingTarget – Server-Antwort lesen', () => {
  it('übernimmt sfu.url aus /api/webrtc-config', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sfu: { url: 'https://sfu.test.example', path: '/sfu-signaling', ready: true } }));
    const res = await fetchSfuSignalingTarget(fetchImpl as unknown as typeof fetch, { viteUrl: null });
    expect(res.target).toMatchObject({ url: 'https://sfu.test.example', source: 'server' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/webrtc-config', { credentials: 'same-origin' });
  });

  it('meldet den Servergrund, wenn keine Adresse konfiguriert ist', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sfu: { ready: false, reason: 'SFU_SIGNALING_URL nicht gesetzt' } }));
    const res = await fetchSfuSignalingTarget(fetchImpl as unknown as typeof fetch, { viteUrl: null });
    expect(res.target).toBeNull();
    expect(res.reason).toContain('SFU_SIGNALING_URL nicht gesetzt');
  });

  it('fällt bei HTTP-Fehler auf VITE_SFU_URL zurück (Build-Notausgang)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const res = await fetchSfuSignalingTarget(fetchImpl as unknown as typeof fetch, { viteUrl: 'https://vite.test.example' });
    expect(res.target?.source).toBe('vite');
  });

  it('nennt den Netzfehler, wenn auch VITE_SFU_URL fehlt', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('kaputt'); });
    const res = await fetchSfuSignalingTarget(fetchImpl as unknown as typeof fetch, { viteUrl: null });
    expect(res.target).toBeNull();
    expect(res.reason).toMatch(/\/api\/webrtc-config nicht lesbar/);
  });

  it('nutzt den Zwischenspeicher, wenn refreshIceConfig die Antwort schon hatte', async () => {
    cacheServerSfuSignaling({ url: 'https://sfu.cached.example', path: '/sfu-signaling', ready: true });
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const res = await fetchSfuSignalingTarget(fetchImpl as unknown as typeof fetch, { viteUrl: null });
    expect(res.target?.url).toBe('https://sfu.cached.example');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('F6: Mixed-Content-Prüfung', () => {
  it('erkennt https-Seite + http-Ziel', () => {
    expect(isMixedContentBlocked('https:', 'http://1.2.3.4')).toBe(true);
    expect(isMixedContentBlocked('http:', 'http://1.2.3.4')).toBe(false);
    expect(isMixedContentBlocked('https:', 'https://sfu.test.example')).toBe(false);
    expect(isMixedContentBlocked('', 'http://1.2.3.4')).toBe(false);
  });
});

/** Socket-Double: verbindet sofort und beantwortet die Signal-Callbacks. */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    connected: true,
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb);
      if (event === 'connect') queueMicrotask(() => cb());
      return this;
    },
    emit(event: string, payload: unknown, cb?: (resp: unknown) => void) {
      if (event === 'getRouterRtpCapabilities') cb?.({ rtpCapabilities: {} });
      else if (event === 'createTransport') cb?.({ id: 'transport-1', iceParameters: {}, iceCandidates: [], dtlsParameters: {} });
      else cb?.({ id: 'ok' });
      return this;
    },
    disconnect() { this.connected = false; },
    handlers,
    payloads: [] as { event: string; payload: unknown }[],
  };
}

describe('F6: MediasoupTransport verbindet die KONFIGURIERTE Adresse', () => {
  it('ohne konfigurierte Adresse: klarer Fehler statt HTML-Verbindung', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sfu: { ready: false, reason: 'SFU_SIGNALING_URL nicht gesetzt' } })));
    const transport = new MediasoupTransport();
    await expect(transport.connect('s-1', 'u-1')).rejects.toThrow(SfuSignalingNotConfiguredError);
    await expect(transport.connect('s-1', 'u-1')).rejects.toThrow(/keine SFU-Adresse konfiguriert/);
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('mit Adresse aus der Server-Antwort: io() bekommt URL + Pfad', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sfu: { url: 'https://sfu.test.example', path: '/sfu-signaling', ready: true } })));
    ioMock.mockReturnValue(fakeSocket());
    const transport = new MediasoupTransport();
    await transport.connect('session-42', 'u-1');
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock.mock.calls[0][0]).toBe('https://sfu.test.example');
    expect(ioMock.mock.calls[0][1]).toMatchObject({ path: '/sfu-signaling', query: { sessionId: 'session-42' } });
    expect(transport.signalingTarget()?.url).toBe('https://sfu.test.example');
    transport.disconnect();
  });

  it('mit ausdruecklichem Ziel: kein Serverabruf, Adresse gewinnt', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);
    ioMock.mockReturnValue(fakeSocket());
    const transport = new MediasoupTransport();
    transport.setSignalingTarget({ url: 'https://sfu.explicit.example', path: '/sfu-signaling', source: 'explicit' });
    await transport.connect('s-1', 'u-1');
    expect(ioMock.mock.calls[0][0]).toBe('https://sfu.explicit.example');
    expect(fetchSpy).not.toHaveBeenCalled();
    transport.disconnect();
  });

  it('HTTPS-Seite + http://-Ziel: Mixed Content wird als Ursache gemeldet', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    const transport = new MediasoupTransport();
    transport.setSignalingTarget({ url: 'http://49.13.65.150', path: '/sfu-signaling', source: 'server' });
    await expect(transport.connect('s-1', 'u-1')).rejects.toThrow(/Mixed Content/);
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('Verbindungsfehler nennen Adresse und Pfad (Zuordnung statt "xhr poll error")', async () => {
    const socket = fakeSocket();
    socket.on = (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'connect_error') queueMicrotask(() => cb(new Error('xhr poll error')));
      return socket;
    };
    ioMock.mockReturnValue(socket);
    const transport = new MediasoupTransport();
    transport.setSignalingTarget({ url: 'https://sfu.test.example', path: '/sfu-signaling', source: 'server' });
    await expect(transport.connect('s-1', 'u-1')).rejects.toThrow(/https:\/\/sfu\.test\.example\/sfu-signaling nicht erreichbar/);
  });
});

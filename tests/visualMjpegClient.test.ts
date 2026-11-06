// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MJPEG_TICKET_URL,
  createFallbackPublisher,
  mjpegStreamUrl,
  requestMjpegTicket,
  shouldPublishFrame,
  studioTokenFromCookie,
} from '../src/utils/visualMjpeg';
import { MJPEG_BOUNDARY, mjpegPart, parseMjpegStream } from '../server/visualStream';

// UI-2026-11-06-002: Der Beamer rendert den MJPEG-Strom als <img>. Der
// WebRTC-Manager (Socket/Mediasoup) ist fuer diese Pruefung ohne Belang - er
// wuerde nur Signalisierung gegen einen nicht vorhandenen Server versuchen.
vi.mock('../src/utils/WebRTCManager', () => ({
  webRTCManager: {
    onOutputBusy: () => () => {},
    sendEndpointReport: () => {},
    isVisualOutMode: true,
  },
}));

/**
 * VISUAL-P1-001 · MJPEG-Fallback, Client-Seite
 * =====================================================================
 * Die Studio-Seite darf NUR senden, wenn jemand schaut — sonst enkodiert der
 * Studio-Rechner dauerhaft JPEGs fuer niemanden. Und sie darf nicht in eine
 * Sendeschleife laufen, wenn der Server bremst (202 = zu schnell).
 */

const fakeCanvas = {} as HTMLCanvasElement;
const blob = (type = 'image/jpeg') => new Blob([new Uint8Array([1, 2, 3])], { type });

function fakeFetch(responses: { status?: number; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body ?? {},
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('VISUAL-P1-001 · MJPEG-Client', () => {
  // AUDIT-2026-10-30-P1-006: Die Stream-URL traegt nur noch das Einmal-Ticket.
  // Vorher stand hier `?token=${...}` mit dem Studio-MASTER-Token - der landete
  // damit in Access-Logs, Referrern und der Browser-History.
  it('baut die Stream-URL mit Einmal-Ticket (fuer <img>)', () => {
    expect(mjpegStreamUrl('abc')).toBe('/visual-stream/mjpeg?ticket=abc');
    expect(mjpegStreamUrl('a b')).toBe('/visual-stream/mjpeg?ticket=a%20b');
    expect(mjpegStreamUrl('abc', 'user-1')).toBe('/visual-stream/mjpeg?ticket=abc&sid=user-1');
    expect(mjpegStreamUrl('', 'user-1')).toBe('/visual-stream/mjpeg');
    expect(mjpegStreamUrl('')).toBe('/visual-stream/mjpeg');
  });

  it('holt das Ticket auf einer authentifizierten Route (Header, kein Query-Token)', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { ticket: 'tick-1', expiresAt: 2000, ttlMs: 1000 } }]);

    const issued = await requestMjpegTicket({ token: 'studio-token', sessionId: 'user-1', fetchImpl: impl });

    expect(MJPEG_TICKET_URL).toBe('/api/visual/mjpeg-ticket');
    expect(issued).toEqual({ ticket: 'tick-1', expiresAt: 2000, ttlMs: 1000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/visual/mjpeg-ticket');
    expect(calls[0].init?.method).toBe('POST');
    // Der Master-Token geht als Header raus - nie in die URL.
    expect(calls[0].url).not.toContain('token=');
    expect((calls[0].init?.headers as Record<string, string>)['x-studio-token']).toBe('studio-token');
    expect((calls[0].init?.headers as Record<string, string>)['x-session-id']).toBe('user-1');
  });

  it('meldet fehlende Tickets als Fehler, statt eine leere URL zu bauen', async () => {
    const denied = fakeFetch([{ status: 401, body: {} }]);
    await expect(requestMjpegTicket({ token: 'x', fetchImpl: denied.impl })).rejects.toThrow('MJPEG_TICKET_401');

    const empty = fakeFetch([{ status: 200, body: { ok: true } }]);
    await expect(requestMjpegTicket({ fetchImpl: empty.impl })).rejects.toThrow('MJPEG_TICKET_EMPTY');
  });

  // (c) Quelle enthaelt keine Master-Token-Interpolation mehr. Der Test liest
  // den echten Quelltext: ein spaeterer "Schnellfix" mit `?token=` wuerde hier
  // auffallen, auch wenn die Laufzeit-Assertions oben umgangen werden.
  it('baut nirgends mehr einen Master-Token in eine URL ein (Quelltext-Beweis)', () => {
    // Seit UI-2026-11-06-002 laeuft diese Datei in jsdom; `import.meta.url` ist
    // dort keine file:-URL mehr. Gelesen wird deshalb relativ zum Repo-Wurzel-
    // verzeichnis (vitest startet dort).
    const repoRoot = process.cwd();
    const read = (file: string) => readFileSync(`${repoRoot}/${file}`, 'utf8');
    const files = [
      'src/utils/visualMjpeg.ts',
      'src/pages/VisualOutPage.tsx',
      'server/routes/visualRoutes.ts',
    ];
    for (const file of files) {
      const source = read(file);
      // Keine Query-Parameter `token=`, keine Interpolation eines Tokens in eine URL.
      expect(source, file).not.toMatch(/\?token=/);
      expect(source, file).not.toMatch(/[?&]token=\$\{/);
      expect(source, file).not.toMatch(/token=\$\{encodeURIComponent/);
      // Der Strom traegt das Ticket.
      if (file.endsWith('visualMjpeg.ts')) expect(source).toContain('?ticket=');
      if (file.endsWith('visualRoutes.ts')) {
        expect(source).not.toContain('tokenFromUrl');
        expect(source).toContain('mjpeg-ticket');
      }
    }
    // Die Beamer-Seite gibt nie den Studio-Token an die Bild-URL.
    const page = read('src/pages/VisualOutPage.tsx');
    expect(page).not.toContain('mjpegStreamUrl(studioTokenFromCookie');
  });

  it('liest den Studio-Token aus dem Cookie', () => {
    expect(studioTokenFromCookie('foo=1; studio=tok123; bar=2')).toBe('tok123');
    expect(studioTokenFromCookie('studio=a%20b')).toBe('a b');
    expect(studioTokenFromCookie('foo=1')).toBe('');
  });

  it('begrenzt die Sendefrequenz unabhaengig von der Aufrufrate', () => {
    expect(shouldPublishFrame(0, 1000, 10)).toBe(true);
    expect(shouldPublishFrame(1000, 1050, 10)).toBe(false);
    expect(shouldPublishFrame(1000, 1100, 10)).toBe(true);
    // maxFps=1 -> hoechstens einmal pro Sekunde
    expect(shouldPublishFrame(1000, 1900, 1)).toBe(false);
    expect(shouldPublishFrame(1000, 2001, 1)).toBe(true);
  });

  it('sendet NICHTS, wenn kein Beamer schaut', async () => {
    const { impl, calls } = fakeFetch([{ body: { viewers: 0, hasFrame: false } }]);
    const publisher = createFallbackPublisher({
      getCanvas: () => fakeCanvas,
      token: 'tok',
      fetchImpl: impl,
      encodeFrame: async () => blob(),
    });

    const result = await publisher.tick();

    expect(result).toEqual({ viewers: 0, sent: false });
    // Nur der Status-Abruf - kein Frame-Upload.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/visual/status');
  });

  it('sendet genau einen Frame pro Frequenzfenster und zaehlt 202 als angenommen', async () => {
    let now = 1000;
    const { impl, calls } = fakeFetch([
      { body: { viewers: 1 } },
      { status: 200, body: { ok: true } },
      { body: { viewers: 1 } }, // zweiter Tick im selben Fenster
      { body: { viewers: 1 } }, // dritter Tick nach Ablauf
      { status: 202, body: { ok: false, reason: 'too-fast' } },
    ]);
    const publisher = createFallbackPublisher({
      getCanvas: () => fakeCanvas,
      token: 'tok',
      maxFps: 10,
      fetchImpl: impl,
      now: () => now,
      encodeFrame: async () => blob(),
    });

    const first = await publisher.tick();
    now = 1050;
    const second = await publisher.tick();
    now = 1200;
    const third = await publisher.tick();

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false); // Frequenzgrenze im Client
    expect(third.sent).toBe(true); // 202 = angenommen (Server bremst, aber kein Fehler)
    const uploads = calls.filter((c) => c.init?.method === 'POST');
    expect(uploads).toHaveLength(2);
    expect((uploads[0].init?.headers as Record<string, string>)['x-studio-token']).toBe('tok');
  });

  it('meldet Fehler, statt still zu scheitern', async () => {
    const onError = vi.fn();
    const failing = vi.fn(async () => { throw new Error('Netz weg'); }) as unknown as typeof fetch;
    const publisher = createFallbackPublisher({
      getCanvas: () => fakeCanvas,
      token: 'tok',
      fetchImpl: failing,
      onError,
      encodeFrame: async () => blob(),
    });

    const result = await publisher.tick();
    expect(result.sent).toBe(false);
    expect(onError).toHaveBeenCalledWith('Netz weg');
  });

  it('startet und stoppt den Zyklus idempotent', () => {
    const { impl } = fakeFetch([]);
    const publisher = createFallbackPublisher({ getCanvas: () => null, token: 'tok', fetchImpl: impl });
    expect(publisher.running).toBe(false);
    publisher.start();
    publisher.start();
    expect(publisher.running).toBe(true);
    publisher.stop();
    publisher.stop();
    expect(publisher.running).toBe(false);
  });
});

/**
 * UI-2026-11-06-002 · Der Beamer muss den Strom OFFEN HALTEN
 * ==========================================================
 * Gemeldeter Fehler: `src/pages/VisualOutPage.tsx` baute das `<img>` beim
 * ersten `onLoad` ab (Statuswechsel auf 'live' entfernte es aus dem Baum).
 * Ein `multipart/x-mixed-replace`-Strom wird aber NIE fertig geladen - mit dem
 * Element endet auch die Verbindung, und der Beamer zeigt nach dem ersten Frame
 * ein Standbild.
 *
 * Der Test haelt den Strom deshalb ueber mehrere Sekunden offen und zaehlt die
 * Frames: ein Zaehler, der nach dem ersten Frame stehenbleibt, ist genau der
 * Fehler.
 */
describe('UI-2026-11-06-002 · MJPEG-Strom bleibt offen', () => {
  let server: Server | null = null;
  const sockets = new Set<import('node:net').Socket>();

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  it('liefert ueber mehrere Sekunden laufend weitere Frames (Zaehler monoton)', async () => {
    server = createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
        'Cache-Control': 'no-store',
      });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        res.write(mjpegPart({
          data: Buffer.alloc(512, sent % 250),
          contentType: 'image/jpeg',
          at: Date.now(),
        }));
      }, 120);
      req.on('close', () => clearInterval(timer));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const chunks: Buffer[] = [];
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/visual-stream/mjpeg?ticket=proof-ticket' },
      (res) => {
        expect(String(res.headers['content-type'])).toContain('multipart/x-mixed-replace');
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
      },
    );
    req.end();

    const frames = () => parseMjpegStream(Buffer.concat(chunks)).length;
    await new Promise((r) => setTimeout(r, 700));
    const afterFirstSecond = frames();
    await new Promise((r) => setTimeout(r, 1500));
    const afterTwoSeconds = frames();
    await new Promise((r) => setTimeout(r, 900));
    const afterThreeSeconds = frames();
    req.destroy();

    // Nach dem ersten Frame kommen WEITERE - der Strom endet nicht.
    expect(afterFirstSecond).toBeGreaterThanOrEqual(1);
    expect(afterTwoSeconds).toBeGreaterThan(afterFirstSecond);
    expect(afterThreeSeconds).toBeGreaterThan(afterTwoSeconds);
    // ~3,1 s bei 120 ms pro Frame: mindestens 12 Frames, nicht 1.
    expect(afterThreeSeconds).toBeGreaterThanOrEqual(12);
  });

  it('baut das <img> bei onLoad NICHT ab - Status wird nur gesetzt', async () => {
    vi.useFakeTimers();
    let tickets = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      tickets += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ticket: `ticket-${tickets}`, expiresAt: 0, ttlMs: 60_000 }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { VisualOutPage } = await import('../src/pages/VisualOutPage');
    render(createElement(VisualOutPage));

    // 6-s-Fallback: WebRTC kommt nicht durch, MJPEG springt ein.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });

    const img = screen.getByAltText('Visual-Fallback (MJPEG)') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('ticket=ticket-1');

    // Erster Frame ist da (bei MJPEG das einzige onLoad-Ereignis).
    await act(async () => { fireEvent.load(img); });

    // Das Element muss bleiben: sonst kappt der Browser den Strom.
    const still = screen.queryByAltText('Visual-Fallback (MJPEG)') as HTMLImageElement | null;
    expect(still).not.toBeNull();
    expect(still?.isConnected).toBe(true);
    expect(still?.getAttribute('src')).toContain('ticket=ticket-1');
    // 'live' ist erreicht -> Status-Overlay weg, aber kein neues Ticket.
    expect(screen.queryByText('VISUAL OUT')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Auch nach weiterer Laufzeit: kein Abbau, kein Ticket-Nachschlag.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.queryByAltText('Visual-Fallback (MJPEG)')).toBe(still);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('holt nach Fehlern hoechstens zwei frische Tickets, dann Fehlermeldung', async () => {
    vi.useFakeTimers();
    let tickets = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      tickets += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ticket: `ticket-${tickets}`, expiresAt: 0, ttlMs: 60_000 }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { VisualOutPage } = await import('../src/pages/VisualOutPage');
    render(createElement(VisualOutPage));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = screen.getByAltText('Visual-Fallback (MJPEG)');
      await act(async () => {
        fireEvent.error(current);
        await vi.advanceTimersByTimeAsync(100);
      });
    }

    // Ticket 1 (Start) + genau zwei frische Tickets nach den Fehlern.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === MJPEG_TICKET_URL)).toBe(true);
    expect(screen.queryByAltText('Visual-Fallback (MJPEG)')).toBeNull();
    expect(document.body.textContent).toContain('Weder WebRTC noch MJPEG-Fallback erreichbar.');
  });
});

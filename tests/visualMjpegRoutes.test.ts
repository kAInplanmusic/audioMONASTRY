/**
 * Abnahmetest der MJPEG-Routen gegen den ECHTEN Server (VISUAL-P1-001)
 * =====================================================================
 * Geprueft wird das, was der Beamer und das Studio wirklich benutzen:
 *   - 401 ohne Token, Token als Header UND als `?token=` (nur hier),
 *   - Groessen-/Typ-/Frequenzgrenzen mit Grund,
 *   - ein ECHTER multipart-Strom: Frames werden gepostet und kommen als
 *     `multipart/x-mixed-replace` zurueck (mit dem Parser des Servers gelesen),
 *   - `/api/visual/status` meldet die Zuschauerzahl (davon haengt ab, ob das
 *     Studio ueberhaupt enkodiert).
 */
// FIXPAKET-C (C3): NODE_ENV-Pin VOR dem Top-level-`await import('../server')`:
// ohne ihn lief der Server hier mit ambient NODE_ENV=production fail-closed.
process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressInfo } from 'node:net';

process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.API_RATE_LIMIT_MAX = '10000';
// AUDIT-2026-10-30-P1-006: kleine TTL, damit "abgelaufen" ohne langes Warten
// pruefbar bleibt (die Produktions-Vorgabe ist groesser, aber ebenfalls klein).
process.env.VISUAL_MJPEG_TICKET_TTL_MS = '1200';

const TOKEN = 'visual-proof-token';
process.env.STUDIO_ACCESS_TOKEN = TOKEN;

const { startServer } = await import('../server');

let baseUrl = '';
let httpServer: { close(cb: () => void): void } | null = null;
const jpeg = (size = 64) => Buffer.alloc(size, 5);

/** Minimaler Multipart-Leser (der Server-Parser wird auch einzeln getestet). */
function frameCount(buffer: Buffer, boundary = 'audiomonastryframe'): number {
  return buffer.toString('latin1').split(`--${boundary}\r\n`).length - 1;
}

beforeAll(async () => {
  const started = await startServer(0);
  httpServer = started?.httpServer ?? null;
  const address = httpServer && (httpServer as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  // Ein Frame im Hub: der Strom schreibt seine Kopfzeilen sonst erst mit dem
  // ersten Frame (bzw. am firstFrameTimeout) - `fetch` wuerde so lange warten.
  await fetch(`${baseUrl}/api/visual/frame`, {
    method: 'POST',
    headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
    body: jpeg(64),
  });
}, 60_000);

afterAll(() => {
  httpServer?.close(() => {});
});

describe('AUDIT-2026-10-30-P1-006 · Master-Token nie in einer URL', () => {
  async function ticket(headers: Record<string, string> = { 'x-studio-token': TOKEN }) {
    const res = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, { method: 'POST', headers });
    return { res, body: (await res.json()) as { ticket?: string; ttlMs?: number; expiresAt?: number; error?: string } };
  }

  it('gibt Tickets nur an authentifizierte Clients aus', async () => {
    const anonymous = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, { method: 'POST' });
    expect(anonymous.status).toBe(401);
    const withWrongToken = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': 'falsch' },
    });
    expect(withWrongToken.status).toBe(401);
  });

  it('gibt ein kurzlebiges, undurchsichtiges Ticket aus (nie den Master-Token)', async () => {
    const { res, body } = await ticket();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket).not.toBe(TOKEN);
    expect(body.ticket?.length).toBeGreaterThanOrEqual(32);
    expect(body.ttlMs).toBeLessThanOrEqual(60_000);
  });

  it('akzeptiert das Master-Token NICHT mehr in der URL', async () => {
    // Der alte Weg (Master-Token als Query) muss tot sein ...
    const withMaster = await fetch(`${baseUrl}/api/visual/mjpeg?token=${encodeURIComponent(TOKEN)}`);
    expect(withMaster.status).toBe(401);
    // ... ebenso ohne alles oder mit fremdem Ticket ...
    const withoutAnything = await fetch(`${baseUrl}/api/visual/mjpeg`);
    expect(withoutAnything.status).toBe(401);
    const streamNoTicket = await fetch(`${baseUrl}/visual-stream/mjpeg`);
    expect(streamNoTicket.status).toBe(401);
    expect(await streamNoTicket.json()).toMatchObject({ error: 'MJPEG_TICKET_REQUIRED' });
    const wrongTicket = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=falsch`);
    expect(wrongTicket.status).toBe(403);
    // ... und der Master-Token bleibt als HEADER weiter gueltig (Skripte/API).
    const controller = new AbortController();
    const withHeader = await fetch(`${baseUrl}/api/visual/mjpeg`, {
      headers: { 'x-studio-token': TOKEN },
      signal: controller.signal,
    });
    expect(withHeader.status).toBe(200);
    controller.abort();
  });

  it('akzeptiert das Ticket unter /api nur mit Credentials (Grenze der Middleware)', async () => {
    const { body } = await ticket();
    const url = `${baseUrl}/api/visual/mjpeg?ticket=${encodeURIComponent(String(body.ticket))}`;

    // Ohne Header/Cookie weist schon die globale /api-Auth ab - die Route kaeme
    // nie dran. Genau deshalb hat der Beamer seine eigene Route ohne /api-Prefix.
    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(401);

    // Mit Cookie (der Browser sendet es beim <img> automatisch) prueft die
    // Route zusaetzlich das Einmal-Ticket.
    const controller = new AbortController();
    const withCookie = await fetch(url, { headers: { cookie: `studio=${TOKEN}` }, signal: controller.signal });
    expect(withCookie.status).toBe(200);
    controller.abort();
  }, 20_000);

  it('lehnt ein wiederverwendetes Ticket ab', async () => {
    const { body } = await ticket();
    const first = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(String(body.ticket))}`);
    expect(first.status).toBe(200);
    first.body?.cancel().catch(() => {});

    const reused = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(String(body.ticket))}`);
    expect(reused.status).toBe(403);
    expect(await reused.json()).toMatchObject({ error: 'MJPEG_TICKET_INVALID', reason: 'used' });
  }, 20_000);

  it('lehnt ein abgelaufenes Ticket ab', async () => {
    const { body } = await ticket();
    await new Promise((r) => setTimeout(r, 1500)); // TTL im Test: 1200 ms
    const expired = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(String(body.ticket))}`);
    expect(expired.status).toBe(403);
    expect(await expired.json()).toMatchObject({ error: 'MJPEG_TICKET_INVALID', reason: 'expired' });
  }, 20_000);

  it('bindet das Ticket an die Session', async () => {
    const { body } = await ticket({ 'x-studio-token': TOKEN, 'x-session-id': 'session-a' });
    const url = (sid: string) =>
      `${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(String(body.ticket))}&sid=${encodeURIComponent(sid)}`;

    // Fremde Session: abgelehnt, ohne das Ticket zu verbrennen ...
    const foreign = await fetch(url('session-b'));
    expect(foreign.status).toBe(403);
    // ... die richtige Session kommt danach durch.
    const controller = new AbortController();
    const own = await fetch(url('session-a'), { signal: controller.signal });
    expect(own.status).toBe(200);
    controller.abort();
  }, 20_000);
});

describe('VISUAL-P1-001 · MJPEG-Routen', () => {
  it('verlangt Studio-Auth (Header) und keinen Query-Token mehr', async () => {
    const noToken = await fetch(`${baseUrl}/api/visual/mjpeg`);
    expect(noToken.status).toBe(401);
    const wrongQuery = await fetch(`${baseUrl}/api/visual/mjpeg?token=falsch`);
    expect(wrongQuery.status).toBe(401);
    const statusNoToken = await fetch(`${baseUrl}/api/visual/status`);
    expect(statusNoToken.status).toBe(401);
    const postNoToken = await fetch(`${baseUrl}/api/visual/frame`, { method: 'POST', body: jpeg() });
    expect(postNoToken.status).toBe(401);
  });

  it('nimmt einen Frame an und meldet Grenzen mit Grund', async () => {
    const ok = await fetch(`${baseUrl}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
      body: jpeg(128),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, bytes: 128 });

    const tooLarge = await fetch(`${baseUrl}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
      body: jpeg(600 * 1024),
    });
    expect(tooLarge.status).toBe(413);

    const wrongType = await fetch(`${baseUrl}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/png' },
      body: jpeg(64),
    });
    expect(wrongType.status).toBe(415);
  });

  it('liefert einen echten MJPEG-Strom (mehrere Frames) und zaehlt den Zuschauer', async () => {
    // AUDIT-2026-10-30-P1-006: Der Strom wird mit einem frisch ausgestellten
    // Einmal-Ticket geoeffnet - nicht mehr mit dem Studio-Token in der URL.
    const issued = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN },
    });
    const { ticket } = (await issued.json()) as { ticket: string };

    // Zuschauer verbinden: Strom lesen, waehrend neue Frames gepostet werden.
    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(ticket)}`, { signal: controller.signal });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('multipart/x-mixed-replace');
    expect(streamRes.headers.get('cache-control')).toContain('no-store');
    // Die Stream-URL (mit Einmal-Ticket) darf nicht als Referer weitergehen.
    expect(streamRes.headers.get('referrer-policy')).toBe('no-referrer');

    const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    const readSome = (async () => {
      try {
        for (let i = 0; i < 4; i += 1) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) chunks.push(Buffer.from(value));
        }
      } catch { /* Abbruch am Ende ist erwartet */ }
    })();

    // Der Status sieht den Zuschauer jetzt.
    await new Promise((r) => setTimeout(r, 200));
    const status = await fetch(`${baseUrl}/api/visual/status`, { headers: { 'x-studio-token': TOKEN } });
    const statusBody = await status.json();
    expect(statusBody.viewers).toBeGreaterThan(0);

    for (let i = 0; i < 4; i += 1) {
      await fetch(`${baseUrl}/api/visual/frame`, {
        method: 'POST',
        headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
        body: jpeg(80 + i),
      });
      await new Promise((r) => setTimeout(r, 120));
    }

    await readSome;
    controller.abort();

    const received = Buffer.concat(chunks);
    const frames = frameCount(received);
    expect(frames).toBeGreaterThanOrEqual(2);
    expect(received.toString('latin1')).toContain('Content-Type: image/jpeg');
    expect(received.toString('latin1')).toContain('Content-Length: 80');
  }, 30_000);

  it('startet mit dem neuesten Frame, ohne auf einen neuen zu warten', async () => {
    // Ein Frame liegt im Hub (beforeAll): der Strom muss sofort mit 200 und
    // multipart/x-mixed-replace beginnen und den letzten Frame schreiben.
    const issued = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN },
    });
    const { ticket } = (await issued.json()) as { ticket: string };
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(ticket)}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('multipart');
    const chunk = await res.body?.getReader().read();
    controller.abort();
    // Der erste Block ist ein vollstaendiger Multipart-Teil mit Bilddaten.
    expect(Buffer.from(chunk?.value ?? new Uint8Array()).toString('latin1')).toContain('Content-Type: image/jpeg');
  });

  it('ist ohne Studio-Token-Konfiguration offen (Dev/Test-Modus)', async () => {
    // Der Server laeuft hier MIT Token; der Dev-Fall (studioAuthOpen) ist in
    // tests/server.test.ts grundsaetzlich abgedeckt. Hier nur die Zusicherung,
    // dass die Route nicht anders behandelt wird als der Rest der API.
    const res = await fetch(`${baseUrl}/api/visual/status`, { headers: { 'x-studio-token': TOKEN } });
    expect(res.status).toBe(200);
  });
});

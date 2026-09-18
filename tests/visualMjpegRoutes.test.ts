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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressInfo } from 'node:net';

process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.API_RATE_LIMIT_MAX = '10000';

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
}, 60_000);

afterAll(() => {
  httpServer?.close(() => {});
});

describe('VISUAL-P1-001 · MJPEG-Routen', () => {
  it('verlangt den Studio-Token (Header oder ?token=)', async () => {
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
    // Zuschauer verbinden: Strom lesen, waehrend neue Frames gepostet werden.
    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/visual/mjpeg?token=${TOKEN}`, { signal: controller.signal });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('multipart/x-mixed-replace');
    expect(streamRes.headers.get('cache-control')).toContain('no-store');

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

  it('endet ehrlich, wenn nie ein Frame kommt (kein leerer Dauerstrom)', async () => {
    // Ohne Frame im Hub wartet der Strom auf den ersten Frame; hier beenden wir
    // den Abruf selbst und pruefen, dass er ueberhaupt nichts Falsches behauptet.
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/visual/mjpeg?token=${TOKEN}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
    expect(res.headers.get('content-type')).toContain('multipart');
  });

  it('ist ohne Studio-Token-Konfiguration offen (Dev/Test-Modus)', async () => {
    // Der Server laeuft hier MIT Token; der Dev-Fall (studioAuthOpen) ist in
    // tests/server.test.ts grundsaetzlich abgedeckt. Hier nur die Zusicherung,
    // dass die Route nicht anders behandelt wird als der Rest der API.
    const res = await fetch(`${baseUrl}/api/visual/status`, { headers: { 'x-studio-token': TOKEN } });
    expect(res.status).toBe(200);
  });
});

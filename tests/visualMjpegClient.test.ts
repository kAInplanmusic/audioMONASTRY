import { describe, expect, it, vi } from 'vitest';
import {
  createFallbackPublisher,
  mjpegStreamUrl,
  shouldPublishFrame,
  studioTokenFromCookie,
} from '../src/utils/visualMjpeg';

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
  it('baut die Stream-URL mit Token (fuer <img>)', () => {
    expect(mjpegStreamUrl('abc')).toBe('/api/visual/mjpeg?token=abc');
    expect(mjpegStreamUrl('a b')).toBe('/api/visual/mjpeg?token=a%20b');
    expect(mjpegStreamUrl('')).toBe('/api/visual/mjpeg');
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

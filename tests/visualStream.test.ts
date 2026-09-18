import { describe, expect, it, vi } from 'vitest';
import {
  MAX_FRAME_BYTES,
  VisualFrameHub,
  mjpegHeaders,
  mjpegPart,
  parseMjpegStream,
  tokenFromUrl,
} from '../server/visualStream';

/**
 * VISUAL-P1-001 · MJPEG-Fallback (Hub + Rahmen)
 * =====================================================================
 * Der Hub entscheidet, was der Beamer bekommt. Drei Eigenschaften sind wichtig
 * genug fuer eigene Tests:
 *   1. Grenzen greifen (Groesse, Frequenz, Typ) und melden einen GRUND,
 *   2. es wird verworfen, nicht gestaut (Live-Bild: der naechste Frame zaehlt),
 *   3. die Multipart-Rahmen sind exakt (sonst rendert kein Browser).
 */

const jpeg = (size = 32) => Buffer.alloc(size, 7);

describe('VISUAL-P1-001 · Frame-Hub', () => {
  it('nimmt gueltige JPEG/WebP-Frames an und behaelt den neuesten', () => {
    let now = 1000;
    const hub = new VisualFrameHub({ maxFps: 10, now: () => now });
    const first = hub.publish(jpeg(10), 'image/jpeg');
    now = 2000;
    const second = hub.publish(jpeg(20), 'image/webp');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(hub.latest?.data.length).toBe(20);
    expect(hub.latest?.contentType).toBe('image/webp');
    hub.reset();
  });

  it('lehnt leere, zu grosse und fremde Frames mit Grund ab', () => {
    const hub = new VisualFrameHub({ maxFps: 10 });
    expect(hub.publish(Buffer.alloc(0), 'image/jpeg')).toEqual({ ok: false, reason: 'empty' });
    expect(hub.publish(jpeg(MAX_FRAME_BYTES + 1), 'image/jpeg')).toEqual({ ok: false, reason: 'too-large' });
    expect(hub.publish(jpeg(10), 'image/png')).toEqual({ ok: false, reason: 'unsupported-type' });
    expect(hub.status().rejected).toMatchObject({ empty: 1, 'too-large': 1, 'unsupported-type': 1 });
    hub.reset();
  });

  it('verwirft zu schnelle Frames statt sie zu stauen', () => {
    let now = 1000;
    const hub = new VisualFrameHub({ maxFps: 10, now: () => now }); // 100 ms Mindestabstand
    expect(hub.publish(jpeg(), 'image/jpeg').ok).toBe(true);
    now = 1050;
    expect(hub.publish(jpeg(), 'image/jpeg')).toEqual({ ok: false, reason: 'too-fast' });
    now = 1110;
    expect(hub.publish(jpeg(), 'image/jpeg').ok).toBe(true);
    // Der verworfene Frame hat den neuesten NICHT ersetzt (keine Warteschlange).
    expect(hub.status().droppedTooFast).toBe(1);
    hub.reset();
  });

  it('verteilt Frames an Zuschauer und zaehlt sie', () => {
    let now = 1000;
    const hub = new VisualFrameHub({ maxFps: 10, now: () => now });
    const seen: number[] = [];
    const off = hub.subscribe((f) => seen.push(f.data.length));
    expect(hub.status().viewers).toBe(1);

    hub.publish(jpeg(11), 'image/jpeg');
    now = 2000;
    hub.publish(jpeg(12), 'image/jpeg');
    expect(seen).toEqual([11, 12]);

    off();
    now = 3000;
    hub.publish(jpeg(13), 'image/jpeg');
    expect(seen).toEqual([11, 12]);
    expect(hub.status().viewers).toBe(0);
    hub.reset();
  });

  it('laesst einen kaputten Zuschauer den Hub nicht stoppen', () => {
    const hub = new VisualFrameHub({ maxFps: 100 });
    const good = vi.fn();
    hub.subscribe(() => { throw new Error('Zuschauer kaputt'); });
    hub.subscribe(good);
    expect(hub.publish(jpeg(), 'image/jpeg').ok).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
    hub.reset();
  });
});

describe('VISUAL-P1-001 · Multipart-Rahmen', () => {
  it('baut einen exakten multipart/x-mixed-replace-Rahmen', () => {
    const frame = { data: jpeg(5), contentType: 'image/jpeg', at: 0 };
    const part = mjpegPart(frame, 'testboundary').toString('latin1');
    expect(part).toBe('--testboundary\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\n\r\n' + frame.data.toString('latin1') + '\r\n');

    const headers = mjpegHeaders();
    expect(headers['Content-Type']).toBe('multipart/x-mixed-replace; boundary=audiomonastryframe');
    expect(headers['Cache-Control']).toContain('no-store');
  });

  it('liest einen erzeugten Strom wieder in Frames zurueck (Round-Trip)', () => {
    let now = 1000;
    const hub = new VisualFrameHub({ maxFps: 100, now: () => now });
    hub.publish(Buffer.from('AAA'), 'image/jpeg');
    now = 2000;
    hub.publish(Buffer.from('BBBBB'), 'image/webp');

    const stream = Buffer.concat([mjpegPart(hub.latest as never), mjpegPart({ data: Buffer.from('BBBBB'), contentType: 'image/webp', at: 0 })]);
    const frames = parseMjpegStream(stream);
    expect(frames.map((f) => f.data.toString())).toEqual(['BBBBB', 'BBBBB']);
    expect(frames[1].contentType).toBe('image/webp');
    hub.reset();
  });

  it('liest den Token aus der URL (nur fuer den <img>-Fall)', () => {
    expect(tokenFromUrl({ url: '/api/visual/mjpeg?token=abc' })).toBe('abc');
    expect(tokenFromUrl({ url: '/api/visual/mjpeg?x=1&token=a%20b' })).toBe('a b');
    expect(tokenFromUrl({ url: '/api/visual/mjpeg' })).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import {
  encodeOscMessage, encodeOscBundle, decodeOscPacket, decodeOscMessage,
  ntpTimetag, timetagToMs, parseControlAddress,
} from '../src/core/hardware/oscCodec';

describe('OSC-Message-Codec', () => {
  it('rundet Adresse + int/float/string-Argumente', () => {
    const bytes = encodeOscMessage('/control/cc/21', [
      { type: 'f', value: 0.75 },
      { type: 'i', value: 3 },
      { type: 's', value: 'ok' },
    ]);
    expect(bytes.length % 4).toBe(0);
    const msg = decodeOscMessage(bytes);
    expect(msg.address).toBe('/control/cc/21');
    expect(msg.args).toHaveLength(3);
    expect(msg.args[0]).toEqual({ type: 'f', value: expect.closeTo(0.75, 5) });
    expect(msg.args[1]).toEqual({ type: 'i', value: 3 });
    expect(msg.args[2]).toEqual({ type: 's', value: 'ok' });
  });

  it('unterstützt T/F/N/I ohne Payload', () => {
    const msg = decodeOscMessage(encodeOscMessage('/test', [
      { type: 'T', value: null },
      { type: 'F', value: null },
      { type: 'N', value: null },
    ]));
    expect(msg.args.map((a) => a.type)).toEqual(['T', 'F', 'N']);
  });

  it('dekodiert Bundles mit Timetag und Elementen', () => {
    const m1 = encodeOscMessage('/a', [{ type: 'i', value: 1 }]);
    const m2 = encodeOscMessage('/b', [{ type: 'i', value: 2 }]);
    const bundle = encodeOscBundle(0x83aa7e80, 0, [
      { kind: 'message', address: '/a', args: [{ type: 'i', value: 1 }] },
      { kind: 'message', address: '/b', args: [{ type: 'i', value: 2 }] },
    ]);
    const decoded = decodeOscPacket(bundle);
    expect(decoded.kind).toBe('bundle');
    if (decoded.kind === 'bundle') {
      expect(decoded.timetag.seconds).toBe(0x83aa7e80);
      expect(decoded.elements).toHaveLength(2);
      expect(decodeOscMessage(m1).address).toBe('/a');
      expect(decodeOscMessage(m2).address).toBe('/b');
    }
  });
});

describe('OSC-Timetags', () => {
  it('konvertiert Date.now() ↔ NTP und zurück (Genauigkeit ±1 ms)', () => {
    const now = Date.now();
    const tag = ntpTimetag(now);
    expect(tag.seconds).toBeGreaterThan(0);
    expect(Math.abs(timetagToMs(tag.seconds, tag.fraction) - now)).toBeLessThanOrEqual(1);
  });
});

describe('OSC-Control-Adressen', () => {
  it('parst /control/<kind>/<id>/<value>/<channel>', () => {
    expect(parseControlAddress('/control/cc/21/64/1')).toEqual({ kind: 'cc', id: 21, value: 64, channel: 1 });
    expect(parseControlAddress('/control/noteon/60/100')).toEqual({ kind: 'noteon', id: 60, value: 100, channel: 1 });
    expect(parseControlAddress('/nope')).toBeNull();
  });
});

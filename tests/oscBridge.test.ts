import { describe, expect, it } from 'vitest';
import {
  oscMessageToControlEvents, controlEventToOsc, midiBytesToBridgeOsc,
} from '../src/core/hardware/oscBridge';
import { decodeOscMessage, encodeOscMessage } from '../src/core/hardware/oscCodec';

describe('OSC-Bridge: OSC → ControlEvent', () => {
  it('übersetzt /control/cc/<id> in ein CC-ControlEvent', () => {
    const msg = decodeOscMessage(encodeOscMessage('/control/cc/21', [{ type: 'f', value: 64 }, { type: 'i', value: 1 }]));
    const events = oscMessageToControlEvents(msg, 'osc:9000');
    expect(events).toHaveLength(1);
    expect(events[0].sourceProtocol).toBe('osc');
    expect(events[0].parameter).toBe(21);
    expect(events[0].value).toBe(64);
    expect(events[0].channel).toBe(1);
  });

  it('übersetzt /midi/cc/<channel>/<cc> (midi-bridge-Konvention)', () => {
    const msg = decodeOscMessage(encodeOscMessage('/midi/cc/2/7', [{ type: 'f', value: 0.5 }]));
    const events = oscMessageToControlEvents(msg, 'bridge');
    expect(events).toHaveLength(1);
    expect(events[0].parameter).toBe(7);
    expect(events[0].channel).toBe(3); // Kanal 2 (0-basiert) → 3 (1-basiert)
    expect(events[0].value).toBeCloseTo(64);
  });

  it('übersetzt /midi/note/<channel> mit Note + Velocity', () => {
    const msg = decodeOscMessage(encodeOscMessage('/midi/note/0', [{ type: 'i', value: 60 }, { type: 'f', value: 1 }]));
    const events = oscMessageToControlEvents(msg, 'bridge');
    expect(events).toHaveLength(1);
    expect(events[0].messageType).toBe('noteOn');
    expect(events[0].parameter).toBe(60);
  });
});

describe('OSC-Bridge: ControlEvent → OSC', () => {
  it('erzeugt eine OSC-Message aus einem ControlEvent', () => {
    const ev = {
      sourceDevice: 'x', sourceProtocol: 'midi' as const, channel: 1,
      parameter: 21, value: 64, resolution: 127, messageType: 'cc' as const, timestamp: 0,
    };
    const osc = controlEventToOsc(ev);
    expect(osc.address).toBe('/control/cc/21');
    expect(osc.args[0]).toEqual({ type: 'f', value: 64 });
    expect(osc.args[1]).toEqual({ type: 'i', value: 1 });
  });
});

describe('OSC-Bridge: MIDI → OSC (Sidecar-Konvention)', () => {
  it('mappt CC, Note On und Pitch Bend', () => {
    expect(midiBytesToBridgeOsc([0xb2, 7, 64])).toEqual([
      { kind: 'message', address: '/midi/cc/2/7', args: [{ type: 'f', value: 64 / 127 }] },
    ]);
    expect(midiBytesToBridgeOsc([0x90, 60, 100])).toEqual([
      { kind: 'message', address: '/midi/note/0', args: [{ type: 'i', value: 60 }, { type: 'f', value: 100 / 127 }] },
    ]);
    expect(midiBytesToBridgeOsc([0xe0, 0, 64])).toEqual([
      { kind: 'message', address: '/midi/pitchbend/0', args: [{ type: 'f', value: 8192 / 16383 }] },
    ]);
  });
});

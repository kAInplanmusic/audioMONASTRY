import { describe, expect, it } from 'vitest';
import { TranslationLayer } from '../src/core/hardware/translationLayer';
import { decodeOscPacket, encodeOscMessage } from '../src/core/hardware/oscCodec';
import { MidiStreamParser } from '../src/core/hardware/midiCodec';
import type { ControlEvent } from '../src/core/interfaces';

const midiEv = (): ControlEvent => ({
  sourceDevice: 'midi-port', sourceProtocol: 'midi', channel: 1,
  parameter: 21, value: 64, resolution: 127, messageType: 'cc', timestamp: 0,
});

describe('TranslationLayer', () => {
  it('MIDI → OSC erzeugt ein dekodierbares OSC-Paket', () => {
    const layer = new TranslationLayer();
    layer.addRule('midi', 'osc');
    const result = layer.translate(midiEv());

    expect(result.matchedRules).toEqual(['midi->osc']);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].sourceProtocol).toBe('osc');
    expect(result.osc).toBeDefined();

    const packet = decodeOscPacket(result.osc!);
    expect(packet.kind).toBe('bundle');
    if (packet.kind === 'bundle') {
      const msg = packet.elements[0];
      if (msg.kind === 'message') {
        expect(msg.address).toBe('/control/cc/21');
      }
    }
  });

  it('OSC → MIDI (fromOsc) übersetzt in ControlEvents', () => {
    const layer = new TranslationLayer();
    const packet = encodeOscMessage('/control/cc/21', [{ type: 'f', value: 64 }, { type: 'i', value: 1 }]);
    const events = layer.fromOsc(packet, 'osc:9000');
    expect(events).toHaveLength(1);
    expect(events[0].sourceProtocol).toBe('osc');
    expect(events[0].parameter).toBe(21);
  });

  it('HID → MIDI erzeugt gültige MIDI-Bytes', () => {
    const layer = new TranslationLayer();
    layer.addRule('hid', 'midi');
    const hidEv: ControlEvent = {
      ...midiEv(),
      sourceProtocol: 'hid',
      parameter: (0x01 << 16) | 0x30, // Generic Desktop X
      resolution: 1023,
      value: 512,
    };
    const result = layer.translate(hidEv);
    expect(result.midi).toBeDefined();
    expect(result.midi?.[0] & 0xf0).toBe(0xb0); // CC
    const parsed = new MidiStreamParser().push(result.midi!);
    expect(parsed.some((e) => e.type === 'cc')).toBe(true);
  });

  it('isoliert Kodierungsfehler (kein Wurf)', () => {
    const layer = new TranslationLayer();
    layer.addRule('midi', 'osc');
    const broken: ControlEvent = {
      sourceDevice: 'x', sourceProtocol: 'midi', channel: 0,
      parameter: 21, value: Number.NaN, resolution: 127,
      messageType: 'cc', timestamp: 0,
    };
    const result = layer.translate(broken);
    expect(result.matchedRules).toEqual(['midi->osc']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  controlMessageToEvent, eventToControlMessage, normalizeControlValue,
} from '../src/core/hardware/controlEvent';

describe('ControlEvent-Konvertierung', () => {
  it('wandelt ControlMessage (MIDI CC) in ein ControlEvent', () => {
    const ev = controlMessageToEvent(
      { kind: 'cc', idNum: 21, value: 64, channel: 1 },
      'port-1',
      'midi',
    );
    expect(ev.sourceDevice).toBe('port-1');
    expect(ev.sourceProtocol).toBe('midi');
    expect(ev.parameter).toBe(21);
    expect(ev.value).toBe(64);
    expect(ev.resolution).toBe(127);
    expect(ev.messageType).toBe('cc');
    expect(ev.timestamp).toBeGreaterThanOrEqual(0);
  });

  it('nutzt 14-Bit-Auflösung für Pitch/RPN/NRPN', () => {
    expect(controlMessageToEvent({ kind: 'pitch', idNum: 0, value: 8192, channel: 1 }, 'p').resolution).toBe(16383);
    expect(controlMessageToEvent({ kind: 'nrpn', idNum: 5, value: 100, channel: 2 }, 'p').resolution).toBe(16383);
  });

  it('skaliert 14-Bit-Werte beim Rückweg auf 7 Bit', () => {
    const msg = eventToControlMessage({
      sourceDevice: 'p', sourceProtocol: 'midi', channel: 1,
      parameter: 0, value: 16383, resolution: 16383,
      messageType: 'pitch', timestamp: 0,
    });
    expect(msg.value).toBe(127);
  });

  it('normalisiert Werte sauber auf 0..1', () => {
    expect(normalizeControlValue(64, 127)).toBeCloseTo(64 / 127);
    expect(normalizeControlValue(16383, 16383)).toBe(1);
    expect(normalizeControlValue(-5, 127)).toBe(0);
    expect(normalizeControlValue(200, 127)).toBe(1);
    expect(normalizeControlValue(50, 0)).toBe(0);
  });
});

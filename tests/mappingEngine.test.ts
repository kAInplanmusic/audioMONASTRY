import { describe, expect, it } from 'vitest';
import { MappingEngine, ruleMatches } from '../src/core/mapping/MappingEngine';
import type { ControlEvent } from '../src/core/interfaces';

const ev = (over: Partial<ControlEvent> = {}): ControlEvent => ({
  sourceDevice: 'dev-1',
  sourceProtocol: 'midi',
  channel: 1,
  parameter: 21,
  value: 64,
  resolution: 127,
  messageType: 'cc',
  timestamp: 0,
  ...over,
});

describe('MappingEngine: ruleMatches', () => {
  const rule = { id: 'r1', sourceProtocol: 'midi' as const, parameter: 21, target: 'mixer.volume', kind: 'absolute' as const };

  it('matcht Protokoll + Parameter', () => {
    expect(ruleMatches(rule, ev())).toBe(true);
    expect(ruleMatches(rule, ev({ parameter: 22 }))).toBe(false);
    expect(ruleMatches(rule, ev({ sourceProtocol: 'hid' }))).toBe(false);
  });

  it('filtert nach Gerät und Kanal, wenn gesetzt', () => {
    expect(ruleMatches({ ...rule, sourceDevice: 'dev-1' }, ev())).toBe(true);
    expect(ruleMatches({ ...rule, sourceDevice: 'dev-2' }, ev())).toBe(false);
    expect(ruleMatches({ ...rule, channel: 2 }, ev())).toBe(false);
  });
});

describe('MappingEngine: Semantik-Klassen', () => {
  it('absolute: skaliert 0..127 auf 0..1', () => {
    const e = new MappingEngine();
    e.addRule({ id: 'abs', sourceProtocol: 'midi', parameter: 21, target: 'mixer.volume', kind: 'absolute' });
    const out = e.map(ev({ value: 64 }));
    expect(out[0].value01).toBeCloseTo(64 / 127);
  });

  it('absolute: respektiert min/max-Zielbereich', () => {
    const e = new MappingEngine();
    e.addRule({ id: 'abs', sourceProtocol: 'midi', parameter: 21, target: 'pan', kind: 'absolute', min: -1, max: 1 });
    expect(e.map(ev({ value: 0 }))[0].value01).toBeCloseTo(-1);
    expect(e.map(ev({ value: 127 }))[0].value01).toBeCloseTo(1);
  });

  it('relative: akkumuliert Deltas und klemmt auf 0..1', () => {
    const e = new MappingEngine();
    e.addRule({ id: 'rel', sourceProtocol: 'hid', parameter: 0x00010037, target: 'jog', kind: 'relative', relativeStep: 0.05 });
    expect(e.map(ev({ sourceProtocol: 'hid', parameter: 0x00010037, value: 2, resolution: 127 }))[0].value01).toBeCloseTo(0.1);
    expect(e.map(ev({ sourceProtocol: 'hid', parameter: 0x00010037, value: -1, resolution: 127 }))[0].value01).toBeCloseTo(0.05);
  });

  it('toggle: toggelt zwischen min/max bei steigender Flanke', () => {
    const e = new MappingEngine();
    e.addRule({ id: 'tgl', sourceProtocol: 'midi', parameter: 41, target: 'mute', kind: 'toggle' });
    expect(e.map(ev({ parameter: 41, value: 127 }))[0].value01).toBe(1);
    expect(e.map(ev({ parameter: 41, value: 0 }))[0].value01).toBe(1); // fallende Flanke ändert nichts
    expect(e.map(ev({ parameter: 41, value: 127 }))[0].value01).toBe(0);
  });

  it('momentary: gedrückt = max, losgelassen = min', () => {
    const e = new MappingEngine();
    e.addRule({ id: 'mom', sourceProtocol: 'midi', parameter: 42, target: 'solo', kind: 'momentary' });
    expect(e.map(ev({ parameter: 42, value: 127 }))[0].value01).toBe(1);
    expect(e.map(ev({ parameter: 42, value: 0 }))[0].value01).toBe(0);
  });

  it('liefert mehrere Treffer (Layer-Mappings)', () => {
    const e = new MappingEngine();
    e.addRule({ id: 'a', sourceProtocol: 'midi', parameter: 21, target: 'a.vol', kind: 'absolute' });
    e.addRule({ id: 'b', sourceProtocol: 'midi', parameter: 21, target: 'b.vol', kind: 'absolute' });
    const out = e.map(ev());
    expect(out.map((o) => o.target)).toEqual(['a.vol', 'b.vol']);
  });
});

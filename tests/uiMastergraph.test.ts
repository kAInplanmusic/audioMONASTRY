import { describe, expect, it } from 'vitest';
import { lufsLabel, transportReadout } from '../src/components/MastergraphReadout';

// UI2-P1-002: Mastergraph ist reine Ansicht - Zeit, Takt.Schlag, LUFS.
describe('transportReadout', () => {
  it('startet bei 00:00 auf Takt 1.1', () => {
    expect(transportReadout(0, 128)).toEqual({ time: '00:00', position: '1.1' });
  });

  it('zählt Schläge und Takte im 4/4 aus Tempo und Sekunden', () => {
    // 120 BPM = 2 Schläge/s: 2 s = 4 Schläge = Takt 2, Schlag 1.
    expect(transportReadout(2, 120).position).toBe('2.1');
    expect(transportReadout(2.6, 120).position).toBe('2.2');
    expect(transportReadout(75, 120)).toEqual({ time: '01:15', position: '38.3' });
  });

  it('ist robust gegen ungültige Werte', () => {
    expect(transportReadout(Number.NaN, 128)).toEqual({ time: '00:00', position: '1.1' });
    expect(transportReadout(-3, 0).position).toBe('1.1');
  });
});

describe('lufsLabel', () => {
  it('zeigt Messwerte mit einer Nachkommastelle', () => {
    expect(lufsLabel(-14.04)).toBe('-14.0');
  });
  it('zeigt Stille und fehlende Messung als Strich', () => {
    expect(lufsLabel(0)).toBe('—');
    expect(lufsLabel(-90)).toBe('—');
    expect(lufsLabel(Number.NaN)).toBe('—');
  });
});

import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_CANVAS_DEFS, canvasDefForInstrument, hitZone, zoneNote,
} from '../src/core/instrument/canvasDefs';

describe('Instrument-Canvas-Definitionen', () => {
  it('liefert für Gitarre/Kalimba/Theremin/Drums passende Defs', () => {
    expect(canvasDefForInstrument('Acoustic Guitar (Nylon)')?.kind).toBe('guitar');
    expect(canvasDefForInstrument('Kalimba')?.kind).toBe('hang');
    expect(canvasDefForInstrument('Theremin')?.kind).toBe('theremin');
    expect(canvasDefForInstrument('808 Kick')?.kind).toBe('drums');
    expect(canvasDefForInstrument('Unbekanntes')).toBeUndefined();
  });

  it('Gitarre: 6 Saiten × 5 Bünde mit chromatisch steigenden Noten', () => {
    const def = canvasDefForInstrument('Guitar')!;
    expect(def.zones).toHaveLength(30);
    expect(def.zones[0].midiNote).toBe(64); // E4
    expect(def.zones[5].midiNote).toBe(59); // nächste Saite (B3? Standard: 59 = B3)
  });

  it('Theremin: X-Position → dynamische Note 36..84', () => {
    const def = canvasDefForInstrument('Theremin')!;
    const zone = def.zones[0];
    expect(zone.midiNote).toBeNull();
    expect(zoneNote(zone, 0)).toBe(36);
    expect(zoneNote(zone, 0.5)).toBe(60);
    expect(zoneNote(zone, 1)).toBe(84);
  });

  it('hitZone findet Zonen an relativen Positionen', () => {
    const def = canvasDefForInstrument('Drums')!;
    expect(hitZone(def, 0.1, 0.1)?.id).toBe('drum-0');
    expect(hitZone(def, 0.9, 0.9)?.id).toBe('drum-7');
    expect(hitZone(def, -0.1, 0.5)).toBeUndefined();
  });

  it('alle Defs haben vollständige Zonen mit gültigen Bounds', () => {
    for (const def of INSTRUMENT_CANVAS_DEFS) {
      expect(def.zones.length).toBeGreaterThan(0);
      for (const z of def.zones) {
        expect(z.x).toBeGreaterThanOrEqual(0);
        expect(z.y).toBeGreaterThanOrEqual(0);
        expect(z.x + z.w).toBeLessThanOrEqual(1.0001);
        expect(z.y + z.h).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});

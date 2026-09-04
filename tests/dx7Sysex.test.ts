import { describe, expect, it } from 'vitest';
import { DX7_UNPACKED_SIZE, dx7RoundtripStable, dx7SysexToPatch, patchToDx7Sysex } from '../src/core/instrument/dx7Sysex';
import { DX7_REFERENCE_PATCHES } from '../src/core/instrument/dx7Presets';

describe('DX7-SysEx (unpacked 156-Byte, Import/Export)', () => {
  it('erzeugt exakt 156 Bytes je Referenz-Patch', () => {
    for (const patch of DX7_REFERENCE_PATCHES) {
      expect(patchToDx7Sysex(patch).length).toBe(DX7_UNPACKED_SIZE);
    }
  });

  it('Roundtrip: Algorithmus + Feedback bleiben stabil', () => {
    for (const patch of DX7_REFERENCE_PATCHES) {
      expect(dx7RoundtripStable(patch)).toBe(true);
    }
  });

  it('Roundtrip erhält Operator-Level/Raten (quantisiert auf 0..127)', () => {
    const bytes = patchToDx7Sysex(DX7_REFERENCE_PATCHES[0]);
    const back = dx7SysexToPatch(bytes);
    expect(back.operators).toHaveLength(6);
    expect(back.operators[0].level).toBeGreaterThan(0.5);
    expect(back.operators[0].rates[0]).toBe(95);
    expect(back.lfo.speedHz).toBe(0);
  });

  it('zu kurze SysEx wird kontrolliert abgelehnt', () => {
    expect(() => dx7SysexToPatch(new Uint8Array(10))).toThrow(/zu kurz/);
  });
});

import { describe, expect, it } from 'vitest';
import { validateRouting } from '../src/utils/routingValidator';

const baseConfig = {
  tracks: [
    { id: 'channel1', instrument: 'kickSynth' },
    { id: 'channel7', instrument: 'bassSynth' },
  ],
  buses: [{ id: 'bus-a', effects: [{ type: 'eq' }] }],
  connections: [{ source: 'channel1', destination: 'bus-a' }],
};

describe('validateRouting', () => {
  it('akzeptiert gültige Konfigurationen', () => {
    expect(validateRouting(baseConfig)).toBe(true);
  });

  it('erkennt ungültige Effekt-Typen', () => {
    const bad = {
      ...baseConfig,
      buses: [{ id: 'bus-a', effects: [{ type: '' }] }],
    };
    expect(validateRouting(bad)).toBe(false);
  });

  it('erkennt ungültige Quellen', () => {
    const bad = {
      ...baseConfig,
      connections: [{ source: 'unbekannt', destination: 'bus-a' }],
    };
    expect(validateRouting(bad)).toBe(false);
  });

  it('erkennt ungültige Ziele', () => {
    const bad = {
      ...baseConfig,
      connections: [{ source: 'channel1', destination: 'nirgendwo' }],
    };
    expect(validateRouting(bad)).toBe(false);
  });
});

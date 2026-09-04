import { describe, expect, it } from 'vitest';
import { validateRouting } from '../src/utils/routingValidator';
import { findUnusedGraphPaths, validateRoutingAgainstGraph } from '../src/core/routing/validateRouting';

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

describe('P2-4: validateRoutingAgainstGraph (routing.json vs. Audio-Graph)', () => {
  const graph = {
    nodes: [
      { id: 'channel1' },
      { id: 'channel7' },
      { id: 'bus-a' },
      { id: 'masterBus' },
    ],
    connections: [
      { source: 'channel1', target: 'bus-a' },
      { source: 'channel7', target: 'masterBus' },
    ],
  };

  it('akzeptiert übereinstimmende routing.json und Graph', () => {
    const routing = {
      nodes: [{ id: 'channel1' }, { id: 'bus-a' }],
      connections: [{ source: 'channel1', target: 'bus-a' }],
    };
    expect(validateRoutingAgainstGraph(routing, graph)).toEqual([]);
  });

  it('findet im Graph fehlende Nodes und Verbindungen', () => {
    const routing = {
      nodes: [{ id: 'channel1' }, { id: 'ghost-node' }],
      connections: [
        { source: 'channel1', target: 'bus-a' },
        { source: 'channel1', target: 'nicht-verbunden' },
      ],
    };
    const errors = validateRoutingAgainstGraph(routing, graph);
    expect(errors).toContain("routing node 'ghost-node' fehlt im Audio-Graph");
    expect(errors).toContain("routing connection 'channel1->nicht-verbunden' fehlt im Audio-Graph");
  });

  it('erkennt doppelte Verbindungen (kein doppelter Pfad)', () => {
    const routing = {
      nodes: [{ id: 'channel1' }, { id: 'bus-a' }],
      connections: [
        { source: 'channel1', target: 'bus-a' },
        { source: 'channel1', target: 'bus-a' },
      ],
    };
    expect(validateRoutingAgainstGraph(routing, graph)).toContain("doppelte Verbindung 'channel1->bus-a' in routing.json");
  });
});

describe('P2-4: findUnusedGraphPaths (kein ungenutzter/doppelter Pfad)', () => {
  it('meldet nichts für einen sauber verdrahteten Graph', () => {
    expect(
      findUnusedGraphPaths({
        nodes: [{ id: 'channel1' }, { id: 'bus-a' }, { id: 'masterBus' }],
        connections: [
          { source: 'channel1', target: 'bus-a' },
          { source: 'bus-a', target: 'masterBus' },
        ],
      }),
    ).toEqual([]);
  });

  it('erkennt ungenutzte Nodes, unbekannte Endpunkte und doppelte Pfade', () => {
    const problems = findUnusedGraphPaths({
      nodes: [{ id: 'channel1' }, { id: 'bus-a' }, { id: 'waise' }],
      connections: [
        { source: 'channel1', target: 'bus-a' },
        { source: 'channel1', target: 'bus-a' },
        { source: 'channel1', target: 'unbekannt' },
      ],
    });
    expect(problems).toContain("doppelter Verbindungs-Pfad 'channel1->bus-a' im Audio-Graph");
    expect(problems).toContain("Verbindung 'channel1->unbekannt' zeigt auf unbekannten Ziel-Node 'unbekannt'");
    expect(problems).toContain("ungenutzter Node 'waise' im Audio-Graph (keine Verbindung)");
  });
});

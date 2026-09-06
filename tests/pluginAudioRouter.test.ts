import { describe, expect, it, vi } from 'vitest';

// P0-2-Test: audioEngine wird gemockt, damit der Router-Test ohne AudioContext
// (jsdom) lauffähig ist – die echte Engine ist in audioEngine.test.ts abgedeckt.
const engineSpies = vi.hoisted(() => ({
  activate: vi.fn(),
  deactivate: vi.fn(),
}));

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    activatePlugin: engineSpies.activate,
    deactivatePlugin: engineSpies.deactivate,
  },
  pluginAudioChannels: (id: string) => {
    const map: Record<string, string[]> = {
      ai: [], controller: [], library: [], mastering: [],
      stem: [], recording: [], performance: [],
      spatial: ['channel7'], mixer: ['channel1'], mcp: ['channel5'],
      drum: ['channel2'], sampler: ['channel5'], synthesizer: ['channel4'],
      instrument: ['channel4'], voice: ['channel8'], sound: ['channel9'],
      drop: ['channel10'], effect: ['channel6'], eq: ['channel6'], dsp: ['channel6'],
    };
    return (map[id] ?? []) as never;
  },
}));

import {
  PLUGIN_ROUTE_IDS,
  assertAllPluginIdsRegistered,
  getPluginRoute,
  listPluginRoutes,
  routeModuleState,
  validateRoutingMatrix,
} from '../src/core/pluginAudioRouter';

describe('pluginAudioRouter (P0-2)', () => {
  it('registriert alle 21 Plugin-IDs', () => {
    expect(PLUGIN_ROUTE_IDS).toHaveLength(21);
    expect(listPluginRoutes()).toHaveLength(21);
    const expected = [
      'mixer', 'drop', 'song', 'effect', 'instrument', 'sampler', 'drum', 'mcp',
      'synthesizer', 'stem', 'voice', 'sound', 'spatial', 'library', 'eq',
      'dsp', 'mastering', 'recording', 'controller', 'performance', 'ai',
    ];
    expect(assertAllPluginIdsRegistered(expected)).toEqual([]);
  });

  it('liefert Routing-Infos für bekannte IDs und ignoriert unbekannte', () => {
    expect(getPluginRoute('synthesizer')?.mainFeeder).toBe(true);
    expect(getPluginRoute('masterplayer')).toBeUndefined();
    expect(assertAllPluginIdsRegistered(['kaputt'])).toEqual(['kaputt']);
  });

  it('OFF deaktiviert Audio, AUTO_AI/PRO aktiviert Audio (audioEngine-Verdrahtung)', () => {
    routeModuleState('mcp', 'AUTO_AI');
    expect(engineSpies.activate).toHaveBeenCalledWith('mcp', 'AUTO_AI');
    routeModuleState('mcp', 'PRO');
    expect(engineSpies.activate).toHaveBeenCalledWith('mcp', 'PRO');
    routeModuleState('mcp', 'OFF');
    expect(engineSpies.deactivate).toHaveBeenCalledWith('mcp');
  });

  it('aktiviert/deaktiviert unbekannte IDs ohne Fehler (nur Log)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      routeModuleState('unbekannt', 'AUTO_AI');
      routeModuleState('unbekannt', 'OFF');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('AM-E2-1: Isolation-Level sind korrekt abgeleitet', () => {
    expect(getPluginRoute('synthesizer')?.isolation).toBe('insert');
    expect(getPluginRoute('mixer')?.isolation).toBe('send');
    expect(getPluginRoute('library')?.isolation).toBe('ui-only');
  });

  it('AM-E2-1: Routing-Matrix validiert alle 21 IDs ohne Verstöße', () => {
    expect(validateRoutingMatrix(PLUGIN_ROUTE_IDS)).toEqual([]);
    expect(validateRoutingMatrix(['kaputt'])).toContain('kaputt: nicht registriert');
  });
});

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
    // ARCH-PLUGIN-001: 16-MONK-Kanalziele (Spiegel der echten pluginChannelMap).
    const map: Record<string, string[]> = {
      ai: [], perfor: [], biblio: [], master: [], stem: [], record: [],
      spatial: ['channel7'], mixer: ['channel1'],
      syntisampler: ['channel4', 'channel5'],
      drumsampler: ['channel2'], instru: ['channel4'],
      voice: ['channel8'], sound: ['channel9'],
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

describe('pluginAudioRouter (P0-2, ARCH-PLUGIN-001)', () => {
  it('registriert exakt 16 MONK-IDs + System-IDs ai/perfor', () => {
    expect(PLUGIN_ROUTE_IDS).toHaveLength(18);
    expect(listPluginRoutes()).toHaveLength(18);
    const expected = [
      'mixer', 'drop', 'song', 'effect', 'syntisampler', 'drumsampler', 'instru', 'biblio',
      'voice', 'sound', 'stem', 'spatial', 'eq', 'dsp', 'master', 'record',
      'ai', 'perfor',
    ];
    expect(assertAllPluginIdsRegistered(expected)).toEqual([]);
  });

  it('liefert Routing-Infos für bekannte IDs und ignoriert unbekannte', () => {
    expect(getPluginRoute('syntisampler')?.mainFeeder).toBe(true);
    expect(getPluginRoute('masterplayer')).toBeUndefined();
    expect(assertAllPluginIdsRegistered(['kaputt'])).toEqual(['kaputt']);
  });

  it('OFF deaktiviert Audio, AUTO_AI/PRO aktiviert Audio (audioEngine-Verdrahtung)', () => {
    routeModuleState('syntisampler', 'AUTO_AI');
    expect(engineSpies.activate).toHaveBeenCalledWith('syntisampler', 'AUTO_AI');
    routeModuleState('syntisampler', 'PRO');
    expect(engineSpies.activate).toHaveBeenCalledWith('syntisampler', 'PRO');
    routeModuleState('syntisampler', 'OFF');
    expect(engineSpies.deactivate).toHaveBeenCalledWith('syntisampler');
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
    expect(getPluginRoute('syntisampler')?.isolation).toBe('insert');
    expect(getPluginRoute('mixer')?.isolation).toBe('send');
    expect(getPluginRoute('biblio')?.isolation).toBe('ui-only');
  });

  it('AM-E2-1: Routing-Matrix validiert alle IDs ohne Verstöße', () => {
    expect(validateRoutingMatrix(PLUGIN_ROUTE_IDS)).toEqual([]);
    expect(validateRoutingMatrix(['kaputt'])).toContain('kaputt: nicht registriert');
  });
});

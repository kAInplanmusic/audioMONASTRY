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
  pluginAudioChannels: (id: string) => (id === 'sequencer' ? ['channel1'] : []),
}));

import {
  PLUGIN_ROUTE_IDS,
  assertAllPluginIdsRegistered,
  getPluginRoute,
  listPluginRoutes,
  routeModuleState,
} from '../src/core/pluginAudioRouter';

describe('pluginAudioRouter (P0-2)', () => {
  it('registriert alle 21 Plugin-IDs', () => {
    expect(PLUGIN_ROUTE_IDS).toHaveLength(21);
    expect(listPluginRoutes()).toHaveLength(21);
    const expected = [
      'masterplayer', 'instrument', 'synthesizer', 'drum', 'sampler', 'sequencer',
      'voice', 'sound', 'mixer', 'controller', 'effect', 'drop', 'library', 'eq',
      'dsp', 'mastering', 'stem', 'spatial', 'recording', 'performance', 'ai',
    ];
    expect(assertAllPluginIdsRegistered(expected)).toEqual([]);
  });

  it('liefert Routing-Infos für bekannte IDs und ignoriert unbekannte', () => {
    expect(getPluginRoute('synthesizer')?.mainFeeder).toBe(true);
    expect(getPluginRoute('masterplayer')?.source).toBe('ui-only');
    expect(assertAllPluginIdsRegistered(['kaputt'])).toEqual(['kaputt']);
  });

  it('OFF deaktiviert Audio, AUTO_AI/PRO aktiviert Audio (audioEngine-Verdrahtung)', () => {
    routeModuleState('sequencer', 'AUTO_AI');
    expect(engineSpies.activate).toHaveBeenCalledWith('sequencer', 'AUTO_AI');
    routeModuleState('sequencer', 'PRO');
    expect(engineSpies.activate).toHaveBeenCalledWith('sequencer', 'PRO');
    routeModuleState('sequencer', 'OFF');
    expect(engineSpies.deactivate).toHaveBeenCalledWith('sequencer');
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
});

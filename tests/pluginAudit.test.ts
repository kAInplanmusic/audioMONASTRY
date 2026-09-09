import { describe, expect, it, vi } from 'vitest';

// GAP-3: Atomarer Plugin-Audit – jede der 16 echten MONK-IDs durchläuft
// Aktivierung → Routing → Deaktivierung. AudioEngine wird gemockt.
// System-IDs (ai/perfor) sind ebenfalls im Router bekannt (State-Sync).
const engineSpies = vi.hoisted(() => ({
  activate: vi.fn(),
  deactivate: vi.fn(),
  stopMainAndClock: vi.fn(),
}));

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    activatePlugin: engineSpies.activate,
    deactivatePlugin: engineSpies.deactivate,
    stopMainAndClock: engineSpies.stopMainAndClock,
  },
  pluginAudioChannels: (id: string) => (id === 'mixer' ? ['channel1'] : id === 'syntisampler' ? ['channel4', 'channel5'] : []),
}));

import { PLUGIN_ROUTE_IDS, routeModuleState } from '../src/core/pluginAudioRouter';

describe('GAP-3: 16-MONK-Audit (Aktivierung → Routing → Deaktivierung)', () => {
  it('alle 16 MONK-IDs + System-IDs (ai/perfor) sind im Router registriert', () => {
    expect(PLUGIN_ROUTE_IDS).toHaveLength(18);
    for (const id of ['mixer', 'drop', 'song', 'effect', 'syntisampler', 'drumsampler', 'instru', 'biblio', 'voice', 'sound', 'stem', 'spatial', 'eq', 'dsp', 'master', 'record', 'ai', 'perfor']) {
      expect(PLUGIN_ROUTE_IDS).toContain(id);
    }
  });

  it('jede MONK-ID kann aktiviert und deaktiviert werden', () => {
    for (const id of PLUGIN_ROUTE_IDS) {
      routeModuleState(id, 'AUTO_AI');
      expect(engineSpies.activate).toHaveBeenCalledWith(id, 'AUTO_AI');
      routeModuleState(id, 'OFF');
      expect(engineSpies.deactivate).toHaveBeenCalledWith(id);
    }
  });

  it('mixerMONK OFF stoppt Main-Ausgabe + MainClock (NEW-D1-2)', () => {
    routeModuleState('mixer', 'OFF');
    expect(engineSpies.stopMainAndClock).toHaveBeenCalled();
  });

  it('andere MONKs lösen keinen MainClock-Stopp aus', () => {
    engineSpies.stopMainAndClock.mockClear();
    routeModuleState('drumsampler', 'OFF');
    expect(engineSpies.stopMainAndClock).not.toHaveBeenCalled();
  });
});

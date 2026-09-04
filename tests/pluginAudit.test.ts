import { describe, expect, it, vi } from 'vitest';

// GAP-3: Atomarer Plugin-Audit – jede der 20 IDs durchläuft
// Aktivierung → Routing → Deaktivierung. AudioEngine wird gemockt.
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
  pluginAudioChannels: (id: string) => (id === 'mixer' ? ['channel1'] : id === 'mcp' ? ['channel5'] : []),
}));

import { PLUGIN_ROUTE_IDS, routeModuleState } from '../src/core/pluginAudioRouter';

describe('GAP-3: 20-Plugin-Audit (Aktivierung → Routing → Deaktivierung)', () => {
  it('alle 20 Plugin-IDs sind im Router registriert', () => {
    expect(PLUGIN_ROUTE_IDS).toHaveLength(20);
  });

  it('jede Plugin-ID kann aktiviert und deaktiviert werden', () => {
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

  it('andere Plugins lösen keinen MainClock-Stopp aus', () => {
    engineSpies.stopMainAndClock.mockClear();
    routeModuleState('drum', 'OFF');
    expect(engineSpies.stopMainAndClock).not.toHaveBeenCalled();
  });
});

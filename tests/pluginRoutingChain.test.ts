// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// pluginAudioRouter zieht die AudioEngine nur fuer Aktivierung und Kanalziele
// heran; im Test wird sie ersetzt (wie in tests/mixerSkins.test.ts).
vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    activatePlugin: () => {},
    deactivatePlugin: () => {},
    stopMainAndClock: () => {},
  },
  pluginAudioChannels: () => ['channel1'],
}));

import { CANONICAL_PLUGIN_IDS } from '../src/plugins/adapters';
import { SIGNAL_CHAIN_ORDER } from '../src/plugins/signalChain';
import {
  PLUGIN_ROUTE_IDS,
  getPluginRoute,
  listRoutesInChainOrder,
  missingChainRoutes,
} from '../src/core/pluginAudioRouter';

describe('pluginAudioRouter × Signalkette', () => {
  it('hat fuer jedes Plugin der Kette eine Route (kein Loch im Pfad)', () => {
    expect(missingChainRoutes()).toEqual([]);
  });

  it('kennt alle 16 kanonischen Plugins', () => {
    for (const id of CANONICAL_PLUGIN_IDS) {
      expect(getPluginRoute(id), `Route fuer ${id}`).toBeDefined();
      expect(PLUGIN_ROUTE_IDS).toContain(id);
    }
  });

  it('liefert die Routen in Signalweg-Reihenfolge', () => {
    expect(listRoutesInChainOrder().map((r) => r.id)).toEqual([...SIGNAL_CHAIN_ORDER]);
  });

  it('ordnet jeder Route Stufe und Position im Signalweg zu', () => {
    expect(getPluginRoute('mixer')?.chainStage).toBe('mixer');
    expect(getPluginRoute('record')?.chainStage).toBe('recorder');
    expect(getPluginRoute('eq')?.chainStage).toBe('processing');
    expect(getPluginRoute('song')?.chainStage).toBe('sources');
    expect(getPluginRoute('record')?.chainIndex).toBeGreaterThan(getPluginRoute('dsp')?.chainIndex ?? -1);
    expect(getPluginRoute('song')?.chainIndex).toBeLessThan(getPluginRoute('mixer')?.chainIndex ?? -1);
  });

  it('haelt System-Module aus der Kette heraus', () => {
    for (const id of ['ai', 'perfor']) {
      const route = getPluginRoute(id);
      expect(route, `Route fuer ${id}`).toBeDefined();
      expect(route?.chainStage).toBeNull();
      expect(route?.chainIndex).toBe(-1);
    }
  });

  it('haelt Isolation und Kettenstufe auseinander (biblio: Quelle, aber ui-only)', () => {
    const biblio = getPluginRoute('biblio');
    expect(biblio?.chainStage).toBe('sources');
    expect(biblio?.isolation).toBe('ui-only');
  });
});

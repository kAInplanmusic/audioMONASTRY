// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: { activatePlugin: vi.fn(), deactivatePlugin: vi.fn() },
  pluginAudioChannels: () => [],
}));

import {
  PLUGIN_COMMAND_CATALOG,
  moaCommandCatalog,
  moaSystemPromptForPlugin,
  moaTaskForPlugin} from '../src/utils/prompts';
import { getPluginRegistry } from '../src/plugins/registry';
import { PLUGIN_ROUTE_IDS } from '../src/core/pluginAudioRouter';

describe('P3-2: Prompt-/Kommando-Katalog für 16 MONKs + System-IDs', () => {
  it('jede Router-ID hat Kommando-Katalog + System-Prompt + Default-Task', () => {
    for (const id of PLUGIN_ROUTE_IDS) {
      expect(PLUGIN_COMMAND_CATALOG[id]).toBeTruthy();
      expect(moaSystemPromptForPlugin(id).length).toBeGreaterThan(20);
      expect(moaTaskForPlugin(id).length).toBeGreaterThan(5);
    }
  });

  it('Registry-IDs (16 MONKs) sind vollständig im Router enthalten (System-IDs zusätzlich)', () => {
    const registryIds = getPluginRegistry().map((p) => p.id).sort();
    expect(registryIds).toHaveLength(16);
    const routeSet = new Set(PLUGIN_ROUTE_IDS);
    for (const id of registryIds) {
      expect(routeSet.has(id)).toBe(true);
    }
  });

  it('Katalog-Text enthält alle Router-IDs', () => {
    const catalog = moaCommandCatalog();
    for (const id of PLUGIN_ROUTE_IDS) {
      expect(catalog).toContain(id);
    }
  });
});

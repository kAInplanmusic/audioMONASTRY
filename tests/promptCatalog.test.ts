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

describe('P3-2: Prompt-/Kommando-Katalog für alle 21 Plugins', () => {
  it('jedes registrierte Plugin hat Kommando-Katalog + System-Prompt + Default-Task', () => {
    for (const id of PLUGIN_ROUTE_IDS) {
      expect(PLUGIN_COMMAND_CATALOG[id] ?? PLUGIN_COMMAND_CATALOG[id === 'synthesizer' ? 'synth' : id] ?? undefined).toBeTruthy();
      expect(moaSystemPromptForPlugin(id).length).toBeGreaterThan(20);
      expect(moaTaskForPlugin(id).length).toBeGreaterThan(5);
    }
  });

  it('Registry-IDs und Plugin-Router-IDs sind deckungsgleich', () => {
    const registryIds = getPluginRegistry().map((p) => p.id).sort();
    expect(registryIds).toEqual([...PLUGIN_ROUTE_IDS].sort());
  });

  it('Katalog-Text enthält alle 21 Plugin-IDs', () => {
    const catalog = moaCommandCatalog();
    for (const id of PLUGIN_ROUTE_IDS) {
      expect(catalog).toContain(id === 'synthesizer' ? 'synthesizer' : id);
    }
  });
});

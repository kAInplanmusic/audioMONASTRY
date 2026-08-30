import { describe, expect, it } from 'vitest';
import { listRegisteredPluginCommands } from '../src/core/voice/pluginCommandRegistry';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';

/** Extrahiert die Aktionsnamen aus dem MOA-Katalog (set_tempo(bpm) → set_tempo). */
function catalogActions(): { pluginId: string; action: string }[] {
  const out: { pluginId: string; action: string }[] = [];
  for (const [pluginId, spec] of Object.entries(PLUGIN_COMMAND_CATALOG)) {
    for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      out.push({ pluginId, action: raw.replace(/\(.*\)/, '') });
    }
  }
  return out;
}

describe('MOA-Kommando-Abdeckung (Audit)', () => {
  it('jeder Katalog-Befehl hat einen registrierten Handler', () => {
    const registered = new Set(listRegisteredPluginCommands().map((c) => `${c.pluginId}:${c.action}`));
    const missing = catalogActions().filter((c) => !registered.has(`${c.pluginId}:${c.action}`));
    expect(missing).toEqual([]);
  });

  it('transport/play/stop und synth/note sind als Plugin-Kommandos registriert', () => {
    const registered = listRegisteredPluginCommands();
    expect(registered).toContainEqual({ pluginId: 'transport', action: 'play' });
    expect(registered).toContainEqual({ pluginId: 'transport', action: 'stop' });
    expect(registered).toContainEqual({ pluginId: 'synth', action: 'note' });
    expect(registered).toContainEqual({ pluginId: 'visualizer', action: 'mode' });
    expect(registered).toContainEqual({ pluginId: 'effect', action: 'automate' });
  });
});

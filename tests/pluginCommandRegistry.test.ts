// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PLUGIN_COMMAND_IDS,
  listRegisteredPluginCommands,
} from '../src/core/voice/pluginCommandRegistry';

describe('P3-2: pluginCommandRegistry deckt 16 MONKs + System-IDs ab', () => {
  it('hat exakt 18 kanonische IDs (16 MONKs + ai/perfor)', () => {
    expect(PLUGIN_COMMAND_IDS).toHaveLength(18);
    expect(new Set(PLUGIN_COMMAND_IDS).size).toBe(18);
  });

  it('registriert für jede Plugin-ID mindestens ein Kommando (inkl. activate/deactivate/route)', () => {
    const commands = listRegisteredPluginCommands();
    const byPlugin = new Map<string, Set<string>>();
    for (const c of commands) {
      if (!byPlugin.has(c.pluginId)) byPlugin.set(c.pluginId, new Set());
      byPlugin.get(c.pluginId)!.add(c.action);
    }
    for (const id of PLUGIN_COMMAND_IDS) {
      const actions = byPlugin.get(id);
      expect(actions, `Plugin ${id} hat keine Kommandos`).toBeDefined();
      expect([...actions!]).toContain('activate');
      expect([...actions!]).toContain('deactivate');
      expect([...actions!]).toContain('route');
    }
  });

  it('hat echte Kern-Kommandos für alle Plugins (kein reines Status-only)', () => {
    const commands = listRegisteredPluginCommands();
    const pluginActions = new Map<string, string[]>();
    for (const c of commands) {
      pluginActions.set(c.pluginId, [...(pluginActions.get(c.pluginId) ?? []), c.action]);
    }
    for (const id of PLUGIN_COMMAND_IDS) {
      const actions = pluginActions.get(id) ?? [];
      const real = actions.filter((a) => !['status', 'route'].includes(a));
      expect(real.length, `Plugin ${id} hat nur Status/Route`).toBeGreaterThan(0);
    }
  });
});

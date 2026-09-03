// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDefaultMcpRuntime } from '../src/core/ai/orchestrator/mcpRuntime';

function createRuntime(recorded: Array<{ pluginId: string; action: string; parameters: Record<string, unknown> }>) {
  return createDefaultMcpRuntime({
    runTask: async () => ({ ok: true }),
    getSessionState: () => ({}),
    searchSamples: () => [],
    getRuntimeStatus: () => ({}),
    loadModel: async () => {},
    unloadModel: async () => {},
    recordPluginCommand: (cmd) => recorded.push(cmd),
  });
}

describe('P3-2: Plugin-MCP-Tools im mcpRuntime', () => {
  it('registriert je Plugin-Katalog-Kommando ein WRITE-Tool', () => {
    const runtime = createRuntime([]);
    const tools = runtime.listTools();
    expect(runtime.hasTool('mixer.gain')).toBe(true);
    expect(runtime.hasTool('synthesizer.note')).toBe(true);
    expect(runtime.hasTool('drum.kit')).toBe(true);
    expect(runtime.hasTool('plugin.command')).toBe(true);
    expect(tools.find((t) => t.name === 'mixer.gain')).toMatchObject({ category: 'plugin', permission: 'WRITE' });
  });

  it('registriert die expliziten P3-2-Aliase (mixer.set_channel, synth.play_note, …)', () => {
    const runtime = createRuntime([]);
    expect(runtime.hasTool('mixer.set_channel')).toBe(true);
    expect(runtime.hasTool('synth.play_note')).toBe(true);
    expect(runtime.hasTool('synthesizer.play_note')).toBe(true);
    expect(runtime.hasTool('sequencer.load_pattern')).toBe(true);
    expect(runtime.hasTool('mcp.load_pattern')).toBe(true);
  });

  it('plant Kommandos über plugin.command (WRITE) und lehnt READ ab', async () => {
    const recorded: Array<{ pluginId: string; action: string; parameters: Record<string, unknown> }> = [];
    const runtime = createRuntime(recorded);

    const denied = await runtime.invoke('plugin.command', { pluginId: 'mixer', action: 'gain', permission: 'READ' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('permission denied');

    const ok = await runtime.invoke('plugin.command', { pluginId: 'mixer', action: 'gain', gain: -6, permission: 'WRITE' });
    expect(ok.ok).toBe(true);
    expect(ok.result).toEqual({ pluginId: 'mixer', action: 'gain', planned: true });
    expect(recorded).toEqual([{ pluginId: 'mixer', action: 'gain', parameters: { pluginId: 'mixer', action: 'gain', gain: -6 } }]);
  });

  it('lehnt unbekannte Plugin-Kommandos ab', async () => {
    const runtime = createRuntime([]);
    const res = await runtime.invoke('plugin.command', { pluginId: 'mixer', action: 'explodiere', permission: 'WRITE' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown plugin command');
  });

  it('Alias-Tools reichen auf das Ziel-Kommando durch', async () => {
    const recorded: Array<{ pluginId: string; action: string; parameters: Record<string, unknown> }> = [];
    const runtime = createRuntime(recorded);

    const res = await runtime.invoke('mixer.set_channel', { channel: 'channel7', gain: 0.8, permission: 'WRITE' });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ pluginId: 'mixer', action: 'channel', planned: true });
    expect(recorded[0]).toMatchObject({ pluginId: 'mixer', action: 'channel' });
  });
});

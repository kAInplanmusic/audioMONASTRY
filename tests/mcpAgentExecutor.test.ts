import { describe, expect, it, vi } from 'vitest';
import {
  buildToolParams,
  catalogFromMcpTools,
  createMcpAgentExecutor,
  isReadOnlyTool,
  parsePlannedCommand,
} from '../server/mcpAgentExecutor';

/**
 * AI-P1-006 · Serverseitiger Agent-Executor (MCP-Werkzeuge)
 * =====================================================================
 * Der Server hat keine Plugin-Registry (die lebt im Browser) — vorher endete
 * jeder serverseitige Schritt mit „Kein Plugin-Kommando". Jetzt führt er die
 * Werkzeuge der MCP-Runtime aus. Zwei Eigenschaften sind sicherheitsrelevant und
 * deshalb hier festgehalten:
 *
 *   1. Nur LESE-Werkzeuge sind ohne Freigabe planbar UND ausführbar; ein
 *      EXECUTION-Werkzeug (kostet GPU-Zeit) wird auch dann abgelehnt, wenn es im
 *      Plan steht.
 *   2. Die Abbildung Plan -> Werkzeug ist deterministisch (`kategorie.aktion`);
 *      ein erfundenes Werkzeug kann nicht ausgeführt werden.
 */

const TOOLS = [
  { name: 'session.getState', description: 'Session-Zustand', permission: 'READ', category: 'session' },
  { name: 'runtime.status', description: 'Runtime-Status', permission: 'READ', category: 'session' },
  { name: 'models.list', description: 'Modell-Registry', permission: 'READ', category: 'session' },
  { name: 'sample.search', description: 'Sample-Suche', permission: 'READ', category: 'sample' },
  { name: 'audio.classify', description: 'Audio-Klassifikation', permission: 'EXECUTION', category: 'analysis' },
  { name: 'plugin.command', description: 'Plugin-Kommando', permission: 'WRITE', category: 'plugin' },
];

function fakeMcp(calls: { tool: string; payload?: Record<string, unknown> }[] = []) {
  return {
    listTools: () => TOOLS,
    invoke: vi.fn(async (name: string, payload?: Record<string, unknown>) => {
      calls.push({ tool: name, payload });
      if (name === 'sample.search') return { ok: true, result: [{ id: 's1', name: 'Bass' }] };
      if (name === 'runtime.status') return { ok: false, error: 'Runtime offline' };
      return { ok: true, result: { ok: true } };
    }),
  };
}

describe('AI-P1-006 · MCP-Executor: Katalog', () => {
  it('leitet den Katalog aus den Werkzeugen ab (ohne EXECUTION/WRITE)', () => {
    const catalog = catalogFromMcpTools(TOOLS);
    // Gruppiert wird nach dem WERKZEUGNAMEN (session./runtime./models.) - nur so
    // ist die Rueckabbildung Plan -> Werkzeug eindeutig.
    expect(catalog).toContain('session: getState');
    expect(catalog).toContain('runtime: status');
    expect(catalog).toContain('models: list');
    expect(catalog).toContain('sample: search(query)');
    // Kostenpflichtige/schreibende Werkzeuge sind NICHT planbar.
    expect(catalog).not.toContain('classify');
    expect(catalog).not.toContain('plugin');
  });

  it('nimmt sie nur mit ausdruecklicher Freigabe auf', () => {
    const catalog = catalogFromMcpTools(TOOLS, { allowExecution: true });
    expect(catalog).toContain('audio: classify');
    expect(catalog).toContain('plugin: command');
  });

  it('erkennt Lese-Werkzeuge unabhaengig von Gross-/Kleinschreibung', () => {
    expect(isReadOnlyTool({ name: 'x.y', description: '', permission: 'read' })).toBe(true);
    expect(isReadOnlyTool({ name: 'x.y', description: '', permission: 'EXECUTION' })).toBe(false);
    expect(isReadOnlyTool({ name: 'x.y', description: '' })).toBe(true); // Default READ
  });

  it('zerlegt Kommandos mit und ohne Argumente', () => {
    expect(parsePlannedCommand('search(bass drum, 4)')).toEqual({ action: 'search', args: ['bass drum', '4'] });
    expect(parsePlannedCommand('getState')).toEqual({ action: 'getstate', args: [] });
    expect(parsePlannedCommand('search()')).toEqual({ action: 'search', args: [] });
    expect(parsePlannedCommand('')).toEqual({ action: '', args: [] });
  });

  it('bildet Argumente ueber die dokumentierte Konvention auf Parameter ab', () => {
    expect(buildToolParams('sample.search', ['bass'])).toEqual({ query: 'bass' });
    expect(buildToolParams('model.load', ['qwen3-14b'])).toEqual({ model: 'qwen3-14b' });
    // Ohne Konvention/Argumente: kein geratener Parameter.
    expect(buildToolParams('session.getState', [])).toEqual({});
    expect(buildToolParams('unbekannt.tool', ['x'])).toEqual({});
  });
});

describe('AI-P1-006 · MCP-Executor: Ausfuehrung', () => {
  it('fuehrt ein geplantes Werkzeug aus (kategorie: aktion)', async () => {
    const calls: { tool: string; payload?: Record<string, unknown> }[] = [];
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(calls), log: () => {} });

    const result = await executor.executePluginCommand?.('u1', 'session', 'getState');

    expect(result).toMatchObject({ handled: true, pluginId: 'session', action: 'session.getState' });
    expect(calls).toEqual([{ tool: 'session.getState', payload: {} }]);
  });

  it('reicht Argumente als Werkzeug-Parameter durch (sample: search(bass))', async () => {
    const calls: { tool: string; payload?: Record<string, unknown> }[] = [];
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(calls), log: () => {} });

    const result = await executor.executePluginCommand?.('u1', 'sample', 'search(bass)');

    expect(result?.handled).toBe(true);
    expect(calls[0]).toEqual({ tool: 'sample.search', payload: { query: 'bass' } });
  });

  it('meldet Werkzeug-Fehler ehrlich (handled:false + Grund)', async () => {
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    const result = await executor.executePluginCommand?.('u1', 'runtime', 'status');
    expect(result).toMatchObject({ handled: false, error: 'Runtime offline' });
  });

  it('lehnt ein nicht existierendes Werkzeug ab (kein stiller Erfolg)', async () => {
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    const result = await executor.executePluginCommand?.('u1', 'transport', 'play');
    expect(result?.handled).toBe(false);
    expect(result?.error).toMatch(/kein serverseitiges Werkzeug/);
  });

  it('fuehrt EXECUTION-/WRITE-Werkzeuge nur mit Freigabe aus', async () => {
    const strict = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    const denied = await strict.executePluginCommand?.('u1', 'audio', 'classify(audioBase64)');
    expect(denied?.handled).toBe(false);
    expect(denied?.error).toMatch(/AI_AGENT_ALLOW_EXECUTION_TOOLS/);

    const calls: { tool: string; payload?: Record<string, unknown> }[] = [];
    const allowed = createMcpAgentExecutor({ mcp: fakeMcp(calls), allowExecution: true, log: () => {} });
    const ok = await allowed.executePluginCommand?.('u1', 'audio', 'classify(audioBase64)');
    expect(ok?.handled).toBe(true);
    expect(calls[0].tool).toBe('audio.classify');
  });

  it('loest eine Aktion ohne Kategorie auf, lehnt Mehrdeutigkeit aber ab', async () => {
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    const unique = await executor.execute('u1', 'getState');
    expect(unique).toMatchObject({ handled: true, action: 'session.getState' });

    const ambiguous = createMcpAgentExecutor({
      mcp: {
        listTools: () => [
          { name: 'a.status', description: '', permission: 'READ' },
          { name: 'b.status', description: '', permission: 'READ' },
        ],
        invoke: vi.fn(async () => ({ ok: true })),
      },
      log: () => {},
    });
    const result = await ambiguous.execute('u1', 'status');
    expect(result.handled).toBe(false);
    expect(result.error).toMatch(/mehrdeutig/);
  });
});

describe('AI-P1-006 · WRITE-Gate und bekannte Lese-Werkzeuge', () => {
  it('belegt nur echte Lese-Werkzeuge als read-only', () => {
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    expect(executor.isReadOnly?.('session', 'getState')).toBe(true);
    expect(executor.isReadOnly?.('sample', 'search(bass)')).toBe(true);
    // Schreibend/kostenpflichtig: NICHT als Lesen gemeldet.
    expect(executor.isReadOnly?.('audio', 'classify(base64)')).toBe(false);
    expect(executor.isReadOnly?.('plugin', 'command(mixer, gain)')).toBe(false);
    // Unbekannt: fail-safe false (das Gate bleibt zustaendig).
    expect(executor.isReadOnly?.('transport', 'play')).toBe(false);
  });

  it('fuehrt ein Lese-Werkzeug ohne Schreib-Bestaetigung aus', async () => {
    // Genau der Live-Fall: der Planer nennt session:getState, das Gate hielt den
    // Schritt faelschlich fuer schreibend ("WRITE nicht bestaetigt").
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    const { MoaAgent } = await import('../src/core/ai/MoaAgent');
    const agent = new MoaAgent(
      async () => ({ provider: 'test' as never, text: '[{"pluginId":"session","command":"getState","prompt":""}]', latencyMs: 1 }),
      executor as never,
      () => 0.001,
      5000,
      'session: getState',
    );

    const result = await agent.run('Status pruefen'); // OHNE confirmWrite
    expect(result.succeeded).toBe(true);
    expect(result.steps[0]?.handled).toBe(true);
  });

  it('haelt das Gate fuer unbekannte Kommandos geschlossen', async () => {
    const { MoaAgent } = await import('../src/core/ai/MoaAgent');
    const executor = createMcpAgentExecutor({ mcp: fakeMcp(), log: () => {} });
    const agent = new MoaAgent(
      async () => ({ provider: 'test' as never, text: '[{"pluginId":"transport","command":"play","prompt":""}]', latencyMs: 1 }),
      executor as never,
      () => 0.001,
      5000,
      'transport: play',
    );

    const result = await agent.run('Abspielen'); // OHNE confirmWrite
    expect(result.steps[0]?.handled).toBe(false);
    expect(result.steps[0]?.error).toMatch(/WRITE nicht bestätigt/);
  });
});

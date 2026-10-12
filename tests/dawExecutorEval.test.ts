/**
 * RT-AUDIT-P1-015 · DAW-Executor: nur schema-gültige Kommandos.
 *
 * Gate (Akzeptanz): Eval-Set mit 50 Prompts, 100 % gültiges JSON. Das Modell
 * ist ein deterministisches Mock (executorEvalSet.ts), das die typischen
 * Fehlformen kleiner Modelle liefert – die Reparatur- und die Reject/Retry-
 * Strecke werden damit wirklich durchlaufen. Das LIVE-Modell (qwen3-4b über
 * vLLM guided_json) misst `npx tsx scripts/eval-ai.ts --executor`.
 */
import { describe, expect, it } from 'vitest';
import {
  DawExecutor,
  MAX_EXECUTOR_COMMANDS,
  executorCatalog,
  parseCatalogEntry,
  pluginCommandJsonSchema,
  validateExecutorOutput,
} from '../src/core/ai/dawExecutor';
import {
  EXECUTOR_EVAL_SET,
  MOCK_NOISE_VARIANTS,
  createMockExecutorModel,
} from '../src/core/ai/orchestrator/executorEvalSet';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';

/**
 * Minimaler Prüfer für genau die Schema-Teilmenge, die `pluginCommandJsonSchema`
 * erzeugt (object/array/anyOf/const/pattern/required/additionalProperties,
 * min/maxItems). Bewusst ohne Fremdbibliothek – keine neue Abhängigkeit.
 */
function conforms(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as Record<string, unknown>[]).some((branch) => conforms(branch, value));
  }
  if ('const' in schema && value !== schema.const) return false;
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return false;
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return false;
      return true;
    case 'array': {
      if (!Array.isArray(value)) return false;
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
      return value.every((item) => conforms(schema.items as Record<string, unknown>, item));
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in record)) return false;
      for (const key of Object.keys(record)) {
        if (!(key in props)) { if (schema.additionalProperties === false) return false; continue; }
        if (!conforms(props[key], record[key])) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

describe('DAW-Executor · Katalog und Schema', () => {
  it('leitet den Katalog vollständig aus PLUGIN_COMMAND_CATALOG ab', () => {
    const catalog = executorCatalog();
    expect([...catalog.keys()].sort()).toEqual(Object.keys(PLUGIN_COMMAND_CATALOG).sort());
    expect(parseCatalogEntry('gain(db), fade_in_main(seconds), channel(channel)')).toEqual([
      { name: 'gain', params: ['db'] },
      { name: 'fade_in_main', params: ['seconds'] },
      { name: 'channel', params: ['channel'] },
    ]);
    const total = [...catalog.values()].reduce((sum, cmds) => sum + cmds.size, 0);
    expect(total).toBeGreaterThanOrEqual(49);
  });

  it('Schema akzeptiert jedes Katalog-Kommando und lehnt Fremdes ab', () => {
    const schema = pluginCommandJsonSchema();
    for (const [pluginId, commands] of executorCatalog()) {
      for (const spec of commands.values()) {
        const command = spec.params.length ? `${spec.name}(${spec.params.map(() => '1').join(', ')})` : spec.name;
        expect(conforms(schema, { commands: [{ pluginId, command }] }), `${pluginId}.${command}`).toBe(true);
      }
    }
    expect(conforms(schema, { commands: [{ pluginId: 'mixer', command: 'explode' }] })).toBe(false);
    expect(conforms(schema, { commands: [{ pluginId: 'mixer', command: 'gain' }] })).toBe(false); // Pflichtparameter fehlt
    expect(conforms(schema, { commands: [{ pluginId: 'transport', command: 'play(1)' }] })).toBe(false);
    expect(conforms(schema, { commands: [{ pluginId: 'nope', command: 'status' }] })).toBe(false);
    expect(conforms(schema, { commands: [] })).toBe(false);
    expect(conforms(schema, { commands: [{ pluginId: 'drop', command: 'status', extra: 1 }] })).toBe(false);
  });
});

describe('DAW-Executor · Validierung (Reparatur/Reject)', () => {
  it('repariert nur mechanisch eindeutige Fehler', () => {
    const v = validateExecutorOutput('```json\n{"commands":[{"pluginId":"Transport","command":"PLAY()"},{"pluginId":"mixer","command":"gain(-6 dB)"}]}\n```');
    expect(v.ok).toBe(true);
    expect(v.commands).toEqual([{ pluginId: 'transport', command: 'play' }, { pluginId: 'mixer', command: 'gain(-6)' }]);
    expect(v.repairs.length).toBeGreaterThan(0);
  });

  it('klemmt Zahlen in den dokumentierten Bereich und rundet Ganzzahl-Parameter', () => {
    const v = validateExecutorOutput('{"commands":[{"pluginId":"transport","command":"set_tempo(400)"},{"pluginId":"instru","command":"program(12.6)"},{"pluginId":"mixer","command":"gain(30)"}]}');
    expect(v.commands.map((c) => c.command)).toEqual(['set_tempo(250)', 'program(13)', 'gain(12)']);
  });

  it('verwirft unbekannte Plugins/Kommandos, fehlende Parameter und Nicht-Zahlen', () => {
    for (const raw of [
      '{"commands":[{"pluginId":"mixer","command":"explode"}]}',
      '{"commands":[{"pluginId":"ghost","command":"status"}]}',
      '{"commands":[{"pluginId":"mixer","command":"gain"}]}',
      '{"commands":[{"pluginId":"transport","command":"set_tempo(fast)"}]}',
      '{"commands":[{"pluginId":"transport","command":"play(now)"}]}',
      '{"commands":[{"pluginId":"transport","command":"set_tempo((128)"}]}',
      'kein json',
      '',
      '{"commands":[]}',
      '{"foo":1}',
    ]) {
      const v = validateExecutorOutput(raw);
      expect(v.ok, raw).toBe(false);
      expect(v.errors.length, raw).toBeGreaterThan(0);
      expect(() => JSON.parse(v.json), raw).not.toThrow();
      expect(conforms(pluginCommandJsonSchema(), JSON.parse(v.json)) || JSON.parse(v.json).commands.length === 0).toBe(true);
    }
  });

  it('kürzt überlange Listen auf das Maximum', () => {
    const many = Array.from({ length: 12 }, () => ({ pluginId: 'drop', command: 'status' }));
    const v = validateExecutorOutput(JSON.stringify({ commands: many }));
    expect(v.commands).toHaveLength(MAX_EXECUTOR_COMMANDS);
  });

  it('erfindet keine Parameter: Text mit Kommas wird verbunden, nicht verworfen', () => {
    const v = validateExecutorOutput('{"commands":[{"pluginId":"voice","command":"speak(hallo, welt)"}]}');
    expect(v.commands).toEqual([{ pluginId: 'voice', command: 'speak(hallo welt)' }]);
  });
});

describe('DAW-Executor · Eval-Set 50 Prompts (Gate: 100 % gültiges JSON)', () => {
  it('hat genau 50 Fälle mit eindeutigen IDs, die jedes Katalog-Plugin abdecken', () => {
    expect(EXECUTOR_EVAL_SET).toHaveLength(50);
    expect(new Set(EXECUTOR_EVAL_SET.map((c) => c.id)).size).toBe(50);
    const covered = new Set(EXECUTOR_EVAL_SET.flatMap((c) => c.expected.map((e) => e.pluginId)));
    expect([...covered].sort()).toEqual(Object.keys(PLUGIN_COMMAND_CATALOG).sort());
    // Jede Erwartung ist selbst katalog- und schema-gültig.
    for (const entry of EXECUTOR_EVAL_SET) {
      expect(validateExecutorOutput(JSON.stringify({ commands: entry.expected })).commands, entry.id).toEqual(entry.expected);
    }
  });

  it('liefert für alle 50 Prompts gültiges, schema-konformes JSON mit den erwarteten Kommandos', async () => {
    const model = createMockExecutorModel();
    const executor = new DawExecutor(model.complete);
    const schema = pluginCommandJsonSchema();
    let validJson = 0;
    let exact = 0;
    let retries = 0;
    for (const entry of EXECUTOR_EVAL_SET) {
      const result = await executor.run(entry.task);
      const parsed = JSON.parse(result.json) as unknown;
      if (result.ok && conforms(schema, parsed)) validJson += 1;
      if (JSON.stringify(result.commands) === JSON.stringify(entry.expected)) exact += 1;
      if (result.attempts > 1) retries += 1;
      expect(result.ok, `${entry.id}: ${result.errors.join('; ')}`).toBe(true);
      expect(result.commands, entry.id).toEqual(entry.expected);
    }
    expect(validJson / EXECUTOR_EVAL_SET.length).toBe(1);
    expect(exact).toBe(50);
    // Die Reject/Retry-Strecke wurde wirklich durchlaufen (halluziniert + Nicht-JSON).
    expect(retries).toBe(EXECUTOR_EVAL_SET.filter((_, i) => /then-clean/.test(MOCK_NOISE_VARIANTS[i % MOCK_NOISE_VARIANTS.length])).length);
    expect(retries).toBeGreaterThan(0);
    // Jeder Aufruf trägt das Schema für vLLM guided_json und nutzt das Executor-Modell (simple).
    expect(model.calls.every((call) => call.jsonSchema === undefined ? false : call.complexity === 'simple')).toBe(true);
  });

  it('lehnt ab statt ungültiges JSON durchzulassen, wenn das Modell dauerhaft Unsinn liefert', async () => {
    const executor = new DawExecutor(async () => ({ provider: 'runpod-local', text: '{"commands":[{"pluginId":"mixer","command":"explode"},{"pluginId":"drop","command":"status"}]}', latencyMs: 1 }));
    const result = await executor.run('irgendwas');
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.commands).toEqual([]); // kein halber Plan
    expect(JSON.parse(result.json)).toEqual({ commands: [] });
  });

  it('meldet einen Modellfehler als Ablehnung (kein Wurf, kein Kommando)', async () => {
    const executor = new DawExecutor(async () => { throw new Error('brain kalt'); });
    const result = await executor.run('Tempo 120');
    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([]);
    expect(result.errors[0]).toContain('brain kalt');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  MosHarness,
  mosRatingFromEvaluation,
  parseMosInput,
} from '../src/core/ai/orchestrator/mosHarness';
import { setAiPersistenceClientForTests, type PersistedEvaluation } from '../src/core/ai/orchestrator/aiPersistence';

/**
 * AI-P1-003 P2: MOS-Harness. Geprüft werden Validierung, ehrliches Gate ohne
 * Hörer (pass=false, kein erfundener MOS), Aggregation und Gate-Entscheidung.
 * Bewusst mit frischer Instanz je Test (der Server-Singleton sammelt global).
 */

describe('MosHarness', () => {
  it('validiert Hörerwertungen strikt (1..5 ganzzahlig, DE/EN, IDs)', () => {
    const h = new MosHarness();
    expect(h.add({ modelId: 'm', language: 'DE', score: 6, evaluatorId: 'e' }).ok).toBe(false);
    expect(h.add({ modelId: 'm', language: 'DE', score: 0, evaluatorId: 'e' }).ok).toBe(false);
    expect(h.add({ modelId: 'm', language: 'DE', score: 3.5, evaluatorId: 'e' }).ok).toBe(false);
    expect(h.add({ modelId: 'm', language: 'FR' as unknown as 'DE', score: 4, evaluatorId: 'e' }).ok).toBe(false);
    expect(h.add({ modelId: '', language: 'DE', score: 4, evaluatorId: 'e' }).ok).toBe(false);
    expect(h.add({ modelId: 'm', language: 'DE', score: 4, evaluatorId: '' }).ok).toBe(false);
    expect(h.list()).toHaveLength(0);
  });

  it('bleibt ohne Hörerwerte ehrlich: pass=false mit Begründung', () => {
    const h = new MosHarness();
    const gate = h.gateFor('qwen3-tts-06b');
    expect(gate.pass).toBe(false);
    expect(gate.count).toBe(0);
    expect(gate.evaluators).toBe(0);
    expect(gate.reason).toContain('keine Hörerwertungen');
  });

  it('aggregiert und besteht das Gate ab 3 Hörern mit MOS >= 4', () => {
    const h = new MosHarness();
    h.add({ modelId: 'mms-tts-deu', language: 'DE', score: 5, evaluatorId: 'a' });
    h.add({ modelId: 'mms-tts-deu', language: 'EN', score: 4, evaluatorId: 'b' });
    expect(h.gateFor('mms-tts-deu').pass).toBe(false); // erst 2 von 3
    h.add({ modelId: 'mms-tts-deu', language: 'DE', score: 5, evaluatorId: 'c' });
    const gate = h.gateFor('mms-tts-deu');
    expect(gate.count).toBe(3);
    expect(gate.evaluators).toBe(3);
    expect(gate.avg).toBeCloseTo(4.667, 2);
    expect(gate.min).toBe(4);
    expect(gate.max).toBe(5);
    expect(gate.pass).toBe(true);
  });

  it('zählt Hörer, nicht Wertungen: dieselbe Person erfüllt das Gate nicht', () => {
    const h = new MosHarness();
    // Eine Person bewertet drei Hörproben - technisch 3 Wertungen, aber 1 Hörer.
    for (const score of [5, 5, 5] as const) {
      h.add({ modelId: 'solo', language: 'DE', score, evaluatorId: 'patrick' });
    }
    const gate = h.gateFor('solo');
    expect(gate.count).toBe(3);
    expect(gate.evaluators).toBe(1);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toContain('erst 1 von 3 Hörern');
    expect(gate.reason).toContain('3 Wertungen');
    // Erst ein zweiter und dritter Hörer öffnen das Gate.
    h.add({ modelId: 'solo', language: 'DE', score: 4, evaluatorId: 'zweit' });
    h.add({ modelId: 'solo', language: 'DE', score: 4, evaluatorId: 'dritt' });
    const open = h.gateFor('solo');
    expect(open.evaluators).toBe(3);
    expect(open.pass).toBe(true);
  });

  it('lässt ein Modell mit schlechtem MOS durchfallen', () => {
    const h = new MosHarness();
    for (const [score, evaluatorId] of [[3, 'a'], [3, 'b'], [2, 'c']] as const) {
      h.add({ modelId: 'bad-tts', language: 'DE', score, evaluatorId });
    }
    const gate = h.gateFor('bad-tts');
    expect(gate.avg).toBeCloseTo(2.667, 2);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toContain('MOS 2.67 < 4');
  });

  it('listet alle bewerteten Modelle sortiert', () => {
    const h = new MosHarness();
    h.add({ modelId: 'b-model', language: 'DE', score: 5, evaluatorId: 'a' });
    h.add({ modelId: 'a-model', language: 'DE', score: 5, evaluatorId: 'a' });
    expect(h.list().map((s) => s.modelId)).toEqual(['a-model', 'b-model']);
  });
});

/**
 * AI-P1-007: Ladepfad. Die Wertungen wurden bisher nur geschrieben, nie
 * gelesen – nach einem Neustart war die Liste leer (live belegt 2026-09-17).
 */
function evaluation(overrides: Partial<PersistedEvaluation> = {}): PersistedEvaluation {
  return {
    id: 'e1',
    pluginId: 'voice',
    task: 'voice.mos',
    model: 'qwen3-tts-06b',
    provider: 'mos-listener',
    input: JSON.stringify({ language: 'DE', evaluatorId: 'peter' }),
    output: '4',
    score: 4,
    metrics: {},
    createdAt: '2026-09-14T22:44:27.490529+00:00',
    ...overrides,
  };
}

/** Mock fuer die PostgREST-Lesekette (`select().eq().eq().order().limit()`). */
function readMockClient(rows: unknown[], calls: Array<{ table: string; filters: Array<[string, unknown]> }>) {
  const chain: Record<string, unknown> = {};
  const entry = { table: '', filters: [] as Array<[string, unknown]> };
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    entry.filters.push([col, val]);
    return chain;
  };
  chain.order = () => chain;
  chain.limit = () => Promise.resolve({ data: rows, error: null });
  return {
    from: (table: string) => {
      entry.table = table;
      calls.push(entry);
      return chain;
    },
  } as never;
}

describe('AI-P1-007 · Zeilen lesen (rein)', () => {
  it('liest language/evaluatorId/notes aus JSON-String UND Objekt', () => {
    expect(parseMosInput('{"language":"EN","evaluatorId":"a","notes":"ok"}')).toEqual({
      language: 'EN', evaluatorId: 'a', notes: 'ok',
    });
    expect(parseMosInput({ language: 'DE', evaluatorId: 'b' })).toEqual({
      language: 'DE', evaluatorId: 'b', notes: undefined,
    });
    expect(parseMosInput('{kaputt')).toEqual({});
    expect(parseMosInput(null)).toEqual({});
  });

  it('verwirft unbrauchbare Zeilen, statt zu raten', () => {
    expect(mosRatingFromEvaluation(evaluation({ model: '' }))).toBeNull();
    expect(mosRatingFromEvaluation(evaluation({ score: 4.5 }))).toBeNull();
    expect(mosRatingFromEvaluation(evaluation({ score: 7 }))).toBeNull();
    // Sprache/Hoerer fehlen im input -> nicht bewertbar.
    expect(mosRatingFromEvaluation(evaluation({ input: JSON.stringify({ language: 'FR', evaluatorId: 'x' }) }))).toBeNull();
    expect(mosRatingFromEvaluation(evaluation({ input: '{}' }))).toBeNull();
    // Unlesbarer Zeitstempel ist kein Grund zu verwerfen (Ordnung, nicht Inhalt).
    expect(mosRatingFromEvaluation(evaluation({ createdAt: 'kaputt' }))?.createdAt).toBe(0);
  });

  it('uebernimmt eine gueltige Zeile inkl. notes', () => {
    const rating = mosRatingFromEvaluation(evaluation({
      input: JSON.stringify({ language: 'DE', evaluatorId: 'peter', notes: 'Grundrauschen' }),
    }));
    expect(rating).toMatchObject({ modelId: 'qwen3-tts-06b', language: 'DE', score: 4, evaluatorId: 'peter', notes: 'Grundrauschen' });
    expect(rating?.createdAt).toBe(Date.parse('2026-09-14T22:44:27.490529+00:00'));
  });
});

describe('AI-P1-007 · hydrate (idempotent)', () => {
  it('laedt Wertungen und baut dasselbe Gate-Aggregat wie direkt eingegebene', () => {
    const h = new MosHarness();
    const rows = [
      evaluation({ id: '1', model: 'm', input: JSON.stringify({ language: 'DE', evaluatorId: 'a' }), score: 5 }),
      evaluation({ id: '2', model: 'm', input: JSON.stringify({ language: 'EN', evaluatorId: 'b' }), score: 4 }),
      evaluation({ id: '3', model: 'm', input: JSON.stringify({ language: 'DE', evaluatorId: 'c' }), score: 5 }),
    ];
    const result = h.hydrate(rows);
    expect(result.loaded).toBe(3);
    expect(result.skipped).toBe(0);
    expect(h.gateFor('m').pass).toBe(true);
    expect(h.gateFor('m').evaluators).toBe(3);
  });

  it('ist verlustfrei: DB-Anzahl je Fingerprint gilt, Wiederholung aendert nichts', () => {
    const h = new MosHarness();
    const rows = [
      evaluation({ id: '1', model: 'm', input: JSON.stringify({ language: 'DE', evaluatorId: 'a' }), score: 5 }),
      // Zweite Zeile derselben Art: steht so in der DB (real: drei Wertungen
      // eines Hoerers in derselben Sekunde) - wird NICHT verschluckt.
      evaluation({ id: '2', model: 'm', input: JSON.stringify({ language: 'DE', evaluatorId: 'a' }), score: 5 }),
      evaluation({ id: '3', model: '', score: 5 }), // ungueltig
    ];
    expect(h.hydrate(rows)).toMatchObject({ loaded: 2, skipped: 1, total: 2 });
    // Zweiter Lauf desselben Bestands aendert nichts (idempotent).
    expect(h.hydrate(rows)).toMatchObject({ loaded: 0, skipped: 3, total: 2 });
    // Zwei Wertungen derselben Person sind kein zweiter HOERER.
    expect(h.gateFor('m').evaluators).toBe(1);
    expect(h.gateFor('m').count).toBe(2);
  });

  it('mischt gespeicherte und neu eingegebene Wertungen ohne Doppelzaehlung', () => {
    const h = new MosHarness();
    h.add({ modelId: 'm', language: 'DE', score: 5, evaluatorId: 'a' });
    const seconds = Math.floor(Date.now() / 1000);
    // Dieselbe Wertung, wie sie in der DB liegen wuerde (created_at = jetzt).
    const persisted = evaluation({
      model: 'm', score: 5, input: JSON.stringify({ language: 'DE', evaluatorId: 'a' }),
      createdAt: new Date(seconds * 1000).toISOString(),
    });
    expect(h.hydrate([persisted]).loaded).toBe(0);
    expect(h.gateFor('m').count).toBe(1);
  });
});

describe('AI-P1-007 · loadPersisted', () => {
  afterEach(() => setAiPersistenceClientForTests(null));

  it('liest voice.mos-Zeilen aus ai_evaluations und stellt das Gate wieder her', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    setAiPersistenceClientForTests(readMockClient([evaluation({ model: 'qwen3-tts-06b' })], calls));

    const h = new MosHarness();
    const result = await h.loadPersisted();
    expect(result).toMatchObject({ loaded: 1, configured: true });
    expect(h.list().map((s) => s.modelId)).toEqual(['qwen3-tts-06b']);
    expect(calls[0].table).toBe('ai_evaluations');
    expect(calls[0].filters).toEqual([['task', 'voice.mos'], ['plugin_id', 'voice']]);
  });

  it('ist nach dem ersten Lauf folgenlos (kein zweiter DB-Zugriff)', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    setAiPersistenceClientForTests(readMockClient([evaluation()], calls));
    const h = new MosHarness();
    await h.loadPersisted();
    const second = await h.loadPersisted();
    expect(second).toMatchObject({ loaded: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(h.persistenceStatus()).toMatchObject({ hydrated: true, configured: true, ratings: 1 });
  });

  it('meldet fehlende Persistenz ehrlich, statt "keine Daten" zu behaupten', async () => {
    setAiPersistenceClientForTests(null);
    const h = new MosHarness();
    // Testumgebung: tests/setup.ts entfernt SB_*/SUPABASE_* -> nicht konfiguriert.
    const result = await h.loadPersisted();
    expect(result).toMatchObject({ loaded: 0, configured: false });
    expect(h.persistenceStatus().hydrated).toBe(false);
  });
});

describe('AI-P1-007 · notes ueberleben den Neustart', () => {
  afterEach(() => setAiPersistenceClientForTests(null));

  it('schreibt notes mit in input (jsonb)', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    setAiPersistenceClientForTests({
      from: () => ({ insert: async (data: Record<string, unknown>) => { inserts.push(data); } }),
    } as never);

    const h = new MosHarness();
    h.add({ modelId: 'm', language: 'DE', score: 5, evaluatorId: 'a', notes: 'klare Aussprache' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inserts).toHaveLength(1);
    expect(JSON.parse(String(inserts[0].input))).toEqual({ language: 'DE', evaluatorId: 'a', notes: 'klare Aussprache' });
    // Gegenprobe: die zurueckgelesene Zeile traegt die Notiz wieder.
    const restored = mosRatingFromEvaluation({
      id: 'i1', pluginId: 'voice', task: 'voice.mos', model: 'm', provider: 'mos-listener',
      input: inserts[0].input, output: '5', score: 5, metrics: {}, createdAt: new Date().toISOString(),
    });
    expect(restored?.notes).toBe('klare Aussprache');
  });
});

import { describe, expect, it } from 'vitest';
import { MosHarness } from '../src/core/ai/orchestrator/mosHarness';

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
    expect(gate.avg).toBeCloseTo(4.667, 2);
    expect(gate.min).toBe(4);
    expect(gate.max).toBe(5);
    expect(gate.pass).toBe(true);
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

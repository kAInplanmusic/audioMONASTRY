import { describe, expect, it } from 'vitest';
import { PromptStore } from '../src/core/ai/orchestrator/promptStore';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';

describe('PromptStore (Versionierung)', () => {
  it('legt Versionen an und liefert die aktivste', () => {
    const store = new PromptStore();
    store.upsert('mixer', 'v1: Mische Pegel', { role: 'system' });
    const v2 = store.upsert('mixer', 'v2: Mische Pegel + Pan', { role: 'system' });
    expect(store.highestVersion('mixer')).toBe(2);
    expect(store.getActive('mixer')?.id).toBe(v2.id);
    expect(store.listVersions('mixer')).toHaveLength(2);
  });

  it('deaktiviert Versionen und wechselt die aktive', () => {
    const store = new PromptStore();
    store.upsert('synth', 'v1', { version: 1 });
    store.upsert('synth', 'v2', { version: 2 });
    store.disable('synth', 2);
    expect(store.getActive('synth')?.version).toBe(1);
  });
});

describe('EvaluationStore (AuditEval/AuditScore)', () => {
  it('berechnet Score und Run-Status', () => {
    const store = new EvaluationStore();
    store.record({ pluginId: 'mixer', task: 'gain', promptVersion: 1, model: 'moa', provider: 'deepseek', input: {}, output: {}, score: 4.5, metrics: { mos: 4.5 } });
    store.record({ pluginId: 'mixer', task: 'pan', promptVersion: 1, model: 'moa', provider: 'deepseek', input: {}, output: {}, score: 3.0, metrics: { mos: 3.0 } });
    const run = store.startRun('mixer');
    expect(store.averageScore('mixer')).toBeCloseTo(3.75);
    const done = store.finishRun(run.runId, 4);
    expect(done.status).toBe('FAIL');
    expect(done.count).toBe(2);
  });
});

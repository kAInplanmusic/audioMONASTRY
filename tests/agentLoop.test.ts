import { describe, expect, it, vi } from 'vitest';
import { AiAgentLoop, assembleAgentContext } from '../src/core/ai/agentLoop';
import type { MoaRunOptions, MoaRunResult } from '../src/core/ai/MoaAgent';

/**
 * AI-P1-003 P5 (Integrationsschicht): Kontext-Assembly aus routing.json +
 * Session-Zustand, und der Einstieg AiAgentLoop.runTask, der diesen Kontext
 * an MoaAgent.run durchreicht. Alles mit Fakes, deterministisch.
 */

const ROUTING = {
  global: { tempo: 120, masterVolume: -6 },
  tracks: [{ id: 'channel1' }, { id: 'channel2' }, { id: 'channel3' }, { id: 'channel7' }],
  buses: [{ id: 'GLOBAL_MASTER' }],
  connections: [{}, {}, {}, {}],
};

describe('assembleAgentContext', () => {
  it('fasst routing.json und Session-Zustand kompakt zusammen', () => {
    const ctx = assembleAgentContext({
      routing: ROUTING,
      sessionState: { state: 'ACTIVE', sessionId: 's1' },
    });
    expect(ctx).toContain('tempo');
    expect(ctx).toContain('routing.tracks=4');
    expect(ctx).toContain('routing.buses=[{"id":"GLOBAL_MASTER"}]');
    expect(ctx).toContain('routing.connections=4');
    expect(ctx).toContain('session={"state":"ACTIVE","sessionId":"s1"}');
  });

  it('lässt fehlende Felder aus und ist leer ohne Kontext', () => {
    expect(assembleAgentContext({})).toBe('');
    expect(assembleAgentContext({ routing: { global: { tempo: 120 } } })).not.toContain('tracks');
  });

  it('kappt den Kontext auf 2000 Zeichen (Prompt-Limit)', () => {
    const long = assembleAgentContext({ sessionState: { blob: 'x'.repeat(5000) } });
    expect(long.length).toBeLessThanOrEqual(2000);
  });
});

describe('AiAgentLoop (Einstieg)', () => {
  it('reicht Kontext, WRITE-Bestätigung und Limits an MoaAgent.run durch', async () => {
    const run = vi.fn(async (_task: string, _opts: MoaRunOptions): Promise<MoaRunResult> => ({
      plan: { task: _task, provider: 'runpod-local', steps: [], raw: '', createdAt: 1 },
      steps: [],
      corrections: 0,
      succeeded: true,
    }));
    const loop = new AiAgentLoop({ run } as unknown as never);

    const confirmWrite = () => true;
    await loop.runTask('Mixer setzen', {
      userId: 'u1',
      routing: ROUTING,
      sessionState: { state: 'ACTIVE' },
      confirmWrite,
      maxCorrections: 2,
    });

    expect(run).toHaveBeenCalledTimes(1);
    const opts = run.mock.calls[0][1];
    expect(opts.userId).toBe('u1');
    expect(opts.context).toContain('routing.tracks=4');
    expect(opts.context).toContain('session={"state":"ACTIVE"}');
    expect(opts.confirmWrite).toBe(confirmWrite);
    expect(opts.maxCorrections).toBe(2);
  });

  it('setzt den Default-User, wenn keiner angegeben ist', async () => {
    const run = vi.fn(async (_task: string, _opts: MoaRunOptions): Promise<MoaRunResult> => ({
      plan: { task: '', provider: 'runpod-local', steps: [], raw: '', createdAt: 1 },
      steps: [],
      corrections: 0,
      succeeded: true,
    }));
    const loop = new AiAgentLoop({ run } as unknown as never);
    await loop.runTask('Status prüfen');
    const opts = run.mock.calls[0][1];
    expect(opts.userId).toBe('localUser');
  });
});

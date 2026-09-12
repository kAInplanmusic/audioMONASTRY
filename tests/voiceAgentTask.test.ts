import { describe, expect, it, vi } from 'vitest';
import { VoiceControlService } from '../src/core/voice/VoiceControlService';
import type { AiAgentLoop } from '../src/core/ai/agentLoop';
import type { MoaRunResult } from '../src/core/ai/MoaAgent';

/**
 * AI-P1-003 P5 (Verdrahtung): VoiceControlService.runAgentTask reicht Aufgabe,
 * User, Kontext, WRITE-Bestätigung und Limits an den Agent-Loop durch.
 */

const RESULT: MoaRunResult = {
  plan: { task: '', provider: 'runpod-local', steps: [], raw: '', createdAt: 1 },
  steps: [],
  corrections: 0,
  succeeded: true,
};

function makeService(fakeLoop: AiAgentLoop): VoiceControlService {
  // Der Parser wird von runAgentTask nicht verwendet – ein Minimal-Stub genügt.
  return new VoiceControlService({ parse: async () => ({ action: 'status', targets: [], parameters: {}, confidence: 1, raw: '' }) } as never, fakeLoop);
}

describe('VoiceControlService.runAgentTask (P5-Verdrahtung)', () => {
  it('delegiert an den Agent-Loop mit User, Kontext und WRITE-Bestätigung', async () => {
    const runTask = vi.fn(async (_task: string, _opts: Record<string, unknown>) => RESULT);
    const svc = makeService({ runTask } as unknown as AiAgentLoop);
    const confirmWrite = () => true;
    const routing = { global: { tempo: 128 }, tracks: [{ id: 'channel1' }] };

    const result = await svc.runAgentTask('u1', 'Pegel anheben und Drop starten', {
      routing,
      sessionState: { state: 'ACTIVE' },
      confirmWrite,
      maxCorrections: 2,
    });

    expect(result).toBe(RESULT);
    expect(runTask).toHaveBeenCalledTimes(1);
    const [task, opts] = runTask.mock.calls[0];
    expect(task).toBe('Pegel anheben und Drop starten');
    expect(opts.userId).toBe('u1');
    expect(opts.routing).toBe(routing);
    expect(opts.sessionState).toEqual({ state: 'ACTIVE' });
    expect(opts.confirmWrite).toBe(confirmWrite);
    expect(opts.maxCorrections).toBe(2);
  });

  it('funktioniert ohne optionalen Kontext (nur Aufgabe + User)', async () => {
    const runTask = vi.fn(async (_task: string, _opts: Record<string, unknown>) => RESULT);
    const svc = makeService({ runTask } as unknown as AiAgentLoop);
    await svc.runAgentTask('u2', 'Status prüfen');
    const [, opts] = runTask.mock.calls[0];
    expect(opts.userId).toBe('u2');
    expect(opts.routing).toBeUndefined();
    expect(opts.confirmWrite).toBeUndefined();
  });
});

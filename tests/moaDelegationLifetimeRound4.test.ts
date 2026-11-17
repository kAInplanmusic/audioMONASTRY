import { describe, expect, it, vi } from 'vitest';
import { MoaAgent, isWriteCommand, type MoaPlan } from '../src/core/ai/MoaAgent';

// Production executor, fake planner/command side effect only: no LLM or cloud.
const plan: MoaPlan = { task: 'delegated eq gain', provider: 'test', createdAt: 1, raw: '',
  steps: [{ pluginId: 'eq', command: 'gain(0.5)', prompt: '' }] };

describe('Runde4 B: delegation must still be valid at actual command execution', () => {
  it.each(['holder-changed', 'mode-OFF', 'mode-ON'])('executes nothing if %s occurs after confirmation but before command dispatch', async reason => {
    const controller = new AbortController();
    const authority = { holder: 'original-holder', mode: 'AUTO_AI' };
    const execute = vi.fn(async () => ({ handled: true, pluginId: 'eq' }));
    const agent = new MoaAgent(async () => ({ provider: 'vast-local', text: '[]', latencyMs: 0 }),
      { execute, executePluginCommand: execute });
    expect(isWriteCommand(plan.steps[0].command)).toBe(true);
    const confirm = () => {
      const permitted = authority.holder === 'original-holder' && authority.mode === 'AUTO_AI';
      // A valid event-loop ordering: revocation is processed during the await
      // of this synchronous confirmation, before the next command can run.
      queueMicrotask(() => {
        if (reason === 'holder-changed') authority.holder = 'new-holder';
        else authority.mode = reason === 'mode-OFF' ? 'OFF' : 'PRO';
        controller.abort(reason);
      });
      return permitted;
    };
    await agent.executePlanGated(plan, 'original-holder', confirm, { signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createSessionRuntime } from '../server/sessionRuntime';
import { MoaAgent, type MoaPlan } from '../src/core/ai/MoaAgent';
const plan: MoaPlan = { task: 'eq', provider: 'fixture', raw: '', createdAt: 0,
  steps: [1, 2].map(i => ({ pluginId: 'eq', command: `gain(${i})`, prompt: '' })) };
async function setup() {
  const runtime = createSessionRuntime();
  await runtime.acquirePluginLock('eq', 'human-a');
  const record = runtime.delegations.start('eq', 'human-a');
  const execute = vi.fn(async () => ({ handled: true, pluginId: 'eq' }));
  const agent = new MoaAgent(async () => ({ provider: 'vast-local', text: '[]', latencyMs: 0 }), { execute, executePluginCommand: execute });
  const options = { authorizeStep: () => runtime.delegations.valid(record, 'human-a', 'eq') };
  return { runtime, record, execute, agent, options };
}
describe('server-attested revocable plugin delegation, separate from human locks', () => {
  it('releases the human lock and revokes AI when another human takes it', async () => {
    const f = await setup();
    expect(await f.runtime.resolveLockOwner('eq')).toBeNull();
    expect(f.runtime.delegations.valid(f.record, 'human-a', 'eq')).toBe(true);
    await f.runtime.acquirePluginLock('eq', 'human-b');
    await f.agent.executePlanGated(plan, 'human-a', () => true, f.options);
    expect(f.execute).not.toHaveBeenCalled(); expect(f.runtime.delegations.get('eq')).toBeNull();
  });
  it.each(['OFF', 'PRO'])('stops before the next step when the delegator changes mode to %s', async state => {
    const f = await setup();
    await f.agent.executePlanGated(plan, 'human-a', () => true, { ...f.options, onStep: () => {
      f.runtime.session.applyEvent({ id: 'mode-change', type: 'plugin-state', senderUserId: 'human-a', pluginId: 'eq', state: state as 'OFF' | 'PRO' });
    } });
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.runtime.delegations.get('eq')).toBeNull();
  });
  it('cooperatively finishes the already-started action but never starts another after revocation', async () => {
    const f = await setup(); let finish!: () => void;
    f.execute.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ handled: true, pluginId: 'eq' }); }));
    const run = f.agent.executePlanGated(plan, 'human-a', () => true, f.options);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.runtime.delegations.revoke('eq'); finish(); const result = await run;
    expect(f.execute).toHaveBeenCalledOnce(); expect(result.results).toHaveLength(1); expect(result.cancelled).toBe(true);
  });
  it('executes no step without the current canonical generation, actor and lease', async () => {
    const f = await setup();
    for (const proof of [null, { ...f.record, generationId: '' }, { ...f.record, generationId: 'stale' }, { ...f.record, pluginId: 'mixer' }]) {
      await f.agent.executePlanGated(plan, 'human-a', () => true, { authorizeStep: () => f.runtime.delegations.valid(proof, 'human-a', 'eq') });
    }
    expect(f.runtime.delegations.valid(f.record, 'human-b', 'eq')).toBe(false);
    expect(f.runtime.delegations.valid(f.record, 'human-a', 'eq', f.record.expiresAt)).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('rejects aiMONK/mixer and noncanonical targets as delegation receivers', async () => {
    const f = await setup();
    for (const id of ['ai', 'mixer', 'sampler']) expect(() => f.runtime.delegations.start(id, 'human-a')).toThrow();
  });
});

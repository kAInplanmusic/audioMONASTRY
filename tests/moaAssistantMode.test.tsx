// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const grants = vi.hoisted(() => Object.fromEntries(['eq', 'syntisampler', 'biblio', 'spatial', 'master'].map(pluginId => [pluginId, { pluginId, delegatedBy: 'session-holder', generationId: 'fixture-generation', aiRole: 'fixture', issuedAt: 0, expiresAt: 8000000000000 }])));
const fixture = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn(), history: vi.fn(), rtc: { userId: 'session-holder', getDelegations: () => grants, subscribeDelegations: () => () => {}, getPluginDelegation: (id: string) => grants[id] ?? null, runDelegated: (_record: unknown, run: () => Promise<unknown>) => run(), validatePluginDelegation: async () => true, revokePluginDelegation: async () => {} } }));
vi.mock('../src/core/ai/MoaAgent', () => ({ moaAgent: { plan: fixture.plan, executePlanGated: fixture.execute } }));
vi.mock('../src/core/ai/MoaHistory', () => ({ moaHistory: { add: fixture.history } }));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: fixture.rtc }));
vi.mock('../src/utils/storage', () => ({ storageGetJson: () => [], storageSetJson: vi.fn() }));
vi.mock('../src/utils/prompts', () => ({ moaTaskForPlugin: () => 'adjust this plugin' }));
import { MoaAssistant } from '../src/components/MoaAssistant';
const step = (pluginId: string) => ({ pluginId, command: 'set_gain(0.5)', prompt: '' });
const plan = { provider: 'fixture', steps: [step('eq')] };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); fixture.rtc.userId = 'session-holder';
  fixture.plan.mockResolvedValue(plan); fixture.execute.mockResolvedValue({ results: [], cancelled: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(2500); });
describe('existing plugin automation follows KI delegation', () => {
  it.each(['off', 'unmount'])('discards a late plan after %s', async transition => {
    let resolve!: (value: typeof plan) => void;
    fixture.plan.mockReturnValue(new Promise(r => { resolve = r; }));
    const activity = vi.fn();
    const view = render(<MoaAssistant pluginId="eq" autoMode onActivity={activity} />);
    await tick(); expect(fixture.plan).toHaveBeenCalledOnce();
    if (transition === 'off') view.rerender(<MoaAssistant pluginId="eq" autoMode={false} onActivity={activity} />);
    else view.unmount();
    activity.mockClear();
    await act(async () => { resolve(plan); });
    expect(fixture.execute).not.toHaveBeenCalled(); expect(fixture.history).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });
  it('uses the real actor and delegates only the selected canonical plugin', async () => {
    fixture.plan.mockResolvedValue({ ...plan, steps: [step('sampler'), step('mixer'), step('unknown')] });
    render(<MoaAssistant pluginId="syntisampler" autoMode />); await tick();
    const [executed, actor, confirm, options] = fixture.execute.mock.calls[0];
    expect(actor).toBe('session-holder'); expect(executed.steps).toEqual([step('syntisampler')]);
    expect(confirm(step('syntisampler'))).toBe(true); expect(confirm(step('mixer'))).toBe(false);
    expect(options.signal.aborted).toBe(false);
  });
  it('aborts an active executor on loss of delegation and never overlaps ticks', async () => {
    fixture.execute.mockReturnValue(new Promise(() => {}));
    const view = render(<MoaAssistant pluginId="eq" autoMode />); await tick();
    const signal = fixture.execute.mock.calls[0][3].signal as AbortSignal;
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(fixture.execute).toHaveBeenCalledOnce();
    view.rerender(<MoaAssistant pluginId="eq" autoMode={false} />);
    expect(signal.aborted).toBe(true);
    expect(fixture.execute.mock.calls[0][2](step('eq'))).toBe(false);
  });
  it('does not plan in manual mode or execute after the session identity changes', async () => {
    const view = render(<MoaAssistant pluginId="eq" autoMode={false} />); await tick();
    expect(fixture.plan).not.toHaveBeenCalled();
    let resolve!: (value: typeof plan) => void;
    fixture.plan.mockReturnValue(new Promise(r => { resolve = r; }));
    view.rerender(<MoaAssistant pluginId="eq" autoMode />); await tick();
    fixture.rtc.userId = 'different-session';
    await act(async () => { resolve(plan); }); expect(fixture.execute).not.toHaveBeenCalled();
  });
});


describe('Runde4 A: the three additional plugin scopes use only explicit delegation', () => {
  it.each(['biblio', 'spatial', 'master'])('%s remains idle until its own KI mode is enabled', async pluginId => {
    fixture.plan.mockResolvedValue({ ...plan, steps: [step(pluginId)] });
    const view = render(<MoaAssistant pluginId={pluginId} autoMode={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(fixture.plan).not.toHaveBeenCalled(); expect(fixture.execute).not.toHaveBeenCalled();
    view.rerender(<MoaAssistant pluginId={pluginId} autoMode />); await tick();
    expect(fixture.plan).toHaveBeenCalledOnce();
    expect(fixture.plan.mock.calls[0][0]).toContain(pluginId + ':');
    expect(fixture.execute.mock.calls[0][0].steps).toEqual([step(pluginId)]);
    expect(fixture.execute.mock.calls[0][1]).toBe('session-holder');
    view.rerender(<MoaAssistant pluginId={pluginId} autoMode={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(fixture.plan).toHaveBeenCalledOnce();
  });
});


describe('Runde4 A: no global or unidentified automation', () => {
  it('never treats the aiMONK system field as a plugin timer, even if passed autoMode', async () => {
    render(<MoaAssistant pluginId="ai" autoMode />);
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(fixture.plan).not.toHaveBeenCalled(); expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('does not start a delegated plugin without an actor identity', async () => {
    fixture.rtc.userId = '';
    render(<MoaAssistant pluginId="biblio" autoMode />);
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(fixture.plan).not.toHaveBeenCalled(); expect(fixture.execute).not.toHaveBeenCalled();
  });
});

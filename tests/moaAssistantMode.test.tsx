// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn(), history: vi.fn(), rtc: { userId: 'session-holder' } }));
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

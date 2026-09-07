import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { AutomationCoalescer } from '../src/core/audio/state/automationCoalescer';

describe('AutomationCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('koalesziert mehrere Updates pro Key auf den letzten Wert', () => {
    const flushed: Array<[string, unknown]> = [];
    const c = new AutomationCoalescer((key, payload) => flushed.push([key, payload]), 16);

    c.push('effect:wet', { value: 1 });
    c.push('effect:wet', { value: 2 });
    c.push('effect:wet', { value: 3 });

    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(flushed).toEqual([['effect:wet', { value: 3 }]]);
  });

  test('flushNow sendet sofort ohne Timer', () => {
    const flushed: Array<[string, unknown]> = [];
    const c = new AutomationCoalescer((key, payload) => flushed.push([key, payload]), 16);

    c.push('dsp:drive', { value: 0.5 });
    c.flushNow();

    expect(flushed).toEqual([['dsp:drive', { value: 0.5 }]]);
  });
});

import { describe, expect, it } from 'vitest';
import { remainingSeconds, TAKEOVER_TIMEOUT_MS } from '../src/hooks/usePluginTakeover';

describe('R17 client countdown', () => {
  it('never shows a negative or invented time', () => {
    const deadline = 10_000;
    expect(remainingSeconds(deadline, 5_000)).toBe(5);
    expect(remainingSeconds(deadline, 10_000)).toBe(0);
    expect(remainingSeconds(deadline, 60_000)).toBe(0);
  });
  it('matches the server window', () => {
    expect(TAKEOVER_TIMEOUT_MS).toBe(5000);
  });
});

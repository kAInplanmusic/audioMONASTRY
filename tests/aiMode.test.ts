import { describe, expect, it, afterEach } from 'vitest';
import { setAiModeActive, isAiModeActive } from '../src/core/ai/aiMode';

describe('NEW-D1-3: AI-Modus-Flag', () => {
  afterEach(() => {
    setAiModeActive(false);
  });

  it('startet inaktiv und kann aktiviert/deaktiviert werden', () => {
    expect(isAiModeActive()).toBe(false);
    setAiModeActive(true);
    expect(isAiModeActive()).toBe(true);
    setAiModeActive(false);
    expect(isAiModeActive()).toBe(false);
  });
});

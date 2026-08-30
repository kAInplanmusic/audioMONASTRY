import { describe, expect, it } from 'vitest';
import { aiRuntime } from '../src/core/adapters';

describe('AIRuntime', () => {
  it('liefert deterministische Ergebnisse', async () => {
    const res = await aiRuntime.infer('stems', { file: 'x' });
    expect(res.kind).toBe('deterministic');
    const data = res.data as { task: string; echo: string };
    expect(data.task).toBe('stems');
    expect(data.echo).toContain('file');
  });

  it('kann alle Backend-Typen ausführen', () => {
    expect(aiRuntime.canRun('deterministic', 'separate')).toBe(true);
    expect(aiRuntime.canRun('local', 'generate')).toBe(true);
  });
});

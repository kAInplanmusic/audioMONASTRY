import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ large: true, rows: [] as string[], sync: vi.fn() }));
vi.mock('node:fs', () => ({
  readdirSync: () => ['101', '102', '999'],
  readFileSync: (path: string) => {
    if (path.endsWith('memory.max')) return '8589934592';
    if (path.endsWith('memory.current')) return '7500000000';
    const pid = Number(path.split('/')[2]);
    return `PPid:\t${pid === 102 ? 101 : 1}\nVmRSS:\t${pid === 999 ? 99999999 : state.large ? pid === 101 ? 5000000 : 2000000 : 1000} kB\n`;
  },
  appendFileSync: (_path: string, value: string) => { state.rows.push(value); },
  openSync: () => 12, fsyncSync: state.sync, closeSync: vi.fn(),
}));
import { sampleSessionMemory } from '../scripts/audit/live-memory-monitor';
it('warns above 80% RSS, includes descendants but excludes unrelated processes and persists the sample', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const high = sampleSessionMemory(101, 'fixture.ndjson');
    expect(high.rssBytes).toBe(7168000000); expect(high.processes).toBe(2);
    expect(high.warningAbove80Percent).toBe(true); expect(warning).toHaveBeenCalledTimes(1);
    expect(state.sync).toHaveBeenCalled(); expect(JSON.parse(state.rows[0]).rssBytes).toBe(high.rssBytes);
    state.large = false;
    expect(sampleSessionMemory(101, 'fixture.ndjson').warningAbove80Percent).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});

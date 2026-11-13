import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HandoverObserver, LiveGuard, type CostSample } from '../scripts/audit/live-guard';
import { LiveJournal } from '../scripts/audit/live-journal';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'live-guard-'));
  const journal = new LiveJournal(directory), stops: string[] = [];
  journal.record({ type: 'raw', sample: 'preserved before termination' });
  const guard = new LiveGuard({ sessionId: 'test', simulation: true, record: event => journal.record(event), flush: () => journal.flush(), stop: reason => {
    const rows = readFileSync(join(directory, 'raw.ndjson'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(rows[0].sample).toBe('preserved before termination'); expect(rows.at(-1).reason).toBe(reason);
    expect(JSON.parse(readFileSync(join(directory, 'checkpoint.json'), 'utf8')).records).toBe(rows.length);
    stops.push(reason);
  } });
  return { guard, stops, journal, directory, close: () => rmSync(directory, { recursive: true }) };
}
it('actual-spend contract stops at 50 EUR; all raw records durable before stop, exactly once', async () => {
  const f = fixture(); try {
    const sample: CostSample = { sessionId: 'test', currency: 'EUR', totalEur: 49.99, observedAt: 0, source: 'simulation', scopeComplete: true };
    await f.guard.cost(sample, 0); expect(f.stops).toEqual([]);
    await f.guard.cost({ ...sample, totalEur: 50, observedAt: 30000 }, 30000);
    await f.guard.halt('duplicate'); expect(f.stops).toEqual(['session-cap-50-eur']);
  } finally { f.close(); }
});
it('network concealment >20% in a rolling 30s window stops; raw saved, glitchRate remains null', async () => {
  const f = fixture(); try {
    await f.guard.rtp('receiver/ssrc', 0, 0, 100); expect(f.stops).toEqual([]);
    await f.guard.rtp('receiver/ssrc', 31000, 21, 100);
    expect(f.stops).toEqual(['network-concealment-over-20-percent']);
    expect(readFileSync(join(f.directory, 'raw.ndjson'), 'utf8')).toContain('"glitchRate":null');
  } finally { f.close(); }
});
it('handover over 5s stops before recovery, repeated owner changes do not reset outage; raw saved', async () => {
  const f = fixture(), observer = new HandoverObserver(); try {
    expect(observer.observe('a', true, 0)).toBeNull();
    await f.guard.handover(observer.observe('b', false, 100)?.outageSeconds ?? null);
    await f.guard.handover(observer.observe('c', false, 5100)?.outageSeconds ?? null); expect(f.stops).toEqual([]);
    await f.guard.handover(observer.observe('c', false, 5101)?.outageSeconds ?? null);
    expect(f.stops).toEqual(['handover-over-5-seconds']);
  } finally { f.close(); }
});
it('continuous flush retains all records; unknown/stale/foreign/estimated costs fail closed and save before stop', async () => {
  for (const bad of [null, { sessionId: 'other', currency: 'EUR', totalEur: 0, observedAt: 0, source: 'simulation', scopeComplete: true },
    { sessionId: 'test', currency: 'EUR', totalEur: 0, observedAt: -30001, source: 'simulation', scopeComplete: true },
    { sessionId: 'test', currency: 'EUR', totalEur: 0, observedAt: 0, source: 'tariff-estimate', scopeComplete: true }]) {
    const f = fixture(); try {
      f.journal.flush(); f.journal.record({ type: 'raw', sample: 'after periodic flush' });
      await f.guard.cost(bad as CostSample | null, 0);
      expect(f.stops).toEqual(['cost-unavailable-or-invalid']);
      expect(readFileSync(join(f.directory, 'raw.ndjson'), 'utf8')).toContain('after periodic flush');
    } finally { f.close(); }
  }
});

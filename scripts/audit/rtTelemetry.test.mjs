import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, procStat, cpuPercent } from './rtTelemetry.mjs';

test('nearest-rank percentiles keep outliers and do not mutate raw samples', () => {
  const samples = [100, ...Array(99).fill(1)];
  assert.deepEqual(distribution(samples), { count: 100, p50: 1, p95: 1, p99: 1, max: 100 });
  assert.equal(samples[0], 100);
  assert.equal(distribution([]).p50, null);
});

test('Linux stat parser handles a comm containing spaces and closing parentheses', () => {
  const fields = Array(20).fill('0');
  fields[11] = '50'; fields[12] = '25'; fields[19] = '12345';
  assert.deepEqual(procStat('42 (mixer ) holder) ' + fields.join(' ')), { ticks: 75, startTicks: '12345' });
});

test('process CPU uses actual elapsed time, one core baseline and rejects PID reuse', () => {
  const a = { ticks: 100, startTicks: '42' };
  assert.equal(cpuPercent(a, { ticks: 150, startTicks: '42' }, 2000, 100), 25);
  assert.throws(() => cpuPercent(a, { ticks: 150, startTicks: '43' }, 2000, 100), /reused/);
});

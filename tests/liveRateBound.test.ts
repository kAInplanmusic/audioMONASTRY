import { expect, it } from 'vitest';
import { LiveGuard, type CostSample } from '../scripts/audit/live-guard';
function fixture() {
  const events: any[] = [], stops: string[] = []; let flushed = false;
  const guard = new LiveGuard({ sessionId: 'rate-test', record: e => events.push(e), flush: () => { flushed = true; },
    stop: reason => { expect(flushed).toBe(true); stops.push(reason); } });
  return { guard, events, stops };
}
it('rate upper bound logs both rates and stops at 50 EUR, raw flushed before stop', async () => {
  const f = fixture(), rates = { rEchtEurPerHour: 10, rGuardEurPerHour: 15, safetyFactor: 1.5 };
  await f.guard.budget(null, 0, 11999999, rates); expect(f.stops).toEqual([]);
  await f.guard.budget(null, 30000, 12000000, rates);
  expect(f.stops).toEqual(['session-cap-50-eur-upper-bound']);
  const row = f.events.filter(e => e.type === 'cost-upper-bound').at(-1);
  expect(row).toMatchObject({ upperEur: 50, rEchtEurPerHour: 10, rGuardEurPerHour: 15,
    label: 'Obergrenze (R_guard), keine Ist-Kosten', decisionSource: 'rate-upper-bound' });
});
it('validated actual spend takes priority; invalid supplied actual data fails closed', async () => {
  const rates = { rEchtEurPerHour: 10, rGuardEurPerHour: 15, safetyFactor: 1.5 };
  const actual: CostSample = { sessionId: 'rate-test', currency: 'EUR', totalEur: 10, observedAt: 0, source: 'provider-api-actual-spend', scopeComplete: true };
  const f = fixture(); await f.guard.budget(actual, 0, 12000000, rates); expect(f.stops).toEqual([]);
  await f.guard.budget({ ...actual, totalEur: 50, observedAt: 30000 }, 30000, 12030000, rates);
  expect(f.stops).toEqual(['session-cap-50-eur']);
  const bad = fixture(); await bad.guard.budget({ ...actual, scopeComplete: false }, 0, 0, rates);
  expect(bad.stops).toEqual(['cost-unavailable-or-invalid']);
});
it('invalid or rewound bounds fail closed; unavailable cost without approved bound still fails closed', async () => {
  for (const rates of [{ rEchtEurPerHour: 10, rGuardEurPerHour: 14, safetyFactor: 1.5 },
    { rEchtEurPerHour: NaN, rGuardEurPerHour: 15, safetyFactor: 1.5 }]) {
    const f = fixture(); await f.guard.budget(null, 0, 0, rates); expect(f.stops).toEqual(['invalid-rate-upper-bound']);
  }
  const f = fixture(); await f.guard.budget(null, 0, 0); expect(f.stops).toEqual(['cost-unavailable-or-invalid']);
  const back = fixture(), rates = { rEchtEurPerHour: 1, rGuardEurPerHour: 1.5, safetyFactor: 1.5 };
  await back.guard.budget(null, 0, 100, rates); await back.guard.budget(null, 0, 99, rates);
  expect(back.stops).toEqual(['invalid-rate-upper-bound']);
});

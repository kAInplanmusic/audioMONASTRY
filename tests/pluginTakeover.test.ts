import { describe, expect, it } from 'vitest';
import { PluginTakeoverCoordinator } from '../server/pluginTakeover';

/** In-memory session double: locks + membership, no timers, settings stay untouched. */
function harness(options: { members?: string[]; holders?: Record<string, string> } = {}) {
  const locks = new Map<string, string>(Object.entries(options.holders ?? { mixer: 'dj' }));
  const members = new Set(options.members ?? ['dj', 'holder', 'third']);
  const settings = new Map<string, Record<string, unknown>>([['eq', { low: 6, mid: -3, high: 2 }], ['master', { gain: 0.8, bands: Array(12).fill(0) }]]);
  const timers = new Map<string, () => void>();
  const events: string[] = [];
  let seq = 0;
  const coordinator = new PluginTakeoverCoordinator({
    ownerOf: (id) => locks.get(id) ?? null,
    isMember: (id) => members.has(id),
    transfer: (id, from, to) => {
      if ((locks.get(id) ?? null) !== from) return { ok: false };
      locks.set(id, to); events.push(`transfer:${id}:${from}->${to}`); return { ok: true };
    },
    acquire: (id, to) => { if (locks.has(id)) return { ok: false }; locks.set(id, to); return { ok: true }; },
    release: (id, from) => { if ((locks.get(id) ?? null) !== from) return false; locks.delete(id); return true; },
    schedule: (fn) => { const key = `t${seq++}`; timers.set(key, fn); return key; },
    cancel: (handle) => { timers.delete(String(handle)); },
    onChange: (event) => events.push(event.kind),
  });
  return {
    coordinator, locks, members, settings, events,
    fireTimers: () => { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } },
    timerCount: () => timers.size,
  };
}

describe('R17 DJ takeover — scenarios A–E', () => {
  it('A: the holder accepts and the DJ inherits the exact settings', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder' } });
    const ask = await h.coordinator.request('dj', 'eq');
    expect(ask.outcome).toBe('pending');
    const answer = await h.coordinator.answer('holder', ask.requestId!, true);
    expect(answer).toMatchObject({ ok: true, outcome: 'accepted' });
    expect(h.locks.get('eq')).toBe('dj');
    // state carry-over: the session settings were never touched by the takeover
    expect(h.settings.get('eq')).toEqual({ low: 6, mid: -3, high: 2 });
    expect(h.coordinator.historyEntries().at(-1)).toMatchObject({ pluginId: 'eq', outcome: 'accepted' });
  });

  it('B: a denial changes nothing and blocks an immediate retry', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder' } });
    const ask = await h.coordinator.request('dj', 'eq');
    expect(await h.coordinator.answer('holder', ask.requestId!, false)).toMatchObject({ ok: true, outcome: 'denied' });
    expect(h.locks.get('eq')).toBe('holder');
    expect(h.timerCount()).toBe(0);
    expect((await h.coordinator.request('dj', 'eq')).outcome).toBe('denied');
  });

  it('C: without an answer the five-second deadline transfers automatically', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder' } });
    const ask = await h.coordinator.request('dj', 'eq');
    expect(ask.outcome).toBe('pending');
    expect(h.timerCount()).toBe(1);
    h.fireTimers();
    await Promise.resolve();
    expect(h.locks.get('eq')).toBe('dj');
    expect(h.coordinator.historyEntries().at(-1)).toMatchObject({ outcome: 'timeout' });
  });

  it('D: an explicit return hands the plugin back with the values the DJ left', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder' } });
    const ask = await h.coordinator.request('dj', 'eq');
    await h.coordinator.answer('holder', ask.requestId!, true);
    h.settings.set('eq', { low: -9, mid: 4, high: 0 }); // the DJ changed values while holding
    expect(await h.coordinator.returnTo('eq', 'dj')).toMatchObject({ ok: true, outcome: 'returned' });
    expect(h.locks.get('eq')).toBe('holder');
    expect(h.settings.get('eq')).toEqual({ low: -9, mid: 4, high: 0 });
  });

  it('E: an offline holder is taken over immediately without a countdown', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'gone' }, members: ['dj', 'holder', 'third'] });
    const ask = await h.coordinator.request('dj', 'eq');
    expect(ask).toMatchObject({ outcome: 'holder-offline' });
    expect(h.locks.get('eq')).toBe('dj');
    expect(h.timerCount()).toBe(0);
  });

  it('refuses non-DJs, the mixer itself and self-takeover', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder', master: 'dj' } });
    expect((await h.coordinator.request('holder', 'eq')).outcome).toBe('denied');
    expect((await h.coordinator.request('dj', 'mixer')).outcome).toBe('denied');
    expect((await h.coordinator.request('dj', 'master')).outcome).toBe('denied');
  });

  it('returns taken plugins when the DJ disconnects and void pending asks', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder', master: 'holder' } });
    const ask = await h.coordinator.request('dj', 'eq');
    await h.coordinator.answer('holder', ask.requestId!, true);
    const second = await h.coordinator.request('dj', 'master');
    expect(second.outcome).toBe('pending');
    await h.coordinator.handleDisconnect('dj');
    expect(h.locks.get('eq')).toBe('holder');
    expect(h.locks.get('master')).toBe('holder');
    expect(h.coordinator.list()).toHaveLength(0);
  });

  it('does not let a third party answer someone else\'s request', async () => {
    const h = harness({ holders: { mixer: 'dj', eq: 'holder' } });
    const ask = await h.coordinator.request('dj', 'eq');
    expect(await h.coordinator.answer('third', ask.requestId!, true)).toMatchObject({ ok: false, reason: 'not-holder' });
    expect(h.locks.get('eq')).toBe('holder');
  });
});

import { describe, expect, it } from 'vitest';
import { AuthoritativeSession, MAX_PLUGIN_SETTINGS_CHARS } from '../src/core/session/authoritativeSession';
import { PluginSettingsStore, mergeKnown, type PluginSettingsTransport } from '../src/core/session/pluginSettingsSync';

// ---------------------------------------------------------------------------
// Beständige Plugins (Betreiber 2026-10-06): „Wenn User 3 aus dem EQ rausgeht
// und User 4 rein, muss die Einstellung bleiben – für alle Plugins."
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

describe('AuthoritativeSession – Plugin-Stand', () => {
  it('nur der Halter darf den Stand schreiben', () => {
    const s = new AuthoritativeSession();
    expect(s.setPluginSettings('eq', 'u3', { gains: [1] }, T0)).toEqual({ ok: false, reason: 'not-owner' });
    s.acquireLock('eq', 'u3', T0);
    const r = s.setPluginSettings('eq', 'u3', { gains: [1, 2] }, T0 + 1);
    expect(r.ok).toBe(true);
    expect(s.setPluginSettings('eq', 'u4', { gains: [9] }, T0 + 2)).toEqual({ ok: false, reason: 'not-owner' });
    expect(s.getPluginSettings('eq')?.settings).toEqual({ gains: [1, 2] });
  });

  it('der Stand bleibt nach dem Verlassen und gehört dann dem nächsten Halter', () => {
    const s = new AuthoritativeSession();
    s.acquireLock('eq', 'u3', T0);
    s.setPluginSettings('eq', 'u3', { gains: [3] }, T0 + 1);
    s.releaseLock('eq', 'u3', T0 + 2);
    expect(s.getPluginSettings('eq')?.settings).toEqual({ gains: [3] });
    s.acquireLock('eq', 'u4', T0 + 3);
    expect(s.snapshot(T0 + 3).pluginSettings.eq.settings).toEqual({ gains: [3] });
    s.setPluginSettings('eq', 'u4', { gains: [4] }, T0 + 4);
    expect(s.getPluginSettings('eq')?.updatedBy).toBe('u4');
  });

  it('Revisionen steigen, ungültige und zu große Stände werden abgewiesen', () => {
    const s = new AuthoritativeSession();
    s.acquireLock('dsp', 'u1', T0);
    const a = s.setPluginSettings('dsp', 'u1', { a: 1 }, T0);
    const b = s.setPluginSettings('dsp', 'u1', { a: 2 }, T0);
    expect(a.ok && b.ok && b.entry.revision > a.entry.revision).toBe(true);
    expect(s.setPluginSettings('dsp', 'u1', [1, 2] as unknown, T0).ok).toBe(false);
    expect(s.setPluginSettings('dsp', 'u1', null, T0).ok).toBe(false);
    expect(s.setPluginSettings('dsp', 'u1', { big: 'x'.repeat(MAX_PLUGIN_SETTINGS_CHARS) }, T0)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('übersteht Sicherung und Wiederherstellung (Server-Neustart)', () => {
    const s = new AuthoritativeSession();
    s.acquireLock('mixer', 'u1', T0);
    s.setPluginSettings('mixer', 'u1', { xfd: 0.3 }, T0);
    const restored = AuthoritativeSession.restore(JSON.parse(JSON.stringify(s.serialize(T0))));
    expect(restored.getPluginSettings('mixer')?.settings).toEqual({ xfd: 0.3 });
    // Ältere Sicherungen ohne Feld laden weiter.
    const old = { ...s.serialize(T0) } as Record<string, unknown>;
    delete old.pluginSettings;
    expect(AuthoritativeSession.restore(old as never).getPluginSettings('mixer')).toBeNull();
  });
});

function fakeTransport(holders: Set<string>) {
  const sent: { pluginId: string; settings: unknown }[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const t: PluginSettingsTransport = {
    send: (pluginId, settings) => sent.push({ pluginId, settings }),
    isHolder: (id) => holders.has(id),
    setTimer: (fn) => { const h = next++; timers.set(h, fn); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  const runTimers = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); };
  return { t, sent, runTimers, timers };
}

describe('PluginSettingsStore – Client', () => {
  it('liest den Einstiegsstand aus dem Session-Snapshot', () => {
    const { t } = fakeTransport(new Set());
    const store = new PluginSettingsStore(t);
    store.acceptSnapshot({ pluginSettings: { eq: { settings: { gains: [5] }, revision: 3, updatedBy: 'u3' } } });
    expect(store.read('eq')).toEqual({ gains: [5] });
    expect(store.read('dsp')).toBeNull();
  });

  it('ältere Stände überschreiben nie neuere', () => {
    const { t } = fakeTransport(new Set());
    const store = new PluginSettingsStore(t);
    store.accept('eq', { settings: { v: 2 }, revision: 5 });
    expect(store.accept('eq', { settings: { v: 1 }, revision: 4 })).toBe(false);
    expect(store.read('eq')).toEqual({ v: 2 });
  });

  it('nur der Halter sendet – entprellt, gleiche Werte nicht doppelt', () => {
    const holders = new Set<string>();
    const { t, sent, runTimers } = fakeTransport(holders);
    const store = new PluginSettingsStore(t);
    store.write('eq', { v: 1 });
    runTimers();
    expect(sent).toEqual([]);
    holders.add('eq');
    store.write('eq', { v: 1 });
    store.write('eq', { v: 2 });
    store.write('eq', { v: 2 });
    runTimers();
    expect(sent).toEqual([{ pluginId: 'eq', settings: { v: 2 } }]);
  });

  it('Verlassen sendet sofort (flush), ein ausstehender eigener Stand gewinnt gegen ältere Meldungen', () => {
    const holders = new Set(['eq']);
    const { t, sent, timers } = fakeTransport(holders);
    const store = new PluginSettingsStore(t);
    store.write('eq', { v: 7 });
    expect(store.accept('eq', { settings: { v: 1 }, revision: 99 })).toBe(false);
    store.flush('eq');
    expect(sent).toEqual([{ pluginId: 'eq', settings: { v: 7 } }]);
    expect(timers.size).toBe(0);
    expect(store.hasPending('eq')).toBe(false);
  });

  it('Bereiche eines Plugins speichern unabhängig (syntisampler: mpc, sampler, synth)', () => {
    const holders = new Set(['syntisampler']);
    const { t, sent, runTimers } = fakeTransport(holders);
    const store = new PluginSettingsStore(t);
    store.write('syntisampler', { bank: 'A' }, 'mpc');
    store.write('syntisampler', { wave: 'saw' }, 'synth');
    runTimers();
    expect(store.read('syntisampler', 'mpc')).toEqual({ bank: 'A' });
    expect(store.read('syntisampler', 'synth')).toEqual({ wave: 'saw' });
    expect(sent.at(-1)?.settings).toEqual({ mpc: { bank: 'A' }, synth: { wave: 'saw' } });
  });
});

describe('mergeKnown', () => {
  it('übernimmt nur bekannte Felder mit passendem Typ', () => {
    const def = { gain: 0.8, on: true, mode: 'A', bands: [0, 0] };
    expect(mergeKnown(def, { gain: 0.5, on: false, mode: 'B', bands: [1, 2], extra: 1 })).toEqual({ gain: 0.5, on: false, mode: 'B', bands: [1, 2] });
    expect(mergeKnown(def, { gain: 'laut', on: 1, mode: 5, bands: 'x' })).toEqual(def);
    expect(mergeKnown(def, { gain: Number.NaN })).toEqual(def);
    expect(mergeKnown(def, null)).toEqual(def);
  });
});

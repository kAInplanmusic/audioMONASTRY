import { describe, expect, it } from 'vitest';
import { AuthoritativeSession } from '../src/core/session/authoritativeSession';
import {
  nextModeStep,
  pluginModeOf,
  pluginOwnerOf,
  pluginPanelOpen,
  pluginSummary,
} from '../src/core/session/pluginMode';
import {
  SYNC_PLUGINS,
  isPluginSynced,
  isSyncPlugin,
  pluginSyncSnapshot,
  pluginSyncVersion,
  setPluginSync,
  subscribePluginSync,
} from '../src/core/session/pluginSync';

// ---------------------------------------------------------------------------
// UI2-P0-001/002/003: Modi OFF/STBY/ON, mixerMONK immer mit genau einem
// Halter, SYNC gegen Main. Geprüft wird die Wirkung der reinen Helfer.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const held = (by: string) => ({ active: true, lockedBy: by });

describe('pluginMode – sichtbarer Modus', () => {
  it('bildet Lock und Modul-Zustand auf OFF/STBY/ON ab', () => {
    expect(pluginModeOf('eq', 'OFF', undefined)).toBe('OFF');
    expect(pluginModeOf('eq', 'OFF', held('u1'))).toBe('STBY');
    expect(pluginModeOf('eq', 'PRO', held('u1'))).toBe('ON');
    expect(pluginModeOf('eq', 'AUTO_AI', undefined)).toBe('ON');
    expect(pluginModeOf('eq', undefined, { active: false, lockedBy: 'u1' })).toBe('OFF');
  });

  it('mixerMONK ist immer ON', () => {
    expect(pluginModeOf('mixer', 'OFF', undefined)).toBe('ON');
    expect(pluginModeOf('mixer', undefined, held('u2'))).toBe('ON');
  });

  it('liest den Halter nur aus aktiven Locks', () => {
    expect(pluginOwnerOf(held('u1'))).toBe('u1');
    expect(pluginOwnerOf({ active: false, lockedBy: 'u1' })).toBeNull();
    expect(pluginOwnerOf({ active: true, lockedBy: null })).toBeNull();
    expect(pluginOwnerOf(undefined)).toBeNull();
  });
});

describe('pluginMode – Modus-Button OFF → STBY → ON → OFF', () => {
  it('durchläuft den Zyklus für den Halter', () => {
    expect(nextModeStep('eq', 'OFF', null, 'me')).toEqual({ kind: 'acquire' });
    expect(nextModeStep('eq', 'STBY', 'me', 'me')).toEqual({ kind: 'activate' });
    expect(nextModeStep('eq', 'ON', 'me', 'me')).toEqual({ kind: 'release' });
  });

  it('holt ein haltloses laufendes Plugin zuerst', () => {
    expect(nextModeStep('eq', 'ON', null, 'me')).toEqual({ kind: 'acquire' });
  });

  it('sperrt fremde Plugins (kein Anfragen, kein Übernehmen)', () => {
    const step = nextModeStep('eq', 'STBY', 'other', 'me');
    expect(step.kind).toBe('denied');
    if (step.kind === 'denied') expect(step.reason).toContain('other');
  });

  it('mixerMONK lässt sich nicht schließen, nur übergeben', () => {
    const step = nextModeStep('mixer', 'ON', 'me', 'me');
    expect(step.kind).toBe('denied');
    if (step.kind === 'denied') expect(step.reason).toMatch(/übergeben/);
  });
});

describe('pluginMode – Bedienfläche und Zusammenfassung', () => {
  it('öffnet die Bedienfläche nur für den Halter bei ON', () => {
    expect(pluginPanelOpen('eq', 'ON', 'me', 'me')).toBe(true);
    expect(pluginPanelOpen('eq', 'STBY', 'me', 'me')).toBe(false);
    expect(pluginPanelOpen('eq', 'ON', 'other', 'me')).toBe(false);
    expect(pluginPanelOpen('mixer', 'ON', 'me', 'me')).toBe(true);
    expect(pluginPanelOpen('mixer', 'ON', 'other', 'me')).toBe(false);
  });

  it('liefert passende Zeilen für Nicht-Bediener', () => {
    expect(pluginSummary('eq', 'OFF', null, 'me')).toMatch(/Frei/);
    expect(pluginSummary('eq', 'ON', 'other', 'me', 'Kai')).toContain('Kai');
    expect(pluginSummary('eq', 'STBY', 'me', 'me')).toMatch(/Bypass/);
    expect(pluginSummary('eq', 'ON', 'me', 'me')).toBe('');
    expect(pluginSummary('mixer', 'ON', 'me', 'me')).toBe('');
    expect(pluginSummary('mixer', 'ON', 'other', 'me', 'Kai')).toContain('Kai');
  });
});

describe('AuthoritativeSession.ensureHolder – mixerMONK hat immer einen Halter', () => {
  it('vergibt an das erste Mitglied, wenn niemand hält', () => {
    const s = new AuthoritativeSession();
    expect(s.ensureHolder('mixer', ['u1', 'u2'], T0)).toBe('u1');
    expect(s.lockOwner('mixer', T0)).toBe('u1');
  });

  it('behält einen anwesenden Halter', () => {
    const s = new AuthoritativeSession();
    s.ensureHolder('mixer', ['u1', 'u2'], T0);
    expect(s.ensureHolder('mixer', ['u2', 'u1'], T0 + 1)).toBeNull();
    expect(s.lockOwner('mixer', T0 + 1)).toBe('u1');
  });

  it('gibt an das am längsten anwesende Mitglied weiter, wenn der Halter geht', () => {
    const s = new AuthoritativeSession();
    s.ensureHolder('mixer', ['u1', 'u2', 'u3'], T0);
    expect(s.ensureHolder('mixer', ['u2', 'u3'], T0 + 1)).toBe('u2');
    expect(s.lockOwner('mixer', T0 + 1)).toBe('u2');
  });

  it('ein zweiter Halter ist unmöglich, übergeben kann nur der Halter', () => {
    const s = new AuthoritativeSession();
    s.ensureHolder('mixer', ['u1', 'u2'], T0);
    expect(s.acquireLock('mixer', 'u2', T0 + 1).ok).toBe(false);
    expect(s.lockOwner('mixer', T0 + 1)).toBe('u1');
    expect(s.transferLock('mixer', 'u2', 'u1', T0 + 2).ok).toBe(false);
    expect(s.lockOwner('mixer', T0 + 2)).toBe('u1');
    expect(s.transferLock('mixer', 'u1', 'u2', T0 + 3).ok).toBe(true);
    expect(s.lockOwner('mixer', T0 + 3)).toBe('u2');
  });

  it('vergibt nichts in einer leeren Sitzung', () => {
    const s = new AuthoritativeSession();
    expect(s.ensureHolder('mixer', [], T0)).toBeNull();
    expect(s.ensureHolder('mixer', ['', '  '], T0)).toBeNull();
    expect(s.lockOwner('mixer', T0)).toBeNull();
  });
});

describe('pluginSync – SYNC gegen Main', () => {
  it('kennt genau die spielenden Plugins, Standard an', () => {
    expect([...SYNC_PLUGINS].sort()).toEqual(['drop', 'drumsampler', 'instru', 'song', 'sound', 'stem', 'syntisampler', 'voice']);
    for (const id of SYNC_PLUGINS) expect(isPluginSynced(id)).toBe(true);
    expect(isSyncPlugin('eq')).toBe(false);
    expect(isPluginSynced('master')).toBe(false);
  });

  it('schaltet SYNC, meldet Änderungen und ignoriert Nicht-Spieler', () => {
    let calls = 0;
    const off = subscribePluginSync(() => { calls += 1; });
    const v0 = pluginSyncVersion();
    expect(setPluginSync('drop', false)).toBe(true);
    expect(isPluginSynced('drop')).toBe(false);
    expect(pluginSyncVersion()).toBe(v0 + 1);
    expect(setPluginSync('drop', false)).toBe(true); // keine Änderung
    expect(calls).toBe(1);
    expect(setPluginSync('eq', true)).toBe(false);
    expect(pluginSyncSnapshot().drop).toBe(false);
    setPluginSync('drop', true);
    off();
    expect(calls).toBe(2);
  });
});

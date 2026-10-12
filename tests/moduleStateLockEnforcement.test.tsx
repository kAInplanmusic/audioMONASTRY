// @vitest-environment jsdom
/**
 * DA-2026-09-29-044 · Die Modul-Sperre sitzt am ZENTRALEN Setter
 * =====================================================================
 * Fund (Deep-Audit): die Sperrpruefung lag nur im UX-Hook (`usePluginState`);
 * der zentrale Setter `ModuleStateContext.setModuleState` uebernahm lokale
 * Aufrufe ohne Owner-Pruefung - ein direkter Aufruf umging die Sperre still.
 *
 * `tests/mainOutGuard.test.ts` prueft die reine Regel. HIER wird die
 * VERDRAHTUNG geprueft: dass der Provider den autoritativen Lock-Schatten
 * (Server-Broadcasts) wirklich an die Regel uebergibt. Ohne diese Pruefung waere
 * die Regel korrekt und trotzdem wirkungslos, wenn niemand sie mit Daten
 * versorgt - genau diese Luecke war im ersten Anlauf nur per tsc + Review
 * abgedeckt.
 *
 * Der Server bleibt die autoritative Grenze (`server/realtime.ts`, Abschnitt
 * "K-2: Lock serverseitig durchsetzen" - geprueft und unveraendert). Dieser Test
 * deckt die Client-Seite ab, die das Ticket als Chokepoint benennt.
 *
 * WICHTIG beim Lesen: Zusicherungen laufen ueber `apiRef.current` (den Kontextwert
 * des JEWEILS LETZTEN Renders). Eine beim Mounten eingefangene Referenz ist nach
 * einer Zustandsaenderung veraltet - damit werden Negativ-Pruefungen wertlos
 * (genau das war der erste Anlauf dieses Tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import React, { useEffect } from 'react';

const { wrtc, listeners } = vi.hoisted(() => {
  const listeners: Record<string, (msg: unknown) => void> = {};
  const off = () => () => {};
  const sent: unknown[] = [];
  const wrtc = {
    userId: 'user-me' as string | null,
    isMainOutOwner: false,
    mainOutOwnerId: null as string | null,
    sent,
    sendToAllPeers: (msg: unknown) => {
      sent.push(msg);
    },
    onSessionState: (cb: (snapshot: unknown) => void) => {
      listeners.sessionState = cb;
      return off();
    },
    onPluginLock: (cb: (msg: unknown) => void) => {
      listeners.lock = cb;
      return off();
    },
    onPluginUnlock: (cb: (msg: unknown) => void) => {
      listeners.unlock = cb;
      return off();
    },
    onPluginLocksSync: (cb: (msg: unknown) => void) => {
      listeners.locksSync = cb;
      return off();
    },
    addDataChannelListener: (cb: (msg: unknown) => void) => {
      listeners.dataChannel = cb;
      return off();
    },
  };
  return { wrtc, listeners };
});

vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: wrtc }));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: { setIdleSilence: vi.fn() } }));
vi.mock('../src/core/pluginAudioRouter', () => ({ routeModuleState: vi.fn() }));
vi.mock('../src/core/ai/aiMode', () => ({ setAiModeFromModuleState: vi.fn() }));
vi.mock('../src/core/ai/aiGate', () => ({ setAiOperatingModeForModuleState: vi.fn() }));

import { ModuleStateProvider, useModuleState } from '../src/context/ModuleStateContext';

type Zustand = 'OFF' | 'AUTO_AI' | 'PRO';
interface Api {
  moduleStates: Record<string, Zustand>;
  setModuleState: (id: string, state: Zustand) => void;
}

//: Ref-Konvention (Endung "Ref"): die React-Lint-Regel react-hooks/immutability
//: verbietet das Mutieren einer Modul-Variablen im Render - ein Ref-Objekt ist genau
//: dafuer da und bleibt die einfachste Moeglichkeit, den Kontextwert abzugreifen.
const apiRef: { current: Api | null } = { current: null };

/** Minimaler Konsument: veroeffentlicht den echten Kontextwert nach jedem Commit. */
function Harness() {
  const ctx = useModuleState();
  // Im Effekt statt direkt im Render: die React-Lint-Regel
  // react-hooks/immutability verbietet das Mutieren einer Modul-Variablen
  // waehrend des Renderns. Nach `act()` sind die Effekte gelaufen, damit ist der
  // Wert fuer die Zusicherungen aktuell.
  useEffect(() => {
    apiRef.current = ctx as unknown as Api;
  });
  return null;
}

function mount(): void {
  render(
    <ModuleStateProvider>
      <Harness />
    </ModuleStateProvider>,
  );
  if (!apiRef.current) throw new Error('Kontext nicht erfasst');
}

/** Aktueller Zustand eines Moduls - nie eine beim Mounten eingefangene Referenz. */
function zustand(id: string): Zustand | undefined {
  return apiRef.current?.moduleStates[id];
}

/** Ruft den zentralen Setter so auf, wie es eine UI-Stelle tun wuerde. */
function setze(id: string, state: Zustand): void {
  act(() => {
    apiRef.current?.setModuleState(id, state);
  });
}

/** Simuliert einen Server-Broadcast (Lock/Unlock/Locks-Snapshot). */
function broadcast(art: 'lock' | 'unlock' | 'locksSync', nachricht: unknown): void {
  act(() => {
    listeners[art]?.(nachricht);
  });
}

describe('DA-2026-09-29-044: Lock am zentralen Setter (Verdrahtung)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    wrtc.userId = 'user-me';
    wrtc.sent.length = 0;
    apiRef.current = null;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    cleanup();
  });

  it('weist den Nicht-Halter ab, wenn der Server einen fremden Lock gemeldet hat', () => {
    mount();
    broadcast('lock', { pluginId: 'eq', lockedBy: 'user-a' });
    setze('eq', 'PRO');
    expect(zustand('eq'), 'Der Zustand darf sich NICHT aendern').toBeUndefined();
    const verweigert = warn.mock.calls.some((call: unknown[]) => String(call[1] ?? '').includes('user-a'));
    expect(verweigert, 'Der Grund nennt den Halter').toBe(true);
    expect(wrtc.sent, 'Eine abgelehnte Aenderung darf nicht gebroadcastet werden').toHaveLength(0);
  });

  it('laesst den Halter schreiben und broadcastet dann', () => {
    mount();
    broadcast('lock', { pluginId: 'eq', lockedBy: 'user-a' });
    wrtc.userId = 'user-a';
    setze('eq', 'PRO');
    expect(zustand('eq')).toBe('PRO');
    expect(wrtc.sent).toHaveLength(1);
  });

  it('ohne Lock bleibt das Modul frei', () => {
    mount();
    setze('eq', 'PRO');
    expect(zustand('eq')).toBe('PRO');
  });

  it('ein Lock ohne Halter (Geister-Lock) sperrt niemanden aus', () => {
    mount();
    broadcast('lock', { pluginId: 'dsp', lockedBy: '' });
    setze('dsp', 'AUTO_AI');
    expect(zustand('dsp')).toBe('AUTO_AI');
  });

  it('nach dem Unlock darf der vorher blockierte Nutzer wieder schreiben', () => {
    mount();
    broadcast('lock', { pluginId: 'eq', lockedBy: 'user-a' });
    setze('eq', 'PRO');
    expect(zustand('eq'), 'gesperrt: keine Aenderung').toBeUndefined();
    broadcast('unlock', { pluginId: 'eq' });
    setze('eq', 'PRO');
    expect(zustand('eq'), 'entsperrt: Aenderung greift').toBe('PRO');
  });

  it('der Ersatz-Sync (Locks-Snapshot) setzt den Schatten ebenfalls', () => {
    mount();
    broadcast('locksSync', { locks: { eq: { active: true, lockedBy: 'user-a' } } });
    setze('eq', 'PRO');
    expect(zustand('eq')).toBeUndefined();
  });
});

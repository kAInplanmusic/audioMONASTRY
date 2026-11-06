// @vitest-environment jsdom
/**
 * AUDIT-2026-10-30-P1-018 · Autosave-Client wartet auf die Server-Bestätigung
 * ==========================================================================
 * Der Server (`server/routes/sessionRoutes.ts`) bestätigt einen Autosave
 * ausdrücklich (`{ ok: true, idempotent: true, key, url }`) und antwortet im
 * Fehlerfall mit 503/502 + `degraded`/`retryable`/`attempts`. Der Client hat
 * diese Antwort bisher NIE gelesen (`keepalive`-fetch ohne `res.ok`-Check):
 * ein 503 (R2 nicht konfiguriert) blieb unsichtbar, ein Reload verlor den
 * unbestätigten Umschlag.
 *
 * Diese Datei belegt die vier Zusagen des Fixes:
 *   1. `ok`/`key` der Antwort werden ausgewertet (kein stilles „gesendet“).
 *   2. 5xx und Netzfehler werden mit exponentiellem Backoff wiederholt;
 *      4xx (ungültige Nutzlast) nicht.
 *   3. Nicht bestätigte Umschläge liegen persistent in der bestehenden
 *      Storage-Schicht (`src/utils/storage.ts`) – nicht nur im Hook-State.
 *   4. Nach einem Reload (neuer Hook-Mount, gleicher Speicher) wird der
 *      unbestätigte Umschlag erneut gesendet (Durability) und erst nach
 *      Bestätigung entfernt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  AUTOSAVE_OUTBOX_KEY,
  OUTBOX_RETRY_INTERVAL_MS,
  describeAutosaveSync,
  readAutosaveOutbox,
  useSessionAutosave,
  type FetchLike,
} from '../src/hooks/useSessionAutosave';
import { resetStorageForTests, storageGetJson } from '../src/utils/storage';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const CONFIRMED_KEY = 'autosaves/rev-1-1700000000000.json';
const confirmedBody = () => ({
  ok: true,
  idempotent: true,
  key: CONFIRMED_KEY,
  url: `https://r2.example/${CONFIRMED_KEY}`,
});

/** 503, wie der Server ihn bei nicht konfiguriertem R2 liefert. */
const unconfiguredBody = () => ({
  ok: false,
  error: 'r2-not-configured',
  reason: 'not-configured',
  degraded: true,
  attempts: 1,
  retryable: true,
  hint: 'R2 ist nicht konfiguriert (docs/OPS_RUNBOOK.md, „R2 (F2)“).',
});

interface Harness {
  fetchImpl: ReturnType<typeof vi.fn<FetchLike>>;
  sleeps: number[];
  options: {
    fetchImpl: FetchLike;
    retry: { attempts: number; baseDelayMs: number; maxDelayMs: number; sleep: (ms: number) => Promise<void> };
  };
}

function harness(impl: (input: string, init?: RequestInit) => Promise<Response>): Harness {
  const fetchImpl = vi.fn<FetchLike>(impl);
  const sleeps: number[] = [];
  return {
    fetchImpl,
    sleeps,
    options: {
      fetchImpl,
      retry: {
        attempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 5_000,
        // Backoff-Reihenfolge bleibt echt (250, 500), die Wartezeit nicht.
        sleep: async (ms: number) => { sleeps.push(ms); },
      },
    },
  };
}

const sentBodies = (fetchImpl: Harness['fetchImpl']) =>
  fetchImpl.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as {
    idempotencyKey: string;
    revision: number;
    payload: unknown;
  });

beforeEach(() => {
  resetStorageForTests();
});

afterEach(() => {
  cleanup();
  resetStorageForTests();
});

describe('P1-018 · Autosave-Client wertet die Server-Bestätigung aus', () => {
  it('gilt erst nach { ok: true } als bestätigt und meldet Key + Status', async () => {
    const h = harness(async () => jsonResponse(200, confirmedBody()));
    const { result } = renderHook(() => useSessionAutosave(h.options));

    await act(async () => {
      result.current.schedule({ bpm: 140 });
      await result.current.flush();
    });

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0];
    expect(url).toBe('/api/session/autosave');
    expect(init?.method).toBe('POST');
    expect(init?.keepalive).toBe(true);

    expect(result.current.sync.state).toBe('synced');
    expect(result.current.sync.lastKey).toBe(CONFIRMED_KEY);
    expect(result.current.sync.pending).toBe(0);
    expect(result.current.sync.attempts).toBe(1);
    expect(describeAutosaveSync(result.current.sync)).toBe('Sync OK');
    expect(readAutosaveOutbox()).toEqual([]);
  });

  it('behandelt eine 200-Antwort ohne ok:true NICHT als Bestätigung', async () => {
    const h = harness(async () => jsonResponse(200, { idempotent: true }));
    const { result } = renderHook(() => useSessionAutosave(h.options));

    await act(async () => {
      result.current.schedule({ bpm: 140 });
      await result.current.flush();
    });

    expect(result.current.sync.state).toBe('failed');
    expect(result.current.sync.lastKey).toBeNull();
    expect(readAutosaveOutbox()).toHaveLength(1);
  });
});

describe('P1-018 · 5xx und Netzfehler werden mit Backoff wiederholt', () => {
  it('wiederholt 503 (R2 nicht konfiguriert) dreimal mit Backoff und hält den Umschlag vor', async () => {
    const h = harness(async () => jsonResponse(503, unconfiguredBody()));
    const { result } = renderHook(() => useSessionAutosave(h.options));

    await act(async () => {
      result.current.schedule({ bpm: 128 });
      await result.current.flush();
    });

    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([250, 500]);

    // Idempotenz: alle Wiederholungen tragen DENSELBEN Schlüssel.
    const keys = sentBodies(h.fetchImpl).map((b) => b.idempotencyKey);
    expect(new Set(keys).size).toBe(1);

    expect(result.current.sync.state).toBe('failed');
    expect(result.current.sync.pending).toBe(1);
    expect(result.current.sync.attempts).toBe(3);
    expect(result.current.sync.lastError).toContain('503');

    const outbox = readAutosaveOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].idempotencyKey).toBe(keys[0]);
    expect(outbox[0].attempts).toBe(3);
    expect(outbox[0].lastError).toContain('503');
    // ... und liegt in der bestehenden Storage-Schicht, nicht nur im State.
    expect(storageGetJson<unknown[]>(AUTOSAVE_OUTBOX_KEY)).toHaveLength(1);
  });

  it('wiederholt Netzfehler (fetch rejected) und hält den Umschlag vor', async () => {
    const h = harness(async () => { throw new TypeError('Failed to fetch'); });
    const { result } = renderHook(() => useSessionAutosave(h.options));

    await act(async () => {
      result.current.schedule({ bpm: 128 });
      await result.current.flush();
    });

    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([250, 500]);
    expect(result.current.sync.state).toBe('failed');
    expect(result.current.sync.lastError).toContain('Netz');
    expect(readAutosaveOutbox()).toHaveLength(1);
  });

  it('wiederholt 4xx NICHT (ungültige Nutzlast ist nicht heilbar) und zeigt sie an', async () => {
    const h = harness(async () => jsonResponse(400, { ok: false, error: 'invalid autosave payload' }));
    const { result } = renderHook(() => useSessionAutosave(h.options));

    await act(async () => {
      result.current.schedule({ bpm: 128 });
      await result.current.flush();
    });

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
    expect(result.current.sync.state).toBe('failed');
    expect(result.current.sync.lastError).toContain('400');
    expect(readAutosaveOutbox()).toHaveLength(1);
  });
});

describe('P1-018 · Wiederholung, solange die Seite lebt', () => {
  it('sendet offene Umschläge im Hintergrund erneut, sobald der Server wieder antwortet', async () => {
    vi.useFakeTimers();
    try {
      let online = false;
      const fetchImpl = vi.fn<FetchLike>(async () => (
        online ? jsonResponse(200, confirmedBody()) : jsonResponse(503, unconfiguredBody())
      ));
      const { result } = renderHook(() => useSessionAutosave({
        fetchImpl,
        // Ein Versuch je Lauf: hier zählt der Hintergrund-Takt, nicht der Backoff.
        retry: { attempts: 1, baseDelayMs: 250, maxDelayMs: 5_000, sleep: async () => {} },
      }));

      await act(async () => {
        result.current.schedule({ bpm: 124 });
        await result.current.flush();
      });
      expect(result.current.sync.state).toBe('failed');
      expect(readAutosaveOutbox()).toHaveLength(1);

      online = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_INTERVAL_MS);
      });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(readAutosaveOutbox()).toEqual([]);
      expect(result.current.sync.state).toBe('synced');
      expect(result.current.sync.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('P1-018 · Durability über den Reload', () => {
  it('sendet den unbestätigten Umschlag nach einem Reload erneut und entfernt ihn erst nach Bestätigung', async () => {
    // Erste Sitzung: R2 ist weg → der Umschlag bleibt unbestätigt liegen.
    const failing = harness(async () => jsonResponse(503, unconfiguredBody()));
    const first = renderHook(() => useSessionAutosave(failing.options));

    await act(async () => {
      first.result.current.schedule({ bpm: 132, isPlaying: true });
      await first.result.current.flush();
    });

    expect(first.result.current.sync.state).toBe('failed');
    const outbox = readAutosaveOutbox();
    expect(outbox).toHaveLength(1);
    const pendingKey = outbox[0].idempotencyKey;
    first.unmount();

    // „Reload“: neuer Hook-Mount, gleiche Storage-Schicht, R2 antwortet wieder.
    const recovered = harness(async () => jsonResponse(200, confirmedBody()));
    const second = renderHook(() => useSessionAutosave(recovered.options));

    await waitFor(() => expect(recovered.fetchImpl).toHaveBeenCalledTimes(1));

    const [url, init] = recovered.fetchImpl.mock.calls[0];
    expect(url).toBe('/api/session/autosave');
    expect(JSON.parse(String(init?.body)).idempotencyKey).toBe(pendingKey);

    await waitFor(() => expect(readAutosaveOutbox()).toEqual([]));
    await waitFor(() => expect(second.result.current.sync.state).toBe('synced'));
    expect(second.result.current.sync.lastKey).toBe(CONFIRMED_KEY);
    expect(second.result.current.sync.pending).toBe(0);
  });

  it('sendet einen beim Schließen (pagehide) gestarteten Umschlag beim nächsten Start erneut', async () => {
    // pagehide: Antwort kommt nicht mehr an (Tab zu) – kein ok, kein Ack.
    const dying = harness(async () => { throw new TypeError('Failed to fetch'); });
    const first = renderHook(() => useSessionAutosave(dying.options));

    await act(async () => {
      first.result.current.schedule({ bpm: 90 });
      window.dispatchEvent(new Event('pagehide'));
      await first.result.current.flush();
    });
    expect(readAutosaveOutbox()).toHaveLength(1);
    first.unmount();

    const recovered = harness(async () => jsonResponse(200, confirmedBody()));
    const second = renderHook(() => useSessionAutosave(recovered.options));
    await waitFor(() => expect(readAutosaveOutbox()).toEqual([]));
    await waitFor(() => expect(second.result.current.sync.state).toBe('synced'));
  });

  it('startet den Sync beim Mount auch ohne neue Änderung (Status ist sofort ehrlich)', () => {
    const h = harness(async () => jsonResponse(200, confirmedBody()));
    const { result } = renderHook(() => useSessionAutosave(h.options));
    // Nichts gespeichert → nichts zu senden, aber kein „OK“ vorgetäuscht.
    expect(result.current.sync.state).toBe('idle');
    expect(describeAutosaveSync(result.current.sync)).toBe('Sync bereit');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('P1-018 · Statuszeile', () => {
  it('beschreibt offene und fehlerhafte Zustände knapp und ohne Secrets', () => {
    const base = { pending: 0, attempts: 0, lastKey: null, lastError: null, lastConfirmedAt: null };
    expect(describeAutosaveSync({ ...base, state: 'idle' })).toBe('Sync bereit');
    expect(describeAutosaveSync({ ...base, state: 'sending' })).toBe('Sync läuft');
    expect(describeAutosaveSync({ ...base, state: 'synced', lastKey: 'k' })).toBe('Sync OK');
    expect(describeAutosaveSync({ ...base, state: 'pending', pending: 2 })).toBe('2 offen');
    expect(describeAutosaveSync({ ...base, state: 'failed', pending: 1, lastError: 'HTTP 503' })).toBe('1 offen · Fehler');
  });
});

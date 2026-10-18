/**
 * DA-2026-10-17-010 · Transienter Fehler im Song-Poll-Loop bricht den Task NICHT ab
 * =================================================================================
 * Der Befund: der `query_result`-Abruf lag ungeschuetzt im Poll-Loop von
 * `pollCompatibleTaskAudio` (ACE-Step/DiffRhythm). Ein einzelner
 * Timeout/ECONNRESET - oder eine halbe, unlesbare Antwort des Wrappers - warf
 * aus der Funktion heraus. Der laufende GPU-Job verfaell, obwohl bis zur
 * Deadline (300 s) Zeit gewesen waere; der Aufrufer sah 502.
 *
 * Geprueft wird die ECHTE Funktion mit gestubbtem `fetch` (kein Netz):
 *   - "flaky": zweimal unlesbarer Body, dann das Ergebnis mit Audio-URL
 *     auf dem Backend-Host -> der Task wird gerettet, der Buffer kommt an.
 *   - "kaputt": IMMER unlesbar -> begrenzter Abbruch mit UpstreamError
 *     code=POLL_FAILED nach N Fehlern IN FOLGE statt Hang bis zur Deadline.
 *
 * Gegenbeweis: ohne die Korrektur wirft die ERSTE unlesbare Antwort aus dem
 * Loop - der "flaky"-Fall wirft dann statt zu retten.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollCompatibleTaskAudio } from '../server/routes/voiceRoutes';

const BASE = 'http://ace-step.example.test:8001';
const HEADERS = { Authorization: 'Bearer test' };
const WAV = Buffer.alloc(44, 7);

type Body = string | Uint8Array;
interface Call { url: string; method: string }

function makeFetch(bodies: {
  query: () => Body | Error;
  audio?: () => Body | Error;
}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? 'GET') });
    if (url.includes('/query_result')) {
      const next = bodies.query();
      if (next instanceof Error) throw next;
      return new Response(next, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/audio/')) {
      const next = bodies.audio ? bodies.audio() : WAV;
      if (next instanceof Error) throw next;
      const payload: BodyInit = typeof next === 'string' ? next : new Blob([new Uint8Array(next)]);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }
    return new Response('nein', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function okResult(): Body {
  return JSON.stringify({
    data: [{ task_id: 't-da010', status: 1, result: JSON.stringify([{ file: `${BASE}/audio/t-da010.wav` }]) }],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DA-2026-10-17-010 · Song-Poll-Loop ist resilient', () => {
  it('rettet den Task nach transienten Fehlern (2x unlesbare Antwort)', async () => {
    let queryCount = 0;
    const { fetch, calls } = makeFetch({
      query: () => {
        queryCount += 1;
        return queryCount <= 2
          ? '<!doctype html><html><body>upstream hiccup</body></html>'
          : okResult();
      },
    });
    vi.stubGlobal('fetch', fetch);

    const buf = await pollCompatibleTaskAudio({
      base: BASE,
      headers: HEADERS,
      taskId: 't-da010',
      deadline: Date.now() + 30_000,
      timeoutMs: 30_000,
      label: 'ACE-Step',
    });

    expect(buf.length).toBe(44);
    // Der Stub wurde mehrfach gefragt: 2 Fehler, dann das Ergebnis.
    expect(calls.filter((c) => c.url.includes('/query_result')).length).toBe(3);
    // Der Audio-Download ging an den Backend-Host (Allowlist erfuellt).
    expect(calls.some((c) => c.url === `${BASE}/audio/t-da010.wav`)).toBe(true);
  }, 40_000);

  it('rettet den Task auch nach echten Netz-Fehlern (fetch wirft)', async () => {
    let queryCount = 0;
    const { fetch, calls } = makeFetch({
      query: () => {
        queryCount += 1;
        // ECONNRESET-Form: der Abruf selbst fliegt (wie der Befundfall).
        if (queryCount <= 2) throw new Error('connect ECONNRESET 10.0.0.5:8001');
        return okResult();
      },
    });
    vi.stubGlobal('fetch', fetch);

    const buf = await pollCompatibleTaskAudio({
      base: BASE,
      headers: HEADERS,
      taskId: 't-da010',
      deadline: Date.now() + 30_000,
      timeoutMs: 30_000,
      label: 'ACE-Step',
    });
    expect(buf.length).toBe(44);
    expect(calls.filter((c) => c.url.includes('/query_result')).length).toBe(3);
  }, 40_000);

  it('bricht bei DAUERFehlern begrenzt ab (POLL_FAILED) statt bis zur Deadline zu hängen', async () => {
    const { fetch, calls } = makeFetch({
      query: () => '<!doctype html><html><body>immer noch kaputt</body></html>',
    });
    vi.stubGlobal('fetch', fetch);

    const started = Date.now();
    await expect(pollCompatibleTaskAudio({
      base: BASE,
      headers: HEADERS,
      taskId: 't-da010',
      deadline: Date.now() + 600_000,
      timeoutMs: 600_000,
      label: 'ACE-Step',
    })).rejects.toMatchObject({ code: 'POLL_FAILED' });
    const elapsed = Date.now() - started;

    // Begrenzt: 5 Versuche IN FOLGE (je 2 s Pause), NICHT die 600-s-Deadline.
    expect(elapsed).toBeLessThan(60_000);
    expect(calls.filter((c) => c.url.includes('/query_result')).length).toBeGreaterThanOrEqual(5);
    expect(calls.filter((c) => c.url.includes('/query_result')).length).toBeLessThan(12);
  }, 60_000);
});

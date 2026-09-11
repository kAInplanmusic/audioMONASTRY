import { describe, expect, it } from 'vitest';
import { AiJobRuntime } from '../src/core/ai/orchestrator/aiJobRuntime';

// ---------------------------------------------------------------------------
// AI-P1-002: AI-Job-Runtime. Geprüft wird die Isolation (kein synchroner
// Job-Start, Event-Loop bleibt frei), Concurrency-Grenze, Timeout mit Abort
// und Cancellation (wartend + laufend).
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AiJobRuntime – Isolation & Concurrency', () => {
  it('führt Job-Code nie synchron in submit() aus (Render-Thread-Schutz)', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 1 });
    let stillInSubmit = true;
    const handle = rt.submit(async () => {
      // Dieser Punkt wird erst NACH dem Rückkehr von submit() erreicht.
      expect(stillInSubmit).toBe(false);
      return 'fertig';
    });
    stillInSubmit = false;
    const result = await handle.promise;
    expect(result.status).toBe('completed');
    expect(result.value).toBe('fertig');
  });

  it('hält die Concurrency-Grenze ein und startet die nächsten Jobs nach', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 3 });
    const running: number[] = [];
    let peak = 0;
    const handles = Array.from({ length: 12 }, (_, i) =>
      rt.submit(async () => {
        running.push(i);
        peak = Math.max(peak, running.length);
        await wait(5);
        running.splice(running.indexOf(i), 1);
        return i;
      }),
    );
    const results = await Promise.all(handles.map((h) => h.promise));
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    const stats = rt.snapshot();
    expect(stats.completed).toBe(12);
    expect(stats.peakRunning).toBeLessThanOrEqual(3);
    expect(stats.submitted).toBe(12);
    expect(stats.queued).toBe(0);
    expect(stats.running).toBe(0);
  });

  it('bevorzugt höhere Priorität, sonst FIFO', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 1 });
    const order: string[] = [];
    // Alle synchron einreihen, damit die Reihenfolge deterministisch ist.
    const a = rt.submit(async () => { order.push('a'); }, { priority: 0 });
    const b = rt.submit(async () => { order.push('b'); }, { priority: 5 });
    const c = rt.submit(async () => { order.push('c'); }, { priority: 0 });
    await Promise.all([a.promise, b.promise, c.promise]);
    expect(order).toEqual(['b', 'a', 'c']);
  });

  it('drain() kehrt erst zurück, wenn Queue und aktive Jobs leer sind', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 2 });
    let done = 0;
    for (let i = 0; i < 5; i++) rt.submit(async () => { await wait(3); done++; });
    await rt.drain();
    expect(done).toBe(5);
    expect(rt.snapshot().running).toBe(0);
    expect(rt.snapshot().queued).toBe(0);
  });

  it('leistet unter Last den Event-Loop nicht aus (Ticker läuft weiter)', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 2 });
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 1);
    for (let i = 0; i < 20; i++) {
      rt.submit(async () => { await wait(3); return i; });
    }
    await rt.drain();
    clearInterval(ticker);
    // Wäre der Loop blockiert, könnte der Ticker nicht mehrfach feuern.
    expect(ticks).toBeGreaterThan(3);
  });
});

describe('AiJobRuntime – Timeout & Cancellation', () => {
  it('beendet hängende Jobs per Timeout und löst das AbortSignal aus', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 1, defaultTimeoutMs: 20 });
    let aborted = false;
    const handle = rt.submit((signal) => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; });
      // bewusst nie auflösen – der Timeout muss greifen.
      void resolve;
    }));
    const result = await handle.promise;
    expect(result.status).toBe('timeout');
    expect((result.error as { code?: string } | undefined)?.code).toBe('AI_JOB_TIMEOUT');
    expect(aborted).toBe(true);
    expect(rt.snapshot().timedOut).toBe(1);
    expect(rt.snapshot().running).toBe(0);
  });

  it('startet abgebrochene, wartende Jobs nie', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 1 });
    const first = rt.submit(async () => { await wait(30); return 'first'; });
    let secondRan = false;
    const second = rt.submit(async () => { secondRan = true; return 'second'; });
    expect(rt.cancel(second.id, 'user-abort')).toBe(true);
    expect((await second.promise).status).toBe('cancelled');
    await first.promise;
    expect(secondRan).toBe(false);
    expect(rt.snapshot().cancelled).toBe(1);
  });

  it('bricht laufende Jobs ab und gibt den Slot sofort frei', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 1 });
    let aborted = false;
    const first = rt.submit((signal) => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; });
      setTimeout(() => resolve('zu spät'), 100);
    }));
    // Warten, bis der Job sicher läuft.
    await wait(5);
    expect(rt.snapshot().running).toBe(1);
    const next = rt.submit(async () => 'next');
    expect(rt.cancel(first.id)).toBe(true);
    expect((await first.promise).status).toBe('cancelled');
    expect(aborted).toBe(true);
    // Nächster Job darf trotz hängendem Provider sofort laufen.
    const nextResult = await next.promise;
    expect(nextResult.status).toBe('completed');
    expect(nextResult.value).toBe('next');
  });

  it('meldet Provider-Fehler als Status statt als Rejection', async () => {
    const rt = new AiJobRuntime({ maxConcurrent: 2 });
    const handle = rt.submit(async () => { throw new Error('kaputt'); });
    const result = await handle.promise;
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('kaputt');
    expect(rt.snapshot().failed).toBe(1);
  });

  it('lehnt doppelte Job-IDs ab', () => {
    const rt = new AiJobRuntime();
    rt.submit(async () => 1, { id: 'dup' });
    expect(() => rt.submit(async () => 2, { id: 'dup' })).toThrow(/bereits vergeben/);
  });
});

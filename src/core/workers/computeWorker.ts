/**
 * audioMONASTRY · Offline-Compute-Worker
 * -------------------------------------
 * Führt ein registriertes, rechenintensives "task" im Offline-Modus aus und
 * blockiert so nie den Main-/Audio-Thread. Tasks werden über einen
 * `taskRegistry`-Import registriert; unbekannte Tasks werden als "deterministic
 * reducer" ausgeführt, damit das Pool-System nie einen Task ablehnen muss.
 */

import { COMPUTE_HANDLERS, type ComputeHandler } from '../computeHandlers';

type Handler = ComputeHandler;

self.onmessage = async (e: MessageEvent) => {
  const { id, task, input } = e.data || {};
  try {
    const handler: Handler | undefined =
      (self as any).__taskFn || COMPUTE_HANDLERS[String(task)];
    if (typeof handler !== 'function') {
      (self as any).postMessage({ id, ok: false, error: `Unbekannter Task: ${task}` });
      return;
    }
    const out = await handler(input);
    (self as any).postMessage({ id, ok: true, out });
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};

// Erlaubt das Zur-Verfügung-Stellen eigener Funktionen vom Main-Thread (optional).
export type { Handler };

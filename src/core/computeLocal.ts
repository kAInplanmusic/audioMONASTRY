/**
 * audioMONASTRY · Lokal-Ausführung (Main-Thread-Fallback, Aufg. 2.2.2)
 * -------------------------------------------------------------------
 * Wird genutzt, wenn Web-Worker blockiert sind (CSP etc.). Hält die Job-Logik
 * identisch zum Worker, damit Offline-Berechnungen nie einfach ausfallen.
 */
import { COMPUTE_HANDLERS } from './computeHandlers';

export async function computeLocal(task: string, input: unknown): Promise<unknown> {
  const fn = COMPUTE_HANDLERS[task];
  if (!fn) throw new Error(`Unbekannter Task (lokal): ${task}`);
  return await fn(input);
}

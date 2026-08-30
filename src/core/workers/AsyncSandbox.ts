/**
 * audioMONASTRY · 2.2.2 – Async-Operation-Sandboxing
 * ===================================================
 * Strikte Trennung sync (Live) / async (Offline). Alle nicht-echtzeitkritischen
 * Operationen laufen über den WorkerPool; schlägt der Worker fehl, greift der
 * lokale Fallback – der Audio-Thread bleibt in jedem Fall reaktionsfähig.
 */
import { workerPool } from './WorkerPool';

export type SandboxedTask<T, R> = (input: T) => R | Promise<R>;

const registry = new Map<string, SandboxedTask<unknown, unknown>>();

export function registerSandboxedTask<T, R>(task: string, fn: SandboxedTask<T, R>): void {
  registry.set(task, fn as SandboxedTask<unknown, unknown>);
}

/** Führt einen Offline-Task aus (Worker zuerst, dann lokaler Fallback). */
export async function runOffline<T, R>(task: string, input: T): Promise<R> {
  try {
    return await workerPool.submit<T, R>(task, input);
  } catch {
    const fn = registry.get(task);
    if (!fn) throw new Error(`Sandboxed-Task nicht registriert: ${task}`);
    return await (fn as SandboxedTask<T, R>)(input);
  }
}

/** Führt einen Live-Task synchron auf dem Main-Thread aus (kurz & vorhersagbar). */
export function runLive<T, R>(task: string, input: T): R {
  const fn = registry.get(task);
  if (!fn) throw new Error(`Live-Task nicht registriert: ${task}`);
  return (fn as SandboxedTask<T, R>)(input) as R;
}

/**
 * audioMONASTRY · Upstream-Fehler an den Client (DA-2026-10-17-014)
 * ================================================================
 * Vorher ging der Body des internen AI-Runtimes ungefiltert in die Antwort:
 *   `AI-Runtime ${model} HTTP ${resp.status}: ${detail.slice(0, 300)}`
 * Damit sahen Browser Stacktraces, interne Hostnamen und Modell-/Pfadangaben.
 *
 * Regel hier:
 *   - der Client bekommt eine GENERISCHE Meldung, einen stabilen Code und eine
 *     Correlation-ID (damit Support/Log zusammengefuehrt werden koennen),
 *   - die Ursache (Status, Body-Auszug, Fehlertext) wird NUR serverseitig
 *     geloggt.
 */
import type { Response } from 'express';

/** Fehler mit internem Detail; `message` ist bewusst NICHT client-tauglich. */
export class UpstreamError extends Error {
  constructor(
    /** stabiler Code, z. B. `UPSTREAM_HTTP`, `NO_AUDIO`, `TIMEOUT` */
    readonly code: string,
    message: string,
    /** Detail fuer das Server-Log (Body-Auszug, Host, Modell …). */
    readonly internalDetail?: string,
    /** HTTP-Status des Upstreams, falls vorhanden. */
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

let correlationSeq = 0;

/** Kurze, nicht erratbare Correlation-ID fuer Client + Log. */
export function newCorrelationId(prefix = 'ai'): string {
  correlationSeq = (correlationSeq + 1) % 1_000_000;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${correlationSeq.toString(36)}-${rand}`;
}

/** Schneidet einen Upstream-Body fuer das Log (nie fuer den Client). */
export function logDetail(err: unknown, max = 300): string {
  if (err instanceof UpstreamError) {
    return String(err.internalDetail ?? err.message ?? '').slice(0, max);
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.slice(0, max);
}

export interface UpstreamFailure {
  /** generische Meldung, z. B. `tts fehlgeschlagen` */
  error: string;
  code: string;
  correlationId: string;
}

/**
 * Loggt die Ursache serverseitig vollstaendig und liefert die Client-Nutzlast.
 * Bewusst ein reines Datenobjekt: der Aufrufer entscheidet ueber den Status.
 */
export function upstreamFailure(label: string, err: unknown): UpstreamFailure {
  const correlationId = newCorrelationId();
  const code = err instanceof UpstreamError ? err.code : 'UPSTREAM_FAILED';
  const status = err instanceof UpstreamError && err.upstreamStatus ? ` status=${err.upstreamStatus}` : '';
  console.error(`[ai] ${label} fehlgeschlagen (${correlationId}) code=${code}${status}: ${logDetail(err)}`);
  return { error: `${label} fehlgeschlagen`, code, correlationId };
}

/**
 * Antwortet mit 502 und der generischen Nutzlast. Der `detail`-Block der alten
 * Routen entfaellt ersatzlos (DA-2026-10-17-014).
 */
export function sendUpstreamFailure(res: Response, label: string, err: unknown): void {
  const payload = upstreamFailure(label, err);
  res.status(502).json(payload);
}

/**
 * audioMONASTRY · 6.1.4 – Fehler-Tracking & Diagnose
 * ===================================================
 * Klassifiziert und priorisiert Laufzeitfehler mit Kontext. Historie wird im
 * Storage gehalten (max. 200 Einträge) und kann als JSON exportiert werden.
 */
import { storageGetJson, storageSetJson } from './storage';
import { random } from './random';

export interface TrackedError {
  id: string;
  message: string;
  source: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context: Record<string, unknown>;
  timestamp: number;
}

const KEY = 'audiomonastry_error_log';

function classify(message: string): TrackedError['severity'] {
  if (/audio|worklet|buffer|context/i.test(message)) return 'critical';
  if (/midi|webrtc|transport|sync/i.test(message)) return 'high';
  if (/fetch|network|api|supabase/i.test(message)) return 'medium';
  return 'low';
}

export function trackError(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): TrackedError {
  const message = error instanceof Error ? error.message : String(error);
  const entry: TrackedError = {
    id: `${Date.now()}_${random().toString(36).slice(2, 8)}`,
    message,
    source,
    severity: classify(message),
    context,
    timestamp: Date.now(),
  };
  const list = storageGetJson<TrackedError[]>(KEY) ?? [];
  list.unshift(entry);
  storageSetJson(KEY, list.slice(0, 200));
  console.error(`[error-tracker] ${entry.severity.toUpperCase()} [${source}]`, message, context);
  reportErrorToServer(entry);
  return entry;
}

/**
 * Auto-Logging: meldet Fehler an den Server (/api/telemetry), der sie als
 * JSON-Line ins Docker-Log schreibt (Log-Rotation greift) und in den
 * Prometheus-Metriken zählt. Fire-and-forget mit keepalive.
 */
export function reportErrorToServer(entry: TrackedError): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'error', source: entry.source, message: entry.message, context: entry.context, ts: entry.timestamp }] }),
      keepalive: true,
    }).catch(() => { /* offline/Feuer-und-vergessen */ });
  } catch { /* noop */ }
}

export function errorLog(): TrackedError[] {
  return storageGetJson<TrackedError[]>(KEY) ?? [];
}

export function errorStats(): Record<TrackedError['severity'], number> {
  const stats: Record<TrackedError['severity'], number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const e of errorLog()) stats[e.severity]++;
  return stats;
}

/**
 * Studio-Speicher ↔ Server (Betreiber 2026-10-06: „NICHTS wird auf den Geräten
 * der Nutzer gespeichert")
 * ==========================================================================
 * - Beim Start alle Einträge vom Server vorladen (GET /api/store), bevor die
 *   Oberfläche zeichnet – Presets, Favoriten usw. sind sofort da.
 * - Schreiben geht über den Socket an die Session (erst nach dem Beitritt;
 *   vorher wird gesammelt und danach gesendet).
 * - Änderungen anderer Geräte kommen live zurück.
 * - Einmalig: alte Gerätedaten (localStorage, Browser-Datenbank) auf den Server
 *   übernehmen und danach vom Gerät löschen – auch Dateien im Gerät (OPFS).
 *
 * Werte gehen als JSON-Text über die Leitung (der Server prüft JSON).
 */
import { applyServerStore, setStudioStoreTransport, storageGet, storageSet, storageSetJson, takeLegacyLocalStorage } from './storage';
import { takeLegacyIndexedDb } from './indexedDB';
import { purgeDeviceFiles } from './opfs';
import { webRTCManager } from './WebRTCManager';

const pending = new Map<string, string | null>();
let joined = false;

function flush(): void {
  for (const [key, value] of pending) {
    if (value === null) webRTCManager.sendStoreRemove(key);
    else webRTCManager.sendStoreSet(key, JSON.stringify(value));
  }
  pending.clear();
}

/** Server-Antwort (Werte als JSON-Text) in Rohtexte für den Adapter wandeln. */
export function decodeServerEntries(entries: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!entries || typeof entries !== 'object') return out;
  for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') out[key] = value;
    } catch { /* ungültiger Eintrag – überspringen */ }
  }
  return out;
}

let started = false;

/** Einmal beim Start (main.tsx), vor dem ersten Zeichnen. */
export async function startStudioStoreSync(timeoutMs = 2500): Promise<void> {
  if (started) return;
  started = true;

  setStudioStoreTransport({
    set: (key, value) => {
      pending.set(key, value);
      if (joined) flush();
    },
    remove: (key) => {
      pending.set(key, null);
      if (joined) flush();
    },
  });
  // Nach jedem (Wieder-)Beitritt kommt ein Session-Snapshot: jetzt darf geschrieben werden.
  webRTCManager.onSessionState(() => {
    joined = true;
    flush();
  });
  webRTCManager.onStoreUpdate((msg: { key?: unknown; value?: unknown }) => {
    const key = typeof msg?.key === 'string' ? msg.key : '';
    if (!key) return;
    if (msg.value === null) applyServerStore({ [key]: null });
    else applyServerStore(decodeServerEntries({ [key]: msg.value }));
  });

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('/api/store', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const body = (await res.json()) as { entries?: unknown };
      applyServerStore(decodeServerEntries(body.entries));
    }
  } catch { /* Server nicht erreichbar – Start ohne vorgeladene Einträge */ }

  // Einmalige Übernahme alter Gerätedaten, danach ist das Gerät leer.
  for (const [key, value] of Object.entries(takeLegacyLocalStorage())) {
    if (storageGet(key) === null) storageSet(key, value);
  }
  void takeLegacyIndexedDb().then(({ kv, scratchpad }) => {
    for (const [key, value] of Object.entries(kv)) {
      if (storageGet(key) === null) storageSetJson(key, value);
    }
    if (scratchpad.length > 0 && storageGet('audiomonastry_scratchpad') === null) {
      storageSetJson('audiomonastry_scratchpad', scratchpad);
    }
  });
  void purgeDeviceFiles();
}

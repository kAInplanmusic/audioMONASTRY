import { useCallback, useEffect, useMemo, useState } from 'react';
import { SessionAutosave } from '../core/persistence/sessionAutosave';
import { createBestEffortStore, type BestEffortStore } from '../core/persistence/browserStore';

/**
 * audioMONASTRY · App-Wiring für den Session-Autosave (PERSIST-P1-002)
 * =====================================================================
 * Hängt den reinen Persistenz-Kern (`SessionAutosave`) an die React-App:
 *   - lokaler Store: IndexedDB, sonst ehrlicher In-Memory-Fallback
 *   - `schedule(payload)` debounced speichern (schnelle Änderungen coalescen)
 *   - `flush()` bei `pagehide` (Tab zu / Reload) → letzter Stand geht nicht verloren
 *   - best-effort Remote-Sync des letzten Umschlags an `/api/session/autosave`
 *     (Idempotenz über den stabilen `idempotencyKey` des Umschlags)
 */

export interface SessionAutosaveHandle {
  schedule: (payload: unknown) => void;
  flush: () => Promise<void>;
  /** `indexeddb` = persistent · `memory` = nur für die Sitzung. */
  kind: BestEffortStore['kind'];
}

export function useSessionAutosave(): SessionAutosaveHandle {
  // Einmalige Instanz pro Mount (useState-Lazy-Init, kein Ref-Zugriff im Render).
  const [state] = useState(() => {
    const best = createBestEffortStore();
    return {
      autosave: new SessionAutosave(best.store, {
        key: 'session-autosave',
        retry: { attempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 },
      }),
      kind: best.kind,
    };
  });
  const { autosave, kind } = state;

  const schedule = useCallback((payload: unknown) => {
    autosave.schedule(payload);
  }, [autosave]);

  const flush = useCallback(async () => {
    await autosave.flush();
    // Remote-Sink best effort: derselbe Umschlag (idempotencyKey) darf
    // mehrfach ankommen – der Server schreibt deterministisch denselben Key.
    const envelope = autosave.getLastEnvelope();
    if (!envelope) return;
    try {
      await fetch('/api/session/autosave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        keepalive: true,
      });
    } catch {
      /* offline/Server nicht erreichbar – lokaler Stand ist bereits sicher */
    }
  }, [autosave]);

  useEffect(() => {
    const onPageHide = () => {
      void flush();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [flush]);

  return useMemo(() => ({ schedule, flush, kind }), [schedule, flush, kind]);
}

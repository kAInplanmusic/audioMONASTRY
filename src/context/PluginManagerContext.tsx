import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { LockStatus } from '../plugins/types';
import { webRTCManager } from '../utils/WebRTCManager';
import { parseSessionSnapshot } from '../core/session/sessionStateBridge';

/** Default lock TTL: 5 Minuten clientseitig als Fallback-Obergrenze.
 * ARCH-#2: Der Server-Sweep läuft mit 60 s TTL (PLUGIN_LOCK_TTL_MS) und
 * broadcastet den Ablauf jetzt aktiv per plugin-unlock — der lokale Wert
 * dient nur noch der Anzeige, nicht mehr als Lock-Wahrheit. */
const DEFAULT_LOCK_TTL = 5 * 60 * 1000;
/** How often to check for expired locks */
const LOCK_SWEEP_INTERVAL = 30_000;

interface PluginManagerContextType {
  pluginLocks: Record<string, LockStatus>;
  requestLock: (pluginId: string, userId: string) => boolean;
  releaseLock: (pluginId: string, userId: string) => void;
}

const PluginManagerContext = createContext<PluginManagerContextType | undefined>(undefined);

export const PluginManagerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [pluginLocks, setPluginLocks] = useState<Record<string, LockStatus>>({});
  // AM-E3-1: Ref ist die Source of Truth – Lock-Entscheidung passiert AUSSERHALB
  // des setState-Updaters (React 18/StrictMode darf Updater doppelt aufrufen).
  const locksRef = useRef<Record<string, LockStatus>>({});

  const commit = useCallback((next: Record<string, LockStatus>) => {
    locksRef.current = next;
    setPluginLocks(next);
  }, []);

  // K-2/K-5: Server-autoritative Lock-Replikation übernehmen.
  useEffect(() => {
    const offLock = webRTCManager.onPluginLock((msg: any) => {
      const pluginId = String(msg?.pluginId ?? '');
      const lockedBy = String(msg?.lockedBy ?? '');
      if (!pluginId || !lockedBy) return;
      commit({
        ...locksRef.current,
        [pluginId]: {
          lockedBy,
          timestamp: Number(msg?.timestamp ?? Date.now()),
          active: true,
          ttl: Number(msg?.ttl ?? DEFAULT_LOCK_TTL),
        },
      });
    });
    const offUnlock = webRTCManager.onPluginUnlock((msg: any) => {
      const pluginId = String(msg?.pluginId ?? '');
      if (!pluginId) return;
      commit({ ...locksRef.current, [pluginId]: { lockedBy: null, timestamp: 0, active: false } });
    });
    // K-2/K-5: Lock-Denial vom Server (Lock wurde von anderem User gehalten).
    // Ohne diesen Handler bliebe der optimistische Lock des Clients stehen
    // und desynced von der server-autoritativen Wahrheit.
    const offDenied = webRTCManager.onPluginLockDenied((msg: any) => {
      const pluginId = String(msg?.pluginId ?? '');
      if (!pluginId) return;
      commit({
        ...locksRef.current,
        [pluginId]: {
          lockedBy: String(msg?.lockedBy ?? ''),
          timestamp: Date.now(),
          active: true,
          ttl: DEFAULT_LOCK_TTL,
        },
      });
    });
    const offSync = webRTCManager.onPluginLocksSync((msg: any) => {
      const raw = msg?.locks;
      if (!raw || typeof raw !== 'object') return;
      const next: Record<string, LockStatus> = {};
      for (const [id, lock] of Object.entries<any>(raw)) {
        if (lock?.active && lock?.lockedBy) {
          next[id] = {
            lockedBy: String(lock.lockedBy),
            timestamp: Number(lock.timestamp ?? Date.now()),
            active: true,
            ttl: Number(lock.ttl ?? DEFAULT_LOCK_TTL),
          };
        }
      }
      commit(next);
    });
    return () => { offLock(); offUnlock(); offDenied(); offSync(); };
  }, [commit]);

  // COLLAB-P0-002: der vollständige Server-Snapshot (join/resync) trägt die
  // Locks mit Lease-Zeiten. Der Server schickt zusätzlich plugin-locks-sync
  // (Legacy-Format); der Snapshot ergänzt/überschreibt autoritativ.
  useEffect(() => {
    return webRTCManager.onSessionState((snapshot: unknown) => {
      const parsed = parseSessionSnapshot(snapshot);
      if (!parsed) return;
      const next = { ...locksRef.current };
      for (const [pluginId, lock] of Object.entries(parsed.locks)) {
        next[pluginId] = {
          lockedBy: lock.lockedBy,
          timestamp: lock.timestamp,
          active: lock.active,
          ttl: lock.ttl,
        };
      }
      commit(next);
    });
  }, [commit]);

  // Sweep expired locks periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const prev = locksRef.current;
      let changed = false;
      const next = { ...prev };
      for (const [id, lock] of Object.entries(next)) {
        const ttl = lock.ttl ?? DEFAULT_LOCK_TTL;
        if (lock.active && now - lock.timestamp > ttl) {
          next[id] = { lockedBy: null, timestamp: 0, active: false };
          changed = true;
        }
      }
      if (changed) commit(next);
    }, LOCK_SWEEP_INTERVAL);
    return () => clearInterval(interval);
  }, [commit]);

  const requestLock = useCallback((pluginId: string, userId: string) => {
    // Identität niemals aus dem Aufruf übernehmen: maßgeblich ist der
    // WebRTC-Manager (lokale Session-Identität des Browsers).
    const localUserId = webRTCManager.userId;
    if (userId !== localUserId) return false;

    const now = Date.now();
    const prev = locksRef.current;
    const lock = prev[pluginId];
    // ROLLENSYSTEM ENTFERNT: keine admin/producer-Übernahme mehr. Ein aktiver
    // Fremd-Lock kann nicht mehr lokal übernommen werden – der Server ist die
    // Wahrheit und lehnt acquireLock ab, solange der Lease läuft.
    if (lock && lock.active && lock.lockedBy !== localUserId) {
      const ttl = lock.ttl ?? DEFAULT_LOCK_TTL;
      if (now - lock.timestamp <= ttl) {
        return false; // Already locked by someone else
      }
      // Lock expired, allow override
    }
    commit({
      ...prev,
      [pluginId]: { lockedBy: localUserId, timestamp: now, active: true, ttl: DEFAULT_LOCK_TTL }
    });
    webRTCManager.sendPluginLock(pluginId);
    return true;
  }, [commit]);

  const releaseLock = useCallback((pluginId: string, userId: string) => {
    const localUserId = webRTCManager.userId;
    if (userId !== localUserId) return;
    const lock = locksRef.current[pluginId];
    if (lock?.active && lock.lockedBy && lock.lockedBy !== localUserId) return;
    commit({
      ...locksRef.current,
      [pluginId]: { lockedBy: null, timestamp: 0, active: false }
    });
    webRTCManager.sendPluginUnlock(pluginId);
  }, [commit]);

  return (
    <PluginManagerContext.Provider value={{ pluginLocks, requestLock, releaseLock }}>
      {children}
    </PluginManagerContext.Provider>
  );
};

export const usePluginManager = () => {
  const context = useContext(PluginManagerContext);
  if (!context) throw new Error('usePluginManager must be used within a PluginManagerProvider');
  return context;
};

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { LockStatus } from '../plugins/types';
import { isAiModeActive } from '../core/ai/aiMode';

/** Default lock TTL: 5 minutes */
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
    const now = Date.now();
    const prev = locksRef.current;
    const lock = prev[pluginId];
    // NEW-D1-3: Halter-Wechsel für mixerMONK nur im AI-Modus erlaubt.
    // In diesem Fall darf ein anderer User den Mixer-Lock übernehmen.
    if (pluginId === 'mixer' && isAiModeActive() && lock && lock.active && lock.lockedBy !== userId) {
      commit({
        ...prev,
        [pluginId]: { lockedBy: userId, timestamp: now, active: true, ttl: DEFAULT_LOCK_TTL }
      });
      return true;
    }
    if (lock && lock.active && lock.lockedBy !== userId) {
      const ttl = lock.ttl ?? DEFAULT_LOCK_TTL;
      if (now - lock.timestamp <= ttl) {
        return false; // Already locked by someone else
      }
      // Lock expired, allow override
    }
    commit({
      ...prev,
      [pluginId]: { lockedBy: userId, timestamp: now, active: true, ttl: DEFAULT_LOCK_TTL }
    });
    return true;
  }, [commit]);

  const releaseLock = useCallback((pluginId: string, _userId: string) => {
    commit({
      ...locksRef.current,
      [pluginId]: { lockedBy: null, timestamp: 0, active: false }
    });
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

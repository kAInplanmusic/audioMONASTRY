import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { LockStatus } from '../plugins/types';

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

  // Sweep expired locks periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setPluginLocks(prev => {
        const now = Date.now();
        let changed = false;
        const next = { ...prev };
        for (const [id, lock] of Object.entries(next)) {
          const ttl = lock.ttl ?? DEFAULT_LOCK_TTL;
          if (lock.active && now - lock.timestamp > ttl) {
            next[id] = { lockedBy: null, timestamp: 0, active: false };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, LOCK_SWEEP_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const requestLock = useCallback((pluginId: string, userId: string) => {
    let granted = false;
    setPluginLocks(prev => {
      const lock = prev[pluginId];
      // Check expiry inline
      const now = Date.now();
      if (lock && lock.active && lock.lockedBy !== userId) {
        const ttl = lock.ttl ?? DEFAULT_LOCK_TTL;
        if (now - lock.timestamp <= ttl) {
          granted = false;
          return prev; // Already locked by someone else
        }
        // Lock expired, allow override
      }
      granted = true;
      return {
        ...prev,
        [pluginId]: { lockedBy: userId, timestamp: now, active: true, ttl: DEFAULT_LOCK_TTL }
      };
    });
    return granted;
  }, []);

  const releaseLock = useCallback((pluginId: string, _userId: string) => {
    setPluginLocks(prev => ({
      ...prev,
      [pluginId]: { lockedBy: null, timestamp: 0, active: false }
    }));
  }, []);

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

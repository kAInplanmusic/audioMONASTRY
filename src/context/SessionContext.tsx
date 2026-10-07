import React, { createContext, useContext, useState } from 'react';
import { AudioSample } from '../data/samples';
import { storageGetJson, storageSetJson } from '../utils/storage';

/** Zwischenablage im Studio-Speicher (Server) – nichts auf dem Gerät. */
const SCRATCHPAD_KEY = 'audiomonastry_scratchpad';

interface ScratchpadItem extends AudioSample {
  lastModified: number;
}

interface SessionContextType {
  scratchpadItems: ScratchpadItem[];
  addToScratchpad: (sample: AudioSample) => void;
  removeFromScratchpad: (id: string) => void;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [scratchpadItems, setScratchpadItems] = useState<ScratchpadItem[]>(
    () => storageGetJson<ScratchpadItem[]>(SCRATCHPAD_KEY) ?? [],
  );

  const addToScratchpad = (sample: AudioSample) => {
    const newItem = { ...sample, lastModified: Date.now() };
    setScratchpadItems(prev => {
        // LWW-CRDT Merge
        const existing = prev.find(i => i.id === sample.id);
        if (!existing || newItem.lastModified > existing.lastModified) {
            const next = [...prev.filter(i => i.id !== sample.id), newItem];
            storageSetJson(SCRATCHPAD_KEY, next);
            return next;
        }
        return prev;
    });
  };

  const removeFromScratchpad = (id: string) => {
      setScratchpadItems(prev => {
        const next = prev.filter(i => i.id !== id);
        storageSetJson(SCRATCHPAD_KEY, next);
        return next;
      });
  };

  return (
    <SessionContext.Provider value={{ scratchpadItems, addToScratchpad, removeFromScratchpad }}>
      {children}
    </SessionContext.Provider>
  );
};


export const useSession = () => {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider');
  return context;
};

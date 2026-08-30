import React, { createContext, useContext, useState, useEffect } from 'react';
import { AudioSample } from '../data/samples';
import { saveToDB, openDB } from '../utils/db';

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
  const [scratchpadItems, setScratchpadItems] = useState<ScratchpadItem[]>([]);

  // Load from IDB on init
  useEffect(() => {
    const loadData = async () => {
      const db = await openDB();
      const tx = db.transaction('scratchpad', 'readonly');
      const items = await new Promise<ScratchpadItem[]>((res) => {
        const req = tx.objectStore('scratchpad').getAll();
        req.onsuccess = () => res(req.result);
      });
      setScratchpadItems(items);
    };
    loadData();
  }, []);

  const addToScratchpad = (sample: AudioSample) => {
    const newItem = { ...sample, lastModified: Date.now() };
    saveToDB(newItem);
    setScratchpadItems(prev => {
        // LWW-CRDT Merge
        const existing = prev.find(i => i.id === sample.id);
        if (!existing || newItem.lastModified > existing.lastModified) {
            return [...prev.filter(i => i.id !== sample.id), newItem];
        }
        return prev;
    });
  };

  const removeFromScratchpad = async (id: string) => {
      const db = await openDB();
      db.transaction('scratchpad', 'readwrite').objectStore('scratchpad').delete(id);
      setScratchpadItems(prev => prev.filter(i => i.id !== id));
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

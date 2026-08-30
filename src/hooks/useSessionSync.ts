// src/hooks/useSessionSync.ts
import { useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { webRTCManager } from '../utils/WebRTCManager';

export const useSessionSync = () => {
  const { addToScratchpad, removeFromScratchpad } = useSession();

  // Listen for remote updates
  useEffect(() => {
    webRTCManager.onDataChannelMessage = (message) => {
      if (message.type === 'SCRATCHPAD_UPDATE') {
        if (message.action === 'ADD') addToScratchpad(message.sample);
        if (message.action === 'REMOVE') removeFromScratchpad(message.id);
      }
    };
  }, [addToScratchpad, removeFromScratchpad]);

  // Sync local changes to remote
  const syncAdd = (sample: any) => {
    addToScratchpad(sample);
    webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'ADD', sample });
  };

  const syncRemove = (id: string) => {
    removeFromScratchpad(id);
    webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'REMOVE', id });
  };

  return { syncAdd, syncRemove };
};

// src/hooks/useSessionSync.ts
import { useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { webRTCManager } from '../utils/WebRTCManager';
import { isTrustedMediaUrl } from '../utils/mediaUrlGuard';

export const useSessionSync = () => {
  const { addToScratchpad, removeFromScratchpad } = useSession();

  // Listen for remote updates (Multi-Listener statt Single-Slot, F2-Fix)
  useEffect(() => {
    return webRTCManager.addDataChannelListener((message) => {
      if (message?.type === 'SCRATCHPAD_UPDATE') {
        // F4-Fix: Peer-Samples nur mit vertrauenswürdiger URL annehmen.
        if (message.action === 'ADD') {
          const sample = message.sample;
          if (
            sample &&
            typeof sample === 'object' &&
            (!sample.url || isTrustedMediaUrl(sample.url))
          ) {
            addToScratchpad(sample);
          }
        }
        if (message.action === 'REMOVE') removeFromScratchpad(message.id);
      }
    });
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

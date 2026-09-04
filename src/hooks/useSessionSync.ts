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
        if (message.action === 'ADD') {
          const sample = message.sample;
          if (
            sample &&
            typeof sample === 'object' &&
            typeof (sample as { id?: unknown }).id === 'string' &&
            String((sample as { id: unknown }).id).length > 0 &&
            typeof (sample as { name?: unknown }).name === 'string' &&
            ((sample as { url?: unknown }).url === undefined || isTrustedMediaUrl(String((sample as { url: unknown }).url)))
          ) {
            addToScratchpad(sample as never);
          }
        }
        if (message.action === 'REMOVE' && typeof message.id === 'string' && message.id.length > 0) {
          removeFromScratchpad(message.id);
        }
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

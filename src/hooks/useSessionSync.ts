// src/hooks/useSessionSync.ts
import { useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { webRTCManager } from '../utils/WebRTCManager';
import { isTrustedMediaUrl } from '../utils/mediaUrlGuard';
import type { AudioSample } from '../data/samples';

// AD-I2: Monotone Sequenz je Sender gegen Out-of-Order-Desync bei SCRATCHPAD_UPDATE.
let scratchpadSeqCounter = 0;
const nextScratchpadSeq = (): number => ++scratchpadSeqCounter;
const lastScratchpadSeq = new Map<string, number>();

/** DA-2026-09-04-219: Einzige Validierung für Scratchpad-Samples (in/out). */
function isValidScratchSample(value: unknown): value is AudioSample {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.length === 0) return false;
  if (typeof s.name !== 'string') return false;
  if (!['bass', 'mids', 'highs'].includes(String(s.category))) return false;
  if (typeof s.type !== 'string' || s.type.length === 0) return false;
  if (typeof s.description !== 'string') return false;
  if (s.url !== undefined && !isTrustedMediaUrl(String(s.url))) return false;
  if (!s.parameters || typeof s.parameters !== 'object') return false;
  return true;
}

export const useSessionSync = () => {
  const { addToScratchpad, removeFromScratchpad } = useSession();

  // Listen for remote updates (Multi-Listener statt Single-Slot, F2-Fix)
  useEffect(() => {
    return webRTCManager.addDataChannelListener((message) => {
      if (message?.type === 'SCRATCHPAD_UPDATE') {
        const sender = String(message.senderId ?? 'peer');
        const seq = Number(message.seq ?? 0);
        if (Number.isFinite(seq) && seq > 0) {
          if (seq <= (lastScratchpadSeq.get(sender) ?? 0)) return; // veraltet/out-of-order
          lastScratchpadSeq.set(sender, seq);
        }
        if (message.action === 'ADD') {
          const sample = message.sample;
          if (isValidScratchSample(sample)) {
            addToScratchpad(sample);
          }
        }
        if (message.action === 'REMOVE' && typeof message.id === 'string' && message.id.length > 0) {
          removeFromScratchpad(message.id);
        }
      }
    });
  }, [addToScratchpad, removeFromScratchpad]);

  // Sync local changes to remote
  const syncAdd = (sample: unknown) => {
    if (!isValidScratchSample(sample)) return false;
    addToScratchpad(sample);
    webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'ADD', sample, seq: nextScratchpadSeq(), ts: Date.now() });
    return true;
  };

  const syncRemove = (id: string) => {
    if (typeof id !== 'string' || id.length === 0) return false;
    removeFromScratchpad(id);
    webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'REMOVE', id, seq: nextScratchpadSeq(), ts: Date.now() });
    return true;
  };

  return { syncAdd, syncRemove };
};

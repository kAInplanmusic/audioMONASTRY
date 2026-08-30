import { useState, useMemo } from 'react';
import { PluginState } from '../plugins/types';
import { webRTCManager } from '../utils/WebRTCManager';
import { usePluginManager } from '../context/PluginManagerContext';
import { logAuditEvent } from '../utils/AuditLogger';

export const usePluginState = (pluginId: string, initialState: PluginState = 'OFF') => {
  const [state, setState] = useState<PluginState>(initialState);
  const { pluginLocks } = usePluginManager();
  
  const lockStatus = useMemo(() => pluginLocks[pluginId] || { lockedBy: null, timestamp: 0, active: false }, [pluginLocks, pluginId]);

  const updateState = (newState: PluginState) => {
    if (!lockStatus.active) {
      setState(newState);
      logAuditEvent('localUser', 'PLUGIN_STATE', { pluginId, state: newState });
      // Sync via WebRTC DataChannel
      webRTCManager.sendToAllPeers({
        type: 'PLUGIN_STATE_UPDATE',
        pluginId,
        state: newState,
        senderId: 'localUser',
        timestamp: Date.now(),
      });
    }
  };

  return { state, lockStatus, updateState };
};

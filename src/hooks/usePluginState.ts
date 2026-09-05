import { useMemo } from 'react';
import { PluginState } from '../plugins/types';
import { usePluginManager } from '../context/PluginManagerContext';
import { useModuleState } from '../context/ModuleStateContext';
import { webRTCManager } from '../utils/WebRTCManager';
import { logAuditEvent } from '../utils/AuditLogger';

/**
 * P0-3/D3: Einheitliche Plugin-State-Quelle.
 * -----------------------------------------
 * Früher hielt dieser Hook einen LOKALEN State – das führte zu zwei Wahrheiten
 * (Terminal lokal vs. ModuleStateContext global). Jetzt liest/schreibt der Hook
 * ausschließlich in den globalen ModuleStateContext; WebRTC-Replikation,
 * Audio-Routing (PluginAudioRouter) und Silence-Gate laufen dort zentral.
 */
export const usePluginState = (pluginId: string, initialState: PluginState = 'OFF') => {
  const { moduleStates, setModuleState } = useModuleState();
  const { pluginLocks } = usePluginManager();

  const state: PluginState = moduleStates[pluginId] ?? initialState;

  const lockStatus = useMemo(
    () => pluginLocks[pluginId] || { lockedBy: null, timestamp: 0, active: false },
    [pluginLocks, pluginId],
  );

  const updateState = (newState: PluginState) => {
    const isOwner = lockStatus.active && lockStatus.lockedBy === webRTCManager.userId;
    if (!lockStatus.active || isOwner) {
      setModuleState(pluginId, newState);
      logAuditEvent(webRTCManager.userId, 'PLUGIN_STATE', { pluginId, state: newState });
    }
  };

  return { state, lockStatus, updateState };
};

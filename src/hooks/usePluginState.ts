import { useCallback, useEffect, useMemo, useRef } from 'react';
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

  // DA-2026-09-04-217: Ref-Spiegel des aktuellen Lock-Status, damit updateState
  // zur Ausführungszeit (nicht zur Closure-Erzeugungszeit) den frischen Wert liest
  // und kein stale lockStatus verwendet wird. Ref-Update im Effect (react-hooks/refs).
  const lockStatusRef = useRef(lockStatus);
  useEffect(() => {
    lockStatusRef.current = lockStatus;
  }, [lockStatus]);

  // Identitätsstabil: useCallback verhindert neue Funktionsinstanzen pro Render.
  const updateState = useCallback(
    (newState: PluginState) => {
      const current = lockStatusRef.current;
      const isOwner = current.active && current.lockedBy === webRTCManager.userId;
      if (!current.active || isOwner) {
        setModuleState(pluginId, newState);
        logAuditEvent(webRTCManager.userId, 'PLUGIN_STATE', { pluginId, state: newState });
      }
    },
    [pluginId, setModuleState],
  );

  return { state, lockStatus, updateState };
};

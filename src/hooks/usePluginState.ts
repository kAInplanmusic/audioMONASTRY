import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
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
  // DA-2026-09-29-042: useLayoutEffect statt useEffect - der Ref wird damit synchron
  // nach dem Commit (und VOR jeder Nutzerinteraktion) gesetzt. Mit useEffect blieb ein
  // Fenster, in dem updateState den alten Lock-Status sah; eine Ref-Schreibung direkt im
  // Render ist hier per Lint-Regel unerwuenscht.
  useLayoutEffect(() => {
    lockStatusRef.current = lockStatus;
  }, [lockStatus]);

  // Identitätsstabil: useCallback verhindert neue Funktionsinstanzen pro Render.
  const updateState = useCallback(
    (newState: PluginState) => {
      const current = lockStatusRef.current;
      // DA-2026-09-29-043: Ein Lock ohne Eigentuemer (lockedBy=null) darf NICHT als
      // eigener Lock gelten. webRTCManager.userId ist vor dem Verbindungsaufbau
      // null/undefined, und der Lock-Fallback oben setzt lockedBy: null - ohne die
      // beiden expliziten Pruefungen waere isOwner dann true und ein unbefugter
      // Client koennte im Namen eines Geister-Locks schreiben.
      const ownerId = webRTCManager.userId;
      const isOwner = current.active && current.lockedBy != null && ownerId != null
        && current.lockedBy === ownerId;
      if (!current.active || isOwner) {
        setModuleState(pluginId, newState);
        logAuditEvent(webRTCManager.userId, 'PLUGIN_STATE', { pluginId, state: newState });
      }
    },
    [pluginId, setModuleState],
  );

  return { state, lockStatus, updateState };
};

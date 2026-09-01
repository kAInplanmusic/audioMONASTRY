import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { storageGet, storageSet } from '../utils/storage';
import { webRTCManager } from '../utils/WebRTCManager';
import { audioEngine } from '../utils/audioEngine';
import { routeModuleState } from '../core/pluginAudioRouter';
import { can, roleForUser, readSessionConfig } from '../utils/rbac';
import { setAiModeActive } from '../core/ai/aiMode';

export type ModuleState = 'OFF' | 'AUTO_AI' | 'PRO';

const STORAGE_KEY = 'audiomonastry_module_states';

interface ModuleContextType {
  moduleStates: Record<string, ModuleState>;
  setModuleState: (id: string, state: ModuleState) => void;
}

const ModuleStateContext = createContext<ModuleContextType | undefined>(undefined);

const loadPersistedStates = (): Record<string, ModuleState> => {
  // P0-1 (Start-Silence): Beim Start sind ALLE Module OFF – persistierte
  // Zustände werden bewusst ignoriert (Session-Scratchpad ersetzt das,
  // siehe P1-4/NEW-D-Maßnahmen).
  return {};
};

/**
 * Kanonischer AUTO_AI-/Modul-State mit LWW-Replikation über den bestehenden
 * WebRTC-DataChannel (PLUGIN_STATE_UPDATE). Stale/Duplicate-Messages werden
 * über (timestamp, senderId)-Tie-Breaks verworfen; Audio läuft bei
 * WebRTC-Ausfall unverändert weiter.
 */
export const ModuleStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [moduleStates, setModuleStates] = useState<Record<string, ModuleState>>(loadPersistedStates);
  const lastSeen = useRef<Record<string, { t: number; sender: string }>>({});

  // Persistiere Modul-Zustände über den Storage-Adapter (UI-Präferenz, asynchron).
  useEffect(() => {
    try {
      storageSet(STORAGE_KEY, JSON.stringify(moduleStates));
    } catch { /* quota exceeded – non-critical */ }
  }, [moduleStates]);

  const setModuleState = useCallback((id: string, state: ModuleState) => {
    const now = Date.now();
    const sender = webRTCManager.userId;
    lastSeen.current[id] = { t: now, sender };
    setModuleStates(prev => {
      const next = { ...prev, [id]: state };
      // P0-4: Silence-Gate – Master stumm, wenn kein Plugin aktiv ist.
      const activeCount = Object.values(next).filter((s) => s !== 'OFF').length;
      try { audioEngine.setIdleSilence(activeCount === 0); } catch { /* Audio nicht initialisiert */ }
      return next;
    });
    // P0-2: Audio-Routing an den PluginAudioRouter delegieren
    // (OFF = Signalkette trennen, AUTO_AI/PRO = Einspeisung).
    routeModuleState(id, state);
    // NEW-D1-3: AI-Modus-Flag für Halter-Wechsel (mixerMONK) synchron halten.
    if (id === 'ai') setAiModeActive(state !== 'OFF');
    // Replikation an alle Peers (bestehender Kollaborations-Kanal).
    webRTCManager.sendToAllPeers({
      type: 'PLUGIN_STATE_UPDATE',
      pluginId: id,
      state,
      senderId: sender,
      timestamp: now,
    });
  }, []);

  // Eingehende Peer-Updates LWW-merge (idempotent, stale-safe).
  useEffect(() => {
    return webRTCManager.addDataChannelListener((msg: any) => {
      if (!msg || msg.type !== 'PLUGIN_STATE_UPDATE') return;
      const { pluginId, state, senderId, timestamp } = msg as {
        pluginId?: string;
        state?: ModuleState;
        senderId?: string;
        timestamp?: number;
      };
      if (!pluginId || !state) return;
      if (state !== 'OFF' && state !== 'AUTO_AI' && state !== 'PRO') return;
      // F1-Fix: Empfangs-RBAC – PRO-Promotion nur durch Producer+ (Lock-Aktion),
      // OFF/AUTO_AI durch alle Rollen (State-Aktion). Client-RBAC bleibt UX,
      // aber fremde States werden nicht mehr blind übernommen.
      const senderRole = roleForUser(senderId ?? '', readSessionConfig().hostUid || null);
      const neededAction = state === 'PRO' ? 'lock' : 'state';
      if (!can(senderRole, neededAction)) {
        console.warn('[module-state] RBAC: Update verworfen', { senderId, state, senderRole });
        return;
      }
      const t = Number(timestamp) || 0;
      const last = lastSeen.current[pluginId];
      if (last && (t < last.t || (t === last.t && (senderId ?? '') <= last.sender))) return; // stale/duplicate
      lastSeen.current[pluginId] = { t, sender: senderId ?? '' };
      setModuleStates(prev => (prev[pluginId] === state ? prev : { ...prev, [pluginId]: state }));
      // P0-2: Auch fremde Zustandswechsel im Audio-Routing nachziehen.
      routeModuleState(pluginId, state);
      // NEW-D1-3: AI-Modus-Flag auch für fremde Updates synchron halten.
      if (pluginId === 'ai') setAiModeActive(state !== 'OFF');
    });
  }, []);

  return (
    <ModuleStateContext.Provider value={{ moduleStates, setModuleState }}>
      {children}
    </ModuleStateContext.Provider>
  );
};

export const useModuleState = () => {
  const context = useContext(ModuleStateContext);
  if (!context) throw new Error('useModuleState must be used within ModuleStateProvider');
  return context;
};

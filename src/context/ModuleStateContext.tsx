import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { storageSet } from '../utils/storage';
import { webRTCManager } from '../utils/WebRTCManager';
import { audioEngine } from '../utils/audioEngine';
import { routeModuleState } from '../core/pluginAudioRouter';
import { setAiModeActive } from '../core/ai/aiMode';
import { EVAL_PLUGIN_IDS } from '../core/ai/orchestrator/evalMatrix';
import { isMainOutPlugin } from '../core/session/mainOutGuard';
import { parseSessionSnapshot, type BridgeModuleState } from '../core/session/sessionStateBridge';

const VALID_PLUGIN_IDS = new Set<string>(EVAL_PLUGIN_IDS);

export type ModuleState = 'OFF' | 'AUTO_AI' | 'PRO';

const STORAGE_KEY = 'audiomonastry_module_states';

interface ModuleContextType {
  moduleStates: Record<string, ModuleState>;
  /** `replicate: false` = nur lokal setzen (kein Peer-Broadcast). */
  setModuleState: (id: string, state: ModuleState, opts?: { replicate?: boolean }) => void;
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
  // COLLAB-P0-002: Lock-Schatten für eingehende Peer-Updates. Der Server ist
  // die Lock-Wahrheit; ohne diesen Filter würde ein abgelehnter WebRTC-Update
  // eines Nicht-Halters trotzdem per DataChannel bei den anderen ankommen.
  const lockOwnersRef = useRef<Record<string, string>>({});

  // Persistiere Modul-Zustände über den Storage-Adapter (UI-Präferenz, asynchron).
  useEffect(() => {
    try {
      storageSet(STORAGE_KEY, JSON.stringify(moduleStates));
    } catch { /* quota exceeded – non-critical */ }
  }, [moduleStates]);

  const setModuleState = useCallback((id: string, state: ModuleState, opts?: { replicate?: boolean }) => {
    const now = Date.now();
    const sender = webRTCManager.userId;
    // P0-1: Main-Out-Schutz (UX-Gate). Der Server lehnt zusätzlich ab – hier
    // wird der Zustand erst gar nicht lokal gesetzt, damit Nicht-MixerMONK-User
    // kein visuelles Feedback einer nicht-autoritativen Änderung bekommen.
    if (isMainOutPlugin(id) && !webRTCManager.isMainOutOwner) {
      console.warn('[module-state] Main-Out-Änderung verweigert (MixerMONK only)', { id, state, sender });
      return;
    }
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
    // P0-1: Es gibt keinen Login-Seed mehr – alle User starten mit OFF.
    if (opts?.replicate === false) return;
    webRTCManager.sendToAllPeers({
      type: 'PLUGIN_STATE_UPDATE',
      pluginId: id,
      state,
      senderId: sender,
      timestamp: now,
    });
  }, []);

  // COLLAB-P0-002: Reconnect ohne Pumping – der Server-Snapshot (join/resync)
  // überschreibt lokale Modul-States autoritativ. Bewusst OHNE Main-Out-Guard
  // (der Server hat die Berechtigung bereits durchgesetzt) und OHNE Replikation
  // (kein Echo an die Session).
  const applyAuthoritativeModules = useCallback((modules: Record<string, BridgeModuleState>) => {
    setModuleStates(prev => {
      const next = { ...prev, ...modules };
      // P0-4: Silence-Gate – Master stumm, wenn kein Plugin aktiv ist.
      const activeCount = Object.values(next).filter((s) => s !== 'OFF').length;
      try { audioEngine.setIdleSilence(activeCount === 0); } catch { /* Audio nicht initialisiert */ }
      return next;
    });
    for (const [id, state] of Object.entries(modules)) {
      routeModuleState(id, state as ModuleState);
    }
  }, []);

  // COLLAB-P0-002: autoritativen Session-Snapshot abonnieren (Join/Resync).
  useEffect(() => {
    return webRTCManager.onSessionState((snapshot: unknown) => {
      const parsed = parseSessionSnapshot(snapshot);
      if (!parsed) return;
      applyAuthoritativeModules(parsed.modules);
    });
  }, [applyAuthoritativeModules]);

  // COLLAB-P0-002: Lock-Schatten pflegen (Server-Broadcasts + Legacy-Sync).
  // Die Daten sind nur ein Filter für den WebRTC-Pfad; die UI-Anzeige der
  // Locks bleibt im PluginManagerContext.
  useEffect(() => {
    const offLock = webRTCManager.onPluginLock((msg: any) => {
      const pluginId = String(msg?.pluginId ?? '');
      const lockedBy = String(msg?.lockedBy ?? '');
      if (!pluginId || !lockedBy) return;
      lockOwnersRef.current[pluginId] = lockedBy;
    });
    const offUnlock = webRTCManager.onPluginUnlock((msg: any) => {
      const pluginId = String(msg?.pluginId ?? '');
      if (!pluginId) return;
      delete lockOwnersRef.current[pluginId];
    });
    const offSync = webRTCManager.onPluginLocksSync((msg: any) => {
      const raw = msg?.locks;
      if (!raw || typeof raw !== 'object') return;
      const next: Record<string, string> = {};
      for (const [id, lock] of Object.entries<any>(raw)) {
        if (lock?.active && lock?.lockedBy) next[id] = String(lock.lockedBy);
      }
      lockOwnersRef.current = next;
    });
    return () => { offLock(); offUnlock(); offSync(); };
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
      if (typeof pluginId !== 'string' || !VALID_PLUGIN_IDS.has(pluginId)) return;
      if (typeof senderId !== 'string' || senderId.length === 0) return;
      if (state !== 'OFF' && state !== 'AUTO_AI' && state !== 'PRO') return;
      const t = Number(timestamp);
      if (!Number.isFinite(t) || t < 0) return;
      // ROLLENSYSTEM ENTFERNT (2026-09-14): keine Rollen-Prüfung mehr. Nur
      // der mixerMONK-Lock-Owner ist besonders (Main-Out-Schutz unten).
      // P0-1: Main-Out-Schutz auch für eingehende Peer-Updates – ein Nicht-Owner
      // darf mixer/master-States nicht einspeisen (Server lehnt den Socket-Pfad ab,
      // hier wird zusätzlich der WebRTC-Pfad gefiltert).
      if (isMainOutPlugin(pluginId)) {
        const mainOutOwner = webRTCManager.mainOutOwnerId;
        if (!mainOutOwner || mainOutOwner !== senderId) {
          console.warn('[module-state] Main-Out-Update von Nicht-Owner verworfen', { senderId, pluginId, state });
          return;
        }
      }
      // COLLAB-P0-002: Auch für gelockte Nicht-Main-Out-Plugins gilt die
      // Server-Wahrheit: der WebRTC-Pfad eines Nicht-Halters wird verworfen,
      // sonst würde ein server-seitig abgelehnter Optimistic-Update die
      // anderen Clients trotzdem umschalten (Desync).
      const lockOwner = lockOwnersRef.current[pluginId];
      if (lockOwner && lockOwner !== senderId) {
        console.warn('[module-state] Update von Nicht-Lock-Owner verworfen', { senderId, pluginId, state });
        return;
      }
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

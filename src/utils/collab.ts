import { useState, useEffect, useCallback } from 'react';
import { random } from './random';
import { storageGet, storageSet } from './storage';

/**
 * Kollaboration – VENDOR-/CLOUD-FREI.
 *
 * Frueher synchronisierte dieses Modul eine Multiplayer-Session ueber Firestore.
 * Jetzt laeuft alles ausschliesslich LOKAL im Browser (keine Cloud-Verbindung).
 * Die Export-Oberflaeche (`useCollabSession`, `localUser`, Lock-/Update-Methoden)
 * bleibt erhalten, damit die App kompiliert und die lokale UI unveraendert laeuft.
 */

// Lokale Identitaet (persistiert im Browser)
const getLocalUserId = () => {
  let id = storageGet('audiomonastry_user_id');
  if (!id) {
    id = 'user_' + random().toString(36).substring(2, 11);
    storageSet('audiomonastry_user_id', id);
  }
  return id;
};

const getLocalUserName = () => {
  let name = storageGet('audiomonastry_user_name');
  if (!name) {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    name = 'Operator ' + names[Math.floor(random() * names.length)] + ' ' + Math.floor(random()*100);
    storageSet('audiomonastry_user_name', name);
  }
  return name;
};

const getLocalUserColor = () => {
  let color = storageGet('audiomonastry_user_color');
  if (!color) {
    const colors = ['#38bdf8', '#fbbf24', '#e879f9', '#34d399', '#f43f5e', '#a78bfa'];
    color = colors[Math.floor(random() * colors.length)];
    storageSet('audiomonastry_user_color', color);
  }
  return color;
};

export const localUser = {
  id: getLocalUserId(),
  name: getLocalUserName(),
  color: getLocalUserColor()
};

export interface CollabSession {
  locks: Record<string, string>;
  playback: {
    isPlaying: boolean;
    bpm: number;
  };
  sequencer: {
    patterns: any;
    synthNotes: number[];
  };
  mastering: {
    cutoff: number;
    resonance: number;
    delayTime: number;
    decay: number;
  };
  activeUsers: Record<string, { name: string; color: string; lastSeen: number }>;
}

const DEFAULT_SESSION: CollabSession = {
  locks: {},
  playback: { isPlaying: false, bpm: 130 },
  sequencer: {
    patterns: {
      kick: Array(16).fill(false),
      hat: Array(16).fill(false),
      clap: Array(16).fill(false),
      synth: Array(16).fill(false),
      snare: Array(16).fill(false),
      tom: Array(16).fill(false),
      perc: Array(16).fill(false),
      bass: Array(16).fill(false)
    },
    synthNotes: Array(16).fill(0)
  },
  mastering: {
    cutoff: 800,
    resonance: 8,
    delayTime: 0.25,
    decay: 0.15
  },
  activeUsers: {}
};

// Lokaler Session-State (kein Firestore).
function createLocalSession(): CollabSession {
  return {
    ...DEFAULT_SESSION,
    activeUsers: {
      [localUser.id]: { name: localUser.name, color: localUser.color, lastSeen: Date.now() }
    }
  };
}

export function useCollabSession(_sessionId: string = 'main_studio') {
  const [session, setSession] = useState<CollabSession>(createLocalSession);
  const [isConnected] = useState(true); // lokal immer "verbunden"

  // Nichts weiter zu beobachten – reine lokale Session.
  useEffect(() => {
    // Intentionally empty: no remote listeners in local mode.
  }, []);

  const acquireLock = useCallback((moduleId: string) => {
    setSession(prev => {
      if (prev.locks[moduleId] && prev.locks[moduleId] !== localUser.id) {
        return prev; // von einem anderen gehalten
      }
      return { ...prev, locks: { ...prev.locks, [moduleId]: localUser.id } };
    });
    return true;
  }, []);

  const releaseLock = useCallback((moduleId: string) => {
    setSession(prev => {
      const locks = { ...prev.locks };
      if (locks[moduleId] === localUser.id) delete locks[moduleId];
      return { ...prev, locks };
    });
  }, []);

  const updatePlayback = useCallback((updates: Partial<CollabSession['playback']>) => {
    setSession(prev => ({ ...prev, playback: { ...prev.playback, ...updates } }));
  }, []);

  const updateSequencer = useCallback((updates: Partial<CollabSession['sequencer']>) => {
    setSession(prev => ({ ...prev, sequencer: { ...prev.sequencer, ...updates } }));
  }, []);

  const updateMastering = useCallback((updates: Partial<CollabSession['mastering']>) => {
    setSession(prev => ({ ...prev, mastering: { ...prev.mastering, ...updates } }));
  }, []);

  return {
    session,
    isConnected,
    localUser,
    acquireLock,
    releaseLock,
    updatePlayback,
    updateSequencer,
    updateMastering,
    isLocked: (moduleId: string) => !!(session.locks[moduleId] && session.locks[moduleId] !== localUser.id),
    getLockOwner: (moduleId: string) =>
      session.locks[moduleId] ? session.activeUsers[session.locks[moduleId]] : null
  };
}

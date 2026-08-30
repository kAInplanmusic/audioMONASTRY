import React, { useState } from 'react';
import { useDevice } from '../hooks/useDevice';
import { useRoom, RoomUser } from '../hooks/useRoom';
import { Headphones, Users, Radio, Shield } from 'lucide-react';
import { audioEngine } from '../utils/audioEngine';

interface StreamLayoutProps {
  children: React.ReactNode;
  roomId: string;
  username: string;
}

// Rollen für die 4 Monitor-Personen (Task 4 / Task 18)
const MONITOR_ROLES = ['DJ', 'Producer', 'Sound Engineer', 'Stem Host'] as const;
type MonitorRole = typeof MONITOR_ROLES[number];

export const StreamLayout: React.FC<StreamLayoutProps> = ({ children, roomId, username }) => {
  const device = useDevice();
  const { room, kickUser } = useRoom(roomId, username);
  const [showPeers, setShowPeers] = useState(false);

  const peers: RoomUser[] = room?.users ?? [];
  const host = room?.hostId ?? username;

  const setMonitorRole = (index: number, role: MonitorRole) => {
    // Passt das Monitorprofil an: nutzt die in Task 4 gebaute Monitor-Gain-Matrix.
    const mon = (`MON${index + 1}`) as 'MON1'|'MON2'|'MON3'|'MON4';
    if (role === 'Producer') {
      audioEngine.setMonitorTrackGain(mon, 'channel2', 0.5);
      audioEngine.setMonitorTrackGain(mon, 'channel6', 1.2);
    } else if (role === 'DJ') {
      audioEngine.setMonitorTrackGain(mon, 'channel1', 1.0);
      audioEngine.setMonitorTrackGain(mon, 'channel7', 1.0);
    } else if (role === 'Stem Host') {
      audioEngine.setMonitorTrackGain(mon, 'channel1', 1.2);
      audioEngine.setMonitorTrackGain(mon, 'channel8', 1.2);
    }
    audioEngine.setMonitorGain(mon, 0.8);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white overflow-hidden">
      <nav className="h-16 border-b border-gray-700 flex items-center justify-between px-4">
        <div className="flex items-center space-x-2 overflow-x-auto">
          <span className="text-[10px] font-black tracking-widest text-purple-400">AUDIOMONASTRY LIVE</span>
          <span className="text-[10px] font-mono text-gray-500 text-xs">Rollen: {MONITOR_ROLES.join(' · ')}</span>
        </div>

        {/* Peer/Monitor-Anzeige */}
        <div className="flex items-center gap-3">
          <button type="button"
            onClick={() => setShowPeers(p => !p)}
            className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-1 rounded-full bg-gray-800 border border-gray-700 text-neutral-300 hover:border-purple-500/60"
          >
            <Users className="w-3 h-3" /> Peers ({peers.length})
          </button>
          <div className="text-xs text-neutral-400 font-mono flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-emerald-500" />
            {host === username ? 'HOST' : `in ${host}'s-Room`}
          </div>
        </div>
      </nav>

      {/* Persistent Session / Monitor-Rollen-Leiste */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-950 border-b border-gray-800 overflow-x-auto">
        {MONITOR_ROLES.map((role, i) => (
          <button type="button"
            key={role}
            onClick={() => setMonitorRole(i, role)}
            title={`${role}: Cue-Mix auf MON${i + 1}`}
            className="flex items-center gap-1.5 text-[9px] font-mono px-2 py-1 rounded bg-gray-800 border border-gray-700 text-neutral-400 hover:border-cyan-500/60"
          >
            <Headphones className="w-3 h-3 text-cyan-400" />
            {role}
          </button>
        ))}
      </div>

      <main className={`flex-1 overflow-auto p-4 ${device === 'mobile' ? 'p-2' : ''}`}>
        {children}
      </main>

      {showPeers && (
        <div className="fixed right-4 top-20 z-40 bg-gray-800/95 border border-gray-600 rounded-xl p-4 shadow-2xl w-64">
          <div className="text-xs font-black text-purple-400 mb-2 flex items-center gap-2">
            <Radio className="w-3.5 h-3.5" /> Live-Session Teilnehmer
          </div>
          {peers.length === 0 && <p className="text-[10px] text-gray-400">Keine aktiven Peers.</p>}
          {peers.map(p => (
            <div key={p.uid} className="flex items-center justify-between text-xs py-1 border-b border-gray-700/50">
              <span className="text-neutral-300">{p.name}</span>
              {host === username && (
                <button type="button" onClick={() => kickUser(p.uid)} className="text-[9px] text-red-400 hover:text-red-300">kick</button>
              )}
            </div>
          ))}
          <p className="text-[9px] text-gray-500 mt-2">Monitor-Cue-Mixe werden in dieser Session lokal gelöst.</p>
        </div>
      )}

      <footer className="text-xs text-gray-600 p-2 text-center">
        Mode: {device.toUpperCase()} · Room: {roomId} · User: {username}
      </footer>
    </div>
  );
};

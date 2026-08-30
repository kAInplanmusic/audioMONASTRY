import React, { useState } from 'react';
import { random } from '../utils/random';
import { localHostRoom, localJoinRoom } from '../hooks/useRoom';

/**
 * B2B-Collaboration-Modal – VENDOR-/CLOUD-FREI.
 *
 * Host/Join von Kollaborations-Raeumen laeuft jetzt rein LOKAL im Browser
 * (keine Firestore-Collection `rooms` mehr). Die Export-Oberflaeche und das
 * visuelle Verhalten bleiben unveraendert.
 */

interface B2BModalProps {
  onJoin: (roomId: string, username: string) => void;
}

export const B2BModal: React.FC<B2BModalProps> = ({ onJoin }) => {
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const hostRoom = () => {
    const userId = random().toString(36).substring(7); // lokale (mock) ID
    const newRoomId = localHostRoom(userId, username || 'Host');
    onJoin(newRoomId, username || 'Host');
  };

  const joinRoom = () => {
    const userId = random().toString(36).substring(7);
    const code = roomCode.trim().toUpperCase();
    if (!code) return;
    const ok = localJoinRoom(code, userId, username || 'Guest');
    if (ok) onJoin(code, username || 'Guest');
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-neutral-900 p-8 rounded-xl border border-neutral-700 w-96 flex flex-col gap-4">
        <h2 className="text-xl font-bold text-white">B2B Collaboration</h2>
        <input
          placeholder="Enter your name"
          className="bg-neutral-800 p-2 rounded text-white"
          value={username} onChange={e => setUsername(e.target.value)}
        />
        <button type="button" onClick={hostRoom} className="bg-blue-600 p-2 rounded text-white font-bold">Host Room</button>
        <div className="flex gap-2">
          <input
            placeholder="Room Code"
            className="bg-neutral-800 p-2 rounded text-white flex-1"
            value={roomCode} onChange={e => setRoomCode(e.target.value)}
          />
          <button type="button" onClick={joinRoom} className="bg-emerald-600 p-2 px-4 rounded text-white font-bold">Join</button>
        </div>
      </div>
    </div>
  );
};

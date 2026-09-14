import { useState } from 'react';
import { random } from '../utils/random';

/**
 * Room-Hook – VENDOR-/CLOUD-FREI.
 *
 * Frueher wurden B2B-Raeume ueber Firestore (Collection `rooms`) verwaltet.
 * Jetzt arbeiten Raeume rein LOKAL im Browser (in-memory). Die Export-Oberflaeche
 * (`useRoom`, `RoomUser`) bleibt erhalten.
 *
 * ROLLENSYSTEM ENTFERNT (2026-09-14): Es gibt keine admin/producer/engineer/
 * guest-Rollen mehr. Einzig der lokale Raum-Ersteller (hostId) darf einen
 * anderen User entfernen – das ist Raumbesitz, kein Rollensystem. Nur
 * mixerMONK (Lock-Owner) ist im Studio besonders.
 */

export interface RoomUser {
  uid: string;
  name: string;
}

// Lokaler Room-Registry (in-memory, pro Tab).
const localRooms: Record<string, { hostId: string; users: RoomUser[] }> = {};

export function useRoom(roomId: string | null, userId: string | null) {
  const [room, setRoom] = useState<{ hostId: string; users: RoomUser[] } | null>(
    roomId ? localRooms[roomId] ?? null : null
  );

  // Bei roomId-Wechsel den Room-Status angleichen (state during render statt
  // setState im Effect, vgl. react-hooks/set-state-in-effect).
  const [lastRoomId, setLastRoomId] = useState(roomId);
  if (lastRoomId !== roomId) {
    setLastRoomId(roomId);
    setRoom(roomId ? localRooms[roomId] ?? null : null);
  }

  // Kick: nur der lokale Raum-Ersteller (hostId) darf entfernen. Kein Rollensystem.
  const kickUser = async (targetUserId: string) => {
    if (!room || !roomId || !userId) return;
    if (userId !== room.hostId) return;
    const next = {
      ...room,
      users: room.users.filter(u => u.uid !== targetUserId),
    };
    localRooms[roomId] = next;
    setRoom(next);
  };

  // Vereinfachte Sicht: host = Raum-Ersteller, sonst member.
  const myRole = userId === room?.hostId ? 'host' : 'member';

  return { room, kickUser, myRole };
}

// Lokale Hilfsfunktionen (von B2BModal genutzt)
export function localHostRoom(userId: string, username: string): string {
  const roomId = random().toString(36).substring(7).toUpperCase();
  localRooms[roomId] = { hostId: userId, users: [{ uid: userId, name: username }] };
  return roomId;
}

export function localJoinRoom(roomId: string, userId: string, username: string): boolean {
  const room = localRooms[roomId];
  if (!room) return false;
  if (!room.users.some(u => u.uid === userId)) {
    room.users.push({ uid: userId, name: username });
  }
  return true;
}

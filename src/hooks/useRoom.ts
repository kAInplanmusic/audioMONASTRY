import { useState } from 'react';
import { random } from '../utils/random';
import { assertCan, roleForUser, Role, logAuditEvent } from '../utils/rbac';

/**
 * Room-Hook – VENDOR-/CLOUD-FREI.
 *
 * Frueher wurden B2B-Raeume ueber Firestore (Collection `rooms`) verwaltet.
 * Jetzt arbeiten Raeume rein LOKAL im Browser (in-memory). Die Export-Oberflaeche
 * (`useRoom`, `RoomUser`) bleibt erhalten.
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

  // RBAC-gestützter Kick: nur admin (Host) darf entfernen; Audit-Event.
  const kickUser = async (targetUserId: string) => {
    if (!room || !roomId || !userId) return;
    const allowed = await assertCan(userId, 'kick', room.hostId, {
      reason: 'kickUser versucht, User zu entfernen',
    });
    if (!allowed) return;
    await logAuditEvent(userId, 'ROOM_KICK', { target: targetUserId, room: roomId });
    const next = {
      ...room,
      users: room.users.filter(u => u.uid !== targetUserId),
    };
    localRooms[roomId] = next;
    setRoom(next);
  };

  // Gibt die RBAC-Rolle des aktuellen Users zurück (Host -> admin).
  const myRole: Role = roleForUser(userId ?? '', room?.hostId ?? null);

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

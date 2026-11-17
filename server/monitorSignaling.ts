/** Private member-monitor signaling. This event never touches Main-Out peers. */
export const MONITOR_SIGNAL_EVENT = 'monitor-signal';
export const MONITOR_SIGNAL_MAX_BYTES = 64 * 1024;
export interface MonitorParticipant { userId: string; sessionId: string; mode: string; socketId: string }
export interface MonitorActor { userId: string; sessionId: string; mode: string }
export interface MonitorSignal {
  senderUserId: string; targetUserId: string; type: 'offer' | 'answer' | 'candidate';
  sdp?: string; candidate?: Record<string, unknown> | null;
}
export type MonitorRoute = { ok: true; targetSocketId: string; payload: MonitorSignal } | { ok: false; reason: string };
const denied = (reason: string): MonitorRoute => ({ ok: false, reason });
function size(value: unknown): number {
  try { const text = JSON.stringify(value); return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : Infinity; }
  catch { return Infinity; }
}
/** Identity and membership are supplied exclusively from the joined server socket. */
export function routeMonitorSignal(raw: unknown, actor: MonitorActor, participants: MonitorParticipant[], ownerId: string): MonitorRoute {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || size(raw) > MONITOR_SIGNAL_MAX_BYTES) return denied('invalid-or-oversize-payload');
  const input = raw as Record<string, unknown>;
  if (!actor.userId || !actor.sessionId || actor.mode !== 'member') return denied('joined-member-required');
  const sender = participants.find(p => p.userId === actor.userId && p.sessionId === actor.sessionId && p.mode === 'member');
  if (!sender) return denied('joined-member-required');
  if (typeof input.targetUserId !== 'string' || !input.targetUserId || input.targetUserId.length > 128 || input.targetUserId === actor.userId) return denied('invalid-target');
  const target = participants.find(p => p.userId === input.targetUserId && p.sessionId === actor.sessionId && p.mode === 'member');
  if (!target) return denied('target-member-required');
  const type = input.type;
  if (type !== 'offer' && type !== 'answer' && type !== 'candidate') return denied('invalid-type');
  if (!ownerId || (type === 'offer' ? actor.userId !== ownerId : type === 'answer' ? target.userId !== ownerId : actor.userId !== ownerId && target.userId !== ownerId)) return denied('monitor-owner-direction-required');
  const payload: MonitorSignal = { senderUserId: actor.userId, targetUserId: target.userId, type };
  if (type === 'offer' || type === 'answer') {
    if (typeof input.sdp !== 'string' || Buffer.byteLength(input.sdp, 'utf8') > 48 * 1024) return denied('invalid-audio-sdp');
    const lines = input.sdp.split(/\r?\n/);
    const media = lines.filter(line => line.startsWith('m='));
    if (lines[0] !== 'v=0' || media.length === 0 || media.some(line => !/^m=audio\s/.test(line))) return denied('audio-only-sdp-required');
    payload.sdp = input.sdp;
  } else {
    if (!Object.hasOwn(input, 'candidate') || size(input.candidate) > 2048) return denied('invalid-candidate');
    if (input.candidate === null) payload.candidate = null;
    else {
      if (!input.candidate || typeof input.candidate !== 'object' || Array.isArray(input.candidate)) return denied('invalid-candidate');
      const c = input.candidate as Record<string, unknown>;
      if (typeof c.candidate !== 'string' || c.candidate.length > 1536
        || (c.sdpMid !== undefined && c.sdpMid !== null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 128))
        || (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null && (!Number.isInteger(c.sdpMLineIndex) || Number(c.sdpMLineIndex) < 0 || Number(c.sdpMLineIndex) > 255))
        || (c.usernameFragment !== undefined && c.usernameFragment !== null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256))) return denied('invalid-candidate');
      payload.candidate = Object.fromEntries(['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].filter(key => Object.hasOwn(c, key)).map(key => [key, c[key]]));
    }
  }
  return { ok: true, targetSocketId: target.socketId, payload };
}
export interface MonitorSignalingSocket {
  data: Record<string, unknown>;
  on: (event: string, handler: (raw: unknown, acknowledge?: (result: unknown) => void) => void) => void;
  emit: (event: string, payload: unknown) => unknown;
}
/** Register only a private relay; membership and current owner are re-read per message. */
export function registerMonitorSignaling(socket: MonitorSignalingSocket, deps: {
  participants: () => MonitorParticipant[]; mainOutOwnerId: () => string;
  emitTo: (socketId: string, event: string, payload: MonitorSignal) => void;
  onActivity?: () => void; audit?: (accepted: boolean, reason: string) => void;
}): void {
  socket.on(MONITOR_SIGNAL_EVENT, (raw, acknowledge) => {
    deps.onActivity?.();
    const result = routeMonitorSignal(raw, {
      userId: typeof socket.data.sessionUserId === 'string' ? socket.data.sessionUserId : '',
      sessionId: typeof socket.data.sessionRoom === 'string' ? socket.data.sessionRoom : '',
      mode: typeof socket.data.sessionMode === 'string' ? socket.data.sessionMode : '',
    }, deps.participants(), deps.mainOutOwnerId());
    if (result.ok === false) {
      deps.audit?.(false, result.reason); socket.emit('monitor-signal-denied', { reason: result.reason });
      if (typeof acknowledge === 'function') acknowledge({ ok: false, reason: result.reason });
      return;
    }
    deps.emitTo(result.targetSocketId, MONITOR_SIGNAL_EVENT, result.payload);
    deps.audit?.(true, result.payload.type);
    if (typeof acknowledge === 'function') acknowledge({ ok: true });
  });
}

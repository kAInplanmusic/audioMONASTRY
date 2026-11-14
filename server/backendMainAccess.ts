import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Server, Socket } from 'socket.io';
import { resolveCanonicalPluginId } from '../src/plugins/legacyAliases';
import type { BackendMainRole } from '../src/core/transport/backendMainProtocol';
import type { BackendMainAccess } from './backendMainTransport';

const TICKET_LIFETIME_MS = 30_000;
const MAX_TICKETS = 1024;
export interface MainTicketPrincipal { socket: Socket; userId: string; session: string; role: BackendMainRole; plugin?: string }
type Ticket = { principal: MainTicketPrincipal; expiresAt: number };
type TicketAck = (response: { ok: false } | { ok: true; ticket: string; session: string; role: BackendMainRole; plugin?: string; expiresAt: number }) => void;

/**
 * Tickets bind Main access to an existing joined signaling socket. Only human
 * lock holders may contribute; AI grants are intentionally not ingested here.
 */
export function attachBackendMainAccess(io: Server, options: { resolveLockOwner: (pluginId: string) => Promise<string | null> | string | null }): {
  authenticate(request: IncomingMessage): MainTicketPrincipal | null;
  authorize(access: BackendMainAccess<MainTicketPrincipal>): Promise<boolean>;
  close(): void;
} {
  const tickets = new Map<string, Ticket>();
  const handlers = new Map<Socket, (payload: unknown, ack: TicketAck) => void>();
  let closed = false;
  function joined(p: MainTicketPrincipal): boolean {
    const s = p.socket;
    return !closed && s.connected && s.data.sessionUserId === p.userId && s.data.sessionRoom === p.session && s.rooms.has(`session:${p.session}`)
      && (p.role === 'pa' ? s.data.sessionMode === 'master-out' : s.data.sessionMode === 'member');
  }
  async function authorize(access: BackendMainAccess<MainTicketPrincipal>): Promise<boolean> {
    const p = access.principal;
    if (!p || p.session !== access.session || p.role !== access.role || p.plugin !== access.plugin || !joined(p)) return false;
    if (p.role !== 'contributor') return true;
    if (!p.plugin || resolveCanonicalPluginId(p.plugin) !== p.plugin) return false;
    try { return await options.resolveLockOwner(p.plugin) === p.userId && joined(p); } catch { return false; }
  }
  const onConnection = (socket: Socket) => {
    const handler = (payload: unknown, ack: TicketAck) => {
      if (typeof ack !== 'function') return;
      const request = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const role = request.role;
      if (role !== 'contributor' && role !== 'pa' && role !== 'monitor') { ack({ ok: false }); return; }
      const plugin = request.plugin;
      if ((role === 'contributor' && (typeof plugin !== 'string' || resolveCanonicalPluginId(plugin) !== plugin)) || (role !== 'contributor' && plugin !== undefined)) { ack({ ok: false }); return; }
      const userId = socket.data.sessionUserId, session = socket.data.sessionRoom;
      if (typeof userId !== 'string' || !userId || typeof session !== 'string' || !session) { ack({ ok: false }); return; }
      const principal: MainTicketPrincipal = { socket, userId, session, role, ...(role === 'contributor' ? { plugin: plugin as string } : {}) };
      void authorize({ principal, session, role, plugin: principal.plugin }).then(allowed => {
        if (!allowed || !joined(principal)) { ack({ ok: false }); return; }
        const now = Date.now();
        for (const [key, value] of tickets) if (value.expiresAt <= now || !joined(value.principal)) tickets.delete(key);
        if (tickets.size >= MAX_TICKETS) { ack({ ok: false }); return; }
        const ticket = randomBytes(32).toString('base64url'); const expiresAt = now + TICKET_LIFETIME_MS;
        tickets.set(ticket, { principal, expiresAt });
        ack({ ok: true, ticket, session, role, ...(principal.plugin ? { plugin: principal.plugin } : {}), expiresAt });
      }).catch(() => ack({ ok: false }));
    };
    handlers.set(socket, handler); socket.on('backend-main-ticket', handler);
    socket.once('disconnect', () => { handlers.delete(socket); });
  };
  io.on('connection', onConnection);
  return {
    authenticate(req) {
      if (closed) return null;
      const origin = req.headers.origin, host = req.headers.host;
      if (!origin || !host) return null;
      try { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host.toLowerCase() || parsed.username || parsed.password) return null; } catch { return null; }
      const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ticket');
      if (!token) return null;
      const found = tickets.get(token); tickets.delete(token);
      if (!found || found.expiresAt <= Date.now() || !joined(found.principal)) return null;
      return found.principal;
    },
    authorize,
    close() { closed = true; io.off('connection', onConnection); for (const [socket, handler] of handlers) socket.off('backend-main-ticket', handler); handlers.clear(); tickets.clear(); },
  };
}

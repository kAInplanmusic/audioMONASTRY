import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { attachBackendMainAccess, type MainTicketPrincipal } from '../server/backendMainAccess';

class FakeSocket extends EventEmitter {
  connected = true;
  data: Record<string, unknown> = { sessionUserId: 'alice', sessionRoom: 'studio-session', sessionMode: 'member' };
  rooms = new Set(['session:studio-session']);
}
function setup() {
  const io = new EventEmitter(); const socket = new FakeSocket(); let owner: string | null = 'alice';
  const access = attachBackendMainAccess(io as unknown as Server, { resolveLockOwner: async () => owner });
  io.emit('connection', socket);
  return { socket, access, owner: (value: string | null) => { owner = value; } };
}
function issue(socket: FakeSocket, role = 'contributor', plugin?: string): Promise<Record<string, any>> {
  return new Promise(resolve => socket.emit('backend-main-ticket', { role, ...(plugin ? { plugin } : {}) }, resolve));
}
function request(ticket: string, origin = 'https://studio.example', host = 'studio.example'): IncomingMessage {
  return { headers: { origin, host }, url: `/?ticket=${ticket}` } as IncomingMessage;
}
afterEach(() => vi.restoreAllMocks());
it('binds one-use tickets to joined identity, role, session, canonical plugin and current lock', async () => {
  const { socket, access, owner } = setup();
  const ticket = await issue(socket, 'contributor', 'syntisampler'); expect(ticket.ok).toBe(true);
  const principal = access.authenticate(request(ticket.ticket)) as MainTicketPrincipal;
  expect(principal.userId).toBe('alice');
  expect(access.authenticate(request(ticket.ticket))).toBeNull();
  const base = { principal, session: 'studio-session', role: 'contributor' as const, plugin: 'syntisampler' };
  expect(await access.authorize(base)).toBe(true);
  expect(await access.authorize({ ...base, session: 'other' })).toBe(false);
  expect(await access.authorize({ ...base, plugin: 'drumsampler' })).toBe(false);
  owner('bob'); expect(await access.authorize(base)).toBe(false);
  access.close();
});
it('rejects unjoined users, aliases, non-matching origin and expired tickets', async () => {
  const { socket, access } = setup();
  expect((await issue(socket, 'contributor', 'synthesizer')).ok).toBe(false);
  socket.data.sessionUserId = undefined; expect((await issue(socket, 'monitor')).ok).toBe(false);
  socket.data.sessionUserId = 'alice';
  const ticket = await issue(socket, 'monitor');
  expect(access.authenticate(request(ticket.ticket, 'https://evil.example'))).toBeNull();
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 30001);
  expect(access.authenticate(request(ticket.ticket))).toBeNull();
  access.close();
});
it('limits PA to its joined master-out socket and invalidates a disconnected principal', async () => {
  const { socket, access } = setup();
  expect((await issue(socket, 'pa')).ok).toBe(false);
  socket.data.sessionMode = 'master-out'; const ticket = await issue(socket, 'pa'); expect(ticket.ok).toBe(true);
  const principal = access.authenticate(request(ticket.ticket))!;
  socket.connected = false;
  expect(await access.authorize({ principal, session: 'studio-session', role: 'pa' })).toBe(false);
  access.close();
});

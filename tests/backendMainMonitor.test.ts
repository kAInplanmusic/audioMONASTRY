import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { attachBackendMainAccess, type MainTicketPrincipal } from '../server/backendMainAccess';
import { createSessionRuntime } from '../server/sessionRuntime';

class FakeSocket extends EventEmitter {
  connected = true;
  data: Record<string, unknown> = { sessionUserId: 'listener', sessionRoom: 'studio-session', sessionMode: 'member' };
  rooms = new Set(['session:studio-session']);
}
const request = (ticket: string): IncomingMessage => ({ headers: { origin: 'https://studio.example', host: 'studio.example' }, url: `/?ticket=${ticket}` } as IncomingMessage);
const issue = (socket: FakeSocket, role: 'monitor' | 'pa' | 'contributor', plugin?: string) =>
  new Promise<Record<string, any>>(resolve => socket.emit('backend-main-ticket', { role, ...(plugin ? { plugin } : {}) }, resolve));

/** R16 §P2: the backend Main monitor is not a free-for-all membership feature. */
describe('backend main monitor authorization', () => {
  it('issues a monitor ticket only for the mixerMONK or masterMONK holder', async () => {
    const runtime = createSessionRuntime();
    const io = new EventEmitter();
    const access = attachBackendMainAccess(io as unknown as Server, {
      resolveLockOwner: id => runtime.resolveLockOwner(id),
      authorizeMonitor: async userId => (await runtime.resolveLockOwner('mixer')) === userId
        || (await runtime.resolveLockOwner('master')) === userId,
    });
    const socket = new FakeSocket(); io.emit('connection', socket);

    // no holder yet -> refused
    expect((await issue(socket, 'monitor')).ok).toBe(false);

    await runtime.acquirePluginLock('master', 'listener');
    const masterTicket = await issue(socket, 'monitor');
    expect(masterTicket.ok).toBe(true);
    const principal = access.authenticate(request(masterTicket.ticket)) as MainTicketPrincipal;
    expect(await access.authorize({ principal, session: 'studio-session', role: 'monitor' })).toBe(true);

    // a plain member who holds neither lock is refused
    const other = new FakeSocket(); other.data.sessionUserId = 'stranger'; io.emit('connection', other);
    expect((await issue(other, 'monitor')).ok).toBe(false);
    access.close();
  });

  it('revalidates the monitor authority after a holder change', async () => {
    const runtime = createSessionRuntime();
    const io = new EventEmitter();
    const access = attachBackendMainAccess(io as unknown as Server, {
      resolveLockOwner: id => runtime.resolveLockOwner(id),
      authorizeMonitor: async userId => (await runtime.resolveLockOwner('mixer')) === userId
        || (await runtime.resolveLockOwner('master')) === userId,
    });
    const socket = new FakeSocket(); io.emit('connection', socket);
    await runtime.acquirePluginLock('master', 'listener');
    const ticket = await issue(socket, 'monitor'); expect(ticket.ok).toBe(true);
    const principal = access.authenticate(request(ticket.ticket)) as MainTicketPrincipal;
    expect(await access.authorize({ principal, session: 'studio-session', role: 'monitor' })).toBe(true);
    await runtime.releasePluginLock('master', 'listener');
    expect(await access.authorize({ principal, session: 'studio-session', role: 'monitor' })).toBe(false);
    access.close();
  });

  it('stays fail-closed when no monitor authority is configured', async () => {
    const io = new EventEmitter();
    const access = attachBackendMainAccess(io as unknown as Server, { resolveLockOwner: async () => 'listener' });
    const socket = new FakeSocket(); io.emit('connection', socket);
    expect((await issue(socket, 'monitor')).ok).toBe(false);
    access.close();
  });

  it('keeps the PA role working without a monitor authority', async () => {
    const io = new EventEmitter();
    const access = attachBackendMainAccess(io as unknown as Server, { resolveLockOwner: async () => null });
    const socket = new FakeSocket(); socket.data.sessionMode = 'master-out'; io.emit('connection', socket);
    const ticket = await issue(socket, 'pa');
    expect(ticket.ok).toBe(true);
    access.close();
  });
});

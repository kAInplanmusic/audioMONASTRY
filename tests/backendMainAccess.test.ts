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
  const access = attachBackendMainAccess(io as unknown as Server, { resolveLockOwner: async () => owner, authorizeMonitor: () => true });
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
it('requires PRO ownership or a current delegation in AUTO_AI and revalidates each packet', async () => {
  const io = new EventEmitter(); const socket = new FakeSocket();
  let mode: string | null = 'PRO'; let owner: string | null = 'alice'; let valid = true;
  const access = attachBackendMainAccess(io as unknown as Server, {
    resolveLockOwner: () => owner, resolveMode: () => mode,
    validateDelegation: (proof, actor, target) => valid && actor === 'alice' && target === 'eq'
      && proof.pluginId === target && proof.generationId === 'generation-1',
  });
  io.emit('connection', socket);
  const send = (payload: unknown): Promise<Record<string, any>> => new Promise(resolve => socket.emit('backend-main-ticket', payload, resolve));
  const human = await send({ role: 'contributor', plugin: 'eq' });
  const humanPrincipal = access.authenticate(request(human.ticket))!;
  const base = { principal: humanPrincipal, session: 'studio-session', role: 'contributor' as const, plugin: 'eq' };
  expect(await access.authorize(base)).toBe(true);
  mode = 'OFF'; expect(await access.authorize(base)).toBe(false);
  mode = null; expect(await access.authorize(base)).toBe(false);
  mode = 'AUTO_AI'; owner = null;
  expect((await send({ role: 'contributor', plugin: 'eq' })).ok).toBe(false);
  expect((await send({ role: 'contributor', plugin: 'eq', delegation: { pluginId: 'dsp', generationId: 'generation-1' } })).ok).toBe(false);
  const proof = { pluginId: 'eq', generationId: 'generation-1' };
  const delegated = await send({ role: 'contributor', plugin: 'eq', delegation: proof });
  expect(delegated.ok).toBe(true);
  const principal = access.authenticate(request(delegated.ticket))!;
  proof.generationId = 'changed';
  const packet = { ...base, principal };
  expect(await access.authorize(packet)).toBe(true);
  valid = false; expect(await access.authorize(packet)).toBe(false);
  valid = true; mode = 'PRO'; owner = 'alice'; expect(await access.authorize(packet)).toBe(false);
  access.close();
});

it('checks current authority synchronously after an asynchronous owner or generation check', async () => {
  const io = new EventEmitter(); const socket = new FakeSocket();
  let mode = 'PRO'; let owner = 'alice'; let generation = 'g1';
  let hold: (() => void) | undefined;
  let block = false;
  const pause = () => block ? new Promise<void>(resolve => { hold = resolve; }) : Promise.resolve();
  const access = attachBackendMainAccess(io as unknown as Server, {
    resolveMode: () => mode,
    resolveLockOwner: async () => { const captured = owner; await pause(); return captured; },
    validateDelegation: async proof => { const captured = proof.generationId === generation; await pause(); return captured; },
    confirmAuthority: principal => mode === 'PRO' ? !principal.delegation && owner === principal.userId
      : mode === 'AUTO_AI' && principal.delegation?.generationId === generation,
  });
  io.emit('connection', socket);
  const send = (payload: unknown): Promise<Record<string, any>> => new Promise(resolve => socket.emit('backend-main-ticket', payload, resolve));
  const human = await send({ role: 'contributor', plugin: 'eq' });
  const principal = access.authenticate(request(human.ticket))!;
  const packet = { principal, session: 'studio-session', role: 'contributor' as const, plugin: 'eq' };
  block = true; const pendingHuman = access.authorize(packet); await Promise.resolve(); await Promise.resolve();
  owner = 'bob'; hold!(); expect(await pendingHuman).toBe(false);
  block = false; mode = 'AUTO_AI';
  const delegated = await send({ role: 'contributor', plugin: 'eq', delegation: { pluginId: 'eq', generationId: 'g1' } });
  const aiPrincipal = access.authenticate(request(delegated.ticket))!;
  block = true; const pendingAi = access.authorize({ ...packet, principal: aiPrincipal }); await Promise.resolve(); await Promise.resolve();
  generation = 'g2'; hold!(); expect(await pendingAi).toBe(false);
  access.close();
});

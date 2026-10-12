/**
 * IDEA-2026-10-07-A-F1 · Capture-Relay über den echten Socket.io-Hub
 * (server/realtime.ts) mit echten Clients: Eingaben gehen nur an den
 * Capture-Halter (Main-Out-Owner) und nur vom drumsampler-Halter; der
 * Vorschlag wird an alle gespiegelt (auch an Nachzügler); „übernommen“ nur vom
 * Sequencer-Halter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createSessionRuntime } from '../server/sessionRuntime';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';
import { ALL_TRACKS } from '../src/types';

describe('Capture-Relay · echter Hub, mehrere Clients', () => {
  let server: http.Server;
  let hub: RealtimeHub;
  let baseUrl = '';
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    delete process.env.REDIS_URL;
    server = http.createServer();
    const runtime = createSessionRuntime({ log: () => { /* still */ } });
    hub = await createRealtimeHub(server, {
      sessionRuntime: runtime,
      addServerAudit: () => { /* still */ },
      resolveSessionMainOutUserId: () => 'user-1',
      pluginLockTtlMs: 60_000,
      studioTokenMissing: false,
      studioAuthOpen: true,
      studioAccessToken: '',
      studioSessionSecret: '',
      safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false,
      log: () => { /* still */ },
      warn: () => { /* still */ },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    await new Promise<void>((resolve) => hub?.io?.close?.(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred: () => boolean, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      await sleep(20);
    }
    throw new Error('Bedingung nicht erreicht');
  };

  async function join(userId: string) {
    const socket = ioClient(baseUrl, { path: '/webrtc-signaling', transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    const inbox: Array<Record<string, unknown>> = [];
    socket.on('capture-relay', (m: Record<string, unknown>) => inbox.push(m));
    let members = false;
    socket.on('session-members', () => { members = true; });
    await new Promise<void>((resolve, reject) => { socket.on('connect', () => resolve()); socket.on('connect_error', reject); });
    socket.emit('join-session', { userId });
    await waitFor(() => members);
    return { socket, inbox };
  }

  const bar = () => Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array(16).fill(false)]));
  const drum = { serverMs: Date.now(), kind: 'drum-pad', track: 'channel2', note: -1, velocity: 1, kitId: 'tr-808', soundId: 'kick' };

  it('Pads des drumsampler-Halters erreichen nur den Capture-Halter; ohne Lock gar nicht', async () => {
    const mixer = await join('user-1');
    const drums = await join('user-2');
    const other = await join('user-3');

    // Ohne Lock: verworfen.
    drums.socket.emit('capture-relay', { kind: 'inputs', lagMs: 50, events: [drum] });
    await sleep(150);
    expect(mixer.inbox).toHaveLength(0);

    let locked = false;
    mixer.socket.on('plugin-lock', (m: { pluginId?: string }) => { if (m?.pluginId === 'drumsampler') locked = true; });
    drums.socket.emit('plugin-lock', { pluginId: 'drumsampler' });
    await waitFor(() => locked);

    drums.socket.emit('capture-relay', { kind: 'inputs', lagMs: 50, events: [drum], senderUserId: 'spoofed' });
    await waitFor(() => mixer.inbox.length === 1);
    expect(mixer.inbox[0]).toMatchObject({ kind: 'inputs', lagMs: 50, senderUserId: 'user-2', events: [drum] });
    await sleep(100);
    expect(other.inbox).toHaveLength(0);
    expect(drums.inbox).toHaveLength(0);

    // Ein Nutzer ohne Lock kann keine Drum-Eingaben unterschieben.
    other.socket.emit('capture-relay', { kind: 'inputs', lagMs: 0, events: [drum] });
    await sleep(150);
    expect(mixer.inbox).toHaveLength(1);
  });

  it('Vorschlag gespiegelt an alle + Nachzügler; „übernommen“ nur vom Sequencer-Halter', async () => {
    const mixer = await join('user-1');
    const drums = await join('user-2');
    let locked = false;
    mixer.socket.on('plugin-lock', (m: { pluginId?: string }) => { if (m?.pluginId === 'drumsampler') locked = true; });
    drums.socket.emit('plugin-lock', { pluginId: 'drumsampler' });
    await waitFor(() => locked);

    const suggestion = {
      id: 'cap-hub', bpm: 120, bars: [bar(), bar()], drumHits: [{ bar: 1, step: 0, kitId: 'tr-808', soundId: 'kick', velocity: 1 }],
      notes: [], suggestedBarIndex: 1, barIndex: 1, transportAligned: true, capturedBy: 'user-1', status: 'open',
    };
    // Nicht-Halter darf keinen Vorschlag veröffentlichen.
    drums.socket.emit('capture-relay', { kind: 'suggestion', suggestion });
    await sleep(150);
    expect(mixer.inbox).toHaveLength(0);

    mixer.socket.emit('capture-relay', { kind: 'suggestion', suggestion });
    await waitFor(() => drums.inbox.length === 1);
    expect(drums.inbox[0]).toMatchObject({ kind: 'suggestion', suggestion: { id: 'cap-hub', capturedBy: 'user-1', status: 'open', barIndex: 1 } });

    // Nachzügler sieht das offene Fenster sofort.
    const late = await join('user-3');
    await waitFor(() => late.inbox.length === 1);
    expect(late.inbox[0]).toMatchObject({ kind: 'suggestion', suggestion: { id: 'cap-hub' } });

    // Mixer-Halter will übernehmen → abgelehnt, er bekommt den Server-Stand zurück.
    mixer.socket.emit('capture-relay', { kind: 'view', id: 'cap-hub', barIndex: 1, status: 'applied' });
    await waitFor(() => mixer.inbox.length === 1);
    expect(mixer.inbox[0]).toMatchObject({ kind: 'suggestion', suggestion: { status: 'open' } });
    expect(drums.inbox).toHaveLength(1);

    // Dritter ohne Lock darf nicht blättern.
    late.socket.emit('capture-relay', { kind: 'view', id: 'cap-hub', barIndex: 0, status: 'open' });
    await waitFor(() => late.inbox.length === 2);
    expect(drums.inbox).toHaveLength(1);

    // Sequencer-Halter übernimmt → alle anderen sehen „applied“.
    drums.socket.emit('capture-relay', { kind: 'view', id: 'cap-hub', barIndex: 1, status: 'applied' });
    await waitFor(() => mixer.inbox.length === 2 && late.inbox.length === 3);
    expect(mixer.inbox[1]).toEqual({ kind: 'view', id: 'cap-hub', barIndex: 1, status: 'applied', changedBy: 'user-2' });
    expect(late.inbox[2]).toEqual({ kind: 'view', id: 'cap-hub', barIndex: 1, status: 'applied', changedBy: 'user-2' });

    // Geschlossene Vorschläge gehen nicht mehr an Nachzügler.
    const later = await join('user-4');
    await sleep(150);
    expect(later.inbox).toHaveLength(0);
  });
});

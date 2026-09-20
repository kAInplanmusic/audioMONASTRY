/**
 * F8 · Socket-Sweep und `online`-Messwert (Ghost-Sockets)
 * ======================================================
 * Befund (docs/FIXPLAN_2026-09-20_externer_apptest.md, F8): `/api/online` meldete
 * **3 Clients bei 1 echten** — Reste abgebrochener Verbindungen. Der damalige
 * Messwert war ein freistehender Zähler; er konnte nur durch ein `disconnect`
 * wieder sinken, das im Abbruchfall nie kommt.
 *
 * Dieser Test belegt am Stub (kein Netz, keine echten Sockets):
 *   1. Der Messwert kommt aus dem Registry → 3 Buchungen bei 1 echten Verbindung
 *      ergeben 1, nicht 3 (Undriftbarkeit, nicht nur „wird irgendwann korrigiert“).
 *   2. Nach dem Abbruch eines Clients fällt der Wert innerhalb EINES
 *      Sweep-Intervalls auf den echten Wert und die Geister-Einträge sind weg.
 *   3. Idle-Sockets werden getrennt, Aktivität verschiebt die Frist.
 *   4. Der Sweep ist intervallgetrieben (kein Busy-Loop) und hämmert nicht auf
 *      einen Socket ein, der sich nicht trennen lässt.
 *
 * Zusätzlich (describe „echter Hub“): derselbe Messwert über einen echten
 * Socket.io-Server + echte Clients — dort wird die Verbindung eines Browsers
 * abgebrochen und der gemeldete Wert danach geprüft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSocketLivenessMonitor, evaluateSocketLiveness } from '../server/socketLiveness';
import { createSessionRuntime } from '../server/sessionRuntime';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * Stub-Registry: erlaubt genau den Fall, den ein Zähler nicht überlebt — eine
 * Verbindung verschwindet OHNE `disconnect`-Event.
 */
function registryStub(initial: string[] = []) {
  const sockets = new Map<string, { id: string; connected: boolean }>();
  const add = (id: string) => { sockets.set(id, { id, connected: true }); };
  for (const id of initial) add(id);
  return {
    add,
    /** Abbruch: Socket ist im Registry nicht mehr vorhanden (kein Event). */
    disappear(id: string) { sockets.delete(id); },
    /** Sauberes Trennen: bleibt im Registry, aber `connected === false`. */
    markDisconnected(id: string) {
      const socket = sockets.get(id);
      if (socket) socket.connected = false;
    },
    values: () => [...sockets.values()],
  };
}

describe('F8: online-Messwert und Socket-Sweep (Stub)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('3 Buchungen bei 1 echten Socket → online ist 1 (Registry ist die Wahrheit)', () => {
    const registry = registryStub(['s1']);
    const monitor = createSocketLivenessMonitor({
      getRegistry: registry.values,
      disconnect: () => { /* im Test nicht relevant */ },
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 1_000,
    });
    // Buchhaltung für drei Sockets, obwohl nur einer verbunden ist — genau die
    // Lage aus dem Befund.
    monitor.attach('s1');
    monitor.attach('s2');
    monitor.attach('s3');
    expect(monitor.entryCount()).toBe(3);

    // Der veröffentlichte Wert hängt am Registry, nicht an der Buchhaltung:
    // er kann nicht auf 3 stehen, solange 1 Socket verbunden ist.
    expect(monitor.online()).toBe(1);
    // Und die Gesamtzahl der Registry-Sockets deckt sich damit.
    expect(monitor.evaluate().online).toBe(1);
  });

  it('nach dem Abbruch eines Clients fällt der Wert innerhalb eines Sweep-Intervalls auf den echten Wert', () => {
    const registry = registryStub(['a', 'b', 'c']);
    const monitor = createSocketLivenessMonitor({
      getRegistry: registry.values,
      disconnect: () => { /* nichts */ },
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 1_000,
    });
    monitor.attach('a');
    monitor.attach('b');
    monitor.attach('c');
    monitor.start();
    expect(monitor.online()).toBe(3);

    // Zwei Browser-Kontexte brechen ab (Transport tot, kein sauberes Trennen).
    registry.disappear('b');
    registry.disappear('c');
    // Ohne Sweep: der Messwert steht sofort richtig, die Buchhaltung ist noch alt.
    expect(monitor.online()).toBe(1);
    expect(monitor.entryCount()).toBe(3);

    vi.advanceTimersByTime(1_000); // genau EIN Sweep-Intervall
    const sweep = monitor.lastEvaluation();
    expect(sweep?.online).toBe(1);
    expect(monitor.entryCount()).toBe(1);
    expect(sweep?.ghosts.sort()).toEqual(['b', 'c']);
    monitor.stop();
  });

  it('getrennte Sockets (connected=false) zählen nicht und werden als Geister entfernt', () => {
    const registry = registryStub(['x', 'y']);
    const monitor = createSocketLivenessMonitor({
      getRegistry: registry.values,
      disconnect: () => { /* nichts */ },
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 1_000,
    });
    monitor.attach('x');
    monitor.attach('y');
    registry.markDisconnected('y');
    const evaluation = monitor.evaluate();
    expect(evaluation.online).toBe(1);
    expect(evaluation.ghosts).toEqual(['y']);
    monitor.sweep();
    expect(monitor.entryCount()).toBe(1);
  });

  it('idle Sockets werden nach der Frist getrennt, Aktivität verschiebt die Frist', () => {
    const registry = registryStub(['idle', 'busy']);
    const disconnected: string[] = [];
    const monitor = createSocketLivenessMonitor({
      getRegistry: registry.values,
      disconnect: (id) => disconnected.push(id),
      idleTimeoutMs: 5_000,
      sweepIntervalMs: 1_000,
    });
    monitor.attach('idle');
    monitor.attach('busy');
    monitor.start();

    vi.advanceTimersByTime(4_000);
    monitor.touch('busy');           // Aktivität auf 'busy'
    vi.advanceTimersByTime(2_000);   // 'idle' ist jetzt 6 s still, 'busy' nur 2 s
    expect(disconnected).toEqual(['idle']);
    expect(monitor.online()).toBe(2); // beide noch im Registry (Stub trennt nicht)
    monitor.stop();
  });

  it('ein Socket, der sich nicht trennen lässt, wird nicht bei jedem Sweep erneut getrennt', () => {
    const registry = registryStub(['stur']);
    const disconnected: string[] = [];
    const monitor = createSocketLivenessMonitor({
      getRegistry: registry.values,
      disconnect: (id) => disconnected.push(id), // ignoriert den Auftrag absichtlich
      idleTimeoutMs: 5_000,
      sweepIntervalMs: 1_000,
      forceRetryMs: 5_000,
    });
    monitor.attach('stur');
    monitor.start();
    vi.advanceTimersByTime(6_000); // 6 Sweeps; ab dem Lauf bei 6 s ist die Frist abgelaufen
    expect(disconnected).toEqual(['stur']);
    vi.advanceTimersByTime(5_000); // nach forceRetryMs ein zweiter Versuch, nicht fünf
    expect(disconnected.length).toBe(2);
    monitor.stop();
  });

  it('der Sweep ist intervallgetrieben: genau ein Lauf je Intervall, stop() beendet ihn', () => {
    const registry = registryStub(['a']);
    let sweeps = 0;
    const monitor = createSocketLivenessMonitor({
      getRegistry: registry.values,
      disconnect: () => { /* nichts */ },
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 1_000,
      onSweep: () => { sweeps += 1; },
    });
    monitor.attach('a');
    monitor.start();
    vi.advanceTimersByTime(0);
    expect(sweeps).toBe(0);            // kein Lauf beim Start (kein Busy-Loop)
    vi.advanceTimersByTime(3_000);
    expect(sweeps).toBe(3);            // genau ein Lauf je Intervall
    monitor.stop();
    vi.advanceTimersByTime(10_000);
    expect(sweeps).toBe(3);
  });

  it('evaluateSocketLiveness ist rein: Registry ohne Liveness-Eintrag zählt als online', () => {
    const evaluation = evaluateSocketLiveness({
      now: 10_000,
      idleTimeoutMs: 5_000,
      registry: [{ id: 'neu', connected: true }, { id: 'alt', connected: true }],
      liveness: [{ id: 'alt', lastSeenAt: 1_000 }],
    });
    expect(evaluation.online).toBe(2);
    expect(evaluation.unattached).toEqual(['neu']);
    expect(evaluation.idle).toEqual(['alt']);
    expect(evaluation.ghosts).toEqual([]);
  });
});

describe('F8: online-Messwert über einen echten Socket.io-Hub', () => {
  let server: http.Server;
  let hub: RealtimeHub;
  let baseUrl = '';
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    delete process.env.REDIS_URL;
    process.env.SIGNALING_SOCKET_SWEEP_MS = '1000';
    process.env.SIGNALING_IDLE_TIMEOUT_MS = '60000';
    server = http.createServer();
    const runtime = createSessionRuntime({ log: () => { /* still */ } });
    hub = await createRealtimeHub(server, {
      sessionRuntime: runtime,
      addServerAudit: () => { /* still */ },
      resolveSessionMainOutUserId: () => 'user-1',
      pluginLockTtlMs: 60_000,
      studioTokenMissing: false,
      studioAuthOpen: true, // Testmodus: Handshake ohne Token
      studioAccessToken: '',
      studioSessionSecret: '',
      safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false,
      log: () => { /* still */ },
      warn: () => { /* still */ },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await new Promise<void>((resolve) => hub?.io?.close?.(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connect = (): Promise<ClientSocket> => new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Bedingung nicht erreicht');
  };

  it('meldet 2 verbundene Clients als 2 und fällt nach dem Abbruch eines Clients auf 1', async () => {
    const first = await connect();
    await connect();
    await waitFor(() => hub.getActiveSocketConnections() === 2);
    expect(hub.getActiveSocketConnections()).toBe(2);

    // Abrupter Abbruch: Transport zu, ohne sauberes `disconnect`-Paket.
    first.io.engine.close();
    await waitFor(() => hub.getActiveSocketConnections() === 1);
    expect(hub.getActiveSocketConnections()).toBe(1);

    // Über ein Sweep-Intervall bleibt der Wert stabil (kein Geister-Wiederaufbau).
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(hub.getActiveSocketConnections()).toBe(1);
    expect(hub.socketLiveness()?.ghosts ?? []).toEqual([]);
  });
});

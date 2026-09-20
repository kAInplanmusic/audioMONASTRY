/**
 * audioMONASTRY · Echtzeit-Schicht (ARCH-P2-002, Socket-/Session-Schicht)
 * =====================================================================
 * Letzter Schritt der server.ts-Zerlegung: Socket.io-Signalisierung, Session-
 * Raum-Verwaltung, Locks, Plugin-State-Relay, Main-Out-Ownership, Telemetrie und
 * der optionale Mediasoup-SFU. Das war ueber 600 Zeilen in `startServer` - und
 * damit Code, der nur ueber den Modulscope von server.ts an Session, Audit und
 * Metriken kam.
 *
 * Die Schicht bekommt alles, was sie benutzt, als `deps` - sie kennt server.ts
 * nicht mehr. Umgekehrt bleibt server.ts die Komposition: app/HTTP, Routen und
 * Start/Stop.
 *
 * Rueckgabe: nur `io` (fuer `serverIo`-Zugriffe der Routen) und der
 * Verbindungszaehler. Der Zaehler liegt absichtlich HIER: er beschreibt genau
 * das, was dieses Modul verwaltet (offene Socket-Verbindungen).
 *
 * F8-Fix (Ghost-Sockets, docs/FIXPLAN_2026-09-20_externer_apptest.md):
 * Der Zaehler ist kein freistehendes `let` mehr, sondern wird aus dem
 * Socket.io-Registry abgeleitet; die Liveness je Socket und der idle-basierte
 * Sweep liegen in `./socketLiveness.ts` (mit Stub-Sockets testbar). Damit kann
 * `/api/online` nach abgebrochenen Verbindungen nicht mehr bei 3 stehen bleiben,
 * waehrend 1 Client verbunden ist.
 */
import http from 'node:http';
import { isListenerMode, normalizeSessionMode } from '../src/core/session/listenerMode';
import { buildPluginStateRelayPayload } from '../src/core/session/pluginStateRelay';
import {
  canControlMainOut,
  MIXER_NEVER_CLOSES,
  isMainOutPlugin,
  validateMainOutPayload,
} from '../src/core/session/mainOutGuard';
import {
  PluginLockSocketSchema,
  PluginLockTransferSocketSchema,
  PluginStateSocketSchema,
} from '../src/types/zod/schemas';
import { createRedisKeyValueStore } from '../src/core/persistence/redisKeyValueStore';
import type { SessionRuntime } from './sessionRuntime.ts';
import {
  createSocketLivenessMonitor,
  type SocketLivenessEvaluation,
  type SocketLivenessMonitor,
} from './socketLiveness.ts';
import { resolveSfuAnnouncedIp } from './sfuNetwork.ts';
import { normalizeSfuSignalingPath } from './webrtcConfig.ts';

/**
 * Was injiziert wird, ist genau das, was server.ts zur Laufzeit besitzt:
 * die Session-Laufzeit, das Audit-Log, die Main-Out-Aufloesung und die
 * Auth-Konfiguration. Alles Rein-Funktionale (Schemas, Guard-Pruefungen,
 * Listener-Modus, Relay-Vertrag, Redis-Adapter) wird direkt importiert - es ist
 * zustandslos und braucht keine Verdrahtung.
 */
/**
 * Antwort auf einen Clock-Ping: t0 kommt vom Client, t1/t2 sind Serverzeit
 * (reines Echo ohne Zustand - siehe `socket.on('clock-ping')`).
 */
export function buildClockPong(data: unknown, serverTime: number): { t0: number; t1: number; t2: number } {
  const raw = Number((data as { t0?: unknown })?.t0 ?? Number.NaN);
  return { t0: Number.isFinite(raw) ? raw : 0, t1: serverTime, t2: serverTime };
}

export interface RealtimeDeps {
  sessionRuntime: SessionRuntime;
  addServerAudit: (userId: string, role: string, action: string, ok: boolean, target?: string) => void;
  resolveSessionMainOutUserId: () => string;
  pluginLockTtlMs: number;
  studioTokenMissing: boolean;
  studioAuthOpen: boolean;
  studioAccessToken: string;
  studioSessionSecret: string;
  safeTokenEqual: (a: string, b: string) => boolean;
  looksLikeStudioSession: (token: string) => boolean;
  verifyStudioSession: (token: string, secret: string) => Promise<boolean>;
  log?: (message: string) => void;
  warn?: (message: string, error?: unknown) => void;
}

export interface RealtimeHub {
  io: any;
  getActiveSocketConnections(): number;
  /**
   * Ergebnis des letzten Socket-Sweeps (F8): Geister/idle/online. `null`, solange
   * noch kein Sweep lief. Reine Diagnose — die Ops-Routen zeigen damit, dass der
   * Messwert aus dem Registry kommt und wie viele Geister entfernt wurden.
   */
  socketLiveness(): SocketLivenessEvaluation | null;
}

export async function createRealtimeHub(server: http.Server, deps: RealtimeDeps): Promise<RealtimeHub> {
  const {
    sessionRuntime,
    addServerAudit,
    resolveSessionMainOutUserId,
    pluginLockTtlMs,
    studioTokenMissing,
    studioAuthOpen,
    studioAccessToken,
    studioSessionSecret,
    safeTokenEqual,
    looksLikeStudioSession,
    verifyStudioSession,
  } = deps;
  const log = deps.log ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));

  /**
   * Offene Socket-Verbindungen (Anzeige in den Ops-Metriken).
   *
   * F8-Fix: KEIN freistehender Zähler mehr. Der Messwert wird aus dem
   * Socket-Registry abgeleitet (`socketLiveness.online()`), der Sweep unten
   * räumt Reste abgebrochener Verbindungen weg. Beleg: FIXPLAN F8 — `/api/online`
   * meldete 3 Clients bei 1 echten.
   */
  // --- WebRTC Socket.io signaling (same origin as the app) ---
  const IDLE_TIMEOUT_MS = Number(process.env.SIGNALING_IDLE_TIMEOUT_MS || 20 * 60 * 1000);
  // Sweep-Intervall: 30 s. Bewusst intervallgetrieben (kein Busy-Loop) — der
  // Messwert selbst hängt nicht am Sweep, nur das Aufräumen der Idle-Sockets.
  const SWEEP_INTERVAL_MS = Math.max(1_000, Number(process.env.SIGNALING_SOCKET_SWEEP_MS || 30_000));

  const ALLOWED_ORIGINS = (process.env.SIGNALING_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // '*' muss als Wildcard durchgereicht werden (Array ['*'] matcht keine Origins).
  const CORS_ORIGIN: any = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : ALLOWED_ORIGINS.length > 0
      ? ALLOWED_ORIGINS
      : false;

  let io: any = null;

  /**
   * Liveness/Sweep (F8): Die Hülle kennt socket.io nicht — sie fragt das Registry
   * über den Getter ab (der `io` erst zur Laufzeit liest) und trennt über den
   * Callback. Deshalb kann sie VOR `io` angelegt werden und ist mit Stubs ohne
   * Netz testbar (tests/socketLiveness.test.ts).
   */
  const socketLiveness: SocketLivenessMonitor = createSocketLivenessMonitor({
    getRegistry: () => io?.sockets?.sockets?.values?.() ?? [],
    disconnect: (id: string) => {
      try {
        io?.sockets?.sockets?.get?.(id)?.disconnect?.(true);
      } catch (e) {
        warn('[signaling] Socket-Sweep: Trennen fehlgeschlagen:', (e as Error).message);
      }
    },
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    log: (message: string) => log(message),
  });
  socketLiveness.start();

  try {
    const { Server } = (await import('socket.io')) as any;
    io = new Server(server, {
      cors: {
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST'],
      },
      path: '/webrtc-signaling',
    });
    // `io` wird als Hub-Rueckgabe veroeffentlicht (server.ts setzt `serverIo`).

    // P-11: Handshake-Auth + Origin-Prüfung. Mit studioAccessToken müssen
    // Clients das `studio`-Cookie (vom Portal gesetzt) mitschicken.
    io.use(async (socket: any, next: (err?: Error) => void) => {
      const origin = String(socket.handshake?.headers?.origin ?? '');
      if (
        ALLOWED_ORIGINS.length > 0 &&
        !ALLOWED_ORIGINS.includes('*') &&
        origin &&
        !ALLOWED_ORIGINS.includes(origin)
      ) {
        return next(new Error('origin-not-allowed'));
      }
      // P0-Security: fail-closed – ohne Studio-Token und ohne expliziten
      // Dev-/Test-Modus keine Signalisierung/WebRTC.
      if (studioTokenMissing) {
        return next(new Error('server-not-configured'));
      }
      if (!studioAuthOpen) {
        const cookie = String(socket.handshake?.headers?.cookie ?? '');
        const m = cookie.match(/(?:^|;\s*)studio=([^;]+)/);
        const token = String(socket.handshake?.auth?.token ?? '') ||
          String(socket.handshake?.headers?.['x-studio-token'] ?? '') ||
          (m ? decodeURIComponent(m[1]) : '');
        const masterOk = Boolean(token) && safeTokenEqual(token, studioAccessToken);
        // SEC-P2-002: zusätzlich das kurzlebige Portal-Session-Token akzeptieren.
        const sessionOk = !masterOk && Boolean(token) && looksLikeStudioSession(token)
          && (await verifyStudioSession(token, studioSessionSecret));
        if (!masterOk && !sessionOk) {
          return next(new Error('unauthorized'));
        }
      }
      next();
    });

    // Multi-Instanz-Modus: Mit REDIS_URL teilen sich alle App-Knoten die
    // Socket.io-Räume (Session-/Plugin-State über Prozessgrenzen hinweg).
    // S-9: REDIS_URL nur mit redis/rediss-Schema akzeptieren.
    let redisUrl = (process.env.REDIS_URL || '').trim();
    if (redisUrl && !/^rediss?:\/\//i.test(redisUrl)) {
      warn('[signaling] REDIS_URL ungültig (Schema) – In-Memory-Adapter aktiv.');
      redisUrl = '';
    }
    if (redisUrl) {
      try {
        const [{ createClient }, { createAdapter }] = await Promise.all([
          import('redis'),
          import('@socket.io/redis-adapter'),
        ]);
        const pubClient = createClient({ url: redisUrl });
        const subClient = pubClient.duplicate();
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        // COLLAB-P0-001 + PERSIST-P1-003: Session-State, Locks UND Snapshots
        // liegen in Redis, damit Neustart/zweite Instanz nichts verlieren.
        // Best-effort: Fehler duerfen den Audio-/Signaling-Betrieb nicht stoeren.
        const { restored, snapshotRestored } = await sessionRuntime.restoreFromRedis(
          pubClient,
          createRedisKeyValueStore(pubClient),
        );
        const rev = sessionRuntime.session.revision;
        log(`Redis-Adapter aktiv (Socket.io Multi-Instanz). Session-State ${restored ? `wiederhergestellt (rev=${rev})` : snapshotRestored ? `aus Snapshot (rev=${rev})` : 'neu'}. Snapshots liegen in Redis.`);
      } catch (e) {
        warn('Redis-Adapter nicht aktiv:', (e as Error).message);
      }
    }

    io.on('connection', (socket: any) => {
      // F8-Fix: EIN Ort für die Liveness je Socket. Den Idle-Timer PRO Verbindung
      // gibt es nicht mehr — der Sweep trennt idle Sockets zentral (und räumt
      // Geister auf). `markSocketActivity()` ist der Ersatz für das frühere
      // `refreshIdleTimer()` an allen Aktivitätspunkten.
      socketLiveness.attach(socket.id);
      const markSocketActivity = () => socketLiveness.touch(socket.id);

      socket.on('disconnect', () => {
        socketLiveness.detach(socket.id);
      });

      // S-2: Signaling-Relay mit Ziel-Validierung – es darf nur an Sockets
      // derselben Session geroutet werden (nie an fremde/ungültige Socket-IDs).
      const relayToSessionPeer = (event: string, data: any, payload: Record<string, unknown>): void => {
        const targetId = String(data?.target ?? '').trim();
        if (!targetId) return;
        const target = io.sockets.sockets.get(targetId);
        if (!target) return;
        const sameRoom = !!socket.data?.sessionRoom
          && target.data?.sessionRoom === socket.data.sessionRoom;
        if (!sameRoom) return;
        target.emit(event, payload);
      };

      socket.on('offer', (data: any) => {
        markSocketActivity();
        if (!data.offer) return;
        relayToSessionPeer('offer', data, { offer: data.offer, sender: socket.id, senderMode: socket.data?.sessionMode ?? 'member' });
      });
      socket.on('answer', (data: any) => {
        markSocketActivity();
        if (!data.answer) return;
        relayToSessionPeer('answer', data, { answer: data.answer, sender: socket.id });
      });
      socket.on('ice-candidate', (data: any) => {
        markSocketActivity();
        if (!data.candidate) return;
        relayToSessionPeer('ice-candidate', data, { candidate: data.candidate, sender: socket.id });
      });
      socket.on('activity', markSocketActivity);

      // Clock-Sync (NTP-artig): der Server spiegelt BEIDE Zeitstempel zurueck,
      // damit der Client den Offset zur Serveruhr rechnen kann (Live-Befund
      // 2026-09-19: die Kette existierte, aber niemand sendete je einen Ping -
      // syncCount blieb 0). Reines Echo: kein Zustand, kein Audit, keine Locks.
      socket.on('clock-ping', (data: unknown, ack?: (answer: unknown) => void) => {
        const answer = buildClockPong(data, Date.now());
        if (typeof ack === 'function') ack(answer);
        else socket.emit('clock-pong', answer);
      });

      // -------------------------------------------------------------------
      // Session-Verwaltung (EINE feste Session, max. 4 User) – Full-Mesh.
      //   Kein Raum-Erstellen/Beitreten: Jede App-Sitzung ist automatisch
      //   genau dieser eine Raum. 'join-session { userId }' → 'session-members'
      //   an den Neuen, 'peer-joined' an alle anderen; bei >4: 'session-full'.
      // -------------------------------------------------------------------
      const SESSION_ROOM_ID = 'studio-session';
      const MAX_SESSION_USERS = 4;

      const sessionMembers = (room: string, excludeSocketId: string) => {
        const members: { socketId: string; userId: string; role: string }[] = [];
        const sockets = io.sockets.adapter.rooms.get(room);
        if (sockets) {
          for (const sid of sockets) {
            if (sid === excludeSocketId) continue;
            const s = io.sockets.sockets.get(sid);
            // Listener (Ghostuser 5/6) zählen NICHT als Session-Mitglieder.
            if (s?.data?.sessionUserId && !isListenerMode(normalizeSessionMode(s?.data?.sessionMode))) {
              members.push({ socketId: sid, userId: s.data.sessionUserId, role: s.data.sessionRole ?? 'guest' });
            }
          }
        }
        return members;
      };

      /**
       * COLLAB-P0-002: Mitgliederliste serverautoritativ an ALLE Session-Sockets
       * verteilen (jeder bekommt die Liste OHNE sich selbst). Vorher bekam nur der
       * Beitretende eine `session-members`-Nachricht; die anderen erfuhren eine
       * Änderung nur über `peer-joined` — ein Client, der beim Join noch nicht
       * zuhörte (Modul-Init vor React-Mount), blieb dauerhaft auf einem alten
       * Zähler stehen (live nachgestellt 2026-09-13).
       */
      const broadcastSessionMembers = (room: string): void => {
        const sockets = io.sockets.adapter.rooms.get(room);
        if (!sockets) return;
        for (const sid of sockets) {
          const s = io.sockets.sockets.get(sid);
          if (!s?.data?.sessionUserId) continue;
          const selfMode = normalizeSessionMode(s.data.sessionMode);
          s.emit('session-members', {
            roomId: SESSION_ROOM_ID,
            members: sessionMembers(room, sid),
            selfMode,
            mainOutUserId: resolveSessionMainOutUserId(),
          });
        }
      };

      socket.on('join-session', (data: any) => {
        markSocketActivity();
        const userId = String(data?.userId ?? socket.id).trim();
        // MASTEROUTMAINSTREAM/VISUALOUTMAINSTREAM: eigener Listen-Modus – zählt
        // nicht zu den 4 Usern, sendet selbst nichts und bekommt die
        // Mitgliederliste, um den Host zu finden (Szenario: 4 iPads + Laptop an
        // der PA (/master-out) + Beamer (/visual-out)).
        const mode = normalizeSessionMode(data?.mode);
        const room = `session:${SESSION_ROOM_ID}`;
        socket.data.sessionUserId = userId;
        socket.data.sessionRoom = SESSION_ROOM_ID;
        socket.data.sessionMode = mode;
        // ROLLENSYSTEM ENTFERNT: alle Session-User sind gleich; nur der
        // mixerMONK-Lock-Owner ist besonders (Main-Out).
        socket.data.sessionRole = 'member';
        addServerAudit(userId, 'member', mode === 'master-out' ? 'JOIN_MASTER_OUT' : mode === 'visual-out' ? 'JOIN_VISUAL_OUT' : 'JOIN_SESSION', true, SESSION_ROOM_ID);
        socket.join(room);
        // K-2: Aktive Locks an den neuen Teilnehmer synchronisieren (Legacy-Format).
        socket.emit('plugin-locks-sync', {
          roomId: SESSION_ROOM_ID,
          locks: sessionRuntime.legacyLockMap(),
        });
        // COLLAB-P0-001: vollständiger, serverautoritativer Snapshot für
        // Join/Reconnect – Revision + Modul-States + Locks + Sequenzen.
        {
          const snapshot = sessionRuntime.session.snapshot();
          socket.emit('session-state', {
            roomId: SESSION_ROOM_ID,
            revision: snapshot.revision,
            modules: snapshot.modules,
            locks: snapshot.locks,
            sequences: snapshot.sequences,
            serverTime: snapshot.serverTime,
          });
        }

        const members = sessionMembers(room, socket.id);
        if (isListenerMode(mode)) {
          // Nicht an die Session-Mitglieder ankündigen (kein peer-joined), damit
          // niemand Mikrofon-Tracks an den Listener schickt. Der Listener
          // initiiert seine Verbindung selbst zum Host.
          socket.emit('session-members', {
            roomId: SESSION_ROOM_ID,
            members,
            selfMode: mode,
            mainOutUserId: resolveSessionMainOutUserId(),
          });
          return;
        }

        if (members.length >= MAX_SESSION_USERS) {
          socket.emit('session-full', { roomId: SESSION_ROOM_ID, max: MAX_SESSION_USERS });
          socket.leave(room);
          return;
        }

        // COLLAB-P0-002: Erst dem Raum den neuen Peer ankündigen, dann allen
        // (inklusive dem Neuen) die autoritative Mitgliederliste schicken.
        socket.to(room).emit('peer-joined', { roomId: SESSION_ROOM_ID, socketId: socket.id, userId });
        broadcastSessionMembers(room);
      });

      // K-2/K-5: Server-autoritative Plugin-Locks (Client bleibt optimistisch).
      socket.on('plugin-lock', (data: any) => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginLockSocketSchema.safeParse(data ?? {});
        if (!parsed.success) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const pluginId = parsed.data.pluginId;
        const acquired = sessionRuntime.session.acquireLock(pluginId, senderUserId);
        if (!acquired.ok) {
          socket.emit('plugin-lock-denied', { pluginId, lockedBy: acquired.lockedBy ?? null });
          return;
        }
        sessionRuntime.persist();
        const lock = { lockedBy: senderUserId, timestamp: Date.now(), ttl: pluginLockTtlMs };
        const revision = sessionRuntime.session.revision;
        socket.to(`session:${roomId}`).emit('plugin-lock', { pluginId, ...lock, revision });
        socket.emit('plugin-lock', { pluginId, ...lock, revision });
        if (pluginId === 'mixer') broadcastMainOutOwner(`session:${roomId}`);
        addServerAudit(senderUserId, String(socket.data?.sessionRole ?? 'guest'), 'PLUGIN_LOCK', true, pluginId);
      });
      // COLLAB-P0-004 (Teil 2): gezielte Uebergabe des Halters. Betreiberregel
      // 2026-09-17: der Halter kann mixerMONK an einen bestimmten Nutzer geben -
      // danach ist dieser der Einzige, der den Mainsound beeinflusst. Nur der
      // aktuelle Halter darf uebertragen; der Ziel-Nutzer muss im Raum sein.
      socket.on('plugin-lock-transfer', (data: any) => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginLockTransferSocketSchema.safeParse(data ?? {});
        if (!parsed.success) {
          socket.emit('plugin-lock-transfer-denied', { reason: 'invalid' });
          return;
        }
        const { pluginId, toUserId } = parsed.data;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        // Der Raumname traegt das Praefix 'session:' (siehe join-session: room = `session:${SESSION_ROOM_ID}`).
        // Ohne das Praefix findet sessionMembers keine Mitglieder - live aufgefallen 2026-09-17.
        const targetIsMember = sessionMembers(`session:${roomId}`, '').some((m) => m.userId === toUserId);
        if (!targetIsMember) {
          socket.emit('plugin-lock-transfer-denied', { pluginId, reason: 'target-not-in-session', lockedBy: sessionRuntime.session.lockOwner(pluginId) ?? null });
          return;
        }
        const result = sessionRuntime.session.transferLock(pluginId, senderUserId, toUserId);
        if (!result.ok) {
          socket.emit('plugin-lock-transfer-denied', {
            pluginId,
            reason: result.reason ?? 'invalid',
            lockedBy: result.lockedBy ?? null,
          });
          addServerAudit(senderUserId, String(socket.data?.sessionRole ?? 'guest'), 'PLUGIN_LOCK_TRANSFER', false, pluginId);
          return;
        }
        sessionRuntime.persist();
        const lock = { lockedBy: toUserId, timestamp: Date.now(), ttl: pluginLockTtlMs };
        const revision = sessionRuntime.session.revision;
        io.to(`session:${roomId}`).emit('plugin-lock', { pluginId, ...lock, revision });
        if (pluginId === 'mixer') broadcastMainOutOwner(`session:${roomId}`);
        addServerAudit(senderUserId, String(socket.data?.sessionRole ?? 'guest'), 'PLUGIN_LOCK_TRANSFER', true, pluginId);
      });
      // ARCH-#2: Broadcast-Callback für Lock-Ablauf (der Sweep laeuft in der
      // Session-Laufzeit und ruft ihn hier auf - io/room leben in diesem Scope).
      sessionRuntime.setLockExpiryBroadcaster((pluginId: string) => {
        io.to(`session:${SESSION_ROOM_ID}`).emit('plugin-unlock', {
          pluginId,
          lockedBy: null,
          reason: 'expired',
        });
        broadcastMainOutOwner(`session:${SESSION_ROOM_ID}`);
      });
      // P0-1 (revidiert): Main-Out-Owner bei jedem Lock-Wechsel an den Raum
      // broadcasten – die Clients spiegeln sonst einen veralteten Owner.
      const broadcastMainOutOwner = (roomId: string): void => {
        io.to(roomId).emit('main-out-owner', { userId: resolveSessionMainOutUserId(), ts: Date.now() });
      };
      socket.on('plugin-unlock', (data: any) => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginLockSocketSchema.safeParse(data ?? {});
        if (!parsed.success) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const pluginId = parsed.data.pluginId;
        if (!sessionRuntime.session.releaseLock(pluginId, senderUserId)) return;
        sessionRuntime.persist();
        socket.to(`session:${roomId}`).emit('plugin-unlock', { pluginId, userId: senderUserId, revision: sessionRuntime.session.revision });
        if (pluginId === 'mixer') broadcastMainOutOwner(`session:${roomId}`);
        addServerAudit(senderUserId, String(socket.data?.sessionRole ?? 'guest'), 'PLUGIN_UNLOCK', true, pluginId);
      });

      // COLLAB-P0-001: Reconnect-Resync – der Client fordert den vollständigen
      // autoritativen Zustand an, ohne die Session neu zu betreten (kein Pumping).
      socket.on('resync-session', () => {
        markSocketActivity();
        if (!socket.data?.sessionRoom) return;
        const snapshot = sessionRuntime.session.snapshot();
        socket.emit('plugin-locks-sync', { roomId: SESSION_ROOM_ID, locks: sessionRuntime.legacyLockMap() });
        socket.emit('session-state', {
          roomId: SESSION_ROOM_ID,
          revision: snapshot.revision,
          modules: snapshot.modules,
          locks: snapshot.locks,
          sequences: snapshot.sequences,
          serverTime: snapshot.serverTime,
        });
      });

      // DCT-102: Socket.io-Relay für Modul-/AUTO_AI-State, wenn WebRTC-DataChannels
      // (noch) nicht offen sind – deterministischer Fallback über den Signaling-Pfad.
      socket.on('plugin-state', (data: any) => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginStateSocketSchema.safeParse(data ?? {});
        if (!parsed.success) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        const { pluginId, state } = parsed.data;
        // COLLAB-P0-004 (Betreiberregel 2026-09-17): mixerMONK ist die einzige
        // Main-Einspeisung und laesst sich NIE schliessen - auch nicht vom Halter.
        // OFF wuerde die Signalkette trennen und Main UND Clock stoppen.
        if (pluginId === MIXER_NEVER_CLOSES && state === 'OFF') {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, pluginId);
          socket.emit('rbac-denied', {
            action: 'plugin-state',
            pluginId,
            state,
            role: senderRole,
            reason: 'mixerMONK laesst sich nicht schliessen',
          });
          return;
        }
        // K-2: Lock serverseitig durchsetzen – nur der Halter darf den State ändern.
        const lockOwner = sessionRuntime.session.lockOwner(pluginId);
        if (lockOwner && lockOwner !== senderUserId) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, pluginId);
          socket.emit('rbac-denied', { action: 'plugin-state', pluginId, state, role: senderRole, reason: 'locked by other' });
          return;
        }
        // ROLLENSYSTEM ENTFERNT: keine Rollen-Prüfung für PRO/OFF/AUTO_AI mehr.
        // Jeder Session-User darf Plugins schalten; Locks + Main-Out-Schutz
        // (unten) regeln die Exklusivität.
        // P0-1: Main-Out-Schutz – mixer/master-Zustand ändert nur der MixerMONK
        // (Main-Out-Owner). Andere User dürfen den Main-Out nicht schalten,
        // auch nicht auf OFF (OFF würde das Main-Signal abwürgen).
        if (isMainOutPlugin(pluginId) && !canControlMainOut(senderUserId, resolveSessionMainOutUserId())) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, `${pluginId}:main-out protected`);
          socket.emit('rbac-denied', {
            action: 'plugin-state',
            pluginId,
            state,
            reason: 'main-out protected (mixerMONK only)',
            mainOutUserId: resolveSessionMainOutUserId(),
          });
          return;
        }
        // COLLAB-P0-001: doppelte/verspätete Events deterministisch verwerfen.
        const eventId = parsed.data.eventId
          ?? `${senderUserId}:${pluginId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        const applied = sessionRuntime.session.applyEvent({
          id: eventId,
          type: 'plugin-state',
          senderUserId,
          pluginId,
          state,
          sequence: parsed.data.sequence,
        });
        if (!applied.accepted) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, `${pluginId}:${applied.reason}`);
          socket.emit('plugin-state-rejected', {
            pluginId,
            eventId,
            reason: applied.reason ?? 'invalid',
            revision: applied.revision,
          });
          return;
        }
        sessionRuntime.persist();
        addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', true, pluginId);
        // Session-Identität + Revision/Event-ID: Empfänger können ordnen/deduplizieren.
        // COLLAB-P0-002: Payload über den getesteten Vertrags-Builder bauen. Der
        // frühere Spread `{ ...parsed.data }` enthielt KEIN type, senderId und
        // timestamp (Zod strippt unbekannte Keys) - die Clients haben das Relay
        // deshalb in dispatchDataMessage verworfen, und die State-Spiegelung hing
        // allein an offenen DataChannels.
        const payload = buildPluginStateRelayPayload({
          pluginId,
          state,
          senderUserId,
          senderRole,
          revision: applied.revision,
          eventId,
          sequence: parsed.data.sequence,
          timestamp: parsed.data.timestamp,
        });
        socket.to(`session:${roomId}`).emit('plugin-state', payload);
        socket.emit('plugin-state-ack', { pluginId, eventId, revision: applied.revision });
      });

      // COLLAB-P1-004: Aktives Plugin/Nav an die Session spiegeln. Reiner
      // UI-Hinweis (kein Audio-State, keine Lock-Wirkung) – egal welcher User
      // gerade welches Modul bedient, die anderen sehen es im Header.
      socket.on('session-nav', (data: any) => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        const pluginId = String(data?.pluginId ?? '').trim().slice(0, 64);
        if (!pluginId) return;
        const payload = { pluginId, senderUserId, senderRole, ts: Date.now() };
        socket.to(`session:${roomId}`).emit('session-nav', payload);
      });

      // P0-1: Server-validierter Main-Out-Parameterkanal (MixerMONK exklusiv).
      // Clients, die Main-Out-Parameter (masterVolume, Fades, …) ändern wollen,
      // senden hierhin statt über den unkontrollierten Peer-Pfad. Der Server
      // validiert Berechtigung + Payload und broadcastet an den Session-Raum.
      socket.on('main-out-update', (data: unknown) => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        const mainOutUserId = resolveSessionMainOutUserId();
        if (!canControlMainOut(senderUserId, mainOutUserId)) {
          addServerAudit(senderUserId, senderRole, 'MAIN_OUT_UPDATE', false);
          socket.emit('rbac-denied', {
            action: 'main-out-update',
            role: senderRole,
            reason: 'main-out protected (MixerMONK only)',
            mainOutUserId,
          });
          return;
        }
        // COLLAB-P1-005: zusaetzlich Allow-List + Wertebereich. Vorher wurde ein
        // formal gueltiger Payload mit unbekanntem Namen (z. B. `bpm`) oder
        // einem Wert ausserhalb des Bereichs (`masterVolumeDb = 99`) ungeprueft
        // an alle Peers gespiegelt und dort auf den Main-Out angewandt.
        // `'reason' in parsed` statt `!parsed.ok`: das Repo faehrt ohne `strict`
        // (strictNullChecks off), dort greift die Diskriminanten-Verengung ueber
        // ein Boolean-Literal nicht - die `in`-Verengung schon.
        const parsed = validateMainOutPayload(data);
        if ('reason' in parsed) {
          addServerAudit(senderUserId, senderRole, 'MAIN_OUT_UPDATE', false, String(parsed.reason));
          socket.emit('main-out-update-rejected', {
            param: String((data as { param?: unknown } | null)?.param ?? ''),
            reason: parsed.reason,
          });
          return;
        }
        addServerAudit(senderUserId, senderRole, 'MAIN_OUT_UPDATE', true, `${parsed.param}=${parsed.value}`);
        const payload = {
          param: parsed.param,
          value: parsed.value,
          senderUserId,
          senderRole,
          ts: Date.now(),
        };
        socket.to(`session:${roomId}`).emit('main-out-update', payload);
        socket.emit('main-out-update', payload);
      });

      socket.on('leave-session', () => {
        markSocketActivity();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const userId = String(socket.data?.sessionUserId ?? '');
        // K-5/COLLAB-P0-001: Locks des Users beim Verlassen freigeben.
        const released = sessionRuntime.session.releaseUserLocks(userId);
        for (const pluginId of released) {
          socket.to(`session:${roomId}`).emit('plugin-unlock', { pluginId, userId, reason: 'left' });
        }
        sessionRuntime.persist();
        if (released.includes('mixer')) broadcastMainOutOwner(`session:${roomId}`);
        socket.to(`session:${roomId}`).emit('peer-left', { roomId, socketId: socket.id, userId: socket.data?.sessionUserId });
        socket.leave(`session:${roomId}`);
      });

      socket.on('disconnect', () => {
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const userId = String(socket.data?.sessionUserId ?? '');
        // K-5: Locks des getrennten Users sofort freigeben und verteilen.
        const released = sessionRuntime.session.releaseUserLocks(userId);
        for (const pluginId of released) {
          socket.to(`session:${roomId}`).emit('plugin-unlock', { pluginId, userId, reason: 'disconnect' });
        }
        sessionRuntime.persist();
        if (released.includes('mixer')) broadcastMainOutOwner(`session:${roomId}`);
        socket.to(`session:${roomId}`).emit('peer-left', { roomId, socketId: socket.id, userId: socket.data?.sessionUserId });
      });
    });

    // ---------------------------------------------------------------------
    // SFU (Mediasoup) – skalierbarer Kollaborations-Transport für 10+ Nutzer
    // Aktiviert mit ENABLE_SFU=1. Baut einen Mediasoup-Router pro Session auf
    // und bedient die RTC-Capabilities-/Transport-/Produce-/Consume-Anfragen
    // des Frontend-`MediasoupTransport`.
    // ---------------------------------------------------------------------
    if ((process.env.ENABLE_SFU || '').trim() === '1') {
      try {
        const mediasoup = (await import('mediasoup')) as any;
        // F6: Pfad der SFU-Signalisierung aus derselben Quelle wie die
        // /api/webrtc-config-Antwort - Client und Server koennen nicht auseinanderlaufen.
        const SFU_SIGNALING_PATH = normalizeSfuSignalingPath(process.env.SFU_SIGNALING_PATH);
        const sfuIo = new Server(server, {
          cors: {
            origin: CORS_ORIGIN,
            methods: ['GET', 'POST'],
          },
          path: SFU_SIGNALING_PATH,
        });

        // Globale (für diese Prozessinstanz) Worker/Router-Registry je Session.
        // RTC-Portbereich per Env einstellbar, damit der docker-compose-Portbereich
        // klein gehalten werden kann (sonst erzeugt Docker sehr viele iptables-Regeln).
        const SFU_RTC_MIN_PORT = Number(process.env.SFU_RTC_MIN_PORT || 40000);
        const SFU_RTC_MAX_PORT = Number(process.env.SFU_RTC_MAX_PORT || 40099);
        // F6: Die öffentliche IP zur LAUFZEIT ermitteln, statt sie zu erwarten.
        // Vorher war SFU_ANNOUNCED_IP auf dem SFU-Knoten leer (bzw. im Portal-Pfad
        // die PRIVATE 10.x-Adresse aus `hostname -I`) - Mediasoup kündigte dann
        // Adressen an, die kein externer Browser erreichen kann, ohne dass es
        // irgendwo stand.
        const announced = await resolveSfuAnnouncedIp(process.env);
        const SFU_ANNOUNCED_IP = announced.announcedIp ?? undefined;
        if (SFU_ANNOUNCED_IP) {
          log(`SFU: announcedIp=${SFU_ANNOUNCED_IP} (Quelle: ${announced.source})`);
        } else {
          warn(
            '[sfu] SFU_ANNOUNCED_IP nicht ermittelbar - ICE-Kandidaten tragen keine oeffentliche Adresse, '
            + `der Medienpfad bleibt auf das LAN beschraenkt (${announced.reason ?? 'unbekannt'}; `
            + `Versuche: ${announced.attempts.join(' | ') || 'keine'})`,
          );
        }
        const mWorker = await mediasoup.createWorker({ rtcMinPort: SFU_RTC_MIN_PORT, rtcMaxPort: SFU_RTC_MAX_PORT });
        const routers = new Map<string, any>();
        // Producer-Registry je Session: erlaubt Peer-uebergreifendes Consume.
        const sessionProducers = new Map<string, Map<string, any>>();

        const ensureRouter = async (sessionId: string) => {
          if (!routers.has(sessionId)) {
            const router = await mWorker.createRouter({
              mediaCodecs: [
                { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
              ],
            });
            routers.set(sessionId, router);
          }
          return routers.get(sessionId);
        };

        sfuIo.on('connection', (socket: any) => {
          const sessionId = (socket.handshake?.query?.sessionId || 'main').toString();
          // S-5: sessionId strikt whitelisten (kein Path/Namespace-Injection in Raumnamen).
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
            socket.disconnect(true);
            return;
          }
          // Mehrere Transports je Socket (send + recv) und lokale Producer-Map.
          const transports = new Map<string, any>();
          const producers = new Map<string, any>();
          if (!sessionProducers.has(sessionId)) sessionProducers.set(sessionId, new Map());
          const sessionProducerMap = sessionProducers.get(sessionId)!;
          socket.join(`sfu-session:${sessionId}`);

          socket.on('getRouterRtpCapabilities', async (_d: any, cb: any) => {
            try {
              const router = await ensureRouter(sessionId);
              cb?.({ rtpCapabilities: router.rtpCapabilities });
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
          });
          socket.on('createTransport', async (data: any, cb: any) => {
            try {
              const router = await ensureRouter(sessionId);
              const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: process.env.SFU_LISTEN_IP || '0.0.0.0', announcedIp: SFU_ANNOUNCED_IP } as any],
                enableUdp: true, enableTcp: true, preferUdp: true,
              });
              transport.on('dtlsstatechange', (s: string) => { if (s === 'closed') transport.close(); });
              transports.set(transport.id, transport);
              if (data?.direction) transport.appData.direction = data.direction;
              cb?.({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
              });
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
          });
          socket.on('connectTransport', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              await t.connect({ dtlsParameters: data.dtlsParameters });
              cb?.({});
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
          });
          socket.on('produce', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              if (t.appData?.direction === 'recv') throw new Error('recv-transport kann nicht produzieren');
              const producer = await t.produce({
                kind: data.kind, rtpParameters: data.rtpParameters, appData: data.appData,
              });
              producers.set(producer.id, producer);
              sessionProducerMap.set(producer.id, producer);
              socket.to(`sfu-session:${sessionId}`).emit('new-producer', { producerId: producer.id, kind: producer.kind });
              cb?.({ id: producer.id });
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
          });
          socket.on('consume', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              if (t.appData?.direction === 'send') throw new Error('send-transport kann nicht konsumieren');
              const producer = sessionProducerMap.get(String(data?.producerId ?? ''));
              if (!producer) throw new Error('producer nicht gefunden');
              const consumer = await t.consume({
                producerId: producer.id, rtpCapabilities: data.rtpCapabilities,
              });
              cb?.({
                id: consumer.id, kind: consumer.kind,
                rtpParameters: consumer.rtpParameters, producerId: producer.id,
              });
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
          });
          socket.on('disconnect', () => {
            for (const t of transports.values()) {
              try { t.close(); } catch { /* ignore */ }
            }
            transports.clear();
            for (const [id] of producers) {
              sessionProducerMap.delete(id);
            }
            producers.clear();
          });
        });
        log(`SFU (Mediasoup) aktiviert: ${SFU_SIGNALING_PATH}`);
      } catch (e) {
        warn('Mediasoup SFU nicht gestartet (ENABLE_SFU):', (e as Error).message);
      }
    }
  } catch (e) {
    warn('Socket.io signaling disabled:', (e as Error).message);
  }

  return {
    io,
    getActiveSocketConnections: () => socketLiveness.online(),
    socketLiveness: () => socketLiveness.lastEvaluation(),
  };
}

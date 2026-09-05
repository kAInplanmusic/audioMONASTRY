import { io, Socket } from 'socket.io-client';
import { random } from './random';
import { WebRTCMessage } from '../types/protocol';
import { SOCKET_IO_SIGNALING_URL } from '../config/runtime';
import type { MediasoupTransport } from '../core/transport/MediasoupTransport';

export type SessionPeer = { socketId: string; userId: string };
export type SessionInfo = { members: SessionPeer[]; full: boolean; joined: boolean };

class WebRTCManager {
  private socket: Socket | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private localStream: MediaStream | null = null;
  private lastActivitySentAt = 0;
  // K-2/K-5: Server-autoritative Plugin-Locks (Client optimistisch, Server siegt).
  private pluginLockListeners = new Set<(msg: any) => void>();
  private pluginUnlockListeners = new Set<(msg: any) => void>();
  private pluginLocksSyncListeners = new Set<(msg: any) => void>();

  private sessionUserId = `user-${random().toString(36).slice(2, 8)}`;

  /** Stabile Session-Identität des lokalen Users (für Locking/Audit). */
  public get userId(): string {
    return this.sessionUserId;
  }

  /** P4-2: Ist dieser Client der Session-Host (Rolle admin)? */
  public get isHost(): boolean {
    return this.localRole === 'admin';
  }

  /** P4-2: Aktuelle server-zugewiesene Rolle. */
  public get role(): string {
    return this.localRole;
  }

  /** P4-2: Host-User-ID (falls vom Server bekannt). */
  public get hostId(): string {
    return this.hostUserId;
  }

  private sessionMembers: SessionPeer[] = [];
  private sessionFull = false;
  private sessionJoined = false;
  private localAudioStarted = false;
  // MASTEROUTMAINSTREAM: eigener Listen-Modus für /master-out – zählt nicht zu
  // den 4 Session-Usern, sendet selbst nichts und verbindet sich nur zum Host.
  private masterOutMode = false;
  private sfuMode = false;
  private sfu: MediasoupTransport | null = null;
  private sfuSubscribed = new Set<string>();
  // P4-1/P4-2: Host-Main-Stream + server-seitige Rolle (Host = admin).
  private mainStream: MediaStream | null = null;
  private localRole: string = 'guest';
  private hostUserId: string = '';
  public onMainStream: (stream: MediaStream, senderId: string) => void = () => {};

  /** Letzte gemessene One-Way-Netzlatenz (RTT/2) in ms – für Telemetrie. */
  public lastRttMs = 0;

  /**
   * AM-E3-4: Adaptiver Jitter-Buffer für eingehende Audio-Receiver (Chromium).
   * `jitterBufferTarget` gibt dem Browser ein Ziel vor (50 ms = stabil bei
   * 4-User-Last, ohne die Sprach-/Cue-Latenz unnötig zu sprengen). Firefox/
   * Safari ignorieren die Eigenschaft (Standard-JitterBuffer bleibt aktiv).
   */
  public jitterBufferTargetMs = 50;

  public setJitterBufferTarget(ms: number): void {
    this.jitterBufferTargetMs = Math.max(10, Math.min(200, ms));
    for (const pc of this.peerConnections.values()) {
      for (const receiver of pc.getReceivers()) this.applyJitterBuffer(receiver);
    }
  }

  private applyJitterBuffer(receiver: RTCRtpReceiver): void {
    try {
      const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
      if ('jitterBufferTarget' in r) {
        r.jitterBufferTarget = this.jitterBufferTargetMs;
      }
    } catch { /* Browser ohne jitterBufferTarget (Firefox/Safari) */ }
  }

  // State-Sync-Coalescing: Hochfrequente Parameter-Updates (Slider/Automation)
  // werden pro Typ gebündelt und einmal pro Frame geflusht. Das senkt die
  // Message-Rate auf ~60 Hz und reduziert Jitter für alle 4 User.
  private pendingState = new Map<string, unknown>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STATE_FLUSH_MS = 16;

  public onRemoteStream: (stream: MediaStream, senderId: string) => void = () => {};
  public onDataChannelMessage: (message: any) => void = () => {};
  // Mehrfach-Listener (F2-Fix): Mehrere Verbraucher (SessionSync, ModuleState,
  // Transport-Adapter) können gleichzeitig Peer-Nachrichten empfangen.
  private dataChannelListeners = new Set<(message: any) => void>();

  public addDataChannelListener(cb: (message: any) => void): () => void {
    this.dataChannelListeners.add(cb);
    return () => { this.dataChannelListeners.delete(cb); };
  }

  private dispatchDataMessage(data: any, sourceSocketId?: string): void {
    if (!data || typeof data !== 'object') return;
    if (typeof data.type !== 'string' || data.type.length === 0 || data.type.length > 128) return;
    // Von einem konkreten DataChannel stammende Nachrichten dürfen senderId
    // nicht spoofen: der Server-/Session-Context bestimmt den echten Absender.
    if (sourceSocketId) {
      const peer = this.sessionMembers.find((m) => m.socketId === sourceSocketId);
      if (!peer) {
        console.warn('[webrtc] DataChannel-Nachricht von unbekanntem Peer verworfen.', { sourceSocketId, type: data.type });
        return;
      }
      if (data.senderId !== undefined && String(data.senderId) !== peer.userId) {
        console.warn('[webrtc] DataChannel-Nachricht mit gespoofter senderId verworfen.', {
          sourceSocketId,
          claimedSender: data.senderId,
          actualUser: peer.userId,
          type: data.type,
        });
        return;
      }
      data = { ...data, senderId: peer.userId };
    }
    this.onDataChannelMessage(data);
    this.dataChannelListeners.forEach((l) => l(data));
  }
  /** Wird bei jeder Änderung der Session (Join/Peer-Join/Peer-Left/Voll) aufgerufen. */
  public onSessionUpdate: (info: SessionInfo) => void = () => {};

  constructor() {
    // '' (empty string) means "same origin" — resolve to io() default so the
    // browser connects to the current host (works on Hetzner, Cloud Run, ...).
    if (SOCKET_IO_SIGNALING_URL !== null) {
      this.socket = io(SOCKET_IO_SIGNALING_URL || undefined, {
        // Der Express-Hauptserver (server.ts) mountet das WebRTC-Signaling
        // IMMER auf /webrtc-signaling – egal ob Dev (localhost:8080) oder
        // Prod (same-origin). Der Pfad ist daher fix, nur die URL variiert.
        path: '/webrtc-signaling',
        autoConnect: true,
        transports: ['websocket', 'polling'],
      });
      this.setupSignaling();
      this.setupActivityHeartbeat();
      // Mikrofon wird NICHT im Konstruktor angefragt: iOS-Safari verlangt
      // eine User-Geste. App.tsx ruft startLocalAudio() nach "Studio betreten".
    }
  }

  private setupActivityHeartbeat() {
    if (typeof window === 'undefined') return;

    const signalActivity = () => {
      if (!this.socket?.connected) return;
      const now = Date.now();
      if (now - this.lastActivitySentAt < 60000) return;
      this.lastActivitySentAt = now;
      this.socket.emit('activity');
    };

    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, signalActivity, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') signalActivity();
    });
  }

  private async initLocalAudio(deviceId?: string) {
    try {
      // Geräte-Wahl: explizite deviceId (Settings) oder System-Default.
      const constraints: MediaStreamConstraints = deviceId
        ? { audio: { deviceId: { ideal: deviceId } } }
        : { audio: true };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.sfuMode && this.sfu) {
        this.localStream.getAudioTracks().forEach((track) => {
          this.sfu?.sendAudioTrack(track).catch((e) => console.warn('SFU produce fehlgeschlagen:', e));
        });
      }
    } catch (err) {
      console.warn('Mikrofon-Zugriff nicht möglich (iOS/Safari oder blockiert):', err);
    }
  }

  /**
   * Mikrofon nach User-Geste anfragen (wird von App.tsx beim Studio-Start
   * aufgerufen). `deviceId` wählt ein konkretes Eingabegerät (Settings).
   */
  public async startLocalAudio(deviceId?: string): Promise<void> {
    if (this.localAudioStarted) return;
    this.localAudioStarted = true;
    await this.initLocalAudio(deviceId);
  }

  /** P4-1: Host-Main-Stream an Peers/SFU senden (Host ruft nach Audio-Init auf). */
  public startMainStream(stream: MediaStream): void {
    this.mainStream = stream;
    if (this.sfuMode && this.sfu) {
      stream.getAudioTracks().forEach((track) => {
        this.sfu?.sendAudioTrack(track).catch((e) => console.warn('SFU main produce fehlgeschlagen:', e));
      });
    } else {
      this.peerConnections.forEach((pc) => this.addMainTracksToPeer(pc));
    }
  }

  /** P4-1: Aktueller Main-Stream (lokal) – für Tests/Debug. */
  public getMainStream(): MediaStream | null {
    return this.mainStream;
  }

  private addMainTracksToPeer(pc: RTCPeerConnection): void {
    if (!this.mainStream) return;
    const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean));
    let added = false;
    for (const track of this.mainStream.getTracks()) {
      if (!existing.has(track.id)) {
        pc.addTrack(track, this.mainStream);
        added = true;
      }
    }
    if (added) void this.renegotiate(pc);
  }

  private async renegotiate(pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const targetId = [...this.peerConnections.entries()].find(([, p]) => p === pc)?.[0];
      if (targetId) this.socket?.emit('offer', { target: targetId, offer });
    } catch (e) {
      console.warn('[webrtc] Renegotiation fehlgeschlagen:', (e as Error).message);
    }
  }

  /** Ob der Media-Pfad aktuell über die SFU (Mediasoup) läuft. */
  public get isSfuMode(): boolean {
    return this.sfuMode;
  }

  /** MASTEROUTMAINSTREAM: Seite /master-out aktiviert den reinen Listen-Modus. */
  public setMasterOutMode(enabled: boolean): void {
    this.masterOutMode = enabled;
  }

  /** MASTEROUTMAINSTREAM: Ist dieser Client ein reiner Main-Listener? */
  public get isMasterOutMode(): boolean {
    return this.masterOutMode;
  }

  /**
   * Schaltet den Transport-Modus um:
   *   p2p  – Full-Mesh-WebRTC (DataChannels + Media), bisheriges Verhalten.
   *   sfu  – Session-/State-Sync weiter über /webrtc-signaling (Socket-Relay),
   *          Media über den Mediasoup-SFU-Transport (Producer/Consumer).
   */
  public setSfuMode(enabled: boolean, sfu?: MediasoupTransport | null): void {
    // DA-220: Laufende P2P-State-Flushes vor dem Moduswechsel stoppen, damit keine
    // verspäteten Nachrichten mehr über alte DataChannels gesendet werden, während
    // die PeerConnections geschlossen/geleert werden.
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingState.clear();

    this.sfuMode = enabled;
    this.sfu = enabled ? (sfu ?? null) : null;
    this.sfuSubscribed.clear();

    if (enabled) {
      // Bestehende P2P-Verbindungen schließen – Media läuft jetzt über die SFU.
      this.peerConnections.forEach((pc) => { try { pc.close(); } catch { /* noop */ } });
      this.peerConnections.clear();
      this.dataChannels.clear();

      if (this.sfu) {
        this.sfu.onProducersChanged = (producers) => this.syncSfuSubscriptions(producers);
        // Falls lokales Mikro schon offen ist: als Producer anbieten.
        if (this.localStream) {
          this.localStream.getAudioTracks().forEach((track) => {
            this.sfu?.sendAudioTrack(track).catch((e) => console.warn('SFU produce fehlgeschlagen:', e));
          });
        }
        // P4-1: Main-Stream (Host) ebenfalls als Producer anbieten.
        if (this.mainStream) {
          this.mainStream.getAudioTracks().forEach((track) => {
            this.sfu?.sendAudioTrack(track).catch((e) => console.warn('SFU main produce fehlgeschlagen:', e));
          });
        }
        this.syncSfuSubscriptions(this.sfu.knownRemoteProducers());
      }
    } else if (this.sfu) {
      this.sfu.onProducersChanged = () => {};
    }
  }

  /** Abonniert fremde SFU-Producer und meldet deren Tracks als Remote-Streams. */
  private syncSfuSubscriptions(producers: { producerId: string; kind: string }[]): void {
    if (!this.sfu) return;
    for (const p of producers) {
      if (this.sfuSubscribed.has(p.producerId)) continue;
      this.sfuSubscribed.add(p.producerId);
      this.sfu.subscribeToPeer(p.producerId)
        .then((track) => {
          if (track) this.onRemoteStream(new MediaStream([track]), p.producerId);
        })
        .catch((e) => {
          // DA-221: Fehlgeschlagene Subscription wieder versuchen (nicht ewig blockieren).
          this.sfuSubscribed.delete(p.producerId);
          console.warn('SFU consume fehlgeschlagen, Retry geplant:', e);
          setTimeout(() => {
            if (this.sfu && !this.sfuSubscribed.has(p.producerId)) {
              this.syncSfuSubscriptions(this.sfu.knownRemoteProducers());
            }
          }, 2000);
        });
    }
  }

  private emitSessionUpdate() {
    this.onSessionUpdate({
      members: [...this.sessionMembers],
      full: this.sessionFull,
      joined: this.sessionJoined,
    });
  }

  private setupSignaling() {
    if (!this.socket) return;

    // Ein Raum pro Sitzung: Nach dem Connect automatisch der festen
    // Studio-Session beitreten (kein Raum-Erstellen im UI).
    this.socket.on('connect', () => {
      this.socket?.emit('join-session', { userId: this.sessionUserId, mode: this.masterOutMode ? 'master-out' : 'member' });
    });

    this.socket.on('session-members', (data: any) => {
      this.sessionFull = false;
      this.sessionJoined = true;
      this.sessionMembers = Array.isArray(data?.members) ? data.members : [];
      // P4-2: Server-seitige Rolle + Host-ID übernehmen.
      if (typeof data?.selfRole === 'string') this.localRole = data.selfRole;
      if (typeof data?.hostUserId === 'string') this.hostUserId = data.hostUserId;
      this.emitSessionUpdate();
      if (this.masterOutMode) {
        // MASTEROUTMAINSTREAM: nur mit dem Host verbinden (Main-Signal).
        const host = this.sessionMembers.find((m) => m.userId === this.hostUserId);
        if (host) void this.connectToPeer(host.socketId);
        return;
      }
      // Full-Mesh: mit allen bereits anwesenden Peers verbinden.
      this.sessionMembers.forEach((m) => {
        if (m.socketId !== this.socket?.id) this.connectToPeer(m.socketId);
      });
    });

    // P4-2: Rollenwechsel (vom Admin ausgelöst) lokal übernehmen.
    this.socket.on('role-changed', (data: any) => {
      if (!data || typeof data !== 'object') return;
      if (String(data.userId ?? '') === this.sessionUserId && typeof data.role === 'string') {
        this.localRole = data.role;
      }
      if (data.role === 'admin') this.hostUserId = String(data.userId ?? this.hostUserId);
    });

    // DCT-102: Socket.io-Relay-Fallback für Plugin-/AUTO_AI-State.
    this.socket.on('plugin-state', (data: any) => {
      if (data && typeof data === 'object') this.dispatchDataMessage(data);
    });

    // K-2/K-5: Server-autoritative Lock-Replikation.
    this.socket.on('plugin-lock', (data: any) => this.pluginLockListeners.forEach((l) => l(data)));
    this.socket.on('plugin-unlock', (data: any) => this.pluginUnlockListeners.forEach((l) => l(data)));
    this.socket.on('plugin-locks-sync', (data: any) => this.pluginLocksSyncListeners.forEach((l) => l(data)));

    this.socket.on('peer-joined', (data: any) => {
      const peer: SessionPeer = { socketId: String(data?.socketId ?? ''), userId: String(data?.userId ?? data?.socketId ?? '') };
      if (!peer.socketId || peer.socketId === this.socket?.id) return;
      if (!this.sessionMembers.some((m) => m.socketId === peer.socketId)) {
        this.sessionMembers = [...this.sessionMembers, peer];
        this.emitSessionUpdate();
      }
      if (data?.role === 'admin') this.hostUserId = String(data.userId ?? this.hostUserId);
      if (this.masterOutMode) {
        // MASTEROUTMAINSTREAM: nur auf den Host reagieren.
        if (data?.role === 'admin' || peer.userId === this.hostUserId) void this.connectToPeer(peer.socketId);
        return;
      }
      this.connectToPeer(peer.socketId);
    });

    this.socket.on('peer-left', (data: any) => {
      const socketId = String(data?.socketId ?? '');
      if (!socketId) return;
      this.closePeerConnection(socketId);
      this.sessionMembers = this.sessionMembers.filter((m) => m.socketId !== socketId);
      this.emitSessionUpdate();
    });

    this.socket.on('session-full', (data: any) => {
      this.sessionFull = true;
      this.sessionJoined = false;
      this.sessionMembers = [];
      this.emitSessionUpdate();
      console.warn(`Session voll (max. ${data?.max ?? 4} User).`);
    });

    this.socket.on('offer', async (data) => {
      const pc = this.createPeerConnection(data.sender, { remoteIsMasterOut: data?.senderMode === 'master-out' });
      // Race-Guard: Bei simultanem Beitritt kann ein zweites Offer eintreffen,
      // während bereits ein Offer verarbeitet wird. Nur im Zustand 'stable'
      // darf ein Remote-Offer gesetzt werden.
      if (pc.signalingState !== 'stable') {
        console.warn('[webrtc] Offer außerhalb des erwarteten Zustands verworfen:', pc.signalingState);
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('answer', { target: data.sender, answer });
      } catch (e) {
        console.warn('[webrtc] Offer/Answer fehlgeschlagen:', (e as Error).message);
      }
    });

    this.socket.on('answer', async (data) => {
      const pc = this.peerConnections.get(data.sender);
      if (!pc) return;
      // Antwort nur annehmen, wenn lokal ein Offer offen ist (sonst Race).
      if (pc.signalingState !== 'have-local-offer') {
        console.warn('[webrtc] Answer außerhalb des erwarteten Zustands verworfen:', pc.signalingState);
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (e) {
        console.warn('[webrtc] Answer setzen fehlgeschlagen:', (e as Error).message);
      }
    });

    this.socket.on('ice-candidate', (data) => {
      const pc = this.peerConnections.get(data.sender);
      if (!pc) return;
      try {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn('[webrtc] ICE-Kandidat verworfen:', (e as Error).message);
      }
    });

    this.socket.on('connect_error', (error) => {
      console.warn('Signaling connection failed:', error.message);
    });

    this.socket.on('disconnect', () => {
      // Peers werden serverseitig per 'peer-left' benachrichtigt; lokal sauber aufräumen.
      this.peerConnections.forEach((pc) => { try { pc.close(); } catch { /* noop */ } });
      this.peerConnections.clear();
      this.dataChannels.clear();
      this.sessionMembers = [];
      this.sessionJoined = false;
      this.emitSessionUpdate();
    });
  }

  private createPeerConnection(targetId: string, opts?: { remoteIsMasterOut?: boolean }): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.services.mozilla.com'] }
      ]
    });

    // MASTEROUTMAINSTREAM: Listen-Client sendet nie eigene Tracks; Host schickt
    // an einen Listener keinen Mikrofon-Track, sondern nur den Main-Stream.
    const isMasterOut = this.masterOutMode || !!opts?.remoteIsMasterOut;

    // Add local tracks (Mikrofon) – nicht für Master-Out-Peers.
    if (!isMasterOut && this.localStream) {
        this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }
    // P4-1: Host-Main-Stream direkt in neue Peer-Verbindungen aufnehmen.
    if (!this.masterOutMode && this.mainStream) {
        this.mainStream.getTracks().forEach(track => pc.addTrack(track, this.mainStream!));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket?.emit('ice-candidate', { target: targetId, candidate: e.candidate });
    };

    pc.ondatachannel = (e) => {
      this.dataChannels.set(targetId, e.channel);
      e.channel.onmessage = (msg) => {
        // F3-Fix: Peer-Frames sind untrusted – kaputte Frames verwerfen, nie werfen.
        let data: any;
        try {
          data = JSON.parse(msg.data);
        } catch {
          console.warn('[webrtc] Ungültiger DataChannel-Frame verworfen.');
          return;
        }
        if (!data || typeof data !== 'object') return;
        if (data.type === 'CLOCK_PING') {
            e.channel.send(JSON.stringify({ type: 'CLOCK_PONG', pingTime: data.timestamp, pongTime: performance.now() }));
        }
        if (data.type === 'LATENCY_PING') {
            e.channel.send(JSON.stringify({ type: 'LATENCY_PONG', timestamp: data.timestamp }));
        }
        if (data.type === 'LATENCY_PONG' && typeof data.timestamp === 'number') {
            // One-Way-Latenz für die Telemetrie (RTT/2).
            this.lastRttMs = Math.max(0, (performance.now() - data.timestamp) / 2);
        }
        this.dispatchDataMessage(data, targetId);
        // console.log('Data from', targetId, data);
      };
    };

    pc.ontrack = (e) => {
        this.applyJitterBuffer(e.receiver); // AM-E3-4
        this.onRemoteStream(e.streams[0], targetId);
    };

    this.peerConnections.set(targetId, pc);
    return pc;
  }

  private closePeerConnection(targetId: string) {
    const pc = this.peerConnections.get(targetId);
    if (pc) { try { pc.close(); } catch { /* noop */ } }
    this.peerConnections.delete(targetId);
    this.dataChannels.delete(targetId);
  }

  public async connectToPeer(targetId: string) {
    // Im SFU-Modus keine P2P-Verbindungen aufbauen – Media läuft über die SFU.
    if (this.sfuMode) return;
    // Kein Selbst-Anruf, keine Doppelverbindung.
    if (!targetId || targetId === this.socket?.id) return;
    if (this.peerConnections.has(targetId)) return;

    // Glare-Auflösung (simultaner Beitritt): Nur der Peer mit der lexikografisch
    // KLEINEREN Socket-ID erstellt das Offer (deterministischer Initiator).
    // Der größere Peer wartet auf das eingehende Offer und beantwortet es;
    // der DataChannel wird dort über ondatachannel übernommen.
    // MASTEROUTMAINSTREAM: der Listener ist der alleinige Initiator (der Host
    // kennt ihn nicht), deshalb die Glare-Regel hier überspringen.
    const selfId = this.socket?.id ?? '';
    if (!this.masterOutMode && selfId && targetId < selfId) return;

    const pc = this.createPeerConnection(targetId);
    if (!this.masterOutMode) {
      const dc = pc.createDataChannel('plugin-sync');
      this.dataChannels.set(targetId, dc);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket?.emit('offer', { target: targetId, offer });
  }

  public sendToAllPeers(data: WebRTCMessage) {
    // Im SFU-Modus läuft der State-Sync ausschließlich über das Socket-Relay
    // (keine DataChannels) – Session-/Plugin-State bleibt damit identisch.
    if (!this.sfuMode) {
      this.dataChannels.forEach(channel => {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify(data));
        }
      });
    }
    // Socket.io-Fallback: State-Sync funktioniert auch ohne offene DataChannels.
    this.socket?.emit('plugin-state', data);
  }

  public sendPluginLock(pluginId: string): void {
    this.socket?.emit('plugin-lock', { pluginId });
  }

  public sendPluginUnlock(pluginId: string): void {
    this.socket?.emit('plugin-unlock', { pluginId });
  }

  public onPluginLock(cb: (msg: any) => void): () => void {
    this.pluginLockListeners.add(cb);
    return () => { this.pluginLockListeners.delete(cb); };
  }

  public onPluginUnlock(cb: (msg: any) => void): () => void {
    this.pluginUnlockListeners.add(cb);
    return () => { this.pluginUnlockListeners.delete(cb); };
  }

  public onPluginLocksSync(cb: (msg: any) => void): () => void {
    this.pluginLocksSyncListeners.add(cb);
    return () => { this.pluginLocksSyncListeners.delete(cb); };
  }

  public sendData(data: any) {
    const t = data?.type as string | undefined;
    // Latenz-/Clock-Pings müssen sofort durch (Messung), alles andere wird
    // gebündelt (letzter Wert je type gewinnt) und einmal pro Frame geflusht.
    if (t === 'CLOCK_PING' || t === 'CLOCK_PONG' || t === 'LATENCY_PING' || t === 'LATENCY_PONG') {
      this.sendToAllPeers(data as WebRTCMessage);
      return;
    }
    this.pendingState.set(t ?? 'state', data);
    if (this.flushTimer == null) {
      this.flushTimer = setTimeout(() => this.flushPendingState(), this.STATE_FLUSH_MS);
    }
  }

  /** Diagnose-/Test-API: Zustand aller Peer-Verbindungen (E2E-Assertions). */
  public getPeerConnectionStates(): Record<string, { signaling: string; ice: string; datachannel: string }> {
    const out: Record<string, { signaling: string; ice: string; datachannel: string }> = {};
    this.peerConnections.forEach((pc, id) => {
      out[id] = {
        signaling: pc.signalingState,
        ice: pc.iceConnectionState,
        datachannel: this.dataChannels.get(id)?.readyState ?? 'none',
      };
    });
    return out;
  }

  private flushPendingState() {
    this.flushTimer = null;
    if (this.pendingState.size === 0) return;
    const batch = Array.from(this.pendingState.values());
    this.pendingState.clear();
    for (const data of batch) {
      this.sendToAllPeers(data as WebRTCMessage);
    }
  }
}

export const webRTCManager = new WebRTCManager();

// Test-/Diagnose-Hook (nur DEV): erlaubt E2E-Assertions auf den echten
// WebRTC-Zustand (Signaling/ICE/DataChannel) ohne Produktions-API-Fläche.
if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) {
  (globalThis as any).__webRTCManager = webRTCManager;
}

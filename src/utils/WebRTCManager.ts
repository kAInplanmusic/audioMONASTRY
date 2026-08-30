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

  private sessionUserId = `user-${random().toString(36).slice(2, 8)}`;

  /** Stabile Session-Identität des lokalen Users (für Locking/Audit). */
  public get userId(): string {
    return this.sessionUserId;
  }
  private sessionMembers: SessionPeer[] = [];
  private sessionFull = false;
  private sessionJoined = false;
  private localAudioStarted = false;
  private sfuMode = false;
  private sfu: MediasoupTransport | null = null;
  private sfuSubscribed = new Set<string>();

  /** Letzte gemessene One-Way-Netzlatenz (RTT/2) in ms – für Telemetrie. */
  public lastRttMs = 0;

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

  private dispatchDataMessage(data: any): void {
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

  /**
   * Schaltet den Transport-Modus um:
   *   p2p  – Full-Mesh-WebRTC (DataChannels + Media), bisheriges Verhalten.
   *   sfu  – Session-/State-Sync weiter über /webrtc-signaling (Socket-Relay),
   *          Media über den Mediasoup-SFU-Transport (Producer/Consumer).
   */
  public setSfuMode(enabled: boolean, sfu?: MediasoupTransport | null): void {
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
        .catch((e) => console.warn('SFU consume fehlgeschlagen:', e));
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
      this.socket?.emit('join-session', { userId: this.sessionUserId });
    });

    this.socket.on('session-members', (data: any) => {
      this.sessionFull = false;
      this.sessionJoined = true;
      this.sessionMembers = Array.isArray(data?.members) ? data.members : [];
      this.emitSessionUpdate();
      // Full-Mesh: mit allen bereits anwesenden Peers verbinden.
      this.sessionMembers.forEach((m) => {
        if (m.socketId !== this.socket?.id) this.connectToPeer(m.socketId);
      });
    });

    // DCT-102: Socket.io-Relay-Fallback für Plugin-/AUTO_AI-State.
    this.socket.on('plugin-state', (data: any) => {
      if (data && typeof data === 'object') this.dispatchDataMessage(data);
    });

    this.socket.on('peer-joined', (data: any) => {
      const peer: SessionPeer = { socketId: String(data?.socketId ?? ''), userId: String(data?.userId ?? data?.socketId ?? '') };
      if (!peer.socketId || peer.socketId === this.socket?.id) return;
      if (!this.sessionMembers.some((m) => m.socketId === peer.socketId)) {
        this.sessionMembers = [...this.sessionMembers, peer];
        this.emitSessionUpdate();
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
      const pc = this.createPeerConnection(data.sender);
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

  private createPeerConnection(targetId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.services.mozilla.com'] }
      ]
    });

    // Add local tracks
    if (this.localStream) {
        this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
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
        this.dispatchDataMessage(data);
        // console.log('Data from', targetId, data);
      };
    };

    pc.ontrack = (e) => {
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
    const selfId = this.socket?.id ?? '';
    if (selfId && targetId < selfId) return;

    const pc = this.createPeerConnection(targetId);
    const dc = pc.createDataChannel('plugin-sync');
    this.dataChannels.set(targetId, dc);

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

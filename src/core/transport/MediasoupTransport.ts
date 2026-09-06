/**
 * audioMONASTRY · SFU-Transport via Mediasoup (Aufg. 3.1.1 / 1.1.6)
 * -----------------------------------------------------------------
 * Skalierbarer SFU-Modus: Der Browser verbindet sich als mediasoup-client
 * gegen eine Mediasoup-SFU. Statt eines Full-Mesh (jeder mit jedem) routers
 * der SFU die Media-Streams – damit ist die Architektur für 10+ Benutzer
 * skalierbar.
 *
 * CLIENT-Transport-Abstraktion hinter `ITransport`. Nutzt socket.io-client
 * für die Signalisierung gegen den /sfu-signaling-Endpoint des Backends.
 */
import { io, Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { ITransport, TransportMode } from '../interfaces';

export interface SfuOptions {
  sessionId?: string;
  handshake?: Record<string, unknown>;
}

export class MediasoupTransport implements ITransport {
  readonly id = 'mediasoup-sfu';
  readonly mode: TransportMode = 'sfu';

  private socket: Socket | null = null;
  private device: Device | null = null;
  private sendTransport: any = null;
  private recvTransport: any = null;
  private producers = new Map<string, any>();
  private consumers = new Map<string, any>();
  private remoteProducers = new Map<string, { producerId: string; kind: string }>();
  private ownProducerIds = new Set<string>();
  private _onMessage: (payload: unknown, fromPeerId: string) => void = () => {};
  private _onPeerJoin: (peerId: string) => void = () => {};
  private _onPeerLeave: (peerId: string) => void = () => {};

  /** true, wenn der SFU-Signaling-Socket aktuell verbunden ist. */
  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
  /** Wird gerufen, wenn sich die Liste fremder Producer der Session ändert. */
  public onProducersChanged: (producers: { producerId: string; kind: string }[]) => void = () => {};

  onMessage: ITransport['onMessage'] = (cb) => { this._onMessage = cb; };
  onPeerJoin: ITransport['onPeerJoin'] = (cb) => { this._onPeerJoin = cb; };
  onPeerLeave: ITransport['onPeerLeave'] = (cb) => { this._onPeerLeave = cb; };

  async connect(sessionId: string, _userId: string, opts?: SfuOptions): Promise<void> {
    this.socket = io({
      path: '/sfu-signaling',
      query: { sessionId: opts?.sessionId ?? sessionId },
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.on('connect', resolve);
      this.socket!.on('connect_error', reject);
    });

    this.device = new Device();
    const routerRtpCapabilities = await this.signal('getRouterRtpCapabilities');
    await this.device.load({ routerRtpCapabilities: routerRtpCapabilities.rtpCapabilities });

    // Send-Transport (eigener Mic/Produce-Pfad)
    const dir = await this.signal('createTransport', { direction: 'send' });
    this.sendTransport = this.device.createSendTransport(dir);
    this.sendTransport.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await this.signal('connectTransport', { transportId: this.sendTransport.id, dtlsParameters });
        callback();
      } catch (e) { errback(e); }
    });
    this.sendTransport.on('produce', async (params: any, callback: any, errback: any) => {
      try {
        const { id } = await this.signal('produce', { transportId: this.sendTransport.id, ...params });
        callback({ id });
      } catch (e) { errback(e); }
    });

    // Fremde Producer der Session registrieren (Server broadcastet new-producer).
    this.socket.on('new-producer', (info: { producerId: string; kind: string }) => {
      if (this.ownProducerIds.has(info.producerId)) return;
      this.remoteProducers.set(info.producerId, info);
      this.onProducersChanged(this.knownRemoteProducers());
    });
    this.socket.on('data', (payload: unknown, fromPeerId: string) => this._onMessage(payload, fromPeerId));
    this._onPeerJoin('local');
  }

  disconnect(): void {
    this.producers.forEach((p) => { try { p.close(); } catch { /* ignore */ } });
    this.consumers.forEach((c) => { try { c.close(); } catch { /* ignore */ } });
    this.producers.clear();
    this.consumers.clear();
    this.remoteProducers.clear();
    this.ownProducerIds.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  broadcast(payload: unknown): void { this.socket?.emit('data', payload); }
  sendTo(_peerId: string, payload: unknown): void { this.broadcast(payload); }
  syncClock(): void { /* RTC-Tracks tragen die Audio-Zeitachse. */ }

  /** Lokalen Audio-Stream als Producer dem SFU-Router anbieten. */
  async sendAudioTrack(track: MediaStreamTrack): Promise<void> {
    if (!this.sendTransport) throw new Error('SFU send-transport nicht bereit');
    const producer = await this.sendTransport.produce({ track });
    this.producers.set(track.id, producer);
    this.ownProducerIds.add(producer.id);
  }

  /** Stellt sicher, dass ein Recv-Transport existiert (fuer Consume). */
  private async ensureRecvTransport(): Promise<any> {
    if (this.recvTransport) return this.recvTransport;
    if (!this.device) throw new Error('SFU device nicht bereit');
    const dir = await this.signal('createTransport', { direction: 'recv' });
    const recv = this.device.createRecvTransport(dir);
    recv.on('connect', async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await this.signal('connectTransport', { transportId: recv.id, dtlsParameters });
        callback();
      } catch (e) { errback(e); }
    });
    this.recvTransport = recv;
    return recv;
  }

  /** Fremden Audio-Stream (via producerId) konsumieren und seinen Track liefern. */
  async subscribeToPeer(producerId: string): Promise<MediaStreamTrack | null> {
    if (!this.device) return null;
    const recv = await this.ensureRecvTransport();
    const { id, kind, rtpParameters } = await this.signal('consume', {
      transportId: recv.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumer = await recv.consume({ id, producerId, kind, rtpParameters });
    this.consumers.set(producerId, consumer);
    return consumer.track;
  }

  /** Bekannte fremde Producer der Session (via new-producer-Events). */
  knownRemoteProducers(): { producerId: string; kind: string }[] {
    return [...this.remoteProducers.values()].filter((p) => !this.ownProducerIds.has(p.producerId));
  }

  /** Socket.io call-basiertes Signalisieren (Server antwortet mit callback). */
  private signal(event: string, payload?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error('SFU signaling nicht verbunden'));
      this.socket.emit(event, payload ?? {}, (resp: any) => {
        if (!resp) return reject(new Error(`SFU-Signal ohne Antwort: ${event}`));
        if (resp.error) return reject(new Error(resp.error));
        resolve(resp);
      });
    });
  }
}

/** Der standardmäßige SFU-Adapter (genutzt, sobald SFU-Server erreichbar ist). */
export const sfuTransport = new MediasoupTransport();

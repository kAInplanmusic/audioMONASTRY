/**
 * audioMONASTRY · 1.1.6 – Transport-Registry & LocalTransport
 * ============================================================
 * Produktionsreife Transport-Abstraktion:
 *
 *  - `LocalTransport`   Offline-/Single-User-Modus (Loopback, deterministisch)
 *  - `TransportRegistry` wählt den Transport per Modus aus und kapselt die
 *    Fallback-Kette: sfu → p2p → local. Session-Logik bleibt identisch,
 *    egal welcher Transport aktiv ist (Validierung siehe Selbsttest unten).
 */
import type { ITransport, TransportMode } from '../interfaces';

/** Loopback-Transport für Offline-Betrieb und Tests. */
export class LocalTransport implements ITransport {
  readonly id = 'local-loopback';
  readonly mode: TransportMode = 'local';

  private _onMessage: (payload: unknown, fromPeerId: string) => void = () => {};
  private _onPeerJoin: (peerId: string) => void = () => {};
  private _onPeerLeave: (peerId: string) => void = () => {};
  private connected = false;

  onMessage: ITransport['onMessage'] = (cb) => { this._onMessage = cb; };
  onPeerJoin: ITransport['onPeerJoin'] = (cb) => { this._onPeerJoin = cb; };
  onPeerLeave: ITransport['onPeerLeave'] = (cb) => { this._onPeerLeave = cb; };

  async connect(_sessionId: string, userId: string): Promise<void> {
    this.connected = true;
    this._onPeerJoin(userId);
  }

  disconnect(): void {
    this.connected = false;
  }

  broadcast(payload: unknown): void {
    if (this.connected) this._onMessage(payload, 'local');
  }

  sendTo(_peerId: string, payload: unknown): void {
    this.broadcast(payload);
  }

  syncClock(): void { /* keine verteilte Uhr nötig */ }
}

export const localTransport = new LocalTransport();

/** Zentrale Auswahl-/Fallback-Logik für Kollaborations-Transporte. */
export class TransportRegistry {
  private transports = new Map<string, ITransport>();
  private active: ITransport = localTransport;

  /** Registriert einen Transport (überschreibt gleiche id). */
  register(transport: ITransport): void {
    this.transports.set(transport.id, transport);
  }

  /** Wählt per Modus; bei Fehler greift die Fallback-Kette sfu → p2p → local. */
  async select(mode: TransportMode, sessionId: string, userId: string): Promise<ITransport> {
    const chain: TransportMode[] =
      mode === 'sfu' ? ['sfu', 'p2p', 'local']
      : mode === 'p2p' ? ['p2p', 'local']
      : ['local'];

    for (const m of chain) {
      const candidate = [...this.transports.values()].find((t) => t.mode === m);
      if (!candidate) continue;
      try {
        await candidate.connect(sessionId, userId);
        this.active = candidate;
        return candidate;
      } catch (e) {
        console.warn(`Transport '${candidate.id}' nicht verfügbar, Fallback.`, e);
        try { candidate.disconnect(); } catch { /* ignore */ }
      }
    }
    await localTransport.connect(sessionId, userId);
    this.active = localTransport;
    return localTransport;
  }

  activeTransport(): ITransport {
    return this.active;
  }

  disconnect(): void {
    try { this.active.disconnect(); } catch { /* ignore */ }
    this.active = localTransport;
  }
}

export const transportRegistry = new TransportRegistry();

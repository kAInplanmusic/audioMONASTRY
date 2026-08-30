/**
 * audioMONASTRY · 5.2.2 – Edge-DSP-Client (App → Edge Gateway)
 * ============================================================
 * Sendet Bewegungsvektoren/Metadaten statt Raw-Audio an einen Edge-Gateway.
 * Produktions-Scaffold: WebSocket mit JSON-Framing + Health-/Routing-Status.
 */
export interface EdgeVectorFrame {
  type: 'vector';
  sourceId: string;
  x: number;
  y: number;
  bpm?: number;
  key?: string;
  ts: number;
}

export interface EdgeStatusFrame {
  type: 'status';
  gateway: string;
  master: string;
  standby: string[];
  latencyMs: number;
  failoverActive: boolean;
}

export class EdgeDspClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onStatus: (s: EdgeStatusFrame) => void = () => {};
  private queue: EdgeVectorFrame[] = [];
  private maxQueue = 256;

  constructor(url = 'ws://127.0.0.1:9001') {
    this.url = url;
  }

  onStatusFrame(cb: (s: EdgeStatusFrame) => void): void {
    this.onStatus = cb;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error(`Edge-Gateway nicht erreichbar: ${this.url}`));
    });
    this.ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data)) as EdgeStatusFrame;
        if (frame?.type === 'status') this.onStatus(frame);
      } catch { /* ignore */ }
    };
    // Gepufferte Vektoren nach Reconnect flushen (adaptive Pfadwahl).
    const pending = this.queue.splice(0, this.queue.length);
    pending.forEach((v) => this.sendVector(v));
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** Sendet einen Bewegungsvektor (bei Offline wird gepuffert). */
  sendVector(frame: EdgeVectorFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return;
    }
    this.queue.push(frame);
    if (this.queue.length > this.maxQueue) this.queue.shift();
  }

  get pendingVectors(): number {
    return this.queue.length;
  }
}

export const edgeDspClient = new EdgeDspClient();

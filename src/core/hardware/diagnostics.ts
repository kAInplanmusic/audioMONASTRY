/**
 * audioMONASTRY · Hardware-Diagnostics
 * =====================================
 * Zentrale, nicht-blockierende Diagnose für Hardware-Ereignisse:
 * CONNECT/DISCONNECT/OPEN/CLOSE/STREAM START/STOP/DEVICE ERROR/
 * SAMPLE RATE/BUFFER/BACKEND.
 *
 * Regeln:
 * - NIE im Audio-Thread/Callback aufrufen (nur Main-Thread/Sidecar).
 * - Keine synchronen I/O-Operationen, kein `console`-Spam: Ring-Puffer +
 *   optionale Listener.
 */
export type HardwareEventKind =
  | 'CONNECT' | 'DISCONNECT' | 'OPEN' | 'CLOSE'
  | 'STREAM_START' | 'STREAM_STOP'
  | 'DEVICE_ERROR'
  | 'SAMPLE_RATE' | 'BUFFER' | 'BACKEND';

export interface HardwareLogEntry {
  kind: HardwareEventKind;
  at: number;             // Date.now()
  device?: string;
  detail?: Record<string, unknown>;
}

const MAX_ENTRIES = 256;

export class HardwareDiagnostics {
  private entries: HardwareLogEntry[] = [];
  private listeners = new Set<(entry: HardwareLogEntry) => void>();
  private consoleEnabled = false;

  /** Aktiviert Konsolen-Spiegelung (nur für Dev/Debug; Default aus). */
  setConsoleLogging(enabled: boolean): void {
    this.consoleEnabled = enabled;
  }

  log(kind: HardwareEventKind, device?: string, detail?: Record<string, unknown>): void {
    const entry: HardwareLogEntry = { kind, at: Date.now(), device, detail };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);

    for (const cb of this.listeners) {
      try { cb(entry); } catch { /* Listener darf Diagnose nie sprengen */ }
    }
    if (this.consoleEnabled) {
      // Sammel-Log außerhalb des Audio-Pfads; nur wenn explizit aktiviert.
      console.info('[hardware]', kind, device ?? '', detail ?? '');
    }
  }

  subscribe(cb: (entry: HardwareLogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  entriesSince(timeMs: number): HardwareLogEntry[] {
    return this.entries.filter((e) => e.at >= timeMs);
  }

  last(kind?: HardwareEventKind): HardwareLogEntry | undefined {
    if (!kind) return this.entries[this.entries.length - 1];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].kind === kind) return this.entries[i];
    }
    return undefined;
  }

  clear(): void {
    this.entries = [];
  }
}

export const hardwareDiagnostics = new HardwareDiagnostics();

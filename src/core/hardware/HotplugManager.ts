/**
 * audioMONASTRY · 8.2.3 – Hot-Plug & Failover für Hardware
 * =========================================================
 * Überwacht verbundene Geräte, erhält deren Zustand bei Trennung und stellt
 * ihn bei Wiederanbindung wieder her (State-Preservation).
 *
 * Erweitert um explizite Ereignisse CONNECTED/DISCONNECTED/CHANGED/RECONNECTED
 * und Multi-Listener-Subscription (bisher: Single-Callback). Abwärtskompatibel:
 * `onDeviceChange` bleibt erhalten.
 */
export interface HardwareDevice {
  id: string;
  name: string;
  connected: boolean;
}

export interface HardwareState {
  deviceId: string;
  state: Record<string, unknown>;
}

export type HotplugEventKind = 'CONNECTED' | 'DISCONNECTED' | 'CHANGED' | 'RECONNECTED';

export interface HotplugEvent {
  kind: HotplugEventKind;
  device: HardwareDevice;
  at: number;
  /** Beim RECONNECTED: wiederhergestellter Zustand (falls vorhanden). */
  preserved?: Record<string, unknown>;
}

export class HotplugManager {
  private devices = new Map<string, HardwareDevice>();
  private preserved = new Map<string, Record<string, unknown>>();
  private listeners = new Set<(event: HotplugEvent) => void>();
  private _onDeviceChange: (device: HardwareDevice) => void = () => {};

  /** Legacy-Single-Callback (bleibt für bestehende Nutzer). */
  onDeviceChange(cb: (device: HardwareDevice) => void): void {
    this._onDeviceChange = cb;
  }

  /** Multi-Listener-Subscription; liefert Unsubscribe-Funktion. */
  subscribe(cb: (event: HotplugEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: HotplugEvent): void {
    this._onDeviceChange(event.device);
    for (const cb of this.listeners) {
      try { cb(event); } catch { /* Listener darf Hotplug nie sprengen */ }
    }
  }

  /** Gerät als verbunden melden (Hot-Plug). */
  attach(id: string, name: string): void {
    const previous = this.devices.get(id);
    const device: HardwareDevice = { id, name, connected: true };
    this.devices.set(id, device);

    if (previous && !previous.connected) {
      // Wiederanbindung: konservierten Zustand zurückgeben.
      const restored = this.preserved.get(id);
      this.emit({ kind: 'RECONNECTED', device, at: Date.now(), preserved: restored });
    } else if (previous && previous.connected) {
      this.emit({ kind: 'CHANGED', device, at: Date.now() });
    } else {
      this.emit({ kind: 'CONNECTED', device, at: Date.now() });
    }
  }

  /** Gerät als getrennt melden – Zustand wird konserviert. */
  detach(id: string): void {
    const device = this.devices.get(id);
    if (!device || !device.connected) return;
    device.connected = false;
    this.emit({ kind: 'DISCONNECTED', device, at: Date.now() });
  }

  /** Geräte-Zustand sichern (Failover-Vorbereitung). */
  preserve(id: string, state: Record<string, unknown>): void {
    this.preserved.set(id, { ...state });
  }

  /** Gesicherten Zustand wiederherstellen (Reconnect). */
  restore(id: string): Record<string, unknown> | undefined {
    const state = this.preserved.get(id);
    return state ? { ...state } : undefined;
  }

  connected(): HardwareDevice[] {
    return [...this.devices.values()].filter((d) => d.connected);
  }

  disconnected(): HardwareDevice[] {
    return [...this.devices.values()].filter((d) => !d.connected);
  }

  isConnected(id: string): boolean {
    return this.devices.get(id)?.connected ?? false;
  }

  /** Entfernt Gerät + konservierten Zustand vollständig. */
  forget(id: string): void {
    this.devices.delete(id);
    this.preserved.delete(id);
  }
}

export const hotplugManager = new HotplugManager();

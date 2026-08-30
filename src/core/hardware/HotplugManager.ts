/**
 * audioMONASTRY · 8.2.3 – Hot-Plug & Failover für Hardware
 * =========================================================
 * Überwacht verbundene Geräte (per Callback), erhält deren Zustand bei
 * Trennung und stellt ihn bei Wiederanbindung wieder her (State-Preservation).
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

export class HotplugManager {
  private devices = new Map<string, HardwareDevice>();
  private preserved = new Map<string, Record<string, unknown>>();
  private _onDeviceChange: (device: HardwareDevice) => void = () => {};

  onDeviceChange(cb: (device: HardwareDevice) => void): void {
    this._onDeviceChange = cb;
  }

  /** Gerät als verbunden melden (Hot-Plug). */
  attach(id: string, name: string): void {
    const device: HardwareDevice = { id, name, connected: true };
    this.devices.set(id, device);
    this._onDeviceChange(device);
  }

  /** Gerät als getrennt melden – Zustand wird konserviert. */
  detach(id: string): void {
    const device = this.devices.get(id);
    if (!device) return;
    device.connected = false;
    this._onDeviceChange(device);
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

  isConnected(id: string): boolean {
    return this.devices.get(id)?.connected ?? false;
  }
}

export const hotplugManager = new HotplugManager();

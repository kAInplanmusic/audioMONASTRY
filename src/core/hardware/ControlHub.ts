/**
 * audioMONASTRY · ControlHub – zentrale Control-Schicht
 * ======================================================
 * Registriert Hardware-Adapter (MIDI/HID/OSC), sammelt deren ControlEvents
 * und speist sie in die Mapping-Engine. Die UI konsumiert ausschließlich
 * diesen Hub — kein direkter Low-Level-Zugriff.
 *
 *   DEVICE → ADAPTER (IHardwareAdapter) → CONTROL HUB → ControlEvent
 *                ↓
 *          MappingEngine (persistent, transportagnostisch)
 *
 * Fehlerisolierung: Ein defekter Adapter/Gerät darf den Hub nie sprengen.
 */
import type { ControlEvent, IHardwareAdapter } from '../interfaces';
import { hardwareDiagnostics } from './diagnostics';
import { hotplugManager } from './HotplugManager';

export interface ControlHubDeviceState {
  adapterId: string;
  connected: boolean;
  name: string;
}

export class ControlHub {
  private adapters = new Map<string, IHardwareAdapter>();
  private eventListeners = new Set<(ev: ControlEvent) => void>();
  private status = new Map<string, ControlHubDeviceState>();

  /** Registriert einen Adapter (idempotent, ersetzt gleiche ID). */
  register(adapter: IHardwareAdapter): void {
    this.adapters.set(adapter.id, adapter);
    if (!this.status.has(adapter.id)) {
      this.status.set(adapter.id, { adapterId: adapter.id, connected: false, name: adapter.id });
    }
    adapter.onControlEvent?.((ev) => this.dispatch(ev));
  }

  /** Verbindet einen einzelnen Adapter (Fehler isoliert). */
  async connect(adapterId: string): Promise<boolean> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return false;
    try {
      await adapter.connect();
      this.status.set(adapterId, { adapterId, connected: true, name: adapter.id });
      hotplugManager.attach(`control:${adapterId}`, adapter.id);
      hardwareDiagnostics.log('OPEN', adapter.id, { backend: adapterId });
      return true;
    } catch (e) {
      this.status.set(adapterId, { adapterId, connected: false, name: adapter.id });
      hardwareDiagnostics.log('DEVICE_ERROR', adapter.id, { error: (e as Error).message });
      return false;
    }
  }

  /** Verbindet alle registrierten Adapter; einzelne Fehler brechen nichts. */
  async connectAll(): Promise<{ ok: string[]; failed: string[] }> {
    const ok: string[] = [];
    const failed: string[] = [];
    for (const id of this.adapters.keys()) {
      if (await this.connect(id)) ok.push(id);
      else failed.push(id);
    }
    return { ok, failed };
  }

  disconnect(adapterId: string): void {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;
    try { adapter.disconnect(); } catch { /* ignore */ }
    this.status.set(adapterId, { adapterId, connected: false, name: adapter.id });
    hotplugManager.detach(`control:${adapterId}`);
    hardwareDiagnostics.log('CLOSE', adapter.id);
  }

  disconnectAll(): void {
    for (const id of [...this.adapters.keys()]) this.disconnect(id);
  }

  /** Abonniert ControlEvents (Multi-Listener). */
  onControlEvent(cb: (ev: ControlEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** Aktueller Adapter-/Verbindungsstatus (für UI). */
  listStatus(): ControlHubDeviceState[] {
    return [...this.status.values()];
  }

  listAdapters(): string[] {
    return [...this.adapters.keys()];
  }

  private dispatch(ev: ControlEvent): void {
    for (const cb of this.eventListeners) {
      try { cb(ev); } catch { /* Listener darf Bus nie sprengen */ }
    }
  }
}

export const controlHub = new ControlHub();

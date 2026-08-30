/**
 * audioMONASTRY · AudioDeviceManager – App-weite Geräte-Verwaltung
 * =================================================================
 * Zentraler Manager für Audio-Geräte der Web-App:
 *
 *  - Enumeration aller Output-/Input-Devices
 *  - ASUS Xonar U7-Erkennung (8-Kanal-USB-DAC)
 *  - App-weite Ausgabe: `setSinkId()` auf dem Master-AudioContext
 *  - Hot-Plug: `devicechange`-Listener mit Reconnect des zuletzt genutzten
 *    Geräts (Re-Apply) und HotplugManager-Events
 *  - Latency-Snapshot (Sample-Rate, baseLatency, outputLatency, Round-Trip)
 *
 * Browser können nativ nur EIN Ausgabegerät ansteuern. Für echte
 * Mehrgeräte-Ausgabe ist OS-seitige Aggregation nötig (Windows:
 * ASIO4ALL/Voicemeeter, Linux: PipeWire Combine-Sink, macOS: Aggregate
 * Device). Dieser Manager liefert dafür die vollständige Kanalzuordnung.
 */
import { enumerateMediaDevices, requestUserMedia } from './mediaDevices';
import {
  assignXonarDevices, isXonarU7, planRoom, requiredXonarDevices, XONAR_U7_CHANNEL_NAMES,
} from '../core/spatial/roomPlanner';
import { hotplugManager } from '../core/hardware/HotplugManager';
import { hardwareDiagnostics } from '../core/hardware/diagnostics';
import { audioEngine } from './audioEngine';

export interface ManagedOutputDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  isXonar: boolean;
}

export interface ManagedInputDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface XonarChannelMap {
  setupId: string;
  totalChannels: number;
  requiredDevices: number;
  channels: { channel: number; name: string; deviceIndex: number; deviceChannel: number; deviceChannelName: string }[];
}

export interface AudioLatencySnapshot {
  state: string;
  sampleRate: number;
  baseLatencyMs: number;
  outputLatencyMs: number;
  /** Round-Trip = base + output (Web Audio hat keine echte Input-Latenz-Metrik). */
  roundTripMs: number;
  /** Hinweis: Werte sind Browser-Metriken, NICHT Device-Garantien. */
  source: 'webaudio';
}

export interface AudioDeviceChange {
  kind: 'CONNECTED' | 'DISCONNECTED' | 'CHANGED';
  deviceId: string;
  label: string;
  kind2: MediaDeviceKind;
}

class AudioDeviceManager {
  private outputs: ManagedOutputDevice[] = [];
  private inputs: ManagedInputDevice[] = [];
  private lastAppliedOutput = '';
  private lastAppliedInput = '';
  private changeTimer: number | null = null;
  private monitoring = false;
  private changeListeners = new Set<(change: AudioDeviceChange) => void>();

  /** Alle Geräte neu einlesen (Output + Input). */
  async refresh(): Promise<ManagedOutputDevice[]> {
    const devices = await enumerateMediaDevices();
    const prevOutputIds = new Set(this.outputs.map((d) => d.deviceId));

    this.outputs = devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || d.deviceId || 'Unbekanntes Gerät',
        kind: d.kind,
        isXonar: isXonarU7(d.label || d.deviceId),
      }));
    this.inputs = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || d.deviceId || 'Unbekanntes Eingabegerät',
        kind: d.kind,
      }));

    this.syncHotplugState(prevOutputIds);
    return this.outputs;
  }

  listOutputs(): ManagedOutputDevice[] {
    return [...this.outputs];
  }

  listInputs(): ManagedInputDevice[] {
    return [...this.inputs];
  }

  /** Erkannte Xonar-U7-Geräte. */
  xonarDevices(): ManagedOutputDevice[] {
    return this.outputs.filter((d) => d.isXonar);
  }

  /** Letztes angewendetes Ausgabegerät (für Reconnect). */
  get currentOutput(): string {
    return this.lastAppliedOutput;
  }

  /** Letztes gewähltes Eingabegerät. */
  get currentInput(): string {
    return this.lastAppliedInput;
  }

  /**
   * Setzt das App-weite Ausgabegerät (setSinkId auf dem Master-Context).
   * Ohne Browser-Unterstützung bleibt der Browser-Default aktiv.
   */
  async applyOutput(deviceId: string): Promise<boolean> {
    this.lastAppliedOutput = deviceId;
    const device = this.outputs.find((d) => d.deviceId === deviceId);
    const label = device?.label ?? deviceId;
    try {
      await audioEngine.setOutputDevice(deviceId);
      hardwareDiagnostics.log('OPEN', label, { deviceId, backend: 'webaudio', sampleRate: audioEngine.getAudioHealth().sampleRate });
      if (deviceId) hotplugManager.attach(`audio-output:${deviceId}`, label);
      return true;
    } catch (e) {
      hardwareDiagnostics.log('DEVICE_ERROR', label, { error: (e as Error).message });
      console.warn('Ausgabegerät nicht gesetzt:', e);
      return false;
    }
  }

  /** Wählt das Eingabegerät (wird beim nächsten startLocalAudio genutzt). */
  async applyInput(deviceId: string): Promise<boolean> {
    this.lastAppliedInput = deviceId;
    const device = this.inputs.find((d) => d.deviceId === deviceId);
    const label = device?.label ?? deviceId;
    try {
      // Test-Öffnung, damit Permission-Fehler sofort sichtbar sind; der
      // tatsächliche Stream wird vom WebRTCManager gehalten.
      if (deviceId) {
        const probe = await requestUserMedia({ audio: { deviceId: { exact: deviceId } } });
        probe.getTracks().forEach((t) => t.stop());
      }
      hardwareDiagnostics.log('OPEN', label, { deviceId, backend: 'getUserMedia' });
      if (deviceId) hotplugManager.attach(`audio-input:${deviceId}`, label);
      return true;
    } catch (e) {
      hardwareDiagnostics.log('DEVICE_ERROR', label, { error: (e as Error).message });
      console.warn('Eingabegerät nicht verfügbar:', e);
      return false;
    }
  }

  /** Latency-Snapshot aus den Web-Audio-Metriken (Browser-Werte). */
  getLatencySnapshot(): AudioLatencySnapshot {
    const health = audioEngine.getAudioHealth();
    return {
      state: health.state,
      sampleRate: health.sampleRate,
      baseLatencyMs: health.baseLatencyMs,
      outputLatencyMs: health.outputLatencyMs,
      roundTripMs: health.baseLatencyMs + health.outputLatencyMs,
      source: 'webaudio',
    };
  }

  /** Abonniert Gerätewechsel (devicechange-Verarbeitung). */
  onDeviceChange(cb: (change: AudioDeviceChange) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /**
   * Startet Hot-Plug-Monitoring. Bei Entfernen des aktiven Geräts bleibt der
   * Default aktiv (kein Crash); bei Rückkehr wird das letzte Gerät erneut
   * angewendet (Reconnect) und der HotplugManager informiert.
   */
  startMonitoring(): void {
    if (this.monitoring) return;
    this.monitoring = true;
    const md = globalThis.navigator?.mediaDevices as MediaDevices & {
      addEventListener?: (type: string, cb: () => void) => void;
      removeEventListener?: (type: string, cb: () => void) => void;
    };
    if (!md?.addEventListener) return;

    const onDeviceChange = () => {
      if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
      this.changeTimer = window.setTimeout(() => {
        this.changeTimer = null;
        void this.refresh().then(() => {
          // Reconnect: Letztes Ausgabegerät ist zurück → erneut anwenden.
          if (this.lastAppliedOutput && this.outputs.some((d) => d.deviceId === this.lastAppliedOutput)) {
            void this.applyOutput(this.lastAppliedOutput);
          }
        });
      }, 150);
    };

    try {
      md.addEventListener('devicechange', onDeviceChange);
      this.changeListener = onDeviceChange;
    } catch { /* ältere Browser: kein Event – manueller Rescan bleibt */ }
  }

  stopMonitoring(): void {
    const md = globalThis.navigator?.mediaDevices as MediaDevices & {
      removeEventListener?: (type: string, cb: () => void) => void;
    };
    if (md?.removeEventListener && this.changeListener) {
      try { md.removeEventListener('devicechange', this.changeListener); } catch { /* ignore */ }
    }
    this.changeListener = null;
    this.monitoring = false;
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
  }

  private changeListener: (() => void) | null = null;

  /** Gleicht Enumeration mit HotplugManager ab (CONNECTED/DISCONNECTED). */
  private syncHotplugState(prevOutputIds: Set<string>): void {
    const currentIds = new Set(this.outputs.map((d) => d.deviceId));
    for (const d of this.outputs) {
      const id = `audio-output:${d.deviceId}`;
      if (!hotplugManager.isConnected(id)) hotplugManager.attach(id, d.label);
    }
    for (const id of prevOutputIds) {
      if (!currentIds.has(id)) {
        const fullId = `audio-output:${id}`;
        // Zustand sichern, dann als getrennt melden (kein Crash, Default bleibt).
        hotplugManager.preserve(fullId, { deviceId: id, reapply: id === this.lastAppliedOutput });
        hotplugManager.detach(fullId);
        hardwareDiagnostics.log('DISCONNECT', id);
      }
    }
  }

  /**
   * Kanalplan für ein Spatial-Setup (12.x/18.x/24.x) über N Xonar-U7-Geräte.
   * Dient als Referenz für OS-Aggregation und spätere native Backends.
   */
  xonarChannelMap(setupId: string, room: { lengthM: number; widthM: number }): XonarChannelMap {
    const plan = planRoom(setupId, room);
    const assigned = assignXonarDevices(plan, 4);
    return {
      setupId,
      totalChannels: plan.totalChannels,
      requiredDevices: requiredXonarDevices(plan),
      channels: assigned.map((s) => ({
        channel: s.channel,
        name: s.name,
        deviceIndex: s.xonar?.deviceIndex ?? 0,
        deviceChannel: s.xonar?.deviceChannel ?? 0,
        deviceChannelName: XONAR_U7_CHANNEL_NAMES[s.xonar?.deviceChannel ?? 0],
      })),
    };
  }

  /** Übersicht für UI/Diagnose. */
  summary() {
    return {
      outputs: this.outputs.length,
      inputs: this.inputs.length,
      xonar: this.xonarDevices().length,
      maxChannels: this.xonarDevices().length * 8,
    };
  }
}

export const audioDeviceManager = new AudioDeviceManager();

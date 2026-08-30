/**
 * audioMONASTRY · AudioDeviceManager – App-weite Ausgabegeräte-Verwaltung
 * ========================================================================
 * Zentraler Manager für alle Audio-Ausgabegeräte der Web-App:
 *
 *  - Enumeration aller Output-Devices
 *  - ASUS Xonar U7-Erkennung (8-Kanal-USB-DAC)
 *  - App-weite Ausgabe: `setSinkId()` auf dem Master-AudioContext
 *  - Mehrgeräte-Aggregation (3–4× Xonar U7 → 24–32 Kanäle) als Kanalplan
 *    für die Spatial-Busse (12.x/18.x/24.x) und alle weiteren Ausgänge
 *
 * Browser können nativ nur EIN Ausgabegerät ansteuern. Für echte
 * Mehrgeräte-Ausgabe ist OS-seitige Aggregation nötig (Windows:
 * ASIO4ALL/Voicemeeter, Linux: PipeWire Combine-Sink, macOS: Aggregate
 * Device). Dieser Manager liefert dafür die vollständige Kanalzuordnung.
 */
import { enumerateMediaDevices } from './mediaDevices';
import {
  assignXonarDevices, isXonarU7, planRoom, requiredXonarDevices, XONAR_U7_CHANNEL_NAMES,
} from '../core/spatial/roomPlanner';
import { audioEngine } from './audioEngine';

export interface ManagedOutputDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  isXonar: boolean;
}

export interface XonarChannelMap {
  setupId: string;
  totalChannels: number;
  requiredDevices: number;
  channels: { channel: number; name: string; deviceIndex: number; deviceChannel: number; deviceChannelName: string }[];
}

class AudioDeviceManager {
  private outputs: ManagedOutputDevice[] = [];

  /** Alle Ausgabegeräte neu einlesen. */
  async refresh(): Promise<ManagedOutputDevice[]> {
    const devices = await enumerateMediaDevices();
    this.outputs = devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || d.deviceId || 'Unbekanntes Gerät',
        kind: d.kind,
        isXonar: isXonarU7(d.label || d.deviceId),
      }));
    return this.outputs;
  }

  listOutputs(): ManagedOutputDevice[] {
    return [...this.outputs];
  }

  /** Erkannte Xonar-U7-Geräte. */
  xonarDevices(): ManagedOutputDevice[] {
    return this.outputs.filter((d) => d.isXonar);
  }

  /**
   * Setzt das App-weite Ausgabegerät (setSinkId auf dem Master-Context).
   * Ohne Browser-Unterstützung bleibt der Browser-Default aktiv.
   */
  async applyOutput(deviceId: string): Promise<boolean> {
    try {
      await audioEngine.setOutputDevice(deviceId);
      return true;
    } catch (e) {
      console.warn('Ausgabegerät nicht gesetzt:', e);
      return false;
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
      xonar: this.xonarDevices().length,
      maxChannels: this.xonarDevices().length * 8,
    };
  }
}

export const audioDeviceManager = new AudioDeviceManager();

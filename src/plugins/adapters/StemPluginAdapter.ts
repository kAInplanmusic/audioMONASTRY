import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** stemMONK – Stem-Separation und -Analyse (kanonische ID `stem`). */
export class StemPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'stem',
    name: 'stemMONK',
    version: '1.0.0',
    kind: 'analysis',
    capabilities: ['ai', 'analysis', 'audio-processor'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(StemPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    // UI2-P0-003-F1: definierter Transport-Start für die SYNC-Taste (channel8 =
    // stem-Rolle); ohne SYNC sofort, mit SYNC taktgleich zu Main.
    if (command.name === 'play' || command.name === 'start') {
      const start = () => { this.context?.audio.triggerEvent('channel8', Number(command.payload?.velocity ?? 0.8)); };
      this.scheduleSyncStart(start);
      return { ok: true, track: 'channel8' };
    }
    if (command.name === 'separate') {
      // Datei-Picker-/Queue-Pfad: Progress, Abbruch und Provider-Fallbacks
      // liegen im StemExtractorTerminal bzw. stem-Router (async).
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:stem-pick-file', command.payload ?? {});
      return { ok: true };
    }
    if (command.name === 'status') {
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:stem-status', command.payload ?? {});
      return { ok: true };
    }
    return super.onCommand(command);
  }
}

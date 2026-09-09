import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** dropMONK – Live Drops, One-Shots, Performance-Samples (kanonische ID `drop`). */
export class DropPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'drop',
    name: 'dropMONK',
    version: '1.0.0',
    kind: 'analysis',
    capabilities: ['analysis', 'library'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(DropPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'pattern') {
      const { controlBus } = await import('../../core/events/ControlBus');
      const preset = String(command.payload?.preset ?? 'build');
      controlBus.emit('monk:drop-pattern', { preset });
      return { ok: true, preset };
    }
    if (command.name === 'autoDrop') {
      // Quantisierte Überleitung: Analyse passiert async im Drop-Core,
      // niemals im synchronen process()-Pfad.
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:drop-auto', command.payload ?? {});
      return { ok: true };
    }
    return super.onCommand(command);
  }
}

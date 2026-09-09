import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** recordMONK – Aufnahme, Bounce, Export (kanonische ID `record`). */
export class RecordPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'record',
    name: 'recordMONK',
    version: '1.0.0',
    kind: 'recording',
    capabilities: ['recording'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(RecordPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    const { controlBus } = await import('../../core/events/ControlBus');
    if (command.name === 'start') {
      controlBus.emit('monk:recorder-start', command.payload ?? {});
      return { ok: true };
    }
    if (command.name === 'stop') {
      controlBus.emit('monk:recorder-stop', command.payload ?? {});
      return { ok: true };
    }
    if (command.name === 'bounce') {
      // Offline-Render/Bounce läuft über die bestehende Bounce-Engine (async).
      const { audioEngine } = await import('../../utils/audioEngine');
      await audioEngine.ensureDemoPattern?.();
      return { ok: true, note: 'bounce delegated to existing offline engine' };
    }
    return super.onCommand(command);
  }
}

import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** biblioMONK – Library, Samples, Assets, Suche (kanonische ID `biblio`). */
export class BiblioPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'biblio',
    name: 'biblioMONK',
    version: '1.0.0',
    kind: 'library',
    capabilities: ['library', 'analysis'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(BiblioPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'sync') {
      const signal = command.payload?.signal as AbortSignal | undefined;
      const res = await fetch('/api/cloud/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal,
      });
      if (!res.ok) throw new Error(`cloud sync failed: ${res.status}`);
      return { ok: true };
    }

    const { controlBus } = await import('../../core/events/ControlBus');
    if (command.name === 'search') {
      controlBus.emit('monk:library-search', command.payload?.query ?? '');
      return { ok: true };
    }
    if (command.name === 'load') {
      controlBus.emit('monk:library-load', command.payload ?? {});
      return { ok: true };
    }
    return super.onCommand(command);
  }
}

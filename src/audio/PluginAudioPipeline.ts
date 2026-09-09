import type {
  CanonicalPluginId,
  PluginAudioBlock,
  PluginInterface,
  PluginSnapshot,
} from '../plugins/plugin_interface';

/**
 * Zentrale, deterministische Audio-Pipeline der 16 kanonischen Adapter.
 *
 * Echtzeitregeln:
 * - keine neuen AudioContext-Instanzen pro Plugin
 * - keine Netzwerkoperation im process()-Pfad
 * - keine React-State-Updates im process()-Pfad
 * - OFF ist ein transparenter Bypass
 * - Fehler eines Adapters werden kontrolliert behandelt und geloggt
 * - dispose() gibt alle Ressourcen frei
 */
export class PluginAudioPipeline {
  constructor(
    private readonly adapters: Readonly<
      Record<CanonicalPluginId, PluginInterface>
    >,
    private readonly order: readonly CanonicalPluginId[],
  ) {}

  process(input: PluginAudioBlock): PluginAudioBlock {
    let block = input;

    for (const pluginId of this.order) {
      const adapter = this.adapters[pluginId];

      if (!adapter || adapter.state === 'OFF') {
        continue;
      }

      try {
        block = adapter.process(block);
      } catch (err) {
        // Echtzeit-sicherer Fehlerpfad: kein Log-Spam im Audio-Thread.
        if (typeof console !== 'undefined' && (console as Console).warn) {
          console.warn(`[plugin-pipeline] ${pluginId} process failed`, err);
        }
      }
    }

    return block;
  }

  snapshot(): PluginSnapshot[] {
    return this.order.map((id) => this.adapters[id].snapshot());
  }

  async dispose(): Promise<void> {
    for (const pluginId of this.order) {
      const adapter = this.adapters[pluginId];
      if (!adapter) continue;
      try {
        await adapter.dispose();
      } catch (err) {
        console.warn(`[plugin-pipeline] ${pluginId} dispose failed`, err);
      }
    }
  }
}

import type {
  CanonicalPluginId,
  PluginAudioBlock,
  PluginInterface,
  PluginSnapshot,
} from '../plugins/plugin_interface';
import { SIGNAL_CHAIN_ORDER } from '../plugins/signalChain';

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
  /**
   * @param order Reihenfolge der Verarbeitung. Vorgabe ist die **Signalkette**
   *   (`plugins/signalChain.ts`): Quellen → Mixer → Nachbearbeitung → Recorder
   *   → Ausgang. Die *Kopfreihenfolge* (`CANONICAL_PLUGIN_IDS`) ist nur die
   *   Darstellung der 16 Icons und als Verarbeitungsreihenfolge nachweislich
   *   falsch: sie stellt `mixer` an Position 0, also VOR die Quellen, und dreht
   *   zusätzlich `spatial` vor `eq` (gemessen, `tests/pluginAudioPipeline.test.ts`).
   */
  constructor(
    private readonly adapters: Readonly<
      Record<CanonicalPluginId, PluginInterface>
    >,
    private readonly order: readonly CanonicalPluginId[] = SIGNAL_CHAIN_ORDER,
  ) {}

  /** Die Reihenfolge, in der dieser Durchlauf verarbeitet – für Prüfungen/Gates. */
  get processingOrder(): readonly CanonicalPluginId[] {
    return this.order;
  }

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

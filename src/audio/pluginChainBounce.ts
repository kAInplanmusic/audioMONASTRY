/**
 * audioMONASTRY – Bounce durch die Signalkette
 * ============================================
 * Der **Ausführer** des linearen Insert-Pfads für den Offline-Fall: Die Quelle
 * läuft Block für Block durch die 16 kanonischen Adapter in der Reihenfolge der
 * Signalkette (`plugins/signalChain.ts`):
 *
 *   Quellen → Mixer → Nachbearbeitung → Recorder → Ausgang
 *
 * Warum offline zuerst: Der Live-Pfad ist nur hörbar, nicht messbar. Hier ist
 * das Ergebnis deterministisch und in Tests Stück für Stück nachweisbar – ist
 * die Kette offline bewiesen, ist der Umzug in den Live-Pfad ein Umzug
 * derselben Ordnung und kein Blindflug mehr.
 *
 * Echtzeit-Regeln gelten hier nicht (es gibt keinen Audio-Thread), aber die
 * Adapter-Verträge schon: `process()` ist synchron, OFF ist ein transparenter
 * Bypass, und die Blockgrenzen sind dieselben wie live (`blockSize`, Vorgabe
 * 128 = ein Web-Audio-Quantum).
 *
 * Zustand setzen: `snapshots` werden über `restore()` eingespielt – das ist der
 * vorgesehene deterministische Weg und funktioniert ohne Runtime-Kontext
 * (`setParameter()` bräuchte einen und wäre im Bounce wirkungslos).
 */

import { createPluginAdapters } from '../plugins/adapters';
import {
  SIGNAL_CHAIN_ORDER,
} from '../plugins/signalChain';
import type {
  CanonicalPluginId,
  PluginAudioBlock,
  PluginInterface,
  PluginSnapshot,
} from '../plugins/plugin_interface';
import { PluginAudioPipeline } from './PluginAudioPipeline';

export interface PluginChainBounceOptions {
  /** Abtastrate des Ergebnisses (Vorgabe 48000). */
  sampleRate?: number;
  /** Nachklang in Sekunden, angehängt als Stille (Vorgabe 0 – nur was Specs brauchen). */
  tailSeconds?: number;
  /** Blockgröße der Verarbeitung (Vorgabe 128 = ein Web-Audio-Quantum). */
  blockSize?: number;
  /** Plugin-Zustand/-Parameter je Adapter, deterministisch eingespielt via `restore()`. */
  snapshots?: readonly PluginSnapshot[];
  /**
   * Eigene Adapter-Menge. Ohne Angabe wird die kanonische Menge erzeugt.
   * Eingereichte Adapter gehören dem Aufrufer und werden NICHT entsorgt.
   */
  adapters?: Readonly<Record<CanonicalPluginId, PluginInterface>>;
  /**
   * Nach so vielen Blöcken einmal an die Event-Loop abgeben, damit ein ganzes
   * Lied die Oberfläche nicht einfriert. `0` = nie abgeben (rein synchron,
   * z. B. in Tests). Ohne Wirkung auf das Ergebnis – nur auf die Bedienbarkeit.
   */
  yieldEveryBlocks?: number;
}

export interface PluginChainBounceResult {
  output: Float32Array[];
  sampleRate: number;
  renderedFrames: number;
  tailFrames: number;
  durationSeconds: number;
  /** Die tatsächlich verwendete Reihenfolge – für Gates/Anzeige. */
  order: readonly CanonicalPluginId[];
}

const DEFAULT_BLOCK_SIZE = 128;
/** Alle 64 Blöcke (~170 ms Audio) einmal abgeben: flüssige Bedienung, kaum Tempo-Verlust. */
const DEFAULT_YIELD_BLOCKS = 64;

/**
 * Rendert `source` (planar, je Kanal ein Float32Array) durch die Signalkette.
 * Das Ergebnis hat die Länge `source + tailSeconds`.
 */
export async function bounceThroughPluginChain(
  source: readonly Float32Array[],
  opts: PluginChainBounceOptions = {},
): Promise<PluginChainBounceResult> {
  const sampleRate = opts.sampleRate ?? 48000;
  const blockSize = Math.max(1, Math.floor(opts.blockSize ?? DEFAULT_BLOCK_SIZE));
  const yieldEveryBlocks = Math.max(0, Math.floor(opts.yieldEveryBlocks ?? DEFAULT_YIELD_BLOCKS));
  const tailFrames = Math.max(0, Math.ceil((opts.tailSeconds ?? 0) * sampleRate));
  const sourceFrames = source[0]?.length ?? 0;
  const totalFrames = sourceFrames + tailFrames;

  // Eigener Ausgabepuffer: die gecachte Quelle darf NIE angefasst werden.
  const output: Float32Array[] = source.map((channel) => {
    const out = new Float32Array(totalFrames);
    out.set(channel.subarray(0, Math.min(channel.length, totalFrames)));
    return out;
  });

  const ownsAdapters = !opts.adapters;
  const adapters = opts.adapters ?? createPluginAdapters();
  for (const snapshot of opts.snapshots ?? []) {
    const adapter = adapters[snapshot.pluginId as CanonicalPluginId];
    adapter?.restore(snapshot);
  }

  const pipeline = new PluginAudioPipeline(adapters, SIGNAL_CHAIN_ORDER);

  try {
    let blockIndex = 0;
    for (let offset = 0; offset < totalFrames; offset += blockSize) {
      const frameCount = Math.min(blockSize, totalFrames - offset);
      const block: PluginAudioBlock = {
        // Views, keine Kopien: der Adapter schreibt in den Ausgabepuffer.
        channels: output.map((channel) => channel.subarray(offset, offset + frameCount)),
        sampleRate,
        timestamp: offset / sampleRate,
        frameCount,
      };

      const processed = pipeline.process(block);

      // Ein Adapter darf einen neuen Block zurückgeben; dann zurückkopieren.
      for (let c = 0; c < output.length; c++) {
        const written = processed.channels[c];
        if (!written || written === output[c]) continue;
        const frames = Math.min(frameCount, written.length);
        output[c].set(written.subarray(0, frames), offset);
      }

      // Ein Lied sind ~100k Blöcke: ohne Abgabe an die Event-Loop stünde die
      // Oberfläche für Sekunden. Das Ergebnis bleibt identisch.
      blockIndex++;
      if (yieldEveryBlocks > 0 && blockIndex % yieldEveryBlocks === 0) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      }
    }
  } finally {
    // Nur entsorgen, was wir selbst erzeugt haben.
    if (ownsAdapters) await pipeline.dispose();
  }

  return {
    output,
    sampleRate,
    renderedFrames: totalFrames,
    tailFrames,
    durationSeconds: totalFrames / sampleRate,
    order: pipeline.processingOrder,
  };
}

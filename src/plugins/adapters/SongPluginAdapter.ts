import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** songMONK – Song-/Track-Generierung und Arrangement (kanonische ID `song`). */
export class SongPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'song',
    name: 'songMONK',
    version: '1.0.0',
    kind: 'audio-source',
    capabilities: ['ai', 'audio-source'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(SongPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name !== 'generate') {
      return super.onCommand(command);
    }

    const prompt = String(command.payload?.prompt ?? command.payload?.text ?? '');
    const { controlBus } = await import('../../core/events/ControlBus');
    controlBus.emit('monk:song-generate', { prompt });

    // Server-/AI-Pfad: abbrechbar, niemals im Audio-Echtzeitpfad.
    const signal = command.payload?.signal as AbortSignal | undefined;
    try {
      const res = await fetch('/api/song/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`song generate failed: ${res.status} ${detail.slice(0, 200)}`);
      }
      const result = (await res.json()) as unknown;
      // Erzeugte Assets werden über biblio übernommen (ControlBus-Event).
      controlBus.emit('monk:song-result', result);
      return result;
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, cancelled: true };
      }
      throw err;
    }
  }
}

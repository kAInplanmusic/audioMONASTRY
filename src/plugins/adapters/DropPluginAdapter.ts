import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';
import { getDropAudioAdapter } from '../../core/drop/DropAudioAdapter';

/** Erlaubte Mixer-Kanaele (1-basiert, wie TrackType der Engine). */
const CHANNEL_RE = /^channel([1-8])$/;

/** `channel`/`track` aus dem Kommando lesen; null = kein gueltiger Kanal. */
function readChannel(payload: Record<string, unknown> | undefined): string | null {
  const raw = String(payload?.channel ?? payload?.track ?? '').trim().toLowerCase();
  const m = CHANNEL_RE.exec(raw.startsWith('ch') && !raw.startsWith('channel') ? `channel${raw.slice(2)}` : raw);
  return m ? raw.replace(/^ch(?!annel)/, 'channel') : null;
}

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
      // Quantisierte Ueberleitung: Analyse passiert async im Drop-Core,
      // niemals im synchronen process()-Pfad.
      //
      // Der Kanal geht MIT (wie pluginCommandRegistry.ts:213 es bereits tut) -
      // vorher reichte der Adapter nur payload durch, der Kanal ging verloren.
      const { controlBus } = await import('../../core/events/ControlBus');
      const payload = command.payload ?? {};
      const channel = readChannel(payload);
      controlBus.emit('monk:drop-auto', channel ? { ...payload, channel } : payload);
      return { ok: true, channel };
    }
    if (command.name === 'play') {
      // Drop hoerbar auf einen Kanal bringen (PREP-6). Nutzt denselben Weg wie
      // der Sprachbefehl: Sample laden -> naechste volle Bar -> feuern + faden.
      const payload = command.payload ?? {};
      const channel = readChannel(payload);
      if (!channel) return { ok: false, reason: 'kein gueltiger Kanal' };

      const url = typeof payload.url === 'string' && payload.url ? payload.url : null;
      if (!url) return { ok: false, reason: 'keine url' };

      const adapter = getDropAudioAdapter();
      if (!adapter?.loadTrackSample || !adapter?.triggerEvent) {
        // Kein Audio-Kontext/Adapter (Headless, Tests, gestoppter Sink).
        return { ok: false, reason: 'kein Audio-Adapter' };
      }

      const loaded = await adapter.loadTrackSample(channel, url);
      if (!loaded) return { ok: false, reason: 'Kanal nicht ladbar' };

      const velocity = typeof payload.velocity === 'number' ? payload.velocity : 0.9;
      const rampSec = typeof payload.rampSec === 'number' ? payload.rampSec : 4;

      const fire = (): void => {
        adapter.triggerEvent?.(channel, velocity);
        adapter.fadeChannelToMain?.(channel, rampSec, 0);
      };

      if (payload.quantize === false) {
        fire();
      } else {
        this.scheduleSyncStart(fire);
      }
      return { ok: true, channel, quantized: payload.quantize !== false };
    }
    return super.onCommand(command);
  }
}

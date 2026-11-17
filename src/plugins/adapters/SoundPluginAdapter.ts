import type { PluginManifest, PluginAudioBlock } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** soundMONK – Sound-Generierung und generative Audio-One-Shots (kanonische ID `sound`). */
export class SoundPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'sound',
    name: 'soundMONK',
    version: '1.0.0',
    kind: 'audio-source',
    capabilities: ['ai', 'audio-source'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(SoundPluginAdapter.MANIFEST);
  }

  /** Pass-through: soundMONK liefert Audio über die globale Engine. */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    return block;
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'trigger') {
      const start = () => { this.context?.audio.triggerEvent('channel7', 0.8); };
      this.scheduleSyncStart(start);
      return { ok: true, track: 'channel7' };
    }
    if (command.name === 'generate') {
      // Generative Beat-/Bass-/Atmosphären-Erzeugung: async, Worklet-/AI-Pfade.
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:sound-generate', command.payload ?? {});
      return { ok: true };
    }
    return super.onCommand(command);
  }
}

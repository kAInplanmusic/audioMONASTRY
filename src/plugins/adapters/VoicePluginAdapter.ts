import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** voiceMONK – Voice/TTS/Gesang (kanonische ID `voice`). */
export class VoicePluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'voice',
    name: 'voiceMONK',
    version: '1.0.0',
    kind: 'audio-source',
    capabilities: ['ai', 'audio-source'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(VoicePluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    const text = String(command.payload?.text ?? '');
    const userId = this.context?.userId ?? 'localUser';
    const signal = command.payload?.signal as AbortSignal | undefined;
    const { voiceMonkService } = await import('../../core/voice/VoiceMonkService');

    switch (command.name) {
      case 'speak':
        return voiceMonkService.speak(userId, text || 'Hallo', { signal } as never);
      case 'sing':
        return voiceMonkService.sing(userId, {
          notes: [{ lyric: text || 'Hallo', midi: 60 }],
          bpm: 120,
        });
      case 'song':
        return voiceMonkService.generateSong(userId, text || 'Dark warehouse techno');
      default:
        return super.onCommand(command);
    }
  }
}

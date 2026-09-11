import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';
import type { TrackType } from '../../types';

/** instruMONK – Instrumente, MIDI-Programme, Presets (kanonische ID `instru`). */
export class InstruPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'instru',
    name: 'instruMONK',
    version: '1.0.0',
    kind: 'audio-source',
    capabilities: ['audio-source', 'hardware'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(InstruPluginAdapter.MANIFEST);
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'program') {
      const program = Number(command.payload?.program ?? 0);
      const { instrumentBackend } = await import('../../core/instrument/InstrumentBackend');
      await instrumentBackend.handleProgramChange(program);
      return { ok: true, program };
    }
    if (command.name === 'note') {
      const note = command.payload?.note ?? 60;
      const { audioEngine } = await import('../../utils/audioEngine');
      audioEngine.instrumentNote(note as string | number);
      return { ok: true };
    }
    if (command.name === 'optional-voice') {
      // FEAT-P3-002: FM-E-Piano (Bellschlag → Sustain) als V2-Quelle.
      const { audioEngine } = await import('../../utils/audioEngine');
      const channel = (command.payload?.channel ?? 'channel4') as TrackType;
      const freq = Number(command.payload?.freq ?? 440);
      const modIndex = Number(command.payload?.modIndex ?? 2.4);
      audioEngine.setOptionalSynthVoice(channel, 'epiano', freq, { modIndex });
      return { ok: true, block: 'electric-piano', channel };
    }
    return super.onCommand(command);
  }
}

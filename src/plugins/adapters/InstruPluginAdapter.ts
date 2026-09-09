import type { PluginManifest } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

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
    return super.onCommand(command);
  }
}

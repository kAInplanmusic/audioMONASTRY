/** Server-issued, revocable AI authority, separate from the human control lock. */
export interface PluginDelegation {
  pluginId: string;
  delegatedBy: string;
  aiRole: string;
  generationId: string;
  issuedAt: number;
  expiresAt: number;
}
export const PLUGIN_AI_ROLE: Readonly<Record<string, string>> = {
  drop: 'audio-brain', song: 'song', effect: 'audio-brain', syntisampler: 'audio-brain',
  drumsampler: 'audio-brain', instru: 'voiceGen', biblio: 'ears', voice: 'voiceGen',
  sound: 'voiceGen', stem: 'studio', spatial: 'audio-brain', eq: 'audio-brain',
  dsp: 'audio-brain', master: 'studio', record: 'audio-brain',
};

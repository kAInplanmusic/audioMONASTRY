import { pluginAudioChannels } from './pluginChannelMap';
import type { TrackType } from '../../types';
/** Only this user's currently held/delegated active source plugins enter private cue. */
export function ownActiveMonitorTracks(
  userId: string,
  states: Readonly<Record<string, string>>,
  locks: Readonly<Record<string, { active?: boolean; lockedBy?: string } | undefined>>,
  hasOwnDelegation: (pluginId: string) => boolean = () => false,
): TrackType[] {
  if (!userId) return [];
  const tracks = new Set<TrackType>();
  for (const [id, state] of Object.entries(states)) {
    if (state === 'OFF') continue;
    const lock = locks[id];
    if (!(lock?.active && lock.lockedBy === userId) && !hasOwnDelegation(id)) continue;
    for (const track of pluginAudioChannels(id)) tracks.add(track);
  }
  return [...tracks];
}

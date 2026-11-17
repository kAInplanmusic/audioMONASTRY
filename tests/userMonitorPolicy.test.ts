import { expect, it } from 'vitest';
import { ownActiveMonitorTracks } from '../src/core/audio/userMonitorPolicy';
import { pluginAudioChannels } from '../src/core/audio/pluginChannelMap';
import { planMonitorRouting } from '../src/core/audio/monitorRouting';
it('includes all own active source plugins, excludes foreign/off and handles own delegated source', () => {
  const tracks = ownActiveMonitorTracks('me', { song: 'PRO', drop: 'AUTO_AI', voice: 'PRO', sound: 'OFF', master: 'PRO' }, {
    song: { active: true, lockedBy: 'me' }, voice: { active: true, lockedBy: 'other' },
    sound: { active: true, lockedBy: 'me' }, master: { active: true, lockedBy: 'me' },
  }, id => id === 'drop');
  expect(new Set(tracks)).toEqual(new Set([...pluginAudioChannels('song'), ...pluginAudioChannels('drop')]));
});
it('empty own source set stays silent in own-only mode, never falls back to foreign/all channels', () => {
  const plan = planMonitorRouting({ source: 'PLUGIN', mon: 'MON2', tracks: [], baseMix: {} });
  expect(plan.mainMonitorGain).toBe(0); expect(Object.values(plan.cueTracks).every(gain => gain === 0)).toBe(true);
});
it('multi-source MIX routes all selected channels plus Main; each of four users stays independent', () => {
  const a = planMonitorRouting({ source: 'MIX', mon: 'MON2', tracks: ['channel2', 'channel5'], baseMix: {} });
  const b = planMonitorRouting({ source: 'PLUGIN', mon: 'MON3', tracks: ['channel3'], baseMix: {} });
  expect(a.mainMonitorGain).toBe(1); expect(a.cueGain).toBe(1);
  expect(a.cueTracks.channel2).toBe(1); expect(a.cueTracks.channel5).toBe(1); expect(a.cueTracks.channel3).toBe(0);
  expect(b.mainMonitorGain).toBe(0); expect(b.cueTracks.channel3).toBe(1); expect(b.cueTracks.channel2).toBe(0);
});

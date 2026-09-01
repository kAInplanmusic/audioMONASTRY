// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  clearSpatialAssignments,
  isSpatialChannelFree,
  isTrackFree,
  mergeClipboardAdd,
  mergeClipboardRemove,
  mergeSpatialClaim,
  mergeSpatialRelease,
  mergeTrackClaim,
  mergeTrackRelease,
  spatialChannelTrack,
  type ProjectClipboardEntry,
  type SpatialChannelAssignment,
  type TrackAssignment,
} from '../src/core/session/projectState';
import {
  canPreview,
  clipboardEntryToContent,
  hasAudioUrl,
  isStreamContent,
  masterStreamContent,
  mixerChannelContent,
  musicToContent,
  sampleToContent,
  toPluginSample,
} from '../src/core/audio/audioContent';
import type { AudioSample } from '../src/data/samples';

const sample: AudioSample = {
  id: 'kick-1',
  name: 'Kick One',
  category: 'bass',
  type: 'Kick',
  url: 'blob:kick',
  description: '',
  parameters: {},
};

function entry(id: string, revision: number, name = id, addedBy = 'user-a'): ProjectClipboardEntry {
  return {
    id,
    name,
    kind: 'sample',
    source: 'test',
    url: `blob:${id}`,
    addedBy,
    addedAt: revision,
    revision,
  };
}

describe('projectState · Project Clipboard', () => {
  it('fügt Einträge ein und ersetzt nur bei neuerer Revision', () => {
    const a = entry('s1', 100);
    const b = entry('s1', 200);
    const list1 = mergeClipboardAdd([], a);
    expect(list1).toHaveLength(1);
    const list2 = mergeClipboardAdd(list1, b);
    expect(list2[0].revision).toBe(200);
    const list3 = mergeClipboardAdd(list2, a);
    expect(list3[0].revision).toBe(200);
  });

  it('entfernt Einträge idempotent', () => {
    const list = mergeClipboardAdd([], entry('s1', 1));
    expect(mergeClipboardRemove(list, 's1')).toHaveLength(0);
    expect(mergeClipboardRemove(list, 'missing')).toHaveLength(1);
  });
});

describe('projectState · Track-Belegung', () => {
  const claim = (track: string, revision: number, name = 'A', by = 'user-a'): TrackAssignment => ({
    track: track as TrackAssignment['track'],
    name,
    kind: 'sample',
    url: 'blob:x',
    assignedBy: by,
    assignedAt: revision,
    revision,
  });

  it('freie Tracks sind belegt, wenn ein Claim existiert', () => {
    expect(isTrackFree({}, 'channel1')).toBe(true);
    const { map } = mergeTrackClaim({}, claim('channel1', 1));
    expect(isTrackFree(map, 'channel1')).toBe(false);
    expect(isTrackFree(map, 'channel2')).toBe(true);
  });

  it('neuerer Claim gewinnt, älterer wird verworfen', () => {
    const first = mergeTrackClaim({}, claim('channel1', 10, 'A', 'user-a'));
    const second = mergeTrackClaim(first.map, claim('channel1', 20, 'B', 'user-b'));
    expect(second.applied).toBe(true);
    expect(second.map.channel1?.name).toBe('B');
    const older = mergeTrackClaim(second.map, claim('channel1', 15, 'C', 'user-c'));
    expect(older.applied).toBe(false);
    expect(older.map.channel1?.name).toBe('B');
  });

  it('gleichzeitiger Claim wird nicht still überschrieben (Konflikt)', () => {
    const first = mergeTrackClaim({}, claim('channel1', 10, 'A', 'user-a'));
    const same = mergeTrackClaim(first.map, claim('channel1', 10, 'B', 'user-b'));
    expect(same.applied).toBe(false);
    expect(same.conflict).toBe(true);
    expect(same.map.channel1?.name).toBe('A');
  });

  it('Release gibt den Track frei', () => {
    const { map } = mergeTrackClaim({}, claim('channel1', 1));
    expect(isTrackFree(mergeTrackRelease(map, 'channel1'), 'channel1')).toBe(true);
  });
});

describe('projectState · Spatial-Belegung', () => {
  const claim = (channelId: number, revision: number, name = 'A', by = 'user-a'): SpatialChannelAssignment => ({
    channelId,
    name,
    kind: 'master-stream',
    streamId: 'master',
    assignedBy: by,
    assignedAt: revision,
    revision,
  });

  it('mappt Kanalnummern auf Track-Typen und spiegelt Claims', () => {
    expect(spatialChannelTrack(1)).toBe('channel1');
    expect(spatialChannelTrack(8)).toBe('channel8');
    const { map } = mergeSpatialClaim({}, claim(2, 1));
    expect(isSpatialChannelFree(map, 2)).toBe(false);
    expect(isSpatialChannelFree(map, 3)).toBe(true);
  });

  it('Release und Reset geben Kanäle frei', () => {
    const { map } = mergeSpatialClaim({}, claim(1, 1));
    expect(isSpatialChannelFree(mergeSpatialRelease(map, 1), 1)).toBe(true);
    expect(clearSpatialAssignments()).toEqual({});
  });
});

describe('audioContent · Normalisierung', () => {
  it('referenziert Samples statt sie zu kopieren', () => {
    const content = sampleToContent(sample, 'library');
    expect(content.sample).toBe(sample);
    expect(content.kind).toBe('sample');
    expect(content.url).toBe(sample.url);
  });

  it('erkennt Streams und erzeugt Master-/Mixer-Streams', () => {
    expect(isStreamContent(masterStreamContent())).toBe(true);
    expect(isStreamContent(mixerChannelContent('channel3'))).toBe(true);
    expect(mixerChannelContent('channel3').id).toBe('mixer-channel3');
  });

  it('normalisiert Musik-Tracks und Clipboard-Einträge', () => {
    const music = musicToContent({ id: 'm1', name: 'Track', artist: 'Artist', url: 'blob:m1' });
    expect(music.kind).toBe('music');
    expect(hasAudioUrl(music)).toBe(true);
    const copy = clipboardEntryToContent(music);
    expect(copy.source).toBe('clipboard');
    expect(copy.url).toBe('blob:m1');
  });

  it('erzeugt Plugin-Samples als leichte Hülle ohne Daten-Duplikat', () => {
    const music = musicToContent({ id: 'm1', name: 'Track', artist: 'Artist', url: 'blob:m1' });
    const pluginSample = toPluginSample(music);
    expect(pluginSample.url).toBe('blob:m1');
    expect(pluginSample.name).toBe('Track · Artist');
  });

  it('Preview nur bei URL oder Synthese-Parametern', () => {
    expect(canPreview(sampleToContent(sample))).toBe(true);
    expect(canPreview(masterStreamContent())).toBe(false);
    expect(canPreview(sampleToContent({ ...sample, url: undefined, parameters: { frequency: 60 } }))).toBe(true);
  });
});

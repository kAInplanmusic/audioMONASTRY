// ============================================================================
// audioMONASTRY · Audio-Content-Normalisierung für die Action-Menu-Interaktion
// ----------------------------------------------------------------------------
// Wandelt bestehende Datenstrukturen (AudioSample, MusicTrack, Live-Streams)
// in die einheitliche `AudioContentRef`-Beschreibung um. Bewusst schlank:
// Es werden ausschließlich vorhandene Objekte referenziert – keine Kopien,
// keine neuen Audio-Daten.
// ============================================================================

import type { AudioSample } from '../../data/samples';
import type { MusicTrack } from '../../data/musicLibrary';
import type { TrackType } from '../../types';
import type { AudioContentRef } from '../session/projectState';

export function sampleToContent(sample: AudioSample, source = 'library'): AudioContentRef {
  return {
    id: sample.id,
    name: sample.name,
    kind: sample.type === 'Stem' ? 'stem' : 'sample',
    source,
    sample,
    url: sample.url,
    params: sample.parameters,
  };
}

export function musicToContent(track: MusicTrack, source = 'music-library'): AudioContentRef {
  return {
    id: track.id,
    name: `${track.name} · ${track.artist}`,
    kind: 'music',
    source,
    url: track.url,
    params: undefined,
  };
}

export function streamToContent(
  id: string,
  name: string,
  kind: 'stream' | 'master-stream' | 'mixer-channel',
  source: string,
): AudioContentRef {
  return {
    id,
    name,
    kind,
    source,
    streamId: id,
  };
}

export function masterStreamContent(): AudioContentRef {
  return streamToContent('master-stream', 'Master-Player-Stream', 'master-stream', 'masterplayer');
}

export function mixerChannelContent(track: TrackType): AudioContentRef {
  return streamToContent(
    `mixer-${track}`,
    `MixerMONK ${track.toUpperCase().replace('CHANNEL', 'K')}`,
    'mixer-channel',
    'mixer',
  );
}

export function clipboardEntryToContent(
  entry: AudioContentRef,
  source = 'clipboard',
): AudioContentRef {
  return { ...entry, source };
}

/**
 * Liefert ein AudioSample-Objekt für Plugin-Übernahmen (sampler/drum). Bei
 * Music-/Stream-Inhalten wird eine schlanke Sample-Hülle aus der URL erzeugt;
 * die eigentliche Audioquelle bleibt die vorhandene URL/Referenz.
 */
export function toPluginSample(content: AudioContentRef): AudioSample {
  if (content.sample) return content.sample;
  return {
    id: content.id,
    name: content.name,
    category: content.kind === 'stem' ? 'mids' : 'mids',
    type: content.kind === 'music' ? 'Track' : content.kind === 'stem' ? 'Stem' : 'Sample',
    url: content.url,
    description: `Übernahme aus ${content.source}`,
    tags: [content.kind, content.source],
    parameters: content.params ?? {},
  };
}

/** True, wenn der Inhalt eine direkte Audio-URL trägt (z. B. Track/Stem/Upload). */
export function hasAudioUrl(content: AudioContentRef): boolean {
  return typeof content.url === 'string' && content.url.length > 0;
}

/** True, wenn der Inhalt als Live-Stream behandelt werden muss. */
export function isStreamContent(content: AudioContentRef): boolean {
  return (
    content.kind === 'stream' ||
    content.kind === 'master-stream' ||
    content.kind === 'mixer-channel'
  );
}

/** True, wenn eine Hörprobe sinnvoll möglich ist. */
export function canPreview(content: AudioContentRef): boolean {
  return hasAudioUrl(content) || !!content.params;
}

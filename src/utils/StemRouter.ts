// src/utils/StemRouter.ts
import { audioEngine } from './audioEngine';
import { TrackType } from '../types';

/** DCT-115: Zentrale Stem-Taxonomie + Kanal-Mapping (4-Stem Demucs, 5-Stem Fallback). */
export const STEM_CHANNEL_MAP: Record<string, TrackType> = {
  vocals: 'channel5',
  melody: 'channel6',
  highs: 'channel8',
  mids: 'channel8',
  lows: 'channel7',
  drums: 'channel6',
  bass: 'channel7',
  other: 'channel8',
};

/** Unknown Stem → deterministischer Fallback (channel8). */
export const resolveStemChannel = (stemType: string): TrackType =>
  STEM_CHANNEL_MAP[stemType] || 'channel8';

export const routeStemToMixer = (stemType: string, stemUrl: string) => {
  const channel = resolveStemChannel(stemType);
  audioEngine.loadTrackSample(channel, stemUrl);
};

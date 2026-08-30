import { audioEngine } from '../utils/audioEngine';
import type { TrackType } from '../types';

/**
 * Wendet einen gemappten Parameter (target, 0..1) auf die Audio-Engine an.
 *
 * Die Mapping-Engine liefert nur abstrakte Targets (Strings) — erst dieser
 * App-Dispatcher übersetzt sie in konkrete Engine-Aufrufe. Damit bleiben
 * Mappings transportagnostisch und die Audio-Engine UI-frei.
 *
 * Unterstützte Targets:
 * - `mixer.<channel1..8>.<volume|pan>`
 * - `master.volume`
 * - `worklet.<param>` (generische Worklet-Parameter)
 */
export function applyMappedParameter(target: string, value01: number): boolean {
  if (!Number.isFinite(value01)) return false;
  const v = Math.max(0, Math.min(1, value01));

  const mixer = /^mixer\.(channel[1-8])\.(volume|pan)$/.exec(target);
  if (mixer) {
    const track = mixer[1] as TrackType;
    if (mixer[2] === 'volume') audioEngine.setChannelGain(track, v);
    else audioEngine.setChannelPan(track, Math.max(-1, Math.min(1, v * 2 - 1)));
    return true;
  }

  if (target === 'master.volume') {
    audioEngine.setMasterVolume(v);
    return true;
  }

  if (target.startsWith('worklet.')) {
    const param = target.slice('worklet.'.length);
    if (param) audioEngine.setWorkletParam(param, v);
    return true;
  }

  return false;
}

/** Listet die vom Dispatcher unterstützten Ziel-Pattern (für UI-Hinweise). */
export const SUPPORTED_MAPPING_TARGETS: { pattern: string; description: string }[] = [
  { pattern: 'mixer.channel1.volume', description: 'Kanal-Lautstärke (channel1..channel8)' },
  { pattern: 'mixer.channel1.pan', description: 'Kanal-Pan (channel1..channel8)' },
  { pattern: 'master.volume', description: 'Master-Lautstärke' },
  { pattern: 'worklet.cc_21', description: 'Generischer Worklet-Parameter' },
];

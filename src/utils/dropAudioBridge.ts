/**
 * dropMONK – Audio-Engine-Verdrahtung (App-Schicht)
 * =================================================
 * Baut den DropAudioAdapter aus der audioEngine und speist die ClockBridge
 * aus dem Step-Listener. Der Core (src/core/drop) bleibt dadurch frei von
 * Engine-/Plattform-Abhängigkeiten (Interface-Boundary-Regel 1.1).
 */

import { audioEngine } from './audioEngine';
import type { TrackType } from '../types';
import { setDropAudioAdapter, clockBridge } from '../core/drop';
import type { DropAudioAdapter, DropMixerChannelSnapshot } from '../core/drop';

/** dropMONK adressiert die 8 Mixer-Kanäle der Engine. */
const CHANNELS: TrackType[] = [
  'channel1', 'channel2', 'channel3', 'channel4',
  'channel5', 'channel6', 'channel7', 'channel8',
];

const isChannel = (id: string): id is TrackType => (CHANNELS as string[]).includes(id);

const clamp = (v: number, min: number, max: number): number =>
  Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;

/** Level vor dem Mute, damit Unmute den Fader zurückholt. */
const preMuteLevels = new Map<string, number>();
const mutedChannels = new Set<string>();

/**
 * Parameter-Writes auf die realen Engine-Automationen abbilden.
 * `value` ist auf den Spec-Bereich skaliert (meist 0..1).
 */
function writePluginParameter(pluginId: string, parameterId: string, value: number): void {
  const v = clamp(value, -1, 1);

  switch (`${pluginId}:${parameterId}`) {
    case 'synthesizer:cutoff':
      audioEngine.automateItSynthParam('cutoff', v);
      audioEngine.setDspParam({ filterCutoff: v });
      return;
    case 'synthesizer:resonance':
      audioEngine.automateItSynthParam('resonance', v);
      return;
    case 'effect:mix':
      audioEngine.automateEffect('wet', clamp(v, 0, 1));
      return;
    case 'effect:size':
      audioEngine.automateEffect('depth', clamp(v, 0, 1));
      return;
    case 'effect:feedback':
      audioEngine.automateEffect('feedback', clamp(v, 0, 1));
      return;
    case 'effect:cutoff':
      audioEngine.automateDsp('depth', clamp(v, 0, 1));
      return;
    case 'drum:drive':
      audioEngine.automateDsp('drive', clamp(v, 0, 1));
      return;
    case 'drum:density':
      // Dichte wirkt als Pegel der Percussion-Kanäle (kein Pattern-Rewrite im Drop).
      audioEngine.setChannelGain('channel2', clamp(v, 0, 1));
      return;
    case 'drum:cymbal_level':
      audioEngine.setChannelGain('channel2', clamp(v, 0, 1));
      return;
    case 'drum:pan':
      audioEngine.setChannelPan('channel1', clamp(v, -1, 1));
      return;
    case 'mixer:bass_gain':
      audioEngine.setChannelGain('channel7', clamp(v, 0, 1));
      return;
    case 'mastering:makeup':
      audioEngine.automateMastering('makeup', clamp(v, 0, 1));
      return;
    case 'dsp:drive':
      audioEngine.automateDsp('drive', clamp(v, 0, 1));
      return;
    case 'dsp:resonance':
      audioEngine.automateDsp('resonance', clamp(v, 0, 1));
      return;
    case 'dsp:depth':
      audioEngine.automateDsp('depth', clamp(v, 0, 1));
      return;
    default:
      // Unbekannte Parameter werden bewusst ignoriert (kein Blindschreiben).
      return;
  }
}

/** Adapter-Implementierung auf Basis der audioEngine. */
export const audioEngineDropAdapter: DropAudioAdapter = {
  getChannels(): DropMixerChannelSnapshot[] {
    const info = audioEngine.getChannelStripInfo();
    return CHANNELS.map((id, index) => ({
      id,
      label: info[index]?.name ?? id.toUpperCase(),
      level: clamp(audioEngine.getChannelGain(id), 0, 1),
      pan: clamp(audioEngine.getChannelPan(id), -1, 1),
      muted: mutedChannels.has(id),
      soloed: false,
    }));
  },

  setChannelLevel(channelId: string, level: number): void {
    if (!isChannel(channelId)) return;
    audioEngine.setChannelGain(channelId, clamp(level, 0, 1));
  },

  setChannelPan(channelId: string, pan: number): void {
    if (!isChannel(channelId)) return;
    audioEngine.setChannelPan(channelId, clamp(pan, -1, 1));
  },

  setChannelMute(channelId: string, muted: boolean): void {
    if (!isChannel(channelId)) return;
    if (muted) {
      preMuteLevels.set(channelId, audioEngine.getChannelGain(channelId));
      mutedChannels.add(channelId);
      audioEngine.setChannelGain(channelId, 0);
    } else {
      mutedChannels.delete(channelId);
      audioEngine.setChannelGain(channelId, preMuteLevels.get(channelId) ?? 0.8);
    }
  },

  setPluginParameter(pluginId: string, parameterId: string, value: number): void {
    writePluginParameter(pluginId, parameterId, value);
  },

  getBpm(): number {
    return audioEngine.getBpm();
  },

  getActivePluginIds(): string[] {
    return audioEngine.getActivePluginIds();
  },
};

let detachStepListener: (() => void) | null = null;

/**
 * dropMONK an die Engine hängen: Adapter registrieren + Clock speisen.
 * Rückgabe: Detach-Funktion (Plugin OFF / Unmount).
 */
export function attachDropBridges(): () => void {
  setDropAudioAdapter(audioEngineDropAdapter);

  const sampleRate = audioEngine.getAudioHealth().sampleRate || 48000;
  clockBridge.initialize(audioEngine.getBpm(), sampleRate);

  // Step-Listener = 16tel-Raster. Aus dem Step-Index wird ein monoton
  // steigender Sample-Zähler abgeleitet (Basis für taktgenaue Drops).
  let lastStep = -1;
  let stepCounter = 0;

  detachStepListener?.();
  detachStepListener = audioEngine.addStepListener((step: number) => {
    if (lastStep >= 0) {
      // Wrap-around berücksichtigen (16 oder 32 Steps pro Pattern).
      stepCounter += step > lastStep ? step - lastStep : 1;
    }
    lastStep = step;

    const bpm = audioEngine.getBpm();
    clockBridge.setBpm(bpm);
    const samplesPerStep = (sampleRate * 60) / bpm / 4; // 16tel
    clockBridge.updateClock(Math.round(stepCounter * samplesPerStep), audioEngine.getIsPlaying());
  });

  return () => {
    detachStepListener?.();
    detachStepListener = null;
    clockBridge.reset();
    setDropAudioAdapter(null);
  };
}

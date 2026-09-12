/**
 * audioMONASTRY · V2-Sync-Spiegel (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * ==========================================================================
 * Spiegelt den Engine-Zustand in den V2-Graph + V2-Live-Sink (Mixer, Patterns,
 * rollenbasierte Synth-Stimmen). Bewusst ohne Engine-Zustand: die Fassade
 * bekommt den Schnappschuss bzw. die Senken hereingereicht und ist damit
 * isoliert testbar. `audioEngine` delegiert nur noch.
 */
import { V2_CHANNELS, type V2Channel, type V2StudioGraph } from '../core/audio/V2StudioGraph';
import type { V2LiveSink } from '../core/audio/backends/V2LiveSink';
import type { V2SynthVoice } from '../core/audio/live/V2SinkEngine';
import type { MonitorRoutingPlan } from '../core/audio/monitorRouting';
import { TRACK_ROLE_MAP, type TrackType } from '../types';

export interface V2ChannelMix {
  gainDb: number;
  pan: number;
  muted: boolean;
}

export interface V2MixMirrorInput {
  channels: Readonly<Record<string, V2ChannelMix>>;
  /** Linearer Master-Gain (nicht dB). */
  masterGainLinear: number;
  monitorPlan: MonitorRoutingPlan;
}

/** Rollen-Hörprofil eines Kanals – dieselbe Zuordnung wie im V2-Sink-Default. */
export function roleVoiceFor(channel: TrackType): { freq: number; voice: V2SynthVoice } {
  const role = TRACK_ROLE_MAP[channel];
  const voice: V2SynthVoice = role === 'kick' ? 'kick'
    : role === 'hat' ? 'hat'
    : role === 'clap' ? 'clap'
    : role === 'bass' ? 'bass'
    : 'lead';
  const freq = role === 'kick' ? 50
    : role === 'hat' ? 6000
    : role === 'clap' ? 1200
    : role === 'bass' ? 55
    : channel === 'channel8' ? 880
    : 440;
  return { freq, voice };
}

/** Mixer-Zustand (Gain/Pan/Mute) + Master + Monitor-Plan in V2-Graph und Live-Sink. */
export function syncV2Mix(studio: V2StudioGraph, sink: V2LiveSink, input: V2MixMirrorInput): void {
  for (const channel of V2_CHANNELS) {
    const mix = input.channels[channel];
    const db = mix?.gainDb ?? 0;
    const pan = mix?.pan ?? 0;
    studio.setGainDb(channel, db);
    studio.setPan(channel, pan);
    sink.setChannelGainDb(channel, db);
    sink.setChannelPan(channel, pan);
  }
  studio.setMasterGain(input.masterGainLinear);
  sink.setMasterGain(input.masterGainLinear);
  // Phase 4: Monitor-/Cue-Plan in den V2-Live-Sink spiegeln.
  sink.setMonitorRouting(input.monitorPlan);
  // AUDIO-P0-001: Mute-Zustand in den V2-Live-Sink spiegeln.
  for (const channel of V2_CHANNELS) {
    sink.setChannelMuted(channel, Boolean(input.channels[channel]?.muted));
  }
}

/** Alle Step-Patterns in den V2-Live-Sink spiegeln (Phase 2). */
export function syncV2Patterns(sink: V2LiveSink, patterns: Readonly<Record<string, boolean[] | undefined>>): void {
  for (const channel of V2_CHANNELS) {
    sink.setPattern(channel as V2Channel, patterns[channel] ?? []);
  }
}

/**
 * AUDIO-P0-001: Rollenbasierte Synth-Stimmen (kick/hat/clap/bass/lead) an den
 * V2-Sink übertragen, damit Pattern-Steps ohne Sample die richtige Stimme spielen.
 * Optionale Overrides erlauben der Engine, gesetzte Optional-Quellen zu erhalten.
 */
export function syncV2Voices(
  sink: V2LiveSink,
  overrides?: Readonly<Partial<Record<string, { freq: number; voice: V2SynthVoice }>>>,
): void {
  for (const channel of V2_CHANNELS) {
    const preset = overrides?.[channel] ?? roleVoiceFor(channel as TrackType);
    sink.setSynthSource(channel as V2Channel, preset.freq, preset.voice);
  }
}

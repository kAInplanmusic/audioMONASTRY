import { describe, expect, it, vi } from 'vitest';
import { roleVoiceFor, syncV2Mix, syncV2Patterns, syncV2Voices } from '../src/audio/v2SyncMirror';
import { V2_CHANNELS, type V2StudioGraph } from '../src/core/audio/V2StudioGraph';
import type { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Der V2-Sync-Spiegel. Geprüft wird, dass alle Kanäle/Master/
// Monitor/Mute/Patterns/Stimmen korrekt an Studio + Live-Sink gehen.
// ---------------------------------------------------------------------------

function fakeStudio() {
  return { setGainDb: vi.fn(), setPan: vi.fn(), setMasterGain: vi.fn() } as unknown as V2StudioGraph;
}
function fakeSink() {
  return {
    setChannelGainDb: vi.fn(), setChannelPan: vi.fn(), setChannelMuted: vi.fn(),
    setMasterGain: vi.fn(), setMonitorRouting: vi.fn(),
    setPattern: vi.fn(), setSynthSource: vi.fn(),
  } as unknown as V2LiveSink;
}

describe('roleVoiceFor', () => {
  it('bildet die Rollen auf die V2-Stimmen ab', () => {
    expect(roleVoiceFor('channel1')).toEqual({ freq: 50, voice: 'kick' });
    expect(roleVoiceFor('channel2')).toEqual({ freq: 6000, voice: 'hat' });
    expect(roleVoiceFor('channel3')).toEqual({ freq: 1200, voice: 'clap' });
    expect(roleVoiceFor('channel7')).toEqual({ freq: 55, voice: 'bass' });
    expect(roleVoiceFor('channel8')).toEqual({ freq: 880, voice: 'lead' });
    expect(roleVoiceFor('channel10')).toEqual({ freq: 440, voice: 'lead' });
  });
});

describe('syncV2Mix', () => {
  it('spiegelt Gain/Pan/Mute je Kanal plus Master und Monitor-Plan', () => {
    const studio = fakeStudio();
    const sink = fakeSink();
    const channels: Record<string, { gainDb: number; pan: number; muted: boolean }> = {};
    for (const t of V2_CHANNELS) channels[t] = { gainDb: -6, pan: 0.25, muted: t === 'channel4' };
    const monitorPlan = { mon: 'MON1' } as never;
    syncV2Mix(studio, sink, { channels, masterGainLinear: 0.5, monitorPlan });

    expect((studio.setGainDb as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(V2_CHANNELS.length);
    expect(sink.setChannelGainDb).toHaveBeenCalledWith('channel4', -6);
    expect(sink.setChannelPan).toHaveBeenCalledWith('channel4', 0.25);
    expect(sink.setChannelMuted).toHaveBeenCalledWith('channel4', true);
    expect(sink.setChannelMuted).toHaveBeenCalledWith('channel2', false);
    expect(studio.setMasterGain).toHaveBeenCalledWith(0.5);
    expect(sink.setMasterGain).toHaveBeenCalledWith(0.5);
    expect(sink.setMonitorRouting).toHaveBeenCalledWith(monitorPlan);
  });

  it('nutzt neutrale Defaults, wenn ein Kanal fehlt', () => {
    const studio = fakeStudio();
    const sink = fakeSink();
    syncV2Mix(studio, sink, { channels: {}, masterGainLinear: 1, monitorPlan: {} as never });
    expect(sink.setChannelGainDb).toHaveBeenCalledWith('channel1', 0);
    expect(sink.setChannelPan).toHaveBeenCalledWith('channel1', 0);
    expect(sink.setChannelMuted).toHaveBeenCalledWith('channel1', false);
  });
});

describe('syncV2Patterns', () => {
  it('setzt jedes Kanal-Pattern (fehlend → leeres Muster)', () => {
    const sink = fakeSink();
    const pattern = Array.from({ length: 16 }, (_, i) => i % 2 === 0);
    syncV2Patterns(sink, { channel1: pattern });
    expect(sink.setPattern).toHaveBeenCalledWith('channel1', pattern);
    expect(sink.setPattern).toHaveBeenCalledWith('channel5', []);
    expect((sink.setPattern as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(V2_CHANNELS.length);
  });
});

describe('syncV2Voices', () => {
  it('setzt alle Kanäle auf ihre Rollen-Stimme und respektiert Overrides', () => {
    const sink = fakeSink();
    syncV2Voices(sink, { channel5: { freq: 330, voice: 'phase' } });
    expect(sink.setSynthSource).toHaveBeenCalledWith('channel1', 50, 'kick');
    expect(sink.setSynthSource).toHaveBeenCalledWith('channel5', 330, 'phase');
    expect((sink.setSynthSource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(V2_CHANNELS.length);
  });
});

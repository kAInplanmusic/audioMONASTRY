// @vitest-environment jsdom
/**
 * P0-6-Prüfpunkt (Main-/Monitor-Routing & Mehrbenutzer-Fix)
 * =========================================================
 * Automatisierte 4-User-Abnahme des Szenarios aus `MASTER_TODO.md`:
 *
 *   „User2 aktiviert Drum → auf MAIN hörbar; User3 wählt PLUGIN-Cue → hört nur
 *    sein Plugin, MAIN bleibt unverändert; zurück auf MAIN → sofort Gesamtmix."
 *
 * Jeder der bis zu 4 User hat im Browser einen eigenen AudioContext, also auch
 * einen eigenen Abhörweg. Die Abhör-Policy ist deshalb als reine Funktion
 * (`core/audio/monitorRouting`) modelliert und wird hier für alle 4 User
 * gleichzeitig geprüft. Zusätzlich wird an der echten `audioEngine` verifiziert,
 * dass der Cue-Wechsel den MAIN-Bus (Kanal-/Master-Pegel, Mastering-Kette)
 * nachweislich NICHT verändert.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('tone', () => {
  class MockNode {
    volume = { value: 0, rampTo: () => {} };
    pan = { value: 0 };
    frequency = { value: 440 };
    gain = { value: 0, rampTo: () => {} };
    Q = { value: 0 };
    connect() { return this; }
    disconnect() { return this; }
    chain() { return this; }
    start() { return this; }
    stop() { return this; }
    dispose() { return this; }
    set() { return this; }
    triggerAttackRelease() {}
    toDestination() { return this; }
  }
  return {
    Volume: MockNode, Gain: MockNode, Filter: MockNode, Oscillator: MockNode,
    Analyser: MockNode, Player: MockNode, Noise: MockNode, AmplitudeEnvelope: MockNode,
    MembraneSynth: MockNode, MetalSynth: MockNode, NoiseSynth: MockNode,
    MonoSynth: MockNode, Synth: MockNode, Panner: MockNode, FeedbackDelay: MockNode,
    Delay: MockNode, Compressor: MockNode, MultibandCompressor: MockNode, Limiter: MockNode,
    Frequency: vi.fn(() => ({ toFrequency: () => 440 })),
    Transport: {
      bpm: { value: 120 }, start: vi.fn(), stop: vi.fn(),
      scheduleRepeat: vi.fn(), cancel: vi.fn(), position: '0:0:0',
    },
    context: { currentTime: 0, destination: {} },
    start: vi.fn(async () => {}),
  };
});

import { ALL_TRACKS, type TrackType } from '../src/types';
import {
  MONITOR_USERS, defaultMonitorPlan, planMonitorRouting,
  type MonitorRoutingPlan, type MonitorUser,
} from '../src/core/audio/monitorRouting';
import { getPluginRoute } from '../src/core/pluginAudioRouter';
import { audioEngine, pluginAudioChannels } from '../src/utils/audioEngine';

/** Voller Cue-Mix (Rollen-Matrix) eines Users – hier neutral 1.0 je Kanal. */
const fullMix = (): Record<TrackType, number> =>
  Object.fromEntries(ALL_TRACKS.map((t) => [t, 1])) as Record<TrackType, number>;

/** Simuliert die 4 Session-User mit je eigenem Abhörweg (eigener Browser). */
function makeSession(): Record<MonitorUser, MonitorRoutingPlan> {
  return Object.fromEntries(
    MONITOR_USERS.map((mon) => [mon, defaultMonitorPlan(mon)]),
  ) as Record<MonitorUser, MonitorRoutingPlan>;
}

describe('P0-6 · Main-/Monitor-Routing (4-User-Prüfpunkt)', () => {
  const drumChannel = pluginAudioChannels('drum')[0];

  it('User2 aktiviert Drum → Drum speist MAIN, alle 4 User hören den Gesamtmix', () => {
    const route = getPluginRoute('drum');
    expect(route?.mainFeeder).toBe(true);
    expect(route?.channels).toContain(drumChannel);

    // Start-Zustand: alle 4 User hören MAIN, kein Cue aktiv.
    const session = makeSession();
    for (const mon of MONITOR_USERS) {
      expect(session[mon].source).toBe('MAIN');
      expect(session[mon].mainMonitorGain).toBe(1);
      expect(session[mon].cueGain).toBe(0);
    }
  });

  it('User3 wählt PLUGIN-Cue → hört nur sein Plugin, MAIN der anderen bleibt unverändert', () => {
    const session = makeSession();
    const before = structuredClone(session);

    session.MON3 = planMonitorRouting({
      source: 'PLUGIN', mon: 'MON3', track: drumChannel, baseMix: fullMix(),
    });

    // User3 hört ausschließlich seinen Plugin-Kanal.
    expect(session.MON3.soloTrack).toBe(drumChannel);
    expect(session.MON3.cueGain).toBeGreaterThan(0);
    expect(session.MON3.cueTracks[drumChannel]).toBeGreaterThan(0);
    for (const t of ALL_TRACKS.filter((t) => t !== drumChannel)) {
      expect(session.MON3.cueTracks[t]).toBe(0);
    }
    // MAIN wird nicht abgeschaltet, sondern nur lokal nicht abgehört.
    expect(session.MON3.mainMonitorGain).toBe(0);

    // Die übrigen 3 User bleiben unverändert auf MAIN (kein State-Desync).
    for (const mon of ['MON1', 'MON2', 'MON4'] as MonitorUser[]) {
      expect(session[mon]).toEqual(before[mon]);
      expect(session[mon].mainMonitorGain).toBe(1);
      expect(session[mon].cueGain).toBe(0);
    }
  });

  it('MIX-Modus blendet MAIN + eigenes Plugin (Main-Monitor bleibt an)', () => {
    const base = fullMix();
    const mix = planMonitorRouting({ source: 'MIX', mon: 'MON1', track: 'channel3', baseMix: base });
    expect(mix.mainMonitorGain).toBe(1);      // MAIN bleibt hörbar
    expect(mix.cueGain).toBeGreaterThan(0);   // Plugin-Kanal wird dazugemischt
    expect(mix.soloTrack).toBe('channel3');
    expect(mix.cueTracks.channel3).toBeGreaterThan(0);
    expect(mix.cueTracks.channel1).toBe(0);   // nur der eigene Kanal im Cue
  });

  it('zurück auf MAIN → sofort wieder Gesamtmix (kein Rest-Solo)', () => {
    const base = fullMix();
    const cue = planMonitorRouting({ source: 'PLUGIN', mon: 'MON3', track: drumChannel, baseMix: base });
    expect(cue.cueTracks.channel1).toBe(0);

    const back = planMonitorRouting({ source: 'MAIN', mon: 'MON3', baseMix: base });
    expect(back.mainMonitorGain).toBe(1);
    expect(back.cueGain).toBe(0);
    expect(back.soloTrack).toBeNull();
    expect(back.cueTracks).toEqual(base);
  });

  it('Rollen-Cue-Mix (MON) bleibt beim Solo erhalten und kehrt vollständig zurück', () => {
    const base = { ...fullMix(), channel2: 0.5, channel6: 1.2 };
    const solo = planMonitorRouting({ source: 'PLUGIN', mon: 'MON2', track: 'channel2', baseMix: base });
    expect(solo.cueTracks.channel2).toBe(0.5);
    expect(solo.cueTracks.channel6).toBe(0);

    const own = planMonitorRouting({ source: 'MON', mon: 'MON2', baseMix: base });
    expect(own.cueTracks.channel2).toBe(0.5);
    expect(own.cueTracks.channel6).toBe(1.2);
    expect(own.mainMonitorGain).toBe(0);
    expect(own.cueGain).toBe(1);
  });

  it('Cue-Solo eines stumm gezogenen Kanals bleibt hörbar; Pegel/NaN werden geklemmt', () => {
    const base = { ...fullMix(), channel4: 0 };
    const solo = planMonitorRouting({ source: 'PLUGIN', mon: 'MON1', track: 'channel4', baseMix: base });
    expect(solo.cueTracks.channel4).toBe(1);

    const clamped = planMonitorRouting({
      source: 'MON', mon: 'MON1', baseMix: { channel1: Number.NaN, channel2: 99 }, cueLevel: Number.NaN,
    });
    expect(clamped.cueTracks.channel1).toBe(1);
    expect(clamped.cueTracks.channel2).toBe(2);
    expect(clamped.cueGain).toBe(1);

    // Unbekannter Bus fällt sicher auf MON1 zurück (kein Crash, kein Blind-Routing).
    const fallback = planMonitorRouting({ source: 'MAIN', mon: 'MONX' as MonitorUser, baseMix: {} });
    expect(fallback.mon).toBe('MON1');
  });
});

describe('P0-6 · audioEngine: Cue-Wechsel lässt den MAIN-Bus unangetastet', () => {
  beforeAll(() => {
    audioEngine.setMonitorSource('MAIN', 'MON3');
  });

  /** MAIN-relevanter Zustand ohne den (immer neuen) Zeitstempel. */
  const mainState = () => {
    const { timestamp: _ts, ...rest } = audioEngine.exportGraphState();
    return rest;
  };

  it('PLUGIN-Cue verändert Kanal-/Master-Pegel des MAIN-Busses nicht', () => {
    const before = mainState();
    audioEngine.setMonitorSource('PLUGIN', 'MON3', 'channel2');

    const routing = audioEngine.getMonitorRouting();
    expect(routing.source).toBe('PLUGIN');
    expect(routing.mon).toBe('MON3');
    expect(routing.soloTrack).toBe('channel2');
    expect(routing.mainMonitorGain).toBe(0);
    expect(routing.cueGain).toBeGreaterThan(0);
    expect(routing.cueTracks.channel2).toBeGreaterThan(0);
    expect(routing.cueTracks.channel1).toBe(0);

    // Beweis „MAIN bleibt unverändert": identischer Master-/Kanal-Zustand.
    expect(mainState()).toEqual(before);
  });

  it('zurück auf MAIN stellt den Gesamtmix wieder her', () => {
    audioEngine.setMonitorSource('MAIN', 'MON3');
    const routing = audioEngine.getMonitorRouting();
    expect(audioEngine.getMonitorSource()).toBe('MAIN');
    expect(routing.mainMonitorGain).toBe(1);
    expect(routing.cueGain).toBe(0);
    expect(routing.soloTrack).toBeNull();
    for (const t of ALL_TRACKS) expect(routing.cueTracks[t]).toBeGreaterThan(0);
  });

  it('Rollen-Cue-Matrix überlebt den Solo-Wechsel (kein Clobbering)', () => {
    audioEngine.setMonitorTrackGain('MON2', 'channel2', 0.5);
    audioEngine.setMonitorSource('PLUGIN', 'MON2', 'channel6');
    audioEngine.setMonitorSource('MAIN', 'MON2');
    expect(audioEngine.getMonitorTrackGain('MON2').channel2).toBe(0.5);
    audioEngine.setMonitorSource('MAIN', 'MON1');
  });
});

import { describe, expect, it } from 'vitest';
import { GraphStateBridge } from '../src/core/audio/GraphStateBridge';
import { V2MonitorGraph } from '../src/core/audio/V2MonitorGraph';
import { V2OutputGraph, v2OutputChannelCount } from '../src/core/audio/V2OutputGraph';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import { planMonitorRouting } from '../src/core/audio/monitorRouting';
import {
  pluginAudioChannels, pluginMonitorSoloTrack, pluginSoloCueTracks,
} from '../src/core/audio/pluginChannelMap';
import { emptyAudioGraphState } from '../src/utils/audioGraphSerialization';
import { ALL_TRACKS } from '../src/types';
import type { IProcessingContext } from '../src/core/audio/types';
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';

const CTX: IProcessingContext = {
  sampleRate: 48000,
  bufferSize: 128,
  quantum: 128 / 48000,
  currentTime: 0,
};

/**
 * RT-AUDIT-P0-004: MAIN läuft durch den Mastering-Limiter mit ECHTEM Lookahead
 * (240 Samples @ 48 kHz), der Cue-Weg zum Monitor ist um denselben Betrag
 * kompensiert. Der erste Block nach einem Start/Umschalten ist deshalb noch
 * (teilweise) der alte Zustand – gemessen wird nach SETTLE_BLOCKS Blöcken.
 */
const SETTLE_BLOCKS = Math.ceil(v2MasteringLookaheadSamples(48000) / 128);

function settled<T>(render: () => T): T {
  for (let b = 0; b < SETTLE_BLOCKS; b++) render();
  return render();
}

function tone(freq: number, len = 128, sr = 48000): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function blockRms(block: Float32Array[] | null | undefined): number {
  if (!block) return 0;
  let sum = 0;
  let count = 0;
  for (const channel of block) {
    for (let i = 0; i < channel.length; i++) {
      sum += channel[i] * channel[i];
      count++;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

describe('Phase 4 · GraphStateBridge auf 8 Kanäle', () => {
  it('import/export round-trip erhält channel7/channel8 Gain/Pan', () => {
    const state = emptyAudioGraphState();
    state.channelGainsDb = {
      channel1: 0, channel2: 0, channel3: 0, channel4: 0,
      channel5: 0, channel6: 0, channel7: -7, channel8: 3,
    };
    state.channelPans = {
      channel1: 0, channel2: 0, channel3: 0, channel4: 0,
      channel5: 0, channel6: 0, channel7: -0.75, channel8: 0.5,
    };

    const bridge = new GraphStateBridge();
    bridge.importState(state);
    const exported = bridge.exportState(state);

    expect(bridge.gainNodes.size).toBe(8);
    expect(bridge.panNodes.size).toBe(8);
    expect(exported.channelGainsDb.channel7).toBeCloseTo(-7, 5);
    expect(exported.channelGainsDb.channel8).toBeCloseTo(3, 5);
    expect(exported.channelPans.channel7).toBeCloseTo(-0.75, 5);
    expect(exported.channelPans.channel8).toBeCloseTo(0.5, 5);
    expect(bridge.graph.compile().validated).toBe(true);
  });
});

describe('Phase 4 · pluginChannelMap/Monitor-Routing in V2', () => {
  it('pluginChannelMap kennt die V2-Kanäle nach 8-Kanal-Zuordnung', () => {
    expect(pluginAudioChannels('sound')).toContain('channel7');
    expect(pluginAudioChannels('drop')).toContain('channel1');
    expect(pluginMonitorSoloTrack('drum')).toBe('channel3');
    expect(pluginMonitorSoloTrack('mastergraph')).toBeNull();
  });

  it('pluginSoloCueTracks mappt Plugin-Kanäle auf Cue-Matrix', () => {
    const cue = pluginSoloCueTracks('drum');
    expect(cue.channel3).toBeGreaterThan(0);
    for (const track of ALL_TRACKS.filter((t) => t !== 'channel3')) {
      expect(cue[track]).toBe(0);
    }
  });
});

describe('Phase 4 · V2MonitorGraph – Cue/Main/Monitor als V2-Graph', () => {
  it('baut 8 Kanalzüge + Cue-Bus + Monitor-Mischer ohne Zyklus', () => {
    const graph = new V2MonitorGraph();
    expect(graph.sources.size).toBe(8);
    expect(graph.cueGains.size).toBe(8);
    const plan = graph.graph.compile();
    expect(plan.validated).toBe(true);
  });

  it('MAIN-Default: Monitor-Ausgang entspricht der Main-Summe', () => {
    const graph = new V2MonitorGraph();
    graph.setSourceBuffer('channel1', [tone(440)]);
    graph.setSourceBuffer('channel2', [tone(220)]);
    const result = settled(() => graph.render(CTX));
    expect(result.main).not.toBeNull();
    expect(result.monitor).not.toBeNull();
    expect(blockRms(result.monitor)).toBeGreaterThan(0.01);
    expect(blockRms(result.main)).toBeGreaterThan(0.01);
  });

  it('PLUGIN-Solo hört nur den Cue-Kanal; MAIN bleibt unverändert', () => {
    const graph = new V2MonitorGraph();
    graph.setSourceBuffer('channel1', [tone(440)]);
    const loud = new Float32Array(128);
    loud.fill(0.4);
    graph.setSourceBuffer('channel2', [loud]);
    graph.setGainDb('channel1', 0);
    graph.setGainDb('channel2', -120); // im MAIN stumm – Cue greift pre-fader

    graph.applyMonitorPlan(planMonitorRouting({
      source: 'PLUGIN',
      mon: 'MON1',
      track: 'channel2',
      baseMix: {},
    }));

    const result = settled(() => graph.render(CTX));
    // MAIN enthält beide Kanäle (Kanal2 durch -120 dB praktisch stumm).
    expect(blockRms(result.main)).toBeGreaterThan(0.01);
    // Monitor = Cue-Solo auf channel2, pre-fader: trotz -120 dB hörbar.
    expect(blockRms(result.monitor)).toBeGreaterThan(0.01);
    expect(graph.monitorPlan.source).toBe('PLUGIN');
    expect(graph.monitorPlan.mainMonitorGain).toBe(0);
  });

  it('Cue-Solo auf einem anderen Kanal blendet den Rest aus', () => {
    const graph = new V2MonitorGraph();
    graph.setSourceBuffer('channel1', [tone(440)]);
    graph.setSourceBuffer('channel2', [tone(220)]);
    graph.applyMonitorPlan(planMonitorRouting({
      source: 'PLUGIN',
      mon: 'MON1',
      track: 'channel3',
      baseMix: {},
    }));
    const { monitor, main } = settled(() => graph.render(CTX));
    // MAIN bleibt aktiv; der Monitor-Solo auf channel3 (ohne Quelle) ist stumm.
    expect(blockRms(main)).toBeGreaterThan(0.01);
    expect(blockRms(monitor)).toBe(0);
  });

  it('zurück auf MAIN stellt den vollen Monitor-Ausgang wieder her', () => {
    const graph = new V2MonitorGraph();
    graph.setSourceBuffer('channel1', [tone(440)]);
    graph.applyMonitorPlan(planMonitorRouting({ source: 'MAIN', mon: 'MON1', baseMix: {} }));
    const { monitor } = settled(() => graph.render(CTX));
    expect(blockRms(monitor)).toBeGreaterThan(0.01);
  });
});

describe('Phase 4 · V2SinkEngine übernimmt MonitorRoutingPlan', () => {
  it('Default MAIN liefert hörbaren Testton; MON-Mix mit stummgezogenem Kanal ist still', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setTestTone(true, 440, 0.2);
    expect(blockRms(settled(() => engine.render(CTX)))).toBeGreaterThan(0.01);

    engine.applyMonitorRouting(planMonitorRouting({
      source: 'MON',
      mon: 'MON1',
      baseMix: { channel1: 0 },
    }));
    expect(blockRms(settled(() => engine.render(CTX)))).toBeLessThan(1e-6);

    engine.applyMonitorRouting(planMonitorRouting({
      source: 'PLUGIN',
      mon: 'MON1',
      track: 'channel1',
      baseMix: { channel1: 0 },
    }));
    // Cue-Solo zieht einen stummgezogenen Kanal auf 1 hoch.
    expect(blockRms(settled(() => engine.render(CTX)))).toBeGreaterThan(0.01);
  });

  it('V2SinkEngine gibt bei 2.1-Layout einen 3-Kanal-Block aus', () => {
    const engine = new V2SinkEngine(48000, 128);
    const dc = new Float32Array(128);
    dc.fill(0.5);
    engine.setSampleBuffer('channel1', dc, null, 48000);
    engine.triggerSample('channel1');
    engine.setOutputLayout('2.1');
    // RT-AUDIT-P0-004: der 128-Sample-One-Shot erscheint nach dem Lookahead
    // (Samples 240…367) – geprüft werden alle Blöcke bis dahin.
    let lfe = false;
    for (let b = 0; b <= SETTLE_BLOCKS + 1; b++) {
      const rendered = engine.render(CTX);
      expect(rendered.length).toBe(3);
      if (rendered[2].some((v) => Math.abs(v) > 0.01)) lfe = true;
    }
    expect(lfe).toBe(true);
  });

  it('V2LiveSink liefert ohne Verbindung für Monitor-Routing ein sicheres false', () => {
    const sink = new V2LiveSink();
    const plan = planMonitorRouting({ source: 'MAIN', mon: 'MON1', baseMix: {} });
    expect(sink.setMonitorRouting(plan)).toBe(false);
    expect(sink.setOutputLayout('2.1')).toBe(false);
  });
});

describe('Phase 4 · V2OutputGraph – Spatial-Bus/2.1-Mehrkanal in V2', () => {
  it('kennt Kanalzahlen für Stereo/2.1/4.0', () => {
    expect(v2OutputChannelCount('stereo')).toBe(2);
    expect(v2OutputChannelCount('2.1')).toBe(3);
    expect(v2OutputChannelCount('4.0')).toBe(4);
  });

  it('Stereo-Layout gibt 2 Kanäle durch', () => {
    const out = new V2OutputGraph(48000);
    out.setInputStereo(tone(440), tone(440));
    const rendered = out.render(CTX);
    expect(rendered).not.toBeNull();
    expect(rendered!.length).toBe(2);
    expect(blockRms(rendered)).toBeGreaterThan(0.01);
  });

  it('2.1-Layout erzeugt L/R/LFE (3 Kanäle) und Sub-Pfad mit Energie', () => {
    const out = new V2OutputGraph(48000);
    out.setLayout('2.1');
    const dcL = new Float32Array(128);
    const dcR = new Float32Array(128);
    dcL.fill(0.5);
    dcR.fill(0.5);
    out.setInputStereo(dcL, dcR);
    const rendered = out.render(CTX)!;
    expect(rendered.length).toBe(3);
    expect(rendered[2].some((v) => Math.abs(v) > 0.01)).toBe(true);
  });

  it('Mehrkanal-Layout nutzt konfigurierbare Spatial-Gewichte', () => {
    const out = new V2OutputGraph(48000);
    out.setLayout('4.0');
    out.setSpatialWeights([1, 0, 0, 0]);
    out.setInputStereo(tone(440), tone(440));
    const rendered = out.render(CTX)!;
    expect(rendered.length).toBe(4);
    expect(blockRms([rendered[0]])).toBeGreaterThan(0.01);
    for (let ch = 1; ch < 4; ch++) {
      expect(blockRms([rendered[ch]])).toBeLessThan(1e-6);
    }
  });
});

/**
 * dropMONK – Phase-4-Tests
 * ========================
 * Deckt Kurven-Interpolation, Kontext-Scoring, Clock-Quantisierung,
 * Parameter-/Mixer-Bridges, Drop-Engine-Timing, Preset-Store und den
 * Server-Generator (/api/ai/generate-drop) ab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DROP_PROFILES,
  interpolateValue,
  DropContextAnalyzer,
  ClockBridge,
  MixerBridge,
  PluginParameterBridge,
  DropEngine,
  DropPresetStore,
  setDropAudioAdapter,
  buildDropPrompt,
  sanitizeAiDropResponse,
  generateDeterministicDrop,
  extractJsonBlock,
  barsToMs,
} from '../src/core/drop';
import type { DropAudioAdapter, DropMixerChannelSnapshot, DropProfile } from '../src/core/drop';

/** Test-Adapter: protokolliert alle Writes statt Audio zu erzeugen. */
const createAdapter = () => {
  const channels: DropMixerChannelSnapshot[] = [
    { id: 'channel1', label: 'KICK', level: 0.8, pan: 0, muted: false, soloed: false },
    { id: 'channel2', label: 'HAT', level: 0.4, pan: 0, muted: false, soloed: false },
  ];
  const parameterWrites: Array<{ pluginId: string; parameterId: string; value: number }> = [];

  const adapter: DropAudioAdapter = {
    getChannels: () => channels.map((c) => ({ ...c })),
    setChannelLevel: (id, level) => {
      const ch = channels.find((c) => c.id === id);
      if (ch) ch.level = level;
    },
    setChannelPan: (id, pan) => {
      const ch = channels.find((c) => c.id === id);
      if (ch) ch.pan = pan;
    },
    setChannelMute: (id, muted) => {
      const ch = channels.find((c) => c.id === id);
      if (ch) ch.muted = muted;
    },
    setPluginParameter: (pluginId, parameterId, value) => {
      parameterWrites.push({ pluginId, parameterId, value });
    },
    getBpm: () => 128,
    getActivePluginIds: () => ['synthesizer', 'effect', 'drum'],
  };

  return { adapter, channels, parameterWrites };
};

beforeEach(() => {
  setDropAudioAdapter(null);
});

describe('dropMONK · Kurven-Interpolation', () => {
  it('liefert an den Rändern exakt Start-/Endwert', () => {
    for (const curve of ['linear', 'exponential', 'logarithmic', 's-curve', 'stepped'] as const) {
      expect(interpolateValue(0.2, 0.9, 0, curve)).toBe(0.2);
      expect(interpolateValue(0.2, 0.9, 1, curve)).toBe(0.9);
    }
  });

  it('ist monoton steigend zwischen Start und Ende', () => {
    for (const curve of ['linear', 'exponential', 'logarithmic', 's-curve'] as const) {
      let previous = -Infinity;
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const value = interpolateValue(0, 1, Math.min(1, p), curve);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
      }
    }
  });

  it('exponential startet langsamer, logarithmic schneller als linear', () => {
    const linear = interpolateValue(0, 1, 0.5, 'linear');
    expect(interpolateValue(0, 1, 0.5, 'exponential')).toBeLessThan(linear);
    expect(interpolateValue(0, 1, 0.5, 'logarithmic')).toBeGreaterThan(linear);
  });

  it('stepped quantisiert auf 10 Stufen', () => {
    const value = interpolateValue(0, 1, 0.44, 'stepped');
    expect(Math.round(value * 10)).toBeCloseTo(value * 10, 6);
  });
});

describe('dropMONK · Context Analyzer', () => {
  const analyzer = new DropContextAnalyzer();

  it('leitet Energie aus den Mixer-Kanälen ab', () => {
    const context = analyzer.analyzeCurrentMix(128, ['synthesizer'], [
      { id: 'channel1', level: 0.8, isMuted: false },
      { id: 'channel2', level: 0.4, isMuted: true },
    ]);
    expect(context.currentEnergy).toBeGreaterThan(0);
    expect(context.bpm).toBe(128);
    expect(analyzer.getLastContext()).toEqual(context);
  });

  it('bewertet Profile mit aktiven Plugins höher', () => {
    const context = analyzer.analyzeCurrentMix(128, ['synthesizer', 'effect', 'drum'], [], 0.6);
    const suggestions = analyzer.suggestDropProfiles(context, 5);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].score).toBeGreaterThanOrEqual(suggestions[suggestions.length - 1].score);
    expect(suggestions[0].reasons.length).toBeGreaterThan(0);
  });

  it('schlägt für Transitions passende Profile vor', () => {
    const context = analyzer.analyzeCurrentMix(128, ['mixer'], [], 0.5);
    const transitions = analyzer.suggestTransitionProfiles(0.5, 0.9, context);
    expect(transitions.length).toBeGreaterThan(0);
    expect(['transition', 'breakdown']).toContain(transitions[0].profile.category);
  });
});

describe('dropMONK · ClockBridge Quantisierung', () => {
  it('rechnet Samples pro Beat tempoabhängig', () => {
    const clock = new ClockBridge();
    clock.initialize(120, 48000);
    expect(clock.getSamplesPerBeat()).toBe(24000);

    clock.setBpm(140);
    expect(clock.getSamplesPerBeat()).toBeCloseTo((48000 * 60) / 140, 6);
  });

  it('liefert die Distanz zum nächsten Takt/Beat', () => {
    const clock = new ClockBridge();
    clock.initialize(120, 48000);
    clock.updateClock(12000, true); // halber Beat

    expect(clock.getSamplesToNextBeat()).toBe(12000);
    expect(clock.getSamplesToNextBar()).toBe(96000 - 12000);
    expect(clock.getDelayToQuantizationMs('1bar')).toBeCloseTo(1750, 3);
  });

  it('führt geplante Drops am Quantisierungspunkt aus', () => {
    const clock = new ClockBridge();
    clock.initialize(120, 48000);
    clock.updateClock(0, true);

    const spy = vi.fn();
    clock.scheduleDrop(spy, '1bar');
    expect(clock.getScheduledCount()).toBe(1);

    clock.updateClock(48000, true); // 1 Beat → noch nicht fällig
    expect(spy).not.toHaveBeenCalled();

    clock.updateClock(96000, true); // Taktgrenze
    expect(spy).toHaveBeenCalledTimes(1);
    expect(clock.getScheduledCount()).toBe(0);
  });

  it('kann geplante Drops abbrechen und Listener informieren', () => {
    const clock = new ClockBridge();
    clock.initialize(120, 48000);
    const spy = vi.fn();
    const id = clock.scheduleDrop(spy, '1beat');
    clock.cancelScheduledDrop(id);

    const listener = vi.fn();
    clock.onClockUpdate('test', listener);
    clock.updateClock(240000, true);

    expect(spy).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();

    clock.offClockUpdate('test');
    clock.updateClock(480000, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rechnet Takte in Millisekunden um', () => {
    expect(ClockBridge.barToMs(4, 120)).toBe(8000);
    expect(ClockBridge.msToBar(8000, 120)).toBe(4);
  });
});

describe('dropMONK · MixerBridge', () => {
  it('liest und schreibt Kanäle über den Adapter', () => {
    const { adapter, channels } = createAdapter();
    setDropAudioAdapter(adapter);

    const bridge = new MixerBridge();
    expect(bridge.getCurrentMixerState()).toHaveLength(2);

    expect(bridge.setMixerLevel('channel1', 0.25)).toBe(true);
    expect(channels[0].level).toBe(0.25);

    expect(bridge.setMixerPan('channel1', -0.5)).toBe(true);
    expect(channels[0].pan).toBe(-0.5);

    bridge.setMixerMute('channel2', true);
    expect(channels[1].muted).toBe(true);
  });

  it('weist ungültige Werte zurück', () => {
    const bridge = new MixerBridge();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(bridge.setMixerLevel('channel1', 2)).toBe(false);
    expect(bridge.setMixerPan('channel1', -5)).toBe(false);
    errorSpy.mockRestore();
  });

  it('nutzt eine Equal-Power-Kurve für Crossfades', () => {
    const mid = MixerBridge.equalPowerGains(0.5);
    expect(mid.from ** 2 + mid.to ** 2).toBeCloseTo(1, 6);
    expect(MixerBridge.equalPowerGains(0).from).toBeCloseTo(1, 6);
    expect(MixerBridge.equalPowerGains(1).to).toBeCloseTo(1, 6);
  });

  it('endet nach dem Crossfade im Zielzustand', async () => {
    const { adapter, channels } = createAdapter();
    setDropAudioAdapter(adapter);

    const bridge = new MixerBridge();
    await bridge.crossfade('channel1', 'channel2', 0, 4);

    expect(channels[0].level).toBe(0);
    expect(channels[1].level).toBe(1);
  });

  it('berechnet das Energy-Level aus nicht gemuteten Kanälen', () => {
    const { adapter } = createAdapter();
    setDropAudioAdapter(adapter);
    const bridge = new MixerBridge();

    expect(bridge.getEnergyLevel()).toBeCloseTo(Math.min(1, ((0.8 + 0.4) / 2) * 1.2), 6);
    expect(bridge.getActiveChannels()).toHaveLength(2);
  });
});

describe('dropMONK · PluginParameterBridge', () => {
  it('kennt alle Parameter der Built-in-Profile', () => {
    const bridge = new PluginParameterBridge();
    for (const profile of DROP_PROFILES) {
      for (const transform of profile.parameterSequence) {
        expect(bridge.validateTransformation(transform)).toBe(true);
      }
    }
  });

  it('clamped Werte und schreibt über den Adapter', () => {
    const { adapter, parameterWrites } = createAdapter();
    setDropAudioAdapter(adapter);

    const bridge = new PluginParameterBridge();
    expect(bridge.setParameter('synthesizer:cutoff', 5)).toBe(1);
    expect(bridge.setParameter('synthesizer:cutoff', -3)).toBe(0);
    expect(parameterWrites).toEqual([
      { pluginId: 'synthesizer', parameterId: 'cutoff', value: 1 },
      { pluginId: 'synthesizer', parameterId: 'cutoff', value: 0 },
    ]);
  });

  it('skaliert normalisierte Werte auf den Spec-Bereich', () => {
    const bridge = new PluginParameterBridge();
    expect(bridge.setNormalizedParameter('drum:pan', 0)).toBe(-1); // min = -1
    expect(bridge.setNormalizedParameter('drum:pan', 1)).toBe(1);
    expect(bridge.getLastValue('drum:pan')).toBe(1);
  });

  it('lehnt unbekannte Parameter ab', () => {
    const bridge = new PluginParameterBridge();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bridge.setParameter('unknown:param', 0.5)).toBeNull();
    expect(bridge.setNormalizedParameter('unknown:param', 0.5)).toBeNull();
    expect(bridge.discoverParameters('effect').length).toBeGreaterThan(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('dropMONK · DropEngine', () => {
  const profile: DropProfile = {
    id: 'test_drop',
    name: 'Test Drop',
    description: 'unit test',
    category: 'buildup',
    parameterSequence: [
      {
        pluginId: 'synthesizer',
        parameterId: 'cutoff',
        startValue: 0,
        endValue: 1,
        duration: 1000,
        curve: 'linear',
      },
    ],
    buildupTime: 1000,
    dropDuration: 1000,
    quantization: '4bar',
  };

  it('schreibt Parameter über die Bridge und meldet Fortschritt', async () => {
    const { adapter, parameterWrites } = createAdapter();
    setDropAudioAdapter(adapter);

    const engine = new DropEngine();
    const started = vi.fn();
    const finished = vi.fn();
    engine.on('onDropStarted', started);
    engine.on('onDropFinished', finished);

    const now = Date.now();
    await engine.triggerDrop(profile, 'immediate', undefined, now);

    expect(started).toHaveBeenCalledWith('test_drop');
    expect(parameterWrites[0]).toEqual({ pluginId: 'synthesizer', parameterId: 'cutoff', value: 0 });

    engine.updateActiveDrops(now + 500);
    expect(parameterWrites.at(-1)?.value).toBeCloseTo(0.5, 2);

    engine.updateActiveDrops(now + 1500);
    expect(parameterWrites.at(-1)?.value).toBe(1);
    expect(finished).toHaveBeenCalledWith('test_drop');
    expect(engine.getStatus().activeDrops).toBe(0);

    engine.stopAll();
  });

  it('berechnet die Quantisierungs-Verzögerung aus der realen BPM', () => {
    const engine = new DropEngine();
    expect(engine.calculateQuantizationDelay('instant')).toBe(0);
    // Default-Clock: 120 BPM → 500 ms pro Beat, 4bar = 16 Beats
    expect(engine.calculateQuantizationDelay('4bar')).toBeCloseTo(8000, 6);
    expect(engine.calculateQuantizationDelay('1bar')).toBeCloseTo(2000, 6);
  });

  it('fährt bei einer DJ-Transition den Crossfade mit', async () => {
    const { adapter, channels } = createAdapter();
    setDropAudioAdapter(adapter);

    const engine = new DropEngine();
    await engine.triggerChannelTransition('channel1', 'channel2', {
      ...profile,
      dropDuration: 0,
    });

    expect(channels[0].level).toBe(0);
    expect(channels[1].level).toBe(1);
    engine.stopAll();
  });
});

describe('dropMONK · DropPresetStore', () => {
  it('speichert, lädt, favorisiert und exportiert Presets', async () => {
    const store = new DropPresetStore();
    const preset = await store.savePreset(DROP_PROFILES[0], 'My Drop', ['techno']);

    expect(await store.loadPreset(preset.id)).toMatchObject({ name: 'My Drop' });
    expect(await store.listPresets({ tags: ['techno'] })).toHaveLength(1);
    expect(await store.listPresets({ category: 'breakdown' })).toHaveLength(0);

    await store.toggleFavorite(preset.id);
    expect(await store.getFavorites()).toHaveLength(1);

    const json = await store.exportAll();
    const imported = await store.importFromJson(json, 'replace');
    expect(imported).toBe(1);

    const stats = await store.getStats();
    expect(stats.totalCount).toBe(1);

    await store.clearAll();
    expect(await store.listPresets()).toHaveLength(0);
  });
});

describe('dropMONK · Server-Drop-Generator', () => {
  const request = { userPrompt: 'Techno buildup mit Bass-Drop', bpm: 128, style: 'extreme' as const };

  it('baut einen Prompt mit Kontext und erlaubten Parametern', () => {
    const prompt = buildDropPrompt(request);
    expect(prompt).toContain('128');
    expect(prompt).toContain('synthesizer:cutoff');
    expect(prompt).toContain(request.userPrompt);
  });

  it('extrahiert JSON aus Markdown-Fences', () => {
    expect(extractJsonBlock('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonBlock('Antwort: {"a":1} Ende')).toBe('{"a":1}');
  });

  it('validiert und clamped LLM-Antworten', () => {
    const raw = JSON.stringify({
      name: 'LLM Drop',
      description: 'test',
      category: 'buildup',
      parameterSequence: [
        { pluginId: 'synthesizer', parameterId: 'cutoff', startValue: -2, endValue: 5, duration: 999999, curve: 'nope' },
        { pluginId: 'hacker', parameterId: 'rm -rf', startValue: 0, endValue: 1, duration: 1000, curve: 'linear' },
      ],
      confidence: 2,
    });

    const result = sanitizeAiDropResponse(raw, request);
    expect(result.parameterSequence).toHaveLength(1);
    expect(result.parameterSequence[0]).toMatchObject({ startValue: 0, endValue: 1, curve: 'linear' });
    expect(result.parameterSequence[0].duration).toBeLessThanOrEqual(barsToMs(4, 128));
    expect(result.confidence).toBe(1);
    expect(result.source).toBe('llm');
  });

  it('wirft, wenn die Antwort keine unterstützten Parameter enthält', () => {
    const raw = JSON.stringify({ name: 'x', parameterSequence: [{ pluginId: 'x', parameterId: 'y' }] });
    expect(() => sanitizeAiDropResponse(raw, request)).toThrow();
  });

  it('erzeugt einen deterministischen Fallback-Drop', () => {
    const a = generateDeterministicDrop(request);
    const b = generateDeterministicDrop(request);

    expect(a).toEqual(b);
    expect(a.source).toBe('local');
    expect(a.parameterSequence.length).toBeGreaterThanOrEqual(3);
    for (const step of a.parameterSequence) {
      expect(step.startValue).toBeGreaterThanOrEqual(0);
      expect(step.endValue).toBeLessThanOrEqual(1);
      expect(step.duration).toBeGreaterThan(0);
    }
  });

  it('erkennt Breakdown- und Transition-Prompts', () => {
    expect(generateDeterministicDrop({ userPrompt: 'ambient breakdown', bpm: 120 }).category).toBe('breakdown');
    expect(generateDeterministicDrop({ userPrompt: 'sanfter Übergang zum nächsten Track', bpm: 120 }).category).toBe('transition');
    expect(generateDeterministicDrop({ userPrompt: 'harter drop', bpm: 120 }).category).toBe('buildup');
  });
});

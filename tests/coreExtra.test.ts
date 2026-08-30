import { describe, expect, it } from 'vitest';
import { OfflineRenderQueue } from '../src/core/render/OfflineRenderQueue';
import { AudioBuffer, AudioGraph } from '../src/core/audio/AudioGraph';
import { WasmBackend } from '../src/core/audio/backends/WasmBackend';
import { LocalSingingEngine, type VoiceModel } from '../src/core/voice/SingingEngine';
import { hfVoiceRequest, isBrowser } from '../src/core/voice/hfApi';

const MODEL: VoiceModel = { id: 'm1', name: 'Test', engine: 'singing', locale: 'de' };

describe('OfflineRenderQueue', () => {
  it('enqueue erzeugt eindeutige, deterministische Job-IDs (ohne Math.random)', () => {
    const queue = new OfflineRenderQueue();
    const output = new AudioBuffer(48000, 128, 1);
    const graph = new AudioGraph();
    const j1 = queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 0.1, channels: 1, factor: 1 }, output);
    const j2 = queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 0.1, channels: 1, factor: 1 }, output);
    expect(j1.id).not.toBe(j2.id);
    expect(queue.list()).toHaveLength(2);
  });

  it('cancel entfernt nur queued Jobs', () => {
    const queue = new OfflineRenderQueue();
    const output = new AudioBuffer(48000, 128, 1);
    const graph = new AudioGraph();
    const job = queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 0.1, channels: 1, factor: 1 }, output);
    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.list()).toHaveLength(0);
  });

  it('processAll verarbeitet Jobs und fängt Fehler ab', async () => {
    const queue = new OfflineRenderQueue();
    const output = new AudioBuffer(48000, 128, 1);
    const graph = new AudioGraph();
    queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 0.1, channels: 1, factor: 1 }, output);
    const fakeRenderer = {
      render: async () => { throw new Error('kaputt'); },
    } as never;
    const jobs = await queue.processAll(fakeRenderer);
    expect(jobs[0].status).toBe('error');
    expect(jobs[0].error).toBe('kaputt');
  });
});

describe('WasmBackend (degressiv ohne Kernel)', () => {
  it('ist ohne geladenen Kernel nicht verfügbar und rendert über den JS-Fallback', async () => {
    const backend = new WasmBackend();
    expect(backend.available).toBe(false);
    await backend.initialize(); // fetch('/wasm/dspKernel.wasm') schlägt in Node fehl → bleibt inaktiv
    expect(backend.available).toBe(false);

    const graph = backend.createGraph();
    const ctx = { sampleRate: 48000, bufferSize: 128, quantum: 128 / 48000, currentTime: 0 };
    const output = backend.createBuffer(48000, 128, 1);
    await backend.render(graph, ctx, output);
    expect(output.numberOfChannels).toBe(1);
    await backend.dispose();
  });
});

describe('LocalSingingEngine', () => {
  it('wirft ohne geladenes Modell und singt mit Modell (offline)', async () => {
    const engine = new LocalSingingEngine();
    await expect(engine.sing({ notes: [{ lyric: 'Ha', midi: 60, start: 0, duration: 0.5 }], bpm: 120 }))
      .rejects.toThrow('Kein VoiceModel geladen');

    await engine.loadModel(MODEL);
    // Node hat kein Audio/URL → Wiedergabe wird übersprungen, Synthese läuft trotzdem.
    await expect(engine.sing({ notes: [{ lyric: 'Ha', midi: 60, start: 0, duration: 0.5 }], bpm: 120 }))
      .resolves.toBeUndefined();
    engine.stop();
  });
});

describe('hfApi', () => {
  it('isBrowser ist in Node false und hfVoiceRequest verwirft relative URLs', async () => {
    expect(isBrowser()).toBe(false);
    await expect(hfVoiceRequest('tts', { text: 'Hallo' })).rejects.toThrow();
  });
});

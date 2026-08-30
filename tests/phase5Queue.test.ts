import { describe, expect, it } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { AudioBuffer } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import { OfflineRenderQueue } from '../src/core/render/OfflineRenderQueue';

describe('Phase 5 – Offline Render Queue', () => {
  it('verarbeitet Jobs sequenziell und deterministisch', async () => {
    const queue = new OfflineRenderQueue();
    const graph = new AudioGraph();
    const source = new SourceNode('src', [new Float32Array([0.5, 0.5])]);
    graph.addNode(source);

    const out1 = new AudioBuffer(48000, 2, 1);
    const out2 = new AudioBuffer(48000, 2, 1);

    queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 2 / 48000, channels: 1, factor: 1 }, out1, 1);
    queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 2 / 48000, channels: 1, factor: 4 }, out2, 2);

    const jobs = await queue.processAll();
    expect(jobs.every((j) => j.status === 'done')).toBe(true);
    expect(out1.channelData[0][0]).toBeCloseTo(0.5, 5);
    expect(out2.channelData[0][0]).toBeCloseTo(0.5, 5);
  });

  it('sortiert nach Priorität (höchste zuerst)', () => {
    const queue = new OfflineRenderQueue();
    const graph = new AudioGraph();
    const output = new AudioBuffer(48000, 1, 1);
    queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 1 / 48000, channels: 1, factor: 1 }, output, 1);
    queue.enqueue({ graph, sampleRate: 48000, durationSeconds: 1 / 48000, channels: 1, factor: 1 }, output, 5);

    const jobs = queue.list();
    expect(jobs[0].priority).toBe(5);
  });
});

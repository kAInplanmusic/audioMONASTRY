import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { V2MonitorGraph } from '../../src/core/audio/V2MonitorGraph';
import { planMonitorRouting } from '../../src/core/audio/monitorRouting';

const rows = [];
for (const sampleRate of [48000, 96000, 192000]) {
  for (const source of ['MAIN', 'MIX', 'PLUGIN'] as const) {
    const size = 128, warmup = 100;
    const graph = new V2MonitorGraph(sampleRate, size);
    graph.applyMonitorPlan(planMonitorRouting({ source, mon: 'MON1', track: 'channel1', baseMix: { channel1: 1 } }));
    const silence = new Float32Array(size);
    let first = -1, peak = 0, cpuMs = 0;
    for (let block = 0; block < warmup + 40; block++) {
      const input = block === warmup ? Float32Array.from({ length: size }, (_, i) => i === 0 ? 0.1 : 0) : silence;
      graph.setSourceBuffer('channel1', [input, input]);
      const t = performance.now();
      const out = graph.render({ sampleRate, bufferSize: size, quantum: size / sampleRate, currentTime: block * size / sampleRate }).monitor;
      cpuMs += performance.now() - t;
      assert.ok(out);
      if (block >= warmup) for (let i = 0; i < size; i++) {
        const value = Math.abs(out[0][i]);
        if (value > 1e-7 && first < 0) first = (block - warmup) * size + i;
        peak = Math.max(peak, value);
      }
    }
    assert.ok(first >= 0, `${source} impulse missing`);
    assert.equal(first, graph.mainLatencySamples, `${source} impulse does not match reported PDC`);
    rows.push({ sampleRate, source, graphDelaySamples: first, graphDelayMs: first * 1000 / sampleRate, reportedMainLatencySamples: graph.mainLatencySamples, impulsePeak: peak, cpuRenderTotalMs: cpuMs, renderedBlocks: warmup + 40, blockSize: size });
  }
}
console.log(JSON.stringify({ scope: 'in-process V2MonitorGraph impulse, settled routing gains and default DSP; software sample-clock delay only', note: 'CPU render time is separately measured wall-clock execution time, not physical end-to-end latency.', rows }, null, 2));

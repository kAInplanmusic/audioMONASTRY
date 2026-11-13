import { describe, expect, it, vi } from 'vitest';
import { audioProbeObservation, browserCpuPercent, emptyLiveValues, quantiles, rtpValues, sanitizeRtpStats, summarizeLiveRun, validateLiveRun, type LiveRun } from '../src/utils/liveSessionAudit';
import { startMainStreamRetry } from '../src/utils/mainStreamRetry';
import { simulatedLiveRun } from '../scripts/audit/live-session';

describe('B1 audit data contracts', () => {
  it('measures all-thread process CPU with a monotonic denominator and rejects process churn', () => {
    expect(browserCpuPercent([{ id: 1, cpuTime: 3 }], [{ id: 1, cpuTime: 1 }], 1000)).toBe(200);
    expect(browserCpuPercent([{ id: 2, cpuTime: 3 }], [{ id: 1, cpuTime: 1 }], 1000)).toBeNull();
    expect(browserCpuPercent([{ id: 1, cpuTime: 0 }], [{ id: 1, cpuTime: 1 }], 1000)).toBeNull();
    expect(browserCpuPercent([], [], 1000)).toBeNull();
  });
  it('uses per-SSRC interval deltas, including a true zero, without inventing first-window measurements', () => {
    const before = [{ id: 'a', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 1, jitterBufferEmittedCount: 100,
      concealedSamples: 20, totalSamplesReceived: 48000 }];
    const after = [{ ...before[0], jitter: .003, jitterBufferDelay: 1.4, jitterBufferEmittedCount: 120, totalSamplesReceived: 96000 }];
    expect(rtpValues(after).jitterBufferMs).toBeNull();
    expect(rtpValues(after, before)).toMatchObject({ networkJitterMs: 3,
      concealedSamples: 0, receivedSamples: 48000, audioInToPaOutMs: null, droppedBlocks: null });
    expect(rtpValues(after, before).jitterBufferMs).toBeCloseTo(20, 9);
    expect(rtpValues(before, after).jitterBufferMs).toBeNull();
  });
  it('uses a nominated successful pair for RTT, not a failed or unselected candidate', () => {
    expect(rtpValues([{ type: 'candidate-pair', state: 'failed', nominated: true, currentRoundTripTime: 5 },
      { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 10 },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: .025 }]).networkRttMs).toBe(25);
  });
  it('keeps missing data out of percentiles and never claims zero latency or glitches', () => {
    expect(quantiles([])).toEqual({ count: 0, p50: null, p95: null, p99: null });
    expect(quantiles([100, 1, 2, NaN, -2])).toEqual({ count: 3, p50: 2, p95: 100, p99: 100 });
    const run: LiveRun = { schemaVersion: 1, mode: 'local-staging', runId: 'missing', seed: 0,
      hostname: 'local', version: 'test', commit: 'test', startedAt: new Date().toISOString(), handovers: [],
      observations: [{ userId: 'u', observerId: 'out', role: 'master-out', at: new Date().toISOString(),
        monotonicMs: 0, values: emptyLiveValues(), methods: { all: 'unavailable' } }] };
    const summary = summarizeLiveRun(run);
    expect(summary.users.u.metrics.audioInToPaOutMs.count).toBe(0);
    expect(summary.users.u.glitchRate).toBeNull();
  });
  it('never exports candidate addresses, credentials, SDP or unrelated stats', () => {
    const report = new Map([['pair', { id: 'p', type: 'candidate-pair', credential: 'test-secret', address: 'test-ip', currentRoundTripTime: .1 }],
      ['candidate', { id: 'c', type: 'local-candidate', address: 'test-ip', credential: 'test-secret' }]]) as unknown as RTCStatsReport;
    expect(sanitizeRtpStats(report)).toEqual([{ id: 'p', type: 'candidate-pair', currentRoundTripTime: .1 }]);
  });
  it('reproduces synthetic values for two users with the same seed and labels them', () => {
    const a = simulatedLiveRun(42), b = simulatedLiveRun(42);
    expect(a.mode).toBe('simulation'); expect(new Set(a.observations.map(o => o.userId)).size).toBe(2);
    expect(a.observations.map(o => o.values)).toEqual(b.observations.map(o => o.values));
    expect(a.observations[0].methods.all).toContain('synthetic');
    expect(simulatedLiveRun(43).observations[0].values).not.toEqual(a.observations[0].values);
    expect(summarizeLiveRun(a).users['sim-user-1'].glitchRate).toBeCloseTo(1 / 37501, 12);
    validateLiveRun(a);
    a.observations[0].values.cpuPercent = Infinity;
    expect(() => validateLiveRun(a)).toThrow('Invalid live observation');
  });
  it('accepts calibrated common-clock probes and rejects negative or uncalibrated timing', () => {
    const probe = { userId: 'u', observerId: 'pa', at: new Date().toISOString(), monotonicMs: 0, clockId: 'capture-device-a',
      calibrationId: 'cal-a', inputMarkerSeconds: 1, paMarkerSeconds: 1.05, uncertaintyMs: .2,
      renderedBlocks: 375, droppedBlocks: 1, mode: 'physical-loopback' as const };
    expect(audioProbeObservation(probe).values.audioInToPaOutMs).toBeCloseTo(50, 9);
    expect(() => audioProbeObservation({ ...probe, clockId: '' })).toThrow('Invalid calibrated');
    expect(() => audioProbeObservation({ ...probe, paMarkerSeconds: .9 })).toThrow('Invalid calibrated');
  });
});
describe('B2 production Main destination retry', () => {
  it('retries at exactly two seconds and stops on success or cleanup', () => {
    vi.useFakeTimers();
    try {
      let ready = false; const start = vi.fn(); const mark = vi.fn();
      const stop = startMainStreamRetry({ ready: () => ready, mark, start });
      vi.advanceTimersByTime(1999); expect(start).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); expect(start).toHaveBeenCalledTimes(1);
      ready = true; vi.advanceTimersByTime(2000); expect(start).toHaveBeenCalledTimes(1);
      stop(); expect(vi.getTimerCount()).toBe(0);
      const stopNext = startMainStreamRetry({ ready: () => false, mark, start }); stopNext();
      vi.advanceTimersByTime(2000); expect(start).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('keeps the existing 150-attempt ceiling', () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(); const stop = startMainStreamRetry({ ready: () => false, mark: () => {}, start });
      vi.advanceTimersByTime(400000); expect(start).toHaveBeenCalledTimes(150); expect(vi.getTimerCount()).toBe(0); stop();
    } finally { vi.useRealTimers(); }
  });
});

/** Opt-in diagnostics outside the render loop. Unknown is null, never zero. */
export const LIVE_METRICS = [
  'audioInToPaOutMs', 'jitterBufferMs', 'droppedBlocks', 'cpuPercent',
  'networkRttMs', 'networkJitterMs', 'concealedSamples', 'receivedSamples', 'renderedBlocks', 'rendererMainThreadCpuPercent',
] as const;
export type LiveMetric = typeof LIVE_METRICS[number];
export type LiveValues = Record<LiveMetric, number | null>;
export interface LiveObservation {
  userId: string;
  observerId: string;
  role: 'member' | 'master-out';
  at: string;
  monotonicMs: number;
  values: LiveValues;
  methods: Record<string, string>;
}
export interface LiveRun {
  schemaVersion: 1;
  mode: 'simulation' | 'local-staging' | 'live';
  runId: string;
  seed: number;
  hostname: string;
  version: string;
  commit: string;
  startedAt: string;
  observations: LiveObservation[];
  handovers: { from: string; to: string; outageSeconds: number | null; method: string }[];
}
export function emptyLiveValues(): LiveValues {
  return Object.fromEntries(LIVE_METRICS.map(key => [key, null])) as LiveValues;
}
/** External calibrated acquisition: both markers must share ONE acquisition clock.
 * Cross-host Date.now differences, RTP jitter and estimated buffers are not PA latency.
 */
export function audioProbeObservation(probe: {
  userId: string; observerId: string; at: string; monotonicMs: number;
  clockId: string; calibrationId: string; inputMarkerSeconds: number; paMarkerSeconds: number;
  uncertaintyMs: number; renderedBlocks: number; droppedBlocks: number;
  mode: 'physical-loopback' | 'simulation';
}): LiveObservation {
  if (!probe.clockId || !probe.calibrationId || !probe.userId || !probe.observerId
    || !Number.isFinite(Date.parse(probe.at)) || !finite(probe.monotonicMs)
    || ![probe.inputMarkerSeconds, probe.paMarkerSeconds, probe.uncertaintyMs, probe.renderedBlocks, probe.droppedBlocks].every(finite)
    || probe.paMarkerSeconds < probe.inputMarkerSeconds
    || !Number.isInteger(probe.renderedBlocks) || !Number.isInteger(probe.droppedBlocks)
    || !['physical-loopback', 'simulation'].includes(probe.mode)) throw new Error('Invalid calibrated audio probe');
  return { userId: probe.userId, observerId: probe.observerId, at: probe.at, monotonicMs: probe.monotonicMs,
    role: 'master-out', values: { ...emptyLiveValues(), audioInToPaOutMs: (probe.paMarkerSeconds - probe.inputMarkerSeconds) * 1000,
      renderedBlocks: probe.renderedBlocks, droppedBlocks: probe.droppedBlocks },
    methods: { audioInToPaOutMs: `${probe.mode}; common acquisition clock=${probe.clockId}; calibration=${probe.calibrationId}; uncertaintyMs=${probe.uncertaintyMs}`,
      droppedBlocks: `${probe.mode}; explicit interval counters from external block probe` } };
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function browserCpuPercent(current: { id: number; cpuTime: number }[], previous: { id: number; cpuTime: number }[], wallMs: number): number | null {
  if (!finite(wallMs) || wallMs === 0 || !current.length || current.length !== previous.length) return null;
  const before = new Map(previous.map(p => [p.id, p.cpuTime]));
  let seconds = 0;
  for (const p of current) {
    const prev = before.get(p.id);
    if (!finite(p.cpuTime) || !finite(prev) || p.cpuTime < prev) return null;
    seconds += p.cpuTime - prev;
  }
  return seconds * 100000 / wallMs; // all processes/threads; may exceed 100% on multicore.
}
export function quantiles(values: number[]) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const p = (q: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null;
  return { count: sorted.length, p50: p(.5), p95: p(.95), p99: p(.99) };
}
/** RFC3550 interarrival-jitter estimates, in ms; NOT variation in JS polling. */
export function rtpValues(rows: Record<string, unknown>[], previous: Record<string, unknown>[] = []): LiveValues {
  const values = emptyLiveValues();
  const inbound = rows.filter(r => r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio'));
  const previousById = new Map(previous.map(r => [r.id, r]));
  let delay = 0, emitted = 0, concealed = 0, received = 0;
  let delayKnown = false, samplesKnown = false;
  const jitters: number[] = [];
  const rtts: number[] = [];
  for (const row of inbound) {
    if (finite(row.jitter)) jitters.push(row.jitter * 1000);
    const prev = previousById.get(row.id);
    const delta = (key: string) => prev && finite(row[key]) && finite(prev[key]) && row[key] >= prev[key]
      ? (row[key] as number) - (prev[key] as number) : null;
    const d = delta('jitterBufferDelay'), e = delta('jitterBufferEmittedCount');
    if (d !== null && e !== null) { delay += d; emitted += e; delayKnown = true; }
    const c = delta('concealedSamples'), s = delta('totalSamplesReceived');
    if (c !== null && s !== null) { concealed += c; received += s; samplesKnown = true; }
  }
  for (const row of rows) {
    if (row.type === 'candidate-pair' && row.state === 'succeeded' && (row.nominated === true || row.selected === true)
      && finite(row.currentRoundTripTime)) rtts.push(row.currentRoundTripTime * 1000);
  }
  values.networkJitterMs = jitters.length ? Math.max(...jitters) : null;
  values.networkRttMs = rtts.length ? Math.max(...rtts) : null;
  values.jitterBufferMs = delayKnown && emitted > 0 ? delay / emitted * 1000 : null;
  values.concealedSamples = samplesKnown ? concealed : null;
  values.receivedSamples = samplesKnown ? received : null;
  return values;
}

/** Deliberately not named dropped blocks: concealment is a receiver statistic. */
export function summarizeLiveRun(run: LiveRun) {
  const users = [...new Set(run.observations.map(o => o.userId))].sort();
  return {
    users: Object.fromEntries(users.map(userId => {
      const observations = run.observations.filter(o => o.userId === userId);
      const measured = observations.filter(o => o.values.concealedSamples !== null && o.values.receivedSamples !== null);
      const samples = measured.reduce((s, o) => s + o.values.receivedSamples!, 0);
      const blocks = observations.filter(o => o.values.renderedBlocks !== null && o.values.droppedBlocks !== null);
      const totalBlocks = blocks.reduce((s, o) => s + o.values.renderedBlocks! + o.values.droppedBlocks!, 0);
      return [userId, {
        metrics: Object.fromEntries(LIVE_METRICS.map(k => [k, quantiles(observations.map(o => o.values[k]).filter(finite))])),
        concealmentRatio: samples > 0 ? measured.reduce((s, o) => s + o.values.concealedSamples!, 0) / samples : null,
        // Only explicit block-probe interval counters can establish a block glitch rate.
        glitchRate: totalBlocks > 0 ? blocks.reduce((s, o) => s + o.values.droppedBlocks!, 0) / totalBlocks : null,
      }];
    })),
    mixerHolderHandoverSeconds: quantiles(run.handovers.map(h => h.outageSeconds).filter(finite)),
  };
}

/** Runtime validation before accepting an external calibrated probe or a saved run. */
export function validateLiveRun(value: unknown): asserts value is LiveRun {
  const run = value as LiveRun;
  if (!run || run.schemaVersion !== 1 || !['simulation', 'local-staging', 'live'].includes(run.mode)
    || !Number.isInteger(run.seed) || run.seed < 0 || run.seed > 0xffffffff
    || !['runId', 'hostname', 'version', 'commit'].every(k => typeof run[k] === 'string' && run[k].length > 0)
    || !Number.isFinite(Date.parse(run.startedAt)) || !Array.isArray(run.observations) || !Array.isArray(run.handovers)) {
    throw new Error('Invalid live-run metadata');
  }
  for (const o of run.observations) {
    if (!o || !o.userId || !o.observerId || !['member', 'master-out'].includes(o.role)
      || !Number.isFinite(Date.parse(o.at)) || !finite(o.monotonicMs) || !o.values || !o.methods
      || !Object.values(o.methods).every(v => typeof v === 'string')
      || !LIVE_METRICS.every(k => o.values[k] === null || finite(o.values[k]))) throw new Error('Invalid live observation');
  }
  for (const h of run.handovers) {
    if (!h || typeof h.from !== 'string' || typeof h.to !== 'string' || !h.method
      || !(h.outageSeconds === null || finite(h.outageSeconds))) throw new Error('Invalid live handover');
  }
}

export const RTP_AUDIT_FIELDS = [
  'id', 'type', 'kind', 'mediaType', 'state', 'nominated', 'selected', 'jitter',
  'currentRoundTripTime', 'jitterBufferDelay', 'jitterBufferEmittedCount',
  'concealedSamples', 'totalSamplesReceived',
] as const;
/** Never export candidates, addresses, SDP, TURN credentials or cookies. */
export function sanitizeRtpStats(report: RTCStatsReport): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  report.forEach(row => {
    if (!['inbound-rtp', 'candidate-pair'].includes(row.type)) return;
    rows.push(Object.fromEntries(RTP_AUDIT_FIELDS.filter(k => row[k] !== undefined).map(k => [k, row[k]])));
  });
  return rows;
}

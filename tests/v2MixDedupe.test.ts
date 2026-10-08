// @vitest-environment node
/**
 * RT-AUDIT-P1-010-F1: Kein Nachrichten-Flood durch den Terminal-Proxy
 * ===================================================================
 * Der Proxy um `audioEngine` ruft vor JEDER Methode `syncV2FromV1()` auf. Vorher
 * gingen dadurch pro Trigger ~26 Mixer-Nachrichten (Gain/Pan/Mute/Master +
 * Monitor-Plan als strukturierter Klon) an den Audio-Thread, obwohl sich nichts
 * geändert hatte. Der Sink dedupliziert jetzt: unveränderter Wert → keine
 * Nachricht; echte Änderung → genau eine; neuer Prozessor (connect) → wieder alle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import { syncV2Mix } from '../src/audio/v2SyncMirror';
import { defaultMonitorPlan } from '../src/core/audio/monitorRouting';
import { V2_CHANNELS, type V2Channel } from '../src/core/audio/V2StudioGraph';

type Listener = (ev: { data?: unknown }) => void;

class FakePort {
  onmessage: Listener | null = null;
  readonly listeners = new Set<Listener>();
  readonly posted: Record<string, unknown>[] = [];
  postMessage(m: unknown): void { this.posted.push(m as Record<string, unknown>); }
  addEventListener(type: string, fn: Listener): void { if (type === 'message') this.listeners.add(fn); }
  removeEventListener(type: string, fn: Listener): void { if (type === 'message') this.listeners.delete(fn); }
  start(): void {}
}

class FakeAudioWorkletNode {
  static created: FakeAudioWorkletNode[] = [];
  readonly port = new FakePort();
  onprocessorerror: ((ev?: { message?: string }) => void) | null = null;
  constructor() { FakeAudioWorkletNode.created.push(this); }
  connect(): void {}
  disconnect(): void {}
}

const fakeContext = (): AudioContext => ({
  audioWorklet: { addModule: vi.fn(async () => {}) },
  destination: {},
}) as unknown as AudioContext;

/** Zählt Nachrichten eines Typs im Fake-Port. */
function count(port: FakePort, type: string): number {
  return port.posted.filter((m) => m.type === type).length;
}

async function connectedSink(): Promise<{ sink: V2LiveSink; port: FakePort }> {
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  const sink = new V2LiveSink({});
  await sink.connect(fakeContext());
  return { sink, port: FakeAudioWorkletNode.created[0].port };
}

const mixInput = (gainDb = 0, pan = 0, muted = false) => ({
  channels: Object.fromEntries(V2_CHANNELS.map((c) => [c, { gainDb, pan, muted }])),
  masterGainLinear: 0.5,
  monitorPlan: defaultMonitorPlan(),
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioWorkletNode.created = [];
});

describe('RT-AUDIT-P1-010-F1 · Mixer-Dedupe im V2LiveSink', () => {
  it('100 × syncV2FromV1 ohne Zustandsänderung → nur der erste Sync sendet Mixer-Nachrichten', async () => {
    const { sink, port } = await connectedSink();
    const input = mixInput();

    // Erster Sync: alles einmal aufbauen.
    syncV2Mix({ setGainDb: () => {}, setPan: () => {}, setMasterGain: () => {} } as never, sink, input);
    const afterFirst = {
      gain: count(port, 'gain-db'),
      pan: count(port, 'pan'),
      mute: count(port, 'mute'),
      master: count(port, 'master-gain'),
      monitor: count(port, 'monitor-plan'),
    };
    expect(afterFirst.gain).toBe(V2_CHANNELS.length);
    expect(afterFirst.pan).toBe(V2_CHANNELS.length);
    expect(afterFirst.mute).toBe(V2_CHANNELS.length);
    expect(afterFirst.master).toBe(1);
    expect(afterFirst.monitor).toBe(1);

    // 100 unveränderte Syncs: KEINE weitere Mixer-Nachricht.
    for (let i = 0; i < 100; i++) {
      syncV2Mix({ setGainDb: () => {}, setPan: () => {}, setMasterGain: () => {} } as never, sink, input);
    }
    expect(count(port, 'gain-db')).toBe(afterFirst.gain);
    expect(count(port, 'pan')).toBe(afterFirst.pan);
    expect(count(port, 'mute')).toBe(afterFirst.mute);
    expect(count(port, 'master-gain')).toBe(afterFirst.master);
    expect(count(port, 'monitor-plan')).toBe(afterFirst.monitor);
  });

  it('echte Änderung erzeugt genau eine Nachricht', async () => {
    const { sink, port } = await connectedSink();
    sink.setChannelGainDb('channel2', -3);
    expect(count(port, 'gain-db')).toBe(1);
    sink.setChannelGainDb('channel2', -3); // unverändert
    expect(count(port, 'gain-db')).toBe(1);
    sink.setChannelGainDb('channel2', -6); // geändert
    expect(count(port, 'gain-db')).toBe(2);
  });

  it('Monitor-Plan nur bei Änderung (teurer strukturierter Klon)', async () => {
    const { sink, port } = await connectedSink();
    const plan = defaultMonitorPlan();
    expect(sink.setMonitorRouting(plan)).toBe(true);
    expect(count(port, 'monitor-plan')).toBe(1);
    sink.setMonitorRouting(plan); // gleicher Inhalt → kein Klon
    expect(count(port, 'monitor-plan')).toBe(1);
    // Inhaltlich geänderter Plan → eine neue Nachricht.
    sink.setMonitorRouting({ ...plan, mainMonitorGain: 0.42 });
    expect(count(port, 'monitor-plan')).toBe(2);
  });

  it('nach disconnect()+connect() sendet der nächste Sync wieder alles', async () => {
    const { sink, port } = await connectedSink();
    sink.setChannelGainDb('channel1', 1);
    expect(count(port, 'gain-db')).toBe(1);
    sink.disconnect();
    await sink.connect(fakeContext());
    // Frischer Prozessor → neu erzeugter Port; der Dedupe-Cache ist geleert.
    const newPort = FakeAudioWorkletNode.created[1].port;
    sink.setChannelGainDb('channel1', 1);
    expect(count(newPort, 'gain-db')).toBe(1);
  });
});

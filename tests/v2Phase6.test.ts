import { describe, expect, it } from 'vitest';
import { LockManager } from '../src/core/session/locking';
import { emptyAudioGraphState } from '../src/utils/audioGraphSerialization';
import { ALL_TRACKS, type TrackType } from '../src/types';
import { planMonitorRouting } from '../src/core/audio/monitorRouting';
import {
  exportV2SessionState, parseV2SessionState, mergeV2SessionStates,
  createV2TransportState, type V2SessionGraphState,
} from '../src/core/session/v2SessionState';
import {
  v2Can, v2ObjectId, applyV2GraphStateWithRbac, syncV2Locks, listV2Locks,
  type V2Role,
} from '../src/core/session/v2LockSync';
import {
  fingerprintV2GraphState, addV2SfuConsumer, addV2SfuProducer,
  removeV2SfuProducer, syncSfuWithV2GraphState,
} from '../src/core/session/v2SfuSync';

function graphWithGains(gains: Partial<Record<TrackType, number>>): ReturnType<typeof emptyAudioGraphState> {
  const state = emptyAudioGraphState();
  for (const [track, value] of Object.entries(gains)) {
    state.channelGainsDb[track] = value ?? 0;
  }
  return state;
}

describe('Phase 6 · V2 Session-State export/import/merge', () => {
  it('export → JSON → import erhält Graph/Monitor/Plugins/Transport', () => {
    const graph = graphWithGains({ channel1: -6, channel9: 3, channel10: -2 });
    const monitor = planMonitorRouting({ source: 'MON', mon: 'MON2', baseMix: { channel2: 0.5, channel6: 1.2 } });
    const state = exportV2SessionState({
      sessionId: 'session-a',
      graph,
      monitor,
      activePlugins: ['drum', 'sound'],
      transport: {
        mode: 'sfu',
        connected: true,
        sessionId: 'sfu-session-1',
        producers: [{ producerId: 'p1', kind: 'audio', peerId: 'host', createdAt: 1 }],
      },
      updatedBy: 'user-a',
    });

    const parsed = parseV2SessionState(JSON.parse(JSON.stringify(state)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.sessionId).toBe('session-a');
    expect(parsed.state.graph.channelGainsDb.channel9).toBe(3);
    expect(parsed.state.monitor.source).toBe('MON');
    expect(parsed.state.monitor.mon).toBe('MON2');
    expect(parsed.state.activePlugins).toEqual(['drum', 'sound']);
    expect(parsed.state.transport.mode).toBe('sfu');
    expect(parsed.state.transport.producers[0].producerId).toBe('p1');
  });

  it('lehnt ungültige Zustände ab und normalisiert fehlende Monitor-/Transportteile', () => {
    expect(parseV2SessionState(null).ok).toBe(false);
    expect(parseV2SessionState({ version: 99 }).ok).toBe(false);

    const state = exportV2SessionState({
      sessionId: 's1',
      graph: emptyAudioGraphState(),
      activePlugins: ['mixer'],
    });
    const parsed = parseV2SessionState({ ...state, monitor: null, transport: undefined });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.monitor.source).toBe('MAIN');
    expect(parsed.state.transport.mode).toBe('local');
  });

  it('merge wählt den neueren Zustand (Tie-Break nach Absender)', () => {
    const a = exportV2SessionState({ sessionId: 's1', graph: emptyAudioGraphState(), updatedBy: 'a', updatedAt: 100 });
    const b = exportV2SessionState({ sessionId: 's1', graph: emptyAudioGraphState(), updatedBy: 'b', updatedAt: 200 });
    expect(mergeV2SessionStates(a, b)).toBe(b);
    const b2 = exportV2SessionState({ sessionId: 's1', graph: emptyAudioGraphState(), updatedBy: 'b', updatedAt: 100 });
    expect(mergeV2SessionStates(a, b2)!.updatedBy).toBe('b');
  });
});

describe('Phase 6 · Locking/RBAC mit V2-State synchronisieren', () => {
  it('RBAC-Level erlauben master erst ab engineer, edit ab producer', () => {
    expect(v2Can('admin', 'edit')).toBe(true);
    expect(v2Can('producer', 'edit')).toBe(true);
    expect(v2Can('engineer', 'edit')).toBe(false);
    expect(v2Can('engineer', 'routing')).toBe(true);
    expect(v2Can('engineer', 'master')).toBe(true);
    expect(v2Can('guest', 'master')).toBe(false);
  });

  it('fremder aktiver Kanal-Lock blockiert den Import für producer', () => {
    const current = graphWithGains({ channel1: 0, channel2: 0 });
    const incoming = graphWithGains({ channel1: -12, channel2: -6 });
    const locks = new LockManager();
    locks.acquire(v2ObjectId('channel', 'channel2'), 'other-user', 60_000, 1_000);

    const result = applyV2GraphStateWithRbac(current, incoming, 'producer-user', 'producer', locks.snapshot(1_000), 1_000);
    expect(result.allowedChannels).toContain('channel1');
    expect(result.deniedChannels).toContain('channel2');
    expect(result.state.channelGainsDb.channel1).toBe(-12);
    expect(result.state.channelGainsDb.channel2).toBe(0); // unverändert
  });

  it('admin darf fremde Locks übernehmen; guest darf keine Kanal-Änderungen importieren', () => {
    const current = graphWithGains({ channel1: 0 });
    const incoming = graphWithGains({ channel1: -3 });
    const locks = new LockManager();
    locks.acquire(v2ObjectId('channel', 'channel1'), 'other-user', 60_000, 1_000);

    const admin = applyV2GraphStateWithRbac(current, incoming, 'admin-user', 'admin', locks.snapshot(1_000), 1_000);
    expect(admin.deniedChannels).not.toContain('channel1');
    expect(admin.state.channelGainsDb.channel1).toBe(-3);

    const guest = applyV2GraphStateWithRbac(current, incoming, 'guest-user', 'guest', [], 1_000);
    expect(guest.deniedChannels).toEqual(ALL_TRACKS);
  });

  it('syncV2Locks akquiriert freie Kanäle und listV2Locks filtert V2-Objekte', () => {
    const lm = new LockManager();
    lm.acquire('other:lock', 'someone', 60_000, 1_000);
    const sync = syncV2Locks(lm, 'owner-a', ['channel1', 'channel2'], 60_000, 1_000);
    expect(sync.acquired).toEqual(['channel1', 'channel2']);
    const v2Locks = listV2Locks(lm, 1_000);
    expect(v2Locks.map((l) => l.objectId)).toEqual([
      v2ObjectId('channel', 'channel1'),
      v2ObjectId('channel', 'channel2'),
    ]);
  });
});

describe('Phase 6 · WebRTC/SFU-State mit V2-GraphState koppeln', () => {
  it('Fingerprint ist unabhängig von Objekt-Key-Reihenfolge', () => {
    const a = emptyAudioGraphState();
    const b = emptyAudioGraphState();
    a.channelGainsDb = { channel10: -1, channel1: 2 };
    b.channelGainsDb = { channel1: 2, channel10: -1 };
    expect(fingerprintV2GraphState(a)).toBe(fingerprintV2GraphState(b));
  });

  it('Producer/Consumer werden idempotent verwaltet', () => {
    let state = createV2TransportState();
    state = addV2SfuProducer(state, { producerId: 'p1', kind: 'audio', peerId: 'host', createdAt: 1 });
    state = addV2SfuProducer(state, { producerId: 'p1', kind: 'audio', peerId: 'host', createdAt: 1 });
    expect(state.producers).toHaveLength(1);
    state = addV2SfuConsumer(state, 'p1');
    state = addV2SfuConsumer(state, 'p1');
    expect(state.consumers).toHaveLength(1);
    state = removeV2SfuProducer(state, 'p1');
    expect(state.producers).toHaveLength(0);
    expect(state.consumers).toHaveLength(0);
  });

  it('syncSfuWithV2GraphState setzt die deterministische Graph-Revision', () => {
    const graph = graphWithGains({ channel1: -6 });
    const state = syncSfuWithV2GraphState(createV2TransportState(), graph);
    expect(state.graphRevision).toBe(fingerprintV2GraphState(graph));
  });
});

describe('Phase 6 · V2SessionState Typ-Hygiene', () => {
  it('aktive Plugins werden defensiv kopiert (keine Referenz-Lecks)', () => {
    const plugins = ['drum', 'sampler'];
    const state = exportV2SessionState({ sessionId: 's', graph: emptyAudioGraphState(), activePlugins: plugins });
    plugins.push('mixer');
    expect(state.activePlugins).toEqual(['drum', 'sampler']);
    const typed: V2SessionGraphState = state;
    expect(typed.version).toBe(1);
  });
});

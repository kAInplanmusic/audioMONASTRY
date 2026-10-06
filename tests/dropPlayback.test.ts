/**
 * dropMONK – Einspiel-Weg (PREP-6)
 * ================================
 * Der Adapter konnte einen Drop analysieren und ankuendigen, aber NICHT auf
 * einen Kanal spielen: `controlBus.emit('monk:drop-auto')` hatte keinen
 * Empfaenger und der Kanal ging im Adapter verloren.
 *
 * Diese Tests belegen den geschlossenen Weg:
 *   dropMONK `play` -> DropAudioAdapter.loadTrackSample(channel, url)
 *                     -> scheduleAtNextBar -> triggerEvent + fadeChannelToMain
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DropPluginAdapter } from '../src/plugins/adapters/DropPluginAdapter';
import {
  setDropAudioAdapter,
  type DropAudioAdapter,
  type DropMixerChannelSnapshot,
} from '../src/core/drop/DropAudioAdapter';

/** Adapter-Attrappe: zeichnet auf, was der Plugin-Adapter aufruft. */
function makeAdapter(overrides: Partial<DropAudioAdapter> = {}): {
  adapter: DropAudioAdapter;
  calls: {
    loaded: Array<[string, string | null]>;
    triggered: Array<[string, number]>;
    faded: Array<[string, number, number]>;
    scheduled: number;
  };
} {
  const calls = {
    loaded: [] as Array<[string, string | null]>,
    triggered: [] as Array<[string, number]>,
    faded: [] as Array<[string, number, number]>,
    scheduled: 0,
  };
  const adapter: DropAudioAdapter = {
    getChannels: (): DropMixerChannelSnapshot[] => [],
    setChannelLevel: () => undefined,
    setChannelPan: () => undefined,
    setChannelMute: () => undefined,
    setPluginParameter: () => undefined,
    getBpm: () => 128,
    getActivePluginIds: () => ['drop'],
    async loadTrackSample(channelId, url) {
      calls.loaded.push([channelId, url]);
      return true;
    },
    triggerEvent(channelId, velocity) {
      calls.triggered.push([channelId, velocity]);
      return true;
    },
    fadeChannelToMain(channelId, rampSec, targetDb) {
      calls.faded.push([channelId, rampSec, targetDb]);
      return true;
    },
    scheduleAtNextBar(cb) {
      calls.scheduled += 1;
      cb();
    },
    ...overrides,
  };
  return { adapter, calls };
}

/** Kommando an den Adapter (onCommand ist protected -> ueber handleCommand). */
async function command(adapter: DropPluginAdapter, name: string, payload?: Record<string, unknown>) {
  return adapter.handleCommand({ name, payload } as never);
}

describe('dropMONK: Drop wird wirklich auf den Kanal gespielt', () => {
  afterEach(() => setDropAudioAdapter(null));

  it('play: laedt das Sample auf den uebergebenen Kanal', async () => {
    const { adapter: audio, calls } = makeAdapter();
    setDropAudioAdapter(audio);

    const res = await command(new DropPluginAdapter(), 'play', {
      channel: 'channel3',
      url: 'https://example.test/drop.mp3',
    });

    expect(res).toMatchObject({ ok: true, channel: 'channel3' });
    expect(calls.loaded).toEqual([['channel3', 'https://example.test/drop.mp3']]);
  });

  it('play: feuert und fadet quantisiert an der naechsten Bar', async () => {
    const { adapter: audio, calls } = makeAdapter();
    setDropAudioAdapter(audio);

    await command(new DropPluginAdapter(), 'play', {
      channel: 'channel1',
      url: 'https://example.test/drop.mp3',
      velocity: 0.75,
      rampSec: 2,
    });

    expect(calls.scheduled).toBe(1);
    expect(calls.triggered).toEqual([['channel1', 0.75]]);
    expect(calls.faded).toEqual([['channel1', 2, 0]]);
  });

  it('play: quantize=false spielt sofort, ohne Bar-Planung', async () => {
    const { adapter: audio, calls } = makeAdapter();
    setDropAudioAdapter(audio);

    await command(new DropPluginAdapter(), 'play', {
      channel: 'channel1',
      url: 'https://example.test/drop.mp3',
      quantize: false,
    });

    expect(calls.scheduled).toBe(0);
    expect(calls.triggered).toEqual([['channel1', 0.9]]);
    expect(calls.faded).toEqual([['channel1', 4, 0]]);
  });

  it('play: akzeptiert `track` als Kanal-Angabe und kuerzt "ch4" auf channel4', async () => {
    const { adapter: audio, calls } = makeAdapter();
    setDropAudioAdapter(audio);

    const viaTrack = await command(new DropPluginAdapter(), 'play', {
      track: 'channel5',
      url: 'https://example.test/drop.mp3',
    });
    expect(viaTrack).toMatchObject({ ok: true, channel: 'channel5' });

    const viaShort = await command(new DropPluginAdapter(), 'play', {
      track: 'ch4',
      url: 'https://example.test/drop.mp3',
    });
    expect(viaShort).toMatchObject({ ok: true, channel: 'channel4' });

    expect(calls.loaded.map(([c]) => c)).toEqual(['channel5', 'channel4']);
  });

  it('play: lehnt ungueltigen Kanal ab, ohne Audio anzufassen', async () => {
    const { adapter: audio, calls } = makeAdapter();
    setDropAudioAdapter(audio);

    const res = await command(new DropPluginAdapter(), 'play', {
      channel: 'channel99',
      url: 'https://example.test/drop.mp3',
    });

    expect(res).toMatchObject({ ok: false });
    expect(calls.loaded).toEqual([]);
    expect(calls.triggered).toEqual([]);
  });

  it('play: lehnt fehlende url ab (kein Blind-Trigger)', async () => {
    const { adapter: audio, calls } = makeAdapter();
    setDropAudioAdapter(audio);

    const res = await command(new DropPluginAdapter(), 'play', { channel: 'channel1' });

    expect(res).toMatchObject({ ok: false });
    expect(calls.loaded).toEqual([]);
  });

  it('play: ohne Audio-Adapter (Headless) sauber ablehnen statt werfen', async () => {
    setDropAudioAdapter(null);

    const res = await command(new DropPluginAdapter(), 'play', {
      channel: 'channel1',
      url: 'https://example.test/drop.mp3',
    });

    expect(res).toMatchObject({ ok: false, reason: 'kein Audio-Adapter' });
  });

  it('play: meldet einen nicht ladbaren Kanal', async () => {
    const { adapter: audio, calls } = makeAdapter({
      async loadTrackSample() {
        return false;
      },
    });
    setDropAudioAdapter(audio);

    const res = await command(new DropPluginAdapter(), 'play', {
      channel: 'channel2',
      url: 'https://example.test/drop.mp3',
    });

    expect(res).toMatchObject({ ok: false, reason: 'Kanal nicht ladbar' });
    expect(calls.triggered).toEqual([]);
  });

  it('play: ohne scheduleAtNextBar wird trotzdem gespielt (kein Stillstand)', async () => {
    const { adapter: audio, calls } = makeAdapter({ scheduleAtNextBar: undefined });
    setDropAudioAdapter(audio);

    const res = await command(new DropPluginAdapter(), 'play', {
      channel: 'channel6',
      url: 'https://example.test/drop.mp3',
    });

    expect(res).toMatchObject({ ok: true });
    expect(calls.triggered).toEqual([['channel6', 0.9]]);
  });

  it('autoDrop: reicht den Kanal im Event mit (vorher ging er verloren)', async () => {
    const { adapter: audio } = makeAdapter();
    setDropAudioAdapter(audio);

    const seen: Array<Record<string, unknown>> = [];
    const { controlBus } = await import('../src/core/events/ControlBus');
    const off = controlBus.on('monk:drop-auto', (p: Record<string, unknown>) => seen.push(p));

    try {
      await command(new DropPluginAdapter(), 'autoDrop', {
        track: 'Irrelevant',
        url: 'https://example.test/x.mp3',
        channel: 'channel7',
      });
    } finally {
      off?.();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].channel).toBe('channel7');
  });
});

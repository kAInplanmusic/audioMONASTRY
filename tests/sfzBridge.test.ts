import { describe, expect, it, vi } from 'vitest';
import { SfzBridge, type SfzBridgeDeps } from '../src/audio/sfzBridge';
import type { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import type { SfzVoiceBank } from '../src/core/instrument/sfzVoice';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: SFZ-Voice-Bridge. Geprüft wird Routing (Bank + V2-Sink), der
// Fehlerpfad und der Streaming-Cache – mit injizierter Fake-Bank.
// ---------------------------------------------------------------------------

function makeDeps(bank: Partial<SfzVoiceBank> = {}) {
  const sink = {
    loadSfzBank: vi.fn(), sfzNoteOn: vi.fn(), sfzNoteOff: vi.fn(),
  } as unknown as V2LiveSink;
  const deps: SfzBridgeDeps = {
    getSampleRate: () => 48000,
    getSink: () => sink,
    createBank: () => ({ load: () => [], noteOn: vi.fn(), noteOff: vi.fn(), ...bank }) as unknown as SfzVoiceBank,
  };
  return { deps, sink };
}

describe('SfzBridge', () => {
  it('lädt eine Bank, registriert sie im V2-Sink und merkt den Kanal', () => {
    const { deps, sink } = makeDeps();
    const bridge = new SfzBridge(deps);
    const errors = bridge.load('<region>', { a: new Float32Array(4) }, 'channel6');
    expect(errors).toEqual([]);
    expect(sink.loadSfzBank).toHaveBeenCalledWith('channel6', '<region>', expect.any(Object));
    expect(bridge.channel).toBe('channel6');
  });

  it('routet Note-On/Off an Bank und V2-Sink (geladener Kanal)', () => {
    const noteOn = vi.fn();
    const noteOff = vi.fn();
    const { deps, sink } = makeDeps({ noteOn, noteOff });
    const bridge = new SfzBridge(deps);
    bridge.load('x', {}, 'channel5');
    bridge.noteOn(60, 90);
    bridge.noteOff(60);
    expect(noteOn).toHaveBeenCalledWith(60, 90);
    expect(noteOff).toHaveBeenCalledWith(60);
    expect(sink.sfzNoteOn).toHaveBeenCalledWith('channel5', 60, 90);
    expect(sink.sfzNoteOff).toHaveBeenCalledWith('channel5', 60);
  });

  it('meldet einen Ladefehler ehrlich statt zu werfen', () => {
    const { deps } = makeDeps({ load: () => { throw new Error('kaputt'); } });
    const bridge = new SfzBridge(deps);
    expect(bridge.load('x', {})).toEqual(['SFZ konnte nicht geladen werden']);
  });

  it('Note-On ohne geladene Bank ist unkritisch (kein Throw)', () => {
    const { deps } = makeDeps();
    const bridge = new SfzBridge(deps);
    expect(() => bridge.noteOn(60)).not.toThrow();
  });

  it('Streaming-Cache speichert und liefert wieder; Chunk-Plan ist nicht leer', () => {
    const { deps } = makeDeps();
    const bridge = new SfzBridge(deps);
    const data = new Float32Array([1, 2, 3]);
    bridge.cacheSample('s1', data, 12);
    expect(bridge.cachedSample('s1')).toBe(data);
    expect(bridge.planChunks(1_000_000).length).toBeGreaterThan(0);
  });
});

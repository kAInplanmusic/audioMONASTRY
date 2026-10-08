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
    isConnected: true, loadSfzRegions: vi.fn(), sfzNoteOn: vi.fn(), sfzNoteOff: vi.fn(),
  } as unknown as V2LiveSink;
  const deps: SfzBridgeDeps = {
    getSampleRate: () => 48000,
    getSink: () => sink,
    createBank: () => ({ loadParsed: () => {}, noteOn: vi.fn(), noteOff: vi.fn(), ...bank }) as unknown as SfzVoiceBank,
  };
  return { deps, sink };
}

describe('SfzBridge', () => {
  it('lädt eine Bank, registriert sie im V2-Sink und merkt den Kanal', () => {
    const { deps, sink } = makeDeps();
    const bridge = new SfzBridge(deps);
    const a = new Float32Array(4);
    const errors = bridge.load('<region> sample=a', { a }, 'channel6');
    expect(errors).toEqual([]);
    // RT-AUDIT-P1-010: der Sink bekommt die im Main-Thread geparsten Regionen
    // (kein SFZ-Text) und eine KOPIE der Quellen (wird übertragen; das Original
    // bleibt beim Aufrufer und in der Main-Thread-Bank).
    expect(sink.loadSfzRegions).toHaveBeenCalledWith('channel6', [expect.objectContaining({ sample: 'a' })], expect.any(Object));
    const sent = (sink.loadSfzRegions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as Record<string, Float32Array>;
    expect(sent.a).not.toBe(a);
    expect(Array.from(sent.a)).toEqual(Array.from(a));
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
    const { deps } = makeDeps({ loadParsed: () => { throw new Error('kaputt'); } });
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

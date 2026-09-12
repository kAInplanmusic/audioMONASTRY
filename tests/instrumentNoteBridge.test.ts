import { describe, expect, it, vi } from 'vitest';
import { InstrumentNoteBridge, instrumentPatches, toPitchDef, type InstrumentNoteBridgeDeps } from '../src/audio/instrumentNoteBridge';
import type { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import type { InstrumentDefinition } from '../src/core/instrument/types';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Instrument-Note-Bridge. Geprüft wird die reine PitchDef-
// Abbildung und das Routing an V2-Sink bzw. it-synth-Worklet.
// ---------------------------------------------------------------------------

function makeDeps(node: unknown = null, ready = true) {
  const sink = { setSynthSource: vi.fn(), synthTrigger: vi.fn(), stopSample: vi.fn() } as unknown as V2LiveSink;
  const deps: InstrumentNoteBridgeDeps = {
    getSink: () => sink,
    getItSynthNode: () => node as AudioWorkletNode | null,
    isItSynthReady: () => ready,
  };
  return { deps, sink };
}

describe('toPitchDef', () => {
  it('bildet die gemeinsamen Felder und Defaults ab', () => {
    const def = { id: 7, name: 'Piano', kind: 'acoustic', attack: 0.02, env: [0, 0.5, 0.8] } as unknown as InstrumentDefinition;
    const p = toPitchDef(def);
    expect(p).toMatchObject({ id: 7, name: 'Piano', kind: 'acoustic', attack: 0.02, release: 0.3, sustain: 0.8, decay: 0.5 });
  });

  it('nimmt kinder-spezifische Felder für fm/drum/fx auf', () => {
    const fm = toPitchDef({ id: 1, name: 'FM', kind: 'fm', modIndex: 4, modulator: 'sine' } as unknown as InstrumentDefinition);
    expect(fm).toMatchObject({ modIndex: 4, modulatorOsc: 'sine', ratio: 2 });
    const drum = toPitchDef({ id: 2, name: 'D', kind: 'drum', freqStart: 120, freqEnd: 40 } as unknown as InstrumentDefinition);
    expect(drum).toMatchObject({ freqStart: 120, freqEnd: 40 });
    const fx = toPitchDef({ id: 3, name: 'X', kind: 'fx', lfoRate: 3 } as unknown as InstrumentDefinition);
    expect(fx).toMatchObject({ lfoRate: 3, wobble: 0.15 });
  });
});

describe('InstrumentNoteBridge', () => {
  it('routet Note-On/Off an den V2-Sink (channel8, geklemmt)', () => {
    const { deps, sink } = makeDeps();
    const b = new InstrumentNoteBridge(deps);
    b.noteOn(99999, 0);
    expect(sink.setSynthSource).toHaveBeenCalledWith('channel8', 20000, 'lead');
    expect(sink.synthTrigger).toHaveBeenCalledWith('channel8', 0.2);
    b.noteOff();
    expect(sink.stopSample).toHaveBeenCalledWith('channel8');
  });

  it('sendet All-Notes-Off/Automation nur mit bereitem Worklet', () => {
    const postMessage = vi.fn();
    const { deps } = makeDeps({ port: { postMessage } }, true);
    const b = new InstrumentNoteBridge(deps);
    b.allNotesOff();
    b.automate('cutoff', 800, 0.03);
    expect(postMessage).toHaveBeenCalledWith({ type: 'allNotesOff' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'automate', param: 'cutoff', value: 800, rampTime: 0.03 });
  });

  it('Automation ohne bereiten Synth ist ein No-Op', () => {
    const postMessage = vi.fn();
    const { deps } = makeDeps({ port: { postMessage } }, false);
    new InstrumentNoteBridge(deps).automate('gain', 1);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('instrumentPatches reicht den Katalog durch', () => {
    expect(instrumentPatches().length).toBeGreaterThan(0);
  });
});

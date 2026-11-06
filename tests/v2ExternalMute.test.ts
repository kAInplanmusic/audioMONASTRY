/**
 * AUDIO-2026-11-06-002 (c) · Mute gilt auch fuer externe Quellen
 * ==============================================================
 * `V2SinkEngine.render` uebernahm `externalBlocks` VOR jeder Mute-Pruefung und
 * markierte den Kanal als belegt. Damit war ein stummgeschalteter Kanal mit
 * externer Quelle (SFZ-Scratch, itSynth-Instrument) weiter hoerbar, waehrend
 * Sample- und Stimmenpfad still blieben.
 *
 * Gemessen (vorher): MUTE + EXTERNAL peak 0.2121 bei 0.3 DC-Block,
 * MUTE + SAMPLE/Synth 0.0000.
 */
import { describe, expect, it } from 'vitest';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';
import type { IProcessingContext } from '../src/core/audio/types';

const SR = 48000;
const BLOCK = 128;
const CTX: IProcessingContext = { sampleRate: SR, bufferSize: BLOCK, quantum: BLOCK / SR, currentTime: 0 };
/** Der Mastering-Lookahead gibt das Signal um diese Anzahl Samples verzoegert aus. */
const SETTLE_BLOCKS = Math.ceil(v2MasteringLookaheadSamples(SR) / BLOCK) + 1;

/** Rendert `blocks` Bloecke und liefert den Spitzenwert ueber alle Ausgangskanaele. */
function peakOf(engine: V2SinkEngine, blocks: number, feed?: (block: number) => void): number {
  let peak = 0;
  for (let b = 0; b < blocks; b++) {
    feed?.(b);
    const rendered = engine.render({ ...CTX, currentTime: (b * BLOCK) / SR });
    for (const channel of rendered) {
      for (let i = 0; i < channel.length; i++) {
        const abs = Math.abs(channel[i]);
        if (abs > peak) peak = abs;
      }
    }
  }
  return peak;
}

/** Externe Quelle, wie sie der Worklet je Quantum liefert (frischer Block). */
function externalBlock(level = 0.3): Float32Array[] {
  return [new Float32Array(BLOCK).fill(level)];
}

describe('V2SinkEngine · MUTE + externe Quelle', () => {
  it('gibt bei stummgeschaltetem Kanal exakt Stille aus (peak 0)', () => {
    const engine = new V2SinkEngine(SR, BLOCK);
    engine.setChannelMuted('channel5', true);
    const peak = peakOf(engine, 40, () => engine.setExternalSource('channel5', externalBlock()));
    expect(peak).toBe(0);
  });

  it('klingt ohne Mute hoerbar (Gegenprobe zur Messung oben)', () => {
    const engine = new V2SinkEngine(SR, BLOCK);
    const peak = peakOf(engine, 40, () => engine.setExternalSource('channel5', externalBlock()));
    expect(peak).toBeGreaterThan(0.05);
  });

  it('wird beim Unmute wieder hoerbar und beim Mute erneut still', () => {
    const engine = new V2SinkEngine(SR, BLOCK);
    const heard = peakOf(engine, 30, () => engine.setExternalSource('channel5', externalBlock()));
    expect(heard).toBeGreaterThan(0.05);

    engine.setChannelMuted('channel5', true);
    // Lookahead-Tail des vorherigen Signale ausklingen lassen, dann messen.
    peakOf(engine, SETTLE_BLOCKS, () => engine.setExternalSource('channel5', externalBlock()));
    const muted = peakOf(engine, 30, () => engine.setExternalSource('channel5', externalBlock()));
    expect(muted).toBe(0);

    engine.setChannelMuted('channel5', false);
    const again = peakOf(engine, 30, () => engine.setExternalSource('channel5', externalBlock()));
    expect(again).toBeGreaterThan(0.05);
  });

  it('deckt auch stereo-externe Quellen (SFZ) und andere Kanaele ab', () => {
    const engine = new V2SinkEngine(SR, BLOCK);
    engine.setChannelMuted('channel5', true);
    engine.setChannelMuted('channel6', true);
    const peak = peakOf(engine, 40, () => {
      engine.setExternalSource('channel5', [new Float32Array(BLOCK).fill(0.3), new Float32Array(BLOCK).fill(0.3)]);
      engine.setExternalSource('channel6', externalBlock(0.2));
    });
    expect(peak).toBe(0);
  });

  it('verwirft den externen Block auch bei Mute (kein Nachholen im naechsten Block)', () => {
    const engine = new V2SinkEngine(SR, BLOCK);
    engine.setChannelMuted('channel5', true);
    engine.setExternalSource('channel5', externalBlock());
    expect(peakOf(engine, 20)).toBe(0);
    // Ohne neue Zufuhr bleibt es still (der Block wurde konsumiert, nicht gepuffert).
    engine.setChannelMuted('channel5', false);
    expect(peakOf(engine, 20)).toBe(0);
  });

  it('Sample- und Stimmenpfad bleiben unveraendert still (Regression)', () => {
    const sample = new V2SinkEngine(SR, BLOCK);
    sample.setSampleBuffer('channel5', new Float32Array(BLOCK).fill(0.3), null, SR);
    sample.setChannelMuted('channel5', true);
    const peak = peakOf(sample, 40, () => { sample.triggerSample('channel5', { loop: true, rate: 1, offset: 0, startSample: 0 }); });
    expect(peak).toBe(0);
  });
});

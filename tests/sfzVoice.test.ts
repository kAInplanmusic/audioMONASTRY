import { describe, expect, it } from 'vitest';
import { SfzVoiceBank } from '../src/core/instrument/sfzVoice';

const SFZ = `
<group> loop_mode=loop_continuous lovel=0 hivel=127
<region> sample=Kick.wav lokey=36 hikey=36 seq_length=2 seq_position=1
<region> sample=KickRR.wav lokey=36 hikey=36 seq_length=2 seq_position=2
<region> sample=Snare.wav key=38 lovel=0 hivel=100
<region> sample=SnareRim.wav key=38 lovel=101 hivel=127
`;

function sine(freq: number, frames: number, sampleRate = 24000): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
  return out;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

describe('SFZ-Voice-Management (SfzVoiceBank)', () => {
  it('lädt SFZ, matcht Velocity-Layer und rendert hörbar', () => {
    const bank = new SfzVoiceBank(24000);
    const errors = bank.load(SFZ, {
      'Kick.wav': sine(60, 12000),
      'KickRR.wav': sine(62, 12000),
      'Snare.wav': sine(190, 6000),
      'SnareRim.wav': sine(220, 6000),
    });
    expect(errors).toEqual([]);
    expect(bank.regionCount).toBe(4);

    bank.noteOn(36, 100);
    const block = new Float32Array(128);
    bank.renderBlock(block, 128);
    expect(rms(block)).toBeGreaterThan(1e-4);
  });

  it('Round-Robin wechselt zwischen den Regionen', () => {
    const bank = new SfzVoiceBank(24000);
    bank.load(SFZ, {
      'Kick.wav': sine(60, 12000),
      'KickRR.wav': sine(62, 12000),
      'Snare.wav': sine(190, 6000),
      'SnareRim.wav': sine(220, 6000),
    });
    const blockA = new Float32Array(256);
    bank.noteOn(36, 100);
    bank.renderBlock(blockA, 256);
    const blockB = new Float32Array(256);
    bank.noteOn(36, 100);
    bank.renderBlock(blockB, 256);
    let diff = 0;
    for (let i = 0; i < 256; i++) diff += Math.abs(blockA[i] - blockB[i]);
    expect(diff).toBeGreaterThan(0.001);
  });

  it('noteOff lässt die Stimme ausklingen', () => {
    const bank = new SfzVoiceBank(24000);
    bank.load(SFZ, {
      'Kick.wav': sine(60, 12000),
      'KickRR.wav': sine(62, 12000),
      'Snare.wav': sine(190, 6000),
      'SnareRim.wav': sine(220, 6000),
    });
    bank.noteOn(38, 80);
    const on = new Float32Array(128);
    bank.renderBlock(on, 128);
    bank.noteOff(38);
    const off = new Float32Array(2400);
    bank.renderBlock(off, 2400);
    expect(rms(on)).toBeGreaterThan(rms(off.subarray(off.length - 256)));
  });
});

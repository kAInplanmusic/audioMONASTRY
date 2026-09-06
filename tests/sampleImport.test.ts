// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  detectImportFormat,
  exsPlistToSfz,
  parseExsRegions,
  parseWav,
  sf2ToSfz,
  toMono,
  wavToSfz,
} from '../src/core/instrument/sampleImport';

/** Erzeugt ein minimales PCM16-Mono-WAV. */
function makeWavPcm16(samples: number[], rate = 44100): ArrayBuffer {
  const n = samples.length;
  const bytesPerSample = 2;
  const dataSize = n * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * bytesPerSample, true); v.setUint16(32, bytesPerSample, true);
  v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  return buf;
}

/** Minimales SF2: phdr + shdr + ein smpl-Sample (16-bit mono). */
function makeSf2(): ArrayBuffer {
  const sampleData = new Int16Array([0, 1000, 2000, 3000, 2000, 1000, 0, -1000]);
  const smpl = new Uint8Array(sampleData.buffer);
  const header = (chunkId: string, size: number) => {
    const b = new ArrayBuffer(8);
    const v = new DataView(b);
    for (let i = 0; i < 4; i++) v.setUint8(i, chunkId.charCodeAt(i));
    v.setUint32(4, size, true);
    return new Uint8Array(b);
  };
  const ascii = (s: string, len: number) => {
    const b = new Uint8Array(len);
    for (let i = 0; i < s.length && i < len; i++) b[i] = s.charCodeAt(i);
    return b;
  };
  const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };

  const shdrEntry = new Uint8Array(46);
  shdrEntry.set(ascii('Sine', 20), 0);
  shdrEntry.set(u32(0), 20); shdrEntry.set(u32(sampleData.length), 24);
  shdrEntry.set(u32(44100), 32);
  const phdrEntry = new Uint8Array(38);
  phdrEntry.set(ascii('Preset1', 20), 0);
  phdrEntry.set(u16(0), 34); // preset-Bank/Lok? sampleStartIndex in phdr liegt bei 34 in unserem Parser

  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let p = 0; for (const b of parts) { out.set(b, p); p += b.length; } return out;
  };
  const pdta = concat(header('phdr', phdrEntry.length * 2), phdrEntry, new Uint8Array(phdrEntry.length),
    header('shdr', shdrEntry.length * 2), shdrEntry, new Uint8Array(shdrEntry.length));
  const sdta = concat(header('smpl', smpl.length), smpl);
  const list = (type: string, body: Uint8Array) => concat(header('LIST', body.length + 4), ascii(type, 4), body);
  const body = concat(list('sdta', sdta), list('pdta', pdta));
  const riff = new Uint8Array(12 + body.length);
  riff.set(ascii('RIFF', 4), 0);
  new DataView(riff.buffer).setUint32(4, body.length + 4, true);
  riff.set(ascii('sfbk', 4), 8);
  riff.set(body, 12);
  return riff.buffer;
}

describe('sampleImport (AUDIO-7)', () => {
  it('parst PCM16-WAV korrekt', () => {
    const buf = makeWavPcm16([0.5, -0.5, 1, -1]);
    const w = parseWav(buf);
    expect(w.sampleRate).toBe(44100);
    expect(w.channels).toBe(1);
    expect(w.bitsPerSample).toBe(16);
    expect(w.samples[0]).toBeCloseTo(0.5, 4);
    expect(w.samples[1]).toBeCloseTo(-0.5, 4);
    expect(w.samples[2]).toBeCloseTo(1, 4);
  });

  it('konvertiert WAV zu SFZ-Instrument mit Mono-Sample', () => {
    const w = parseWav(makeWavPcm16([0.25, 0.5, 0.75]));
    const inst = wavToSfz('Kick 01', w);
    expect(inst.format).toBe('wav');
    expect(inst.sfzText).toContain('sample=Kick_01.wav');
    expect(inst.samples['Kick_01.wav'].length).toBe(3);
    expect(Array.from(toMono(w))).toEqual(Array.from(inst.samples['Kick_01.wav']));
  });

  it('detektiert WAV vs SF2 anhand der RIFF-Typen', () => {
    expect(detectImportFormat('x.wav', makeWavPcm16([0]))).toBe('wav');
    expect(detectImportFormat('x.sf2', makeSf2())).toBe('sf2');
  });

  it('konvertiert SF2-Subset zu SFZ mit Sample-Map', () => {
    const inst = sf2ToSfz('SF2Test', makeSf2());
    expect(inst.format).toBe('sf2');
    expect(inst.sampleRate).toBe(44100);
    const keys = Object.keys(inst.samples);
    expect(keys.length).toBeGreaterThan(0);
    expect(inst.sfzText).toContain('sample=');
    expect(inst.samples[keys[0]].length).toBe(8);
  });

  it('parst EXS-plist-XML zu Regionen und SFZ', () => {
    const xml = `<?xml version="1.0"?><plist><dict>
      <key>filename</key><string>piano_c3.wav</string><key>note</key><integer>60</integer>
      <key>lo key</key><integer>55</integer><key>hi key</key><integer>64</integer>
    </dict></plist>`;
    const regions = parseExsRegions(xml);
    expect(regions[0]).toMatchObject({ file: 'piano_c3.wav', key: 60, loKey: 55, hiKey: 64 });
    const samples = { piano_c3_wav: new Float32Array(64) };
    const inst = exsPlistToSfz('Piano', xml, samples);
    expect(inst.sfzText).toContain('sample=piano_c3_wav');
    expect(inst.sfzText).toContain('pitch_keycenter=60');
  });
});

import { describe, expect, it } from 'vitest';
import {
  WAV_HEADER_BYTES,
  encodeWavFromAudioBuffer,
  encodeWavFromChannels,
  encodeWavMono,
  quantizeInt16,
} from '../src/utils/wavEncode';

/** Liest einen Blob als Bytes (jsdom/Node-freundlich). */
async function bytesOf(blob: Blob): Promise<DataView> {
  const arrayBuffer = await blob.arrayBuffer();
  return new DataView(arrayBuffer);
}

function ascii(view: DataView, offset: number, len = 4): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('WAV-Encoder – Header', () => {
  it('schreibt einen korrekten 44-Byte-RIFF/WAVE-Header (mono)', async () => {
    const samples = new Float32Array(100);
    const blob = encodeWavMono(samples, 22050);
    expect(blob.type).toBe('audio/wav');
    const view = await bytesOf(blob);

    expect(view.byteLength).toBe(WAV_HEADER_BYTES + 200);
    expect(ascii(view, 0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 200); // Chunk-Größe
    expect(ascii(view, 8)).toBe('WAVE');
    expect(ascii(view, 12)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // Kanäle
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint32(28, true)).toBe(22050 * 2); // Byte-Rate
    expect(view.getUint16(32, true)).toBe(2); // Block-Align
    expect(view.getUint16(34, true)).toBe(16); // Bits je Sample
    expect(ascii(view, 36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(200);
  });

  it('verschränkt zwei Kanäle in der Reihenfolge L,R (Block-Align 4)', async () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0.5, 0]);
    const view = await bytesOf(encodeWavFromChannels([left, right], 48000));

    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint32(28, true)).toBe(48000 * 4);

    const frame = (i: number) => ({
      l: view.getInt16(WAV_HEADER_BYTES + i * 4, true),
      r: view.getInt16(WAV_HEADER_BYTES + i * 4 + 2, true),
    });
    expect(frame(0)).toEqual({ l: 32767, r: 0 });
    expect(frame(1)).toEqual({ l: 0, r: quantizeInt16(0.5) });
    expect(frame(2)).toEqual({ l: -32768, r: 0 });
  });

  it('begrenzt auf 2 Kanäle (WAV-PCM-Stereo) und hält den Header konsistent', async () => {
    const ch = new Float32Array([0.1, 0.2]);
    const view = await bytesOf(encodeWavFromChannels([ch, ch, ch, ch], 44100));
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.byteLength).toBe(WAV_HEADER_BYTES + 2 * 2 * 2);
  });

  it('weicht bei unsinniger Sample-Rate auf 44100 aus, statt einen kaputten Header zu schreiben', async () => {
    const view = await bytesOf(encodeWavFromChannels([new Float32Array(2)], Number.NaN));
    expect(view.getUint32(24, true)).toBe(44100);
  });
});

describe('WAV-Encoder – Quantisierung', () => {
  it('klemmt auf den vollen int16-Bereich (asymmetrisch, richtig gerundet)', () => {
    expect(quantizeInt16(0)).toBe(0);
    expect(quantizeInt16(1)).toBe(32767);
    expect(quantizeInt16(-1)).toBe(-32768);
    expect(quantizeInt16(2)).toBe(32767);
    expect(quantizeInt16(-2)).toBe(-32768);
    // Abschneiden statt runden (wie zuvor durch setInt16): 0.5 * 32767 = 16383,5 → 16383
    expect(quantizeInt16(0.5)).toBe(16383);
    expect(quantizeInt16(-0.5)).toBe(-16384); // 0.5 * -32768 = -16384 (exakt)
  });

  it('macht aus NaN/Infinity Stille statt undefinierter PCM-Bits', () => {
    expect(quantizeInt16(Number.NaN)).toBe(0);
    expect(quantizeInt16(Number.POSITIVE_INFINITY)).toBe(0);
    expect(quantizeInt16(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('schreibt NaN-Samples als 0 in die Datei', async () => {
    const view = await bytesOf(encodeWavMono(new Float32Array([Number.NaN, 0.5]), 8000));
    expect(view.getInt16(WAV_HEADER_BYTES, true)).toBe(0);
    expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(quantizeInt16(0.5));
  });
});

describe('WAV-Encoder – AudioBuffer-Pfad', () => {
  it('liefert für gleiche Daten dieselben Bytes wie der Kanal-Pfad', async () => {
    const left = new Float32Array([0.25, -0.25, 1, -1]);
    const right = new Float32Array([0, 0.75, -0.5, 0.1]);
    const fakeBuffer = {
      numberOfChannels: 2,
      length: left.length,
      sampleRate: 44100,
      getChannelData: (ch: number) => (ch === 0 ? left : right),
    } as unknown as AudioBuffer;

    const viaBuffer = new Uint8Array(await encodeWavFromAudioBuffer(fakeBuffer).arrayBuffer());
    const viaChannels = new Uint8Array(await encodeWavFromChannels([left, right], 44100).arrayBuffer());
    expect(Array.from(viaBuffer)).toEqual(Array.from(viaChannels));
  });
});

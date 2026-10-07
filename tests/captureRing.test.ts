// @vitest-environment node
/**
 * IDEA-2026-10-07-A · Capture: Audio-Ring (writeCaptureBlock/readCaptureRing),
 * Stille-Trimmen und der echte captureTapProcessor mit gestubten Worklet-Globals.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CAPTURE_HEADER,
  CAPTURE_HEADER_LENGTH,
  captureTotalFrames,
  initCaptureHeader,
  readCaptureRing,
  trimLeadingSilence,
  trimTrailingSilence,
  writeCaptureBlock,
} from '../src/core/capture/captureRing';
import { isAudioCaptureSupported } from '../src/core/capture/audioCapture';

function makeRing(frames: number, sampleRate = 100) {
  const data = new SharedArrayBuffer(frames * 2 * 4);
  const header = new Int32Array(new SharedArrayBuffer(CAPTURE_HEADER_LENGTH * 4));
  initCaptureHeader(header, frames, sampleRate);
  return { data, ringL: new Float32Array(data, 0, frames), ringR: new Float32Array(data, frames * 4, frames), header };
}

function ramp(from: number, n: number, sign = 1): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = sign * (from + i);
  return a;
}

describe('captureRing · Schreiben/Lesen', () => {
  it('weniger geschrieben als angefragt → nur die geschriebenen Frames', () => {
    const { ringL, ringR, header } = makeRing(10);
    writeCaptureBlock(ringL, ringR, header, ramp(1, 4), ramp(1, 4, -1), 4);
    const [l, r] = readCaptureRing(ringL, ringR, header, 60, 100);
    expect(Array.from(l)).toEqual([1, 2, 3, 4]);
    expect(Array.from(r)).toEqual([-1, -2, -3, -4]);
    expect(captureTotalFrames(header)).toBe(4);
  });

  it('Wraparound: liefert chronologisch die letzten Frames', () => {
    const { ringL, ringR, header } = makeRing(10);
    for (let b = 0; b < 4; b++) writeCaptureBlock(ringL, ringR, header, ramp(b * 4, 4), null, 4); // 16 Frames: 0..15
    expect(Atomics.load(header, CAPTURE_HEADER.WRITE_FRAME)).toBe(6);
    const [all] = readCaptureRing(ringL, ringR, header, 1, 10); // 10 Frames gewünscht = Kapazität
    expect(Array.from(all)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const [last3, right3] = readCaptureRing(ringL, ringR, header, 0.3, 10);
    expect(Array.from(last3)).toEqual([13, 14, 15]);
    expect(Array.from(right3)).toEqual([13, 14, 15]); // Mono → L auf beide
  });

  it('Ausschnitt exakt 60 s, wenn mehr geschrieben wurde (Ring mit 1 s Reserve)', () => {
    const sr = 100;
    const { ringL, ringR, header } = makeRing(61 * sr, sr);
    const block = 128;
    const total = 70 * sr + 37; // ungerade Blockgrenze
    let written = 0;
    while (written < total) {
      const n = Math.min(block, total - written);
      writeCaptureBlock(ringL, ringR, header, ramp(written, n), ramp(written, n, -1), n);
      written += n;
    }
    const [l, r] = readCaptureRing(ringL, ringR, header, 60, sr);
    expect(l.length).toBe(60 * sr);
    expect(l[0]).toBe(total - 60 * sr);
    expect(l[l.length - 1]).toBe(total - 1);
    expect(r[r.length - 1]).toBe(-(total - 1));
  });

  it('ohne Eingang schreibt der Block Stille und die Zeitachse läuft weiter', () => {
    const { ringL, ringR, header } = makeRing(8);
    writeCaptureBlock(ringL, ringR, header, ramp(1, 4), null, 4);
    writeCaptureBlock(ringL, ringR, header, null, null, 4);
    const [l] = readCaptureRing(ringL, ringR, header, 1, 8);
    expect(Array.from(l)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
  });

  it('Gesamtzähler läuft über 2^32 korrekt in das High-Wort', () => {
    const { ringL, ringR, header } = makeRing(4);
    Atomics.store(header, CAPTURE_HEADER.TOTAL_LOW, -2); // 0xFFFFFFFE
    writeCaptureBlock(ringL, ringR, header, ramp(0, 4), null, 4);
    expect(captureTotalFrames(header)).toBe(4294967296 + 2);
  });
});

describe('captureRing · Stille trimmen', () => {
  it('schneidet führende Stille unter −60 dBFS ab (beide Kanäle zählen)', () => {
    const l = new Float32Array([0, 0.0001, 0, 0, 0.5, 0]);
    const r = new Float32Array([0, 0, 0, 0.01, 0, 0]);
    const [tl, tr] = trimLeadingSilence([l, r]);
    expect(tl.length).toBe(3);
    expect(tr[0]).toBeCloseTo(0.01, 6);
  });

  it('nur Stille → leere Kanäle; nachlaufende Stille wird ebenfalls entfernt', () => {
    expect(trimLeadingSilence([new Float32Array(5), new Float32Array(5)])[0].length).toBe(0);
    const [t] = trimTrailingSilence([new Float32Array([0.2, 0.3, 0, 0])]);
    expect(Array.from(t)).toEqual([expect.closeTo(0.2, 6), expect.closeTo(0.3, 6)]);
  });

  it('isAudioCaptureSupported verlangt crossOriginIsolated', () => {
    const g = globalThis as { crossOriginIsolated?: boolean };
    const prev = g.crossOriginIsolated;
    g.crossOriginIsolated = false;
    expect(isAudioCaptureSupported()).toBe(false);
    g.crossOriginIsolated = true;
    expect(isAudioCaptureSupported()).toBe(true);
    g.crossOriginIsolated = prev;
  });
});

interface TapInstance {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let TapCtor: (new () => TapInstance) | null = null;

describe('captureTapProcessor (echter Worklet-Code, gestubte Globals)', () => {
  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.sampleRate = 48000;
    g.currentFrame = 0;
    g.currentTime = 0;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null, postMessage: () => {} };
    };
    g.registerProcessor = (name: string, ctor: new () => TapInstance) => {
      if (name === 'capture-tap-processor') TapCtor = ctor;
    };
    await import('../src/audio/worklets/captureTapProcessor.ts');
    expect(TapCtor).not.toBeNull();
  });

  it('schreibt Stereo in den SAB-Ring, Ausgang bleibt Null, Mono → L auf beide', () => {
    const p = new TapCtor!();
    const frames = 512;
    const data = new SharedArrayBuffer(frames * 2 * 4);
    const headerBuf = new SharedArrayBuffer(CAPTURE_HEADER_LENGTH * 4);
    const header = new Int32Array(headerBuf);
    initCaptureHeader(header, frames, 48000);
    p.port.onmessage?.({ data: { type: 'capture-sab', data, header: headerBuf, frames } });

    const out = [new Float32Array(128).fill(7)];
    expect(p.process([[ramp(1, 128), ramp(1, 128, -1)]], [out])).toBe(true);
    expect(out[0].every((v) => v === 0)).toBe(true);
    expect(p.process([[ramp(200, 128)]], [[new Float32Array(128)]])).toBe(true);
    expect(p.process([[]], [[new Float32Array(128)]])).toBe(true); // kein Eingang → Stille

    const ringL = new Float32Array(data, 0, frames);
    const ringR = new Float32Array(data, frames * 4, frames);
    const [l, r] = readCaptureRing(ringL, ringR, header, 1, 48000);
    expect(l.length).toBe(384);
    expect(l[0]).toBe(1);
    expect(r[0]).toBe(-1);
    expect(l[128]).toBe(200);
    expect(r[128]).toBe(200);
    expect(l[300]).toBe(0);

    p.port.onmessage?.({ data: { type: 'capture-stop' } });
    expect(p.process([[ramp(1, 128)]], [[new Float32Array(128)]])).toBe(false);
  });

  it('ohne SAB-Nachricht ist process() ein No-Op (läuft weiter)', () => {
    const p = new TapCtor!();
    const out = [new Float32Array(128).fill(1)];
    expect(p.process([[ramp(1, 128)]], [out])).toBe(true);
    expect(out[0][0]).toBe(0);
  });
});

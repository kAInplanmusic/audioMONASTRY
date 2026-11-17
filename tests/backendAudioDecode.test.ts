import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeBackendAudio } from '../server/backendAudioDecode';

const formats = [
  ['wav', 'pcm_s24le', 'wav'], ['mp3', 'libmp3lame', 'mp3'], ['flac', 'flac', 'flac'],
  ['aac', 'aac', 'adts'], ['aiff', 'pcm_s24be', 'aiff'], ['ogg', 'libvorbis', 'ogg'], ['m4a', 'aac', 'ipod'],
] as const;
function fixture(codec: string, format: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'decode-fixture-'));
  const path = join(dir, `fixture.${format}`);
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=96000:duration=0.1', '-ac', '2', '-c:a', codec, '-f', format, path]);
    return readFileSync(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe('backend audio decode', () => {
  for (const [name, codec, format] of formats) it(`decodes real ${name}`, async () => {
    const result = await decodeBackendAudio(fixture(codec, format));
    expect(result.sampleRate).toBe(96000);
    expect(result.channels).toBe(2);
    expect(result.bitDepth).toBe(24);
    // Lossy codecs may emit encoder priming or padding; do not claim exact duration.
    expect(result.frames).toBeGreaterThan(8000);
    expect(result.frames).toBeLessThan(14000);
    expect(result.pcm.length).toBe(result.frames * 6);
  });
  it('honors seekable MP3 gapless duration', async () => {
    const result = await decodeBackendAudio(fixture('libmp3lame', 'mp3'));
    expect(result.frames).toBe(9600);
  });
  it('preserves PCM24 samples in FLAC at each supported rate', async () => {
    for (const sampleRate of [48000, 96000, 192000] as const) {
      const source = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=997:sample_rate=${sampleRate}:duration=0.1`, '-ac', '2', '-c:a', 'pcm_s24le', '-f', 's24le', 'pipe:1']);
      const flac = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's24le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0', '-c:a', 'flac', '-f', 'flac', 'pipe:1'], { input: source });
      const decoded = await decodeBackendAudio(flac, { sampleRate });
      expect(decoded.frames).toBe(sampleRate / 10);
      expect(decoded.pcm.equals(source)).toBe(true);
    }
  });
  it('rejects invalid input and enforces limits', async () => {
    await expect(decodeBackendAudio(Buffer.alloc(0))).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
    await expect(decodeBackendAudio(Buffer.from('bad'))).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    await expect(decodeBackendAudio(Buffer.alloc(4), { maxInputBytes: 3 })).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    await expect(decodeBackendAudio(fixture('flac', 'flac'), { maxOutputBytes: 100 })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    await expect(decodeBackendAudio(Buffer.from('x'), { ffmpegBin: '/nonexistent/ffmpeg' })).rejects.toMatchObject({ code: 'NO_FFMPEG' });
  });
});

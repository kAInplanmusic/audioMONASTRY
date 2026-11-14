import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type BackendSampleRate = 48000 | 96000 | 192000;
export type AudioDecodeErrorCode = 'EMPTY_INPUT' | 'INPUT_LIMIT' | 'INVALID_OPTIONS' | 'NO_FFMPEG' | 'DECODE_FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT';
export class AudioDecodeError extends Error {
  constructor(public readonly code: AudioDecodeErrorCode, message: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}
export interface BackendDecodeOptions {
  sampleRate?: BackendSampleRate;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  ffmpegBin?: string;
}
/** ID3-tagged or raw MPEG audio; ADTS AAC has reserved MPEG layer bits 00. */
function looksLikeMp3(input: Buffer): boolean {
  if (input.length >= 10 && input.toString('ascii', 0, 3) === 'ID3') return true;
  if (input.length < 4 || input[0] !== 0xff || (input[1] & 0xe0) !== 0xe0) return false;
  const version = (input[1] >> 3) & 3, layer = (input[1] >> 1) & 3;
  const bitrate = input[2] >> 4, rate = (input[2] >> 2) & 3;
  return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && rate !== 3;
}
/** Decode an in-memory asset to interleaved signed 24-bit little-endian stereo PCM. */
export async function decodeBackendAudio(input: Buffer, options: BackendDecodeOptions = {}): Promise<{ pcm: Buffer; sampleRate: BackendSampleRate; channels: 2; bitDepth: 24; frames: number }> {
  const sampleRate = options.sampleRate ?? 96000;
  const maxInputBytes = options.maxInputBytes ?? 64 * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (![48000, 96000, 192000].includes(sampleRate) || ![maxInputBytes, maxOutputBytes, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new AudioDecodeError('INVALID_OPTIONS', 'Invalid decoder rate or limit');
  if (!input.length) throw new AudioDecodeError('EMPTY_INPUT', 'Empty audio input');
  if (input.length > maxInputBytes) throw new AudioDecodeError('INPUT_LIMIT', 'Audio input exceeds byte limit');
  let dir: string | undefined;
  try {
    const mp3 = looksLikeMp3(input);
    if (mp3) {
      dir = await mkdtemp(join(tmpdir(), 'audiomonastry-decode-'));
      await writeFile(join(dir, 'input.mp3'), input, { mode: 0o600, flag: 'wx' });
    }
    return await new Promise((resolve, reject) => {
    const inputArgs = mp3 ? ['-protocol_whitelist', 'file,pipe', '-f', 'mp3', '-i', join(dir!, 'input.mp3')] : ['-protocol_whitelist', 'pipe', '-i', 'pipe:0'];
    const child = spawn(options.ffmpegBin || process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', ...inputArgs, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '2', '-ar', String(sampleRate), '-c:a', 'pcm_s24le', '-f', 's24le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: AudioDecodeError | undefined;
    const stop = (error: AudioDecodeError) => { if (!failure) failure = error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new AudioDecodeError('TIMEOUT', 'Audio decode timed out')), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxOutputBytes) stop(new AudioDecodeError('OUTPUT_LIMIT', 'Decoded audio exceeds byte limit')); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 1024) stderr += chunk.toString().slice(0, 1024 - stderr.length); });
    child.stdin.on('error', () => {});
    child.on('error', error => { failure ??= new AudioDecodeError('NO_FFMPEG', error.message); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || size === 0 || size % 6 !== 0) return reject(new AudioDecodeError('DECODE_FAILED', stderr.trim() || 'Invalid or empty decoded audio'));
      resolve({ pcm: Buffer.concat(chunks, size), sampleRate, channels: 2, bitDepth: 24, frames: size / 6 });
    });
    child.stdin.end(mp3 ? undefined : input);
    });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBackendAudio } from '../../server/backendAudioDecode';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'decode-frame-proof-'));
  try {
    const rows = [];
    for (const [name, codec, format, lossless] of [
      ['wav', 'pcm_s24le', 'wav', true], ['mp3', 'libmp3lame', 'mp3', false],
      ['flac', 'flac', 'flac', true], ['aac', 'aac', 'adts', false],
      ['aiff', 'pcm_s24be', 'aiff', true], ['ogg', 'libvorbis', 'ogg', false], ['m4a', 'aac', 'ipod', false],
    ] as const) {
      const path = join(dir, `fixture.${name}`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=96000:duration=0.1', '-ac', '2', '-c:a', codec, '-f', format, path]);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate:frame=nb_samples', '-show_frames', '-of', 'json', path], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
      const sourceRate = Number(probe.streams[0].sample_rate);
      const probeFrames = probe.frames.reduce((n: number, frame: { nb_samples: number }) => n + Number(frame.nb_samples), 0);
      const targetReference = probeFrames * 96000 / sourceRate;
      const decoded = await decodeBackendAudio(readFileSync(path));
      if (lossless) { assert.equal(sourceRate, 96000); assert.equal(probeFrames, 9600); assert.equal(decoded.frames, 9600); }
      rows.push({ format: name, lossless, encodedStreamSampleRate: sourceRate, ffprobeDecodedFrames: probeFrames, ffprobeRateScaledFrames: targetReference, backendOutputRate: decoded.sampleRate, backendDecodedFrames: decoded.frames, differenceFromRateScaledProbe: decoded.frames - targetReference });
    }
    console.log(JSON.stringify({ sourceFrames: 9600, sourceRate: 96000, method: 'FFprobe counts decoded frame nb_samples on seekable fixture; backend uses a seekable temporary file for identified MP3 and stdin for other formats. Rate scaling does not account for resampler rounding, container seekability, gapless trim or codec padding.', rows }, null, 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

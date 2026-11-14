import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBackendAudio } from '../../server/backendAudioDecode';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'architecture-format-'));
  try {
    const rows = [];
    for (const [name, codec, format] of [['wav','pcm_s24le','wav'], ['mp3','libmp3lame','mp3'], ['flac','flac','flac'], ['aac','aac','adts'], ['aiff','pcm_s24be','aiff'], ['ogg','libvorbis','ogg'], ['m4a','aac','ipod']]) {
      const path = join(dir, `source.${name}`);
      execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=997:sample_rate=96000:duration=0.1','-ac','2','-c:a',codec,'-f',format,path]);
      const decoded = await decodeBackendAudio(readFileSync(path));
      rows.push({ format: name, frames: decoded.frames, sampleRate: decoded.sampleRate, channels: decoded.channels, bitDepth: decoded.bitDepth });
    }
    console.log(JSON.stringify({ sourceFrames: 9600, note: 'Lossy codec priming and padding can change decoded frame counts.', rows }, null, 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

// PROD-P1-002: Audio-Qualitaets-Gate (LUFS/True-Peak) über die Golden-WAVs.
// Positiv: die committed Goldens bestehen. Negativ: ein übersteuertes WAV
// muss das Gate brechen (sonst schützt es nichts).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../scripts/audio-gate.sh');
const goldenDir = resolve(__dirname, 'fixtures/audio');

function gate(dir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', [script, dir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (e: any) {
    return { status: typeof e?.status === 'number' ? e.status : 1, stdout: String(e?.stdout ?? '') };
  }
}

describe('PROD-P1-002 Audio-Gate', () => {
  it('besteht die Golden-WAVs', () => {
    const r = gate(goldenDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('AUDIO-GATE: OK');
  });

  it('schlägt bei einem übersteuerten WAV fehl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audio-gate-'));
    const clip = join(dir, 'clip.wav');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.5:sample_rate=48000',
      '-af', 'volume=20dB',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      clip,
      '-y',
    ]);
    const r = gate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('AUDIO-GATE: FEHLGESCHLAGEN');
  });
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIO_EXPORT_FORMATS,
  AudioEncodeError,
  buildEncodeArgs,
  buildMetadataArgs,
  encodeAudioBuffer,
  exportFileName,
  exportFormatInfo,
  ffmpegAvailable,
  resetFfmpegProbe,
  sanitizeMetadataValue,
} from '../server/audioEncode';

/**
 * FEAT-P3-004: Export/Bounce konnten nur WAV. Geprüft wird der reine
 * Argument-Bauer, das Fehlerverhalten ohne ffmpeg UND - wie beim Audio-Gate
 * (tests/audioGate.test.ts) - ein echter ffmpeg-Lauf mit ffprobe-Gegenprobe
 * (Codec, Dauer, Tags).
 */

/** Minimales WAV (mono, 16 Bit, 0,4 s, 440 Hz) - ohne ffmpeg erzeugt. */
function sineWav(sampleRate = 44100, seconds = 0.4, frequency = 440): Buffer {
  const frames = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function ffprobeJson(file: string): Record<string, any> {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

describe('FEAT-P3-004 · Formatkatalog (rein)', () => {
  it('kennt WAV/FLAC/MP3/AAC/OGG inkl. Aliase', () => {
    expect(AUDIO_EXPORT_FORMATS.map((f) => f.format)).toEqual(['wav', 'flac', 'mp3', 'aac', 'ogg']);
    expect(exportFormatInfo('MP3')?.codec).toBe('libmp3lame');
    expect(exportFormatInfo('m4a')?.format).toBe('aac');
    expect(exportFormatInfo('mp4')?.format).toBe('aac');
    expect(exportFormatInfo(' aac ')?.extension).toBe('m4a');
    expect(exportFormatInfo('opus')).toBeNull();
    expect(exportFormatInfo(undefined)).toBeNull();
  });

  it('markiert verlustfreie Formate und Default-Bitraten', () => {
    expect(exportFormatInfo('wav')?.lossless).toBe(true);
    expect(exportFormatInfo('flac')?.lossless).toBe(true);
    expect(exportFormatInfo('mp3')).toMatchObject({ lossless: false, defaultBitrateKbps: 320 });
    expect(exportFormatInfo('ogg')?.defaultQuality).toBe(6);
  });

  it('baut die ffmpeg-Argumente deterministisch', () => {
    const mp3 = buildEncodeArgs('/in.wav', '/out.mp3', exportFormatInfo('mp3')!, { title: 'Mixdown', artist: 'MONK' });
    expect(mp3).toContain('libmp3lame');
    expect(mp3).toEqual(expect.arrayContaining(['-b:a', '320k', '-id3v2_version', '3', '-metadata', 'title=Mixdown', '-metadata', 'artist=MONK']));
    expect(mp3[mp3.length - 1]).toBe('/out.mp3');

    // Verlustfrei: keine Bitraten-Angabe, feste Kompressionsstufe.
    const flac = buildEncodeArgs('/in.wav', '/out.flac', exportFormatInfo('flac')!);
    expect(flac).toContain('flac');
    expect(flac).not.toContain('-b:a');
    expect(flac).toEqual(expect.arrayContaining(['-compression_level', '8']));

    // OGG laeuft bewusst VBR: libvorbis lehnt hohe CBR-Bitraten je nach
    // Kanalzahl ab ("encoder setup failed" bei Mono/44.1 kHz).
    const ogg = buildEncodeArgs('/in.wav', '/out.ogg', exportFormatInfo('ogg')!);
    expect(ogg).toEqual(expect.arrayContaining(['-q:a', '6']));
    expect(ogg).not.toContain('-b:a');
    const oggHigh = buildEncodeArgs('/in.wav', '/out.ogg', exportFormatInfo('ogg')!, { quality: 25 });
    expect(oggHigh).toEqual(expect.arrayContaining(['-q:a', '10']));
  });

  it('bereinigt Metadaten (keine Umbrüche, Länge begrenzt)', () => {
    expect(sanitizeMetadataValue('a\nb\tc')).toBe('a b c');
    expect(sanitizeMetadataValue('x'.repeat(500)).length).toBe(200);
    expect(buildMetadataArgs({ title: '', artist: 'A' })).toEqual(['-metadata', 'artist=A']);
    expect(buildMetadataArgs({})).toEqual([]);
  });

  it('baut sichere Dateinamen', () => {
    const mp3 = exportFormatInfo('mp3')!;
    expect(exportFileName(mp3, 'audiomonastry-master')).toBe('audiomonastry-master.mp3');
    expect(exportFileName(mp3, '../../etc/passwd"')).toBe('etc-passwd.mp3');
    expect(exportFileName(mp3, '')).toBe('audiomonastry-mixdown.mp3');
    // AAC liegt im M4A-Container.
    expect(exportFileName(exportFormatInfo('aac')!, 'master')).toBe('master.m4a');
  });

  it('wirft typisierte Fehler statt still zu scheitern', async () => {
    await expect(encodeAudioBuffer(Buffer.from('x'), 'opus')).rejects.toMatchObject({ code: 'UNKNOWN_FORMAT' });
    await expect(encodeAudioBuffer(Buffer.alloc(0), 'mp3')).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
    resetFfmpegProbe();
    await expect(encodeAudioBuffer(sineWav(), 'mp3', { ffmpegBin: '/nonexistent-ffmpeg-binary' })).rejects.toMatchObject({
      code: 'NO_FFMPEG',
    });
    // Ein Fehlschlag darf NICHT dauerhaft cachen (transienter Last-Timeout
    // haette sonst den ganzen Export abgeschaltet - live beobachtet 2026-09-17).
    expect(await ffmpegAvailable()).toBe(true);
    // Zeitschranke: die ffmpeg-Probe darf bis FFMPEG_PROBE_TIMEOUT_MS (30 s)
    // laufen - das vitest-Limit von 15 s riss diesen Test unter voller Suite-Last
    // (real gesehen am 2026-09-18, waehrend parallel ein Image-Build lief). Der
    // Test prueft bewusst die Probe, also bekommt er ein passendes Budget.
  }, 45_000);

  it('lässt WAV unverändert durch (kein ffmpeg, bit-identisch)', async () => {
    const wav = sineWav();
    const { data, info } = await encodeAudioBuffer(wav, 'wav');
    expect(info.format).toBe('wav');
    expect(data.equals(wav)).toBe(true);
  });

  it('kodiert MP3/FLAC/AAC/OGG und ffprobe bestätigt Codec, Dauer und Tags', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'audiomonastry-encode-test-'));
    try {
      const wav = sineWav();
      const expected: Array<[string, string, string]> = [
        ['mp3', 'mp3', 'audio/mpeg'],
        ['flac', 'flac', 'audio/flac'],
        ['aac', 'aac', 'audio/mp4'],
        ['ogg', 'vorbis', 'audio/ogg'],
      ];
      for (const [format, codecName, mimeType] of expected) {
        const { data, info } = await encodeAudioBuffer(wav, format, {
          title: 'Prüfton',
          artist: 'audioMONASTRY',
        });
        expect(info.mimeType).toBe(mimeType);
        expect(data.length).toBeGreaterThan(1000);

        const file = join(workDir, `out-${format}.${info.extension}`);
        writeFileSync(file, data);
        expect(existsSync(file)).toBe(true);

        const probe = ffprobeJson(file);
        expect(probe.streams?.[0]?.codec_name).toBe(codecName);
        expect(Number(probe.format?.duration)).toBeGreaterThan(0.3);
        expect(Number(probe.format?.duration)).toBeLessThan(0.6);
        // Metadaten müssen im Container landen (Acceptance: "korrekte Metadaten").
        const tags = { ...(probe.format?.tags ?? {}), ...(probe.streams?.[0]?.tags ?? {}) };
        const joined = Object.values(tags).join('|');
        expect(joined).toContain('Prüfton');
        expect(joined).toContain('audioMONASTRY');
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('meldet einen kaputten Eingabepuffer als ENCODE_FAILED', async () => {
    await expect(encodeAudioBuffer(Buffer.from('kein wav'), 'flac')).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
    expect(new AudioEncodeError('ENCODE_FAILED', 'x').name).toBe('AudioEncodeError');
  });
});

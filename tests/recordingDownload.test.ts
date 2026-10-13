import { describe, expect, it, vi } from 'vitest';
import {
  downloadRecordingAsWav,
  isServerAudioUrl,
  isWavBytes,
  RecordingDownloadError,
  wavFileName,
  type RecordingDownloadDeps,
} from '../src/utils/recordingDownload';
import { encodeWavFromChannels } from '../src/utils/wavEncode';

// ---------------------------------------------------------------------------
// STORE-P1-001: recordMONK-Aufnahme als WAV herunterladen – Audio vom Server,
// keine Gerätekopie als Quelle.
// ---------------------------------------------------------------------------

function deps(body: ArrayBuffer, over: Partial<RecordingDownloadDeps> = {}) {
  const saved: Array<{ blob: Blob; name: string }> = [];
  const d: RecordingDownloadDeps = {
    fetch: vi.fn(async () => new Response(body, { status: 200 })),
    decode: vi.fn(async () => ({
      numberOfChannels: 1,
      sampleRate: 48000,
      length: 4,
      getChannelData: () => new Float32Array([0, 0.5, -0.5, 0]),
    }) as unknown as AudioBuffer),
    save: vi.fn(async (blob: Blob, name: string) => {
      saved.push({ blob, name });
      return 'downloaded' as const;
    }),
    ...over,
  };
  return { d, saved };
}

describe('recordMONK – WAV-Download', () => {
  it('nur Server-Adressen sind Quelle', () => {
    expect(isServerAudioUrl('/api/media/uploads/rec-1.wav')).toBe(true);
    expect(isServerAudioUrl('https://cdn.example/x.wav')).toBe(true);
    expect(isServerAudioUrl('blob:http://localhost/abc')).toBe(false);
    expect(isServerAudioUrl('data:audio/wav;base64,AA')).toBe(false);
    expect(isServerAudioUrl(undefined)).toBe(false);
  });

  it('Take noch nicht hochgeladen (blob:) → kein Download', async () => {
    const { d } = deps(new ArrayBuffer(0));
    await expect(downloadRecordingAsWav('blob:http://x/1', 'a.webm', d)).rejects.toMatchObject({ code: 'NOT_ON_SERVER' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('WAV vom Server läuft bit-identisch durch, ohne Browser-Cache', async () => {
    const wav = encodeWavFromChannels([new Float32Array([0, 0.25, -0.25])], 48000);
    const bytes = await wav.arrayBuffer();
    const { d, saved } = deps(bytes);
    const r = await downloadRecordingAsWav('/api/media/uploads/rec-1.wav', 'Chain_Bounce_1.wav', d);
    expect(r).toBe('downloaded');
    expect(d.fetch).toHaveBeenCalledWith('/api/media/uploads/rec-1.wav', { cache: 'no-store' });
    expect(d.decode).not.toHaveBeenCalled();
    expect(saved[0].name).toBe('Chain_Bounce_1.wav');
    expect(new Uint8Array(await saved[0].blob.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });

  it('WebM-Aufnahme wird decodiert und als WAV gespeichert', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    const { d, saved } = deps(webm);
    await downloadRecordingAsWav('/api/media/uploads/rec-2.wav', 'MASTER_OUT_Take_x.webm', d);
    expect(d.decode).toHaveBeenCalledTimes(1);
    expect(saved[0].name).toBe('MASTER_OUT_Take_x.wav');
    expect(isWavBytes(new Uint8Array(await saved[0].blob.arrayBuffer()))).toBe(true);
  });

  it('Server-Fehler wird gemeldet', async () => {
    const { d } = deps(new ArrayBuffer(0), { fetch: vi.fn(async () => new Response('', { status: 404 })) });
    const p = downloadRecordingAsWav('/api/media/uploads/missing.wav', 'x', d);
    await expect(p).rejects.toBeInstanceOf(RecordingDownloadError);
    await expect(p).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('Dateiname immer .wav ohne Pfadanteile', () => {
    expect(wavFileName('../../etc/passwd')).toBe('etc-passwd.wav');
    expect(wavFileName('')).toBe('recordMONK-take.wav');
  });
});

// @vitest-environment node
/**
 * DROP-P1-001 · dropMONK Audio-Drop-Client
 * Aufruf mit Session-Kennung, Retry bei POD_NOT_READY, klare Fehler, Pad-Profil
 * und Abspielen ueber den Einspiel-Weg (Bar-genau bei quantized).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_DROP_ENDPOINT,
  AudioDropError,
  audioDropProfile,
  isAudioDropProfile,
  playAudioDrop,
  projectKeyForDrop,
  requestAudioDrop,
  setDropAudioAdapter,
  type AudioDropResult,
  type DropAudioAdapter,
} from '../src/core/drop';
import { setSessionIdentity } from '../src/core/session/sessionIdentity';

const RESULT: AudioDropResult = {
  libraryId: 'lib-1',
  url: '/api/media/uploads/lib-1.wav',
  name: 'AI Drop dark',
  format: 'wav',
  bpm: 128,
  key: 'A Minor',
  durationSeconds: 15,
  seed: null,
  model: 'acestep-v15-xl-turbo',
  steps: 8,
  cached: false,
  costUsd: 0.01,
};

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body }) as unknown as Response;

afterEach(() => setDropAudioAdapter(null));

describe('requestAudioDrop', () => {
  it('sendet Prompt/BPM/Tonart/Takte mit x-session-id an die Server-Route', async () => {
    setSessionIdentity('user-alpha');
    const fetchImpl = vi.fn(async () => json(200, RESULT));
    const res = await requestAudioDrop({ prompt: 'dark', bpm: 128, key: 'Am', bars: 8 }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.libraryId).toBe('lib-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(AUDIO_DROP_ENDPOINT);
    expect((init.headers as Record<string, string>)['x-session-id']).toBe('user-alpha');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'dark', bpm: 128, key: 'Am', bars: 8 });
  });

  it('wiederholt bei POD_NOT_READY mit der Server-Wartezeit und meldet den Status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(503, { code: 'POD_NOT_READY', retryable: true, retryAfterMs: 2000, error: 'Kaltstart' }))
      .mockResolvedValueOnce(json(200, RESULT));
    const sleep = vi.fn(async () => {});
    const onStatus = vi.fn();
    const res = await requestAudioDrop({ prompt: 'x' }, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep, onStatus });
    expect(res.libraryId).toBe('lib-1');
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(onStatus.mock.calls[0][0]).toMatch(/Musik-Pod startet/);
  });

  it('gibt nach maxRetries auf und wirft eine klare Meldung', async () => {
    const fetchImpl = vi.fn(async () => json(503, { code: 'POD_NOT_READY', retryable: true, retryAfterMs: 1000, error: 'Musik-Pod (RP3) nicht bereit' }));
    await expect(
      requestAudioDrop({ prompt: 'x' }, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, maxRetries: 1 }),
    ).rejects.toMatchObject({ code: 'POD_NOT_READY', message: 'Musik-Pod (RP3) nicht bereit' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('Lock-Fehler (423) wird nicht wiederholt', async () => {
    const fetchImpl = vi.fn(async () => json(423, { code: 'DROP_LOCKED', error: 'dropMONK wird von user-beta gehalten' }));
    const err = await requestAudioDrop({ prompt: 'x' }, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(AudioDropError);
    expect(err.code).toBe('DROP_LOCKED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Pad + Abspielen', () => {
  it('audioDropProfile traegt nur die Server-URL, isAudioDropProfile erkennt es', () => {
    const p = audioDropProfile(RESULT, 'dark');
    expect(isAudioDropProfile(p)).toBe(true);
    expect(p.audio).toEqual({ url: RESULT.url, libraryId: 'lib-1', durationSeconds: 15, cached: false });
    expect(p.dropDuration).toBe(15000);
    expect(isAudioDropProfile({ ...p, audio: undefined } as never)).toBe(false);
  });

  function adapter() {
    const calls: string[] = [];
    let scheduled: (() => void) | null = null;
    const a: Partial<DropAudioAdapter> = {
      loadTrackSample: vi.fn(async (ch: string, url: string | null) => {
        calls.push(`load:${ch}:${url}`);
        return true;
      }),
      triggerEvent: vi.fn((ch: string) => {
        calls.push(`trigger:${ch}`);
        return true;
      }),
      fadeChannelToMain: vi.fn(() => true),
      scheduleAtNextBar: vi.fn((cb: () => void) => {
        scheduled = cb;
      }),
    };
    setDropAudioAdapter(a as DropAudioAdapter);
    return { calls, runScheduled: () => scheduled?.() };
  }

  it('sofort: laedt das Sample und loest aus', async () => {
    const { calls } = adapter();
    expect(await playAudioDrop(audioDropProfile(RESULT, 'x'), 'channel3', false)).toBe(true);
    expect(calls).toEqual([`load:channel3:${RESULT.url}`, 'trigger:channel3']);
  });

  it('quantized: wartet auf die naechste volle Bar (Master-Clock)', async () => {
    const { calls, runScheduled } = adapter();
    await playAudioDrop(audioDropProfile(RESULT, 'x'), 'channel1', true);
    expect(calls).toEqual([`load:channel1:${RESULT.url}`]);
    runScheduled();
    expect(calls).toContain('trigger:channel1');
  });

  it('ohne Einspiel-Weg: false statt Fehler', async () => {
    expect(await playAudioDrop(audioDropProfile(RESULT, 'x'))).toBe(false);
  });

  it('projectKeyForDrop: Mixer-Tonart uebernehmen, Platzhalter verwerfen', () => {
    expect(projectKeyForDrop('Am')).toBe('Am');
    expect(projectKeyForDrop('F# minor')).toBe('F# minor');
    expect(projectKeyForDrop('A-Moll')).toBe('A minor');
    expect(projectKeyForDrop('C#-Dur')).toBe('C# major');
    expect(projectKeyForDrop('H-Dur')).toBe('B major');
    expect(projectKeyForDrop('–')).toBeUndefined();
    expect(projectKeyForDrop(undefined)).toBeUndefined();
  });
});

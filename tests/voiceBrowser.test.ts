// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionMediaStore } from '../src/core/session/SessionMediaStore';
import { VoiceMonkService } from '../src/core/voice/VoiceMonkService';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Gemockter Browser-Fetch: liefert immer eine kleine WAV-Antwort. */
function stubAudioFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(44), {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  })));
}

describe('VoiceMonkService im Browser (HF-Erfolgspfade, jsdom)', () => {
  it('speak nutzt den HF-TTS-Server-Proxy und legt tts ab', async () => {
    stubAudioFetch();
    const store = new MemorySessionMediaStore();
    const svc = new VoiceMonkService(store);

    const item = await svc.speak('User1', 'Hallo', {});
    expect(item.kind).toBe('tts');
    expect(item.provider).toBe('hf');
    expect(store.listByUser('User1')).toHaveLength(1);
  });

  it('sing nutzt den HF-Bark-Proxy und legt singing ab', async () => {
    stubAudioFetch();
    const store = new MemorySessionMediaStore();
    const svc = new VoiceMonkService(store);

    const item = await svc.sing('User2', { notes: [{ lyric: 'Ha', midi: 60 }], bpm: 120 });
    expect(item.kind).toBe('singing');
    expect(item.provider).toBe('hf-bark');
  });

  it('generateSong nutzt den HF-MusicGen-Proxy und legt song ab', async () => {
    stubAudioFetch();
    const store = new MemorySessionMediaStore();
    const svc = new VoiceMonkService(store);

    const item = await svc.generateSong('User3', 'Dark techno');
    expect(item.kind).toBe('song');
    expect(item.provider).toBe('hf-musicgen');
  });
});

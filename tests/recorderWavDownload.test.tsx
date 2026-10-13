// @vitest-environment jsdom
/**
 * STORE-P1-001 · recordMONK: Take als WAV herunterladen.
 * Quelle ist die Server-Adresse aus der Bibliothek (nach dem Upload), nie die
 * Blob-Kopie im Browser; gespeichert wird über src/utils/userExport.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { library, addSample, saveBlob } = vi.hoisted(() => {
  const library = new Map<string, { id: string; url: string }>();
  return {
    library,
    addSample: vi.fn((s: { id: string; url: string }) => { library.set(s.id, { ...s, url: `/api/media/uploads/${s.id}.wav` }); }),
    saveBlob: vi.fn(async () => 'downloaded' as const),
  };
});

vi.mock('../src/context/SampleContext', () => ({
  useSamples: () => ({ addSample, getSampleById: (id: string) => library.get(id) }),
}));
vi.mock('../src/hooks/usePluginState', () => ({
  usePluginState: () => ({ state: 'PRO', lockStatus: { active: true, lockedBy: 'u1' }, updateState: () => undefined }),
}));
vi.mock('../src/context/AudioContext', () => ({ useAudio: () => ({ audioContext: null }) }));
vi.mock('../src/utils/WebRTCManager', () => ({
  webRTCManager: { userId: 'u1', sendPluginSettings: () => undefined, onSessionState: () => () => undefined, onPluginSettings: () => () => undefined },
}));
vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    getTrackSampleUrl: () => '/song.wav',
    getMusicSampleChannels: async () => [new Float32Array([0, 0.1, -0.1])],
    previewSample: () => undefined,
    readMeterValues: () => null,
  },
}));
vi.mock('../src/audio/pluginChainBounce', () => ({
  bounceThroughPluginChain: async (channels: Float32Array[]) => ({
    output: channels, sampleRate: 48000, durationSeconds: 1, renderedFrames: 3, order: ['mixer'],
  }),
}));
vi.mock('../src/components/MoaAssistant', () => ({ MoaAssistant: () => null }));
vi.mock('../src/components/AudioActionMenuHost', () => ({ openAudioActionMenu: () => undefined }));
vi.mock('../src/utils/userExport', async (orig) => ({
  ...(await orig<typeof import('../src/utils/userExport')>()),
  saveBlobToUserFile: saveBlob,
}));

import { RecorderTerminal } from '../src/components/RecorderTerminal';
import { encodeWavFromChannels } from '../src/utils/wavEncode';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('recordMONK – WAV-Download', () => {
  it('Take ohne Server-Adresse: Download gesperrt', () => {
    render(<RecorderTerminal />);
    const btn = screen.getByLabelText('Als WAV herunterladen: Main_Mix_Take_01.wav') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Bounce-Take geht in die Bibliothek und wird vom Server als WAV gespeichert', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:local/1', revokeObjectURL: () => undefined });
    const wav = await encodeWavFromChannels([new Float32Array([0, 0.1, -0.1])], 48000).arrayBuffer();
    const fetchMock = vi.fn(async () => new Response(wav, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<RecorderTerminal />);
    fireEvent.click(screen.getByText('BOUNCE DURCH DIE KETTE'));
    await waitFor(() => expect(addSample).toHaveBeenCalledTimes(1));
    const sampleId = (addSample.mock.calls[0] as unknown as [{ id: string; name: string }])[0];
    expect(sampleId.id).toMatch(/^bounce-\d+$/);

    const btn = await screen.findByLabelText(`Als WAV herunterladen: ${sampleId.name}`) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/media/uploads/${sampleId.id}.wav`, { cache: 'no-store' });
    const [blob, fileName] = saveBlob.mock.calls[0] as unknown as [Blob, string];
    expect(fileName).toMatch(/^Chain_Bounce_.*\.wav$/);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(wav));
  });
});

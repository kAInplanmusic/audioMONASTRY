/** Verifies the real stem pipeline against loopback-only Fake Agent responses. */
import assert from 'node:assert/strict';
import { VastProvider } from '../../src/core/ai/orchestrator/vastProvider';
import { FIVE_STEM_KEYS, RP5_STEM_MODEL, separateOnRp5 } from '../../server/stemSeparation';
import type { StemLibraryEntry } from '../../server/stemSeparation';

interface Fixture {
  simulated?: boolean;
  audioBase64?: string;
  modelStemAudio?: Record<string, string>;
}

function pcmFixture(audio: Buffer, channels: number): Buffer {
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  assert.equal(audio.readUInt16LE(22), channels);
  assert.equal(audio.readUInt32LE(24), 48_000);
  assert.equal(audio.readUInt16LE(34), 16);
  const pcm = audio.subarray(44);
  assert.equal(pcm.length, 12_000 * 2 * channels);
  assert.ok(pcm.some((byte) => byte !== 0), 'expected audible PCM');
  return audio;
}

async function main() {
  assert.equal(process.env.AI_FLEET_MODE, 'pods');
  assert.ok(process.env.VAST_POD_URL_STUDIO && process.env.VAST_POD_URL_VOICE);
  for (const [name, value] of Object.entries(process.env)) {
    assert.ok(!value || !/^(VAST_API_KEY$|VAST_POD_ID_)/.test(name), 'remove provider control credentials');
    if (name.startsWith('VAST_POD_URL_') && value) {
      assert.match(value, /^https:\/\/127\.0\.0\.1:\d+$/, 'use only the local HTTPS simulator');
    }
  }

  const voice = new VastProvider('voiceGen');
  const tts = await voice.run('tts', 'qwen3-tts-17b', { text: 'Fixture' }) as { result: Fixture };
  assert.equal(tts.result.simulated, true);
  const input = pcmFixture(Buffer.from(tts.result.audioBase64 ?? '', 'base64'), 1);

  const files = new Map<string, Buffer>();
  const library: StemLibraryEntry[] = [];
  const result = await separateOnRp5({ data: input, filename: 'simulated-voice.wav' }, {}, {
    runTask: async (model, payload, signal) => {
      const raw = await voice.run('stem.separate', model, { ...payload, includeModelStems: true }, signal);
      const fixture = (raw as { result: Fixture }).result;
      assert.equal(fixture.simulated, true);
      const native = Object.values(fixture.modelStemAudio ?? {});
      assert.equal(new Set(native).size, 6);
      for (const audio of native) pcmFixture(Buffer.from(audio, 'base64'), 2);
      return { provider: voice.id, result: raw };
    },
    storage: {
      presignPut: () => null,
      async store(key, data) {
        files.set('/' + key, pcmFixture(data, 2));
        return { url: '/' + key, storage: 'server' };
      },
    },
    async writeLibrary(entry) {
      assert.ok(files.has(entry.url));
      library.push(entry);
    },
  });
  assert.equal(result.model, RP5_STEM_MODEL);
  assert.equal(result.librarySaved, true);
  assert.deepEqual(library.map((entry) => entry.key), [...FIVE_STEM_KEYS]);
  assert.equal(new Set([...files.values()].map((file) => file.toString('base64'))).size, FIVE_STEM_KEYS.length);
  console.log('Fake Agent audio verified: mono TTS, six native stems, five stored WAVs and five Library entries.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

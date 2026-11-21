import { expect, test } from '@playwright/test';
import type {} from './fixtures/release-output';

test('Chromium captures actual stereo and spatial PCM before and after reconnect', async ({ page, baseURL }, info) => {
  const origin = new URL(baseURL!).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto('/tests/e2e/fixtures/release-output.html');
  await page.getByRole('button', { name: 'Start PCM measurement' }).click();
  const result = await page.evaluate(() => window.releaseOutputProof);
  expect(result).toBeDefined();
  if (!result) throw new Error('PCM measurement did not start');
  await info.attach('release-output-pcm.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.sampleRate).toBe(48000);
  expect(result.faults).toEqual([]);
  expect(result.binaural.tone).toBeGreaterThan(0.01);
  expect(result.recording.channels).toBe(2);
  expect(result.recording.frames).toBeGreaterThanOrEqual(9600);
  expect(result.recording.bytes).toBeGreaterThan(0);
  expect(result.recording.pcm.tone).toBeGreaterThan(0.02);
  expect(result.spatialChannels).toHaveLength(12);
  expect(result.spatialChannels.filter(channel => channel.active)).toHaveLength(1);
  for (const channel of ['left', 'right'] as const) {
    expect(result.baseline[channel].tone).toBeGreaterThan(0.02);
    expect(result.dryWithSpatial[channel].rms / result.baseline[channel].rms).toBeCloseTo(1, 1);
    expect(result.reconnected[channel].rms / result.baseline[channel].rms).toBeCloseTo(1, 1);
    expect(result.stopped[channel].peak).toBeLessThan(0.00001);
  }
});

import { test, expect } from '@playwright/test';
import { collectErrors, navButton } from './helpers/studioNav';

/**
 * ECHTER Live-V2-Pfad im Browser (Live-/Audio-Gate).
 *
 * Dieser Test setzt den V2-Modus, startet die App und prüft Play/Stop gegen
 * den echten AudioWorklet-Pfad (`v2LiveSink` + `V2SampleClock` im Browser).
 *
 * WICHTIG: In Headless-/Container-Umgebungen kann Chromium keinen echten
 * `AudioWorkletNode` aus Tone.js konstruieren („parameter 1 is not of type
 * BaseAudioContext“). Der Test ist deshalb als Live-Gate markiert und muss auf
 * einem audio-fähigen Browser bzw. gegen die echte Deployment-Instanz laufen.
 */
// Live-Gate nur ausführen, wenn ein echter Audio-fähiger Browser verfügbar ist
// (DISPLAY gesetzt, kein CI). In Headless-/Container-Umgebungen bleibt der Test
// bewusst geskippt – genau wie im V2TODO §6 gefordert.
const LIVE_GATE_ACTIVE = Boolean(process.env.DISPLAY) && process.env.CI !== 'true' && process.env.V2_LIVE_SKIP !== '1';

(LIVE_GATE_ACTIVE ? test : test.skip)('V2 Live: AudioEngine im V2-Modus, V2LiveSink verbunden, Play/Stop real', async ({ page }) => {
  const { pageErrors, consoleErrors } = collectErrors(page);

  // Bundle laden und V2-Modus VOR dem Audio-Start aktivieren.
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as { __audioMonastry?: { audioEngine?: unknown } };
    return !!w.__audioMonastry?.audioEngine;
  });
  await page.evaluate(() => {
    const w = window as unknown as { __audioMonastry: { audioEngine: { setPlaybackMode: (m: string) => void } } };
    w.__audioMonastry.audioEngine.setPlaybackMode('v2');
  });

  // Studio starten (echter AudioContext + Worklet-Load) und mixerMONK aktivieren.
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(navButton(page, 'MIX')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /mixerMONK Power/i }).click();
  await expect(page.getByText(/mixerMONK · 6 CH/i)).toBeVisible({ timeout: 15_000 });

  // MAIN-Schutz: play() läuft nur, wenn mixerMONK den PRO-Halter hat.
  // Power aktiviert lediglich (AUTO_AI) – das ⋮-Menü promotet zu PRO (Lock).
  await page.getByRole('button', { name: /mixerMONK Menü/i }).click();
  await expect
    .poll(async () => page.evaluate(() => {
      const w = window as unknown as { __audioMonastry: { audioEngine: { isMainHolderActive: () => boolean } } };
      return w.__audioMonastry.audioEngine.isMainHolderActive();
    }), { timeout: 10_000 })
    .toBe(true);

  // Engine muss im V2-Modus stehen.
  await expect
    .poll(async () => page.evaluate(() => {
      const w = window as unknown as { __audioMonastry: { audioEngine: { playbackMode?: string } } };
      return w.__audioMonastry.audioEngine.playbackMode ?? null;
    }), { timeout: 15_000 })
    .toBe('v2');

  // Play über die echte Engine-Bridge – V2LiveSink verbindet sich als AudioWorklet.
  await page.evaluate(async () => {
    const w = window as unknown as { __audioMonastry: { audioEngine: { play: () => Promise<void> } } };
    await w.__audioMonastry.audioEngine.play();
  });
  await expect
    .poll(async () => page.evaluate(() => {
      const w = window as unknown as { __audioMonastry: { audioEngine: { isPlaying?: boolean; v2LiveSink?: { isConnected?: boolean } } } };
      return {
        playing: w.__audioMonastry.audioEngine.isPlaying ?? false,
        v2Connected: w.__audioMonastry.audioEngine.v2LiveSink?.isConnected ?? false,
      };
    }), { timeout: 15_000 })
    .toEqual({ playing: true, v2Connected: true });

  // Kurz laufen lassen (mehrere Audio-Quanten, echte Scheduler-Steps).
  await page.waitForTimeout(500);

  // Stop über die echte Engine-Bridge.
  await page.evaluate(() => {
    const w = window as unknown as { __audioMonastry: { audioEngine: { stop: () => void } } };
    w.__audioMonastry.audioEngine.stop();
  });
  await expect
    .poll(async () => page.evaluate(() => {
      const w = window as unknown as { __audioMonastry: { audioEngine: { isPlaying?: boolean } } };
      return w.__audioMonastry.audioEngine.isPlaying ?? false;
    }), { timeout: 10_000 })
    .toBe(false);

  // Kein Worklet-/Seitenfehler.
  expect(pageErrors).toEqual([]);
  const critical = consoleErrors.filter((e) => /No valid URL|Unexpected token 'export'|AudioWorklet|v2-sink/i.test(e));
  expect(critical).toEqual([]);
});

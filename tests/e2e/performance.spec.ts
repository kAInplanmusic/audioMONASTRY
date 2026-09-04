import { test, expect, type Page, type CDPSession } from '@playwright/test';

/**
 * P2-4 Prüfpunkt (Live, automatisiert im Headless-Chromium):
 * Performance-Messung unter Studio-Last (alle Plugins aktiv, Transport läuft,
 * kontinuierliche Pattern-Updates) muss < 70 % CPU zeigen.
 *
 * Messung über Chrome DevTools Protocol (Performance.getMetrics):
 *   TaskDuration-Delta / Wanduhr-Delta = CPU-Auslastung des Renderer-Main-Threads.
 * Das ist die übliche Browser-CPU-Kennzahl (TaskDuration zählt Sekunden, die der
 * Main-Thread mit Tasks beschäftigt war). Audio-Worklets laufen auf dem
 * Audio-Thread und sind bewusst nicht Teil dieser Main-Thread-Kennzahl.
 */

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 30_000 });
}

/** Studio vorbereiten: alle Toolbar-Plugins aktivieren und Transport starten. */
async function prepareStudio(page: Page): Promise<number> {
  await enterStudio(page);
  const pluginButtons = page.locator('nav[aria-label="Plugin-Toolbar"] button[aria-pressed]');
  const pluginCount = await pluginButtons.count();
  for (let i = 0; i < pluginCount; i++) {
    await pluginButtons.nth(i).click({ delay: 6, force: true });
  }
  await page.waitForTimeout(800); // Vite-Dep-Optimierung / Lazy-Chunks setzen lassen.
  await page.keyboard.press('Space'); // Transport PLAY
  await expect(page.locator('#rack-masterplayer').getByText('PLAY', { exact: true })).toBeVisible();
  return pluginCount;
}

function metric(metrics: { name: string; value: number }[], name: string): number {
  const m = metrics.find((x) => x.name === name);
  if (!m) throw new Error(`CDP-Metrik ${name} nicht vorhanden`);
  return m.value;
}

async function getMetrics(cdp: CDPSession): Promise<{ name: string; value: number }[]> {
  const res = await cdp.send('Performance.getMetrics');
  return res.metrics as { name: string; value: number }[];
}

test('P2-4 Performance-Prüfpunkt: CPU < 70 % unter Studio-Last', async ({ page, context }) => {
  test.setTimeout(150_000);

  const navLog: string[] = [];
  page.on('framenavigated', (f) => navLog.push(f.url()));
  page.on('pageerror', (e) => console.log('[P2-4] pageerror:', e.message.slice(0, 160)));

  await enterStudio(page);
  navLog.length = 0; // Initial-Navigation (page.goto) zählt nicht.

  // Kaltstart-Warm-up: Beim ersten Aktivieren aller Plugins optimiert Vite ggf.
  // Dependencies neu und lädt die Seite dabei neu. Deshalb einmal voll durchlaufen,
  // dann neu laden und erst die zweite Runde messen.
  await prepareStudio(page);
  await page.reload();
  const pluginCount = await prepareStudio(page);
  navLog.length = 0; // Baseline für die Messung: danach darf keine Navigation mehr kommen.
  const navBaseline = navLog.length;

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  const before = await getMetrics(cdp);
  const wallStart = Date.now();

  // Moderate Dauerlast: 8 s lang alle 100 ms eine 8-Kanal-Pattern-Matrix an die
  // Engine melden (entspricht laufendem Sequencer-Betrieb mehrerer User).
  const LOAD_MS = 8000;
  const STEP_MS = 2000;
  for (let elapsed = 0; elapsed < LOAD_MS; elapsed += STEP_MS) {
    expect(navLog, `Seite hat während der Messung navigiert: ${navLog.join(' → ')}`).toHaveLength(navBaseline);
    await page.evaluate(
      (durationMs) =>
        new Promise<void>((resolve) => {
          const start = performance.now();
          const tracks = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'];
          const tick = () => {
            const patterns: Record<string, boolean[]> = {};
            for (const t of tracks) patterns[t] = Array.from({ length: 16 }, () => Math.random() < 0.35);
            window.dispatchEvent(
              new CustomEvent('monk:apply-patterns', {
                detail: { patterns, bpm: 120 },
              }),
            );
            if (performance.now() - start >= durationMs) resolve();
            else setTimeout(tick, 100);
          };
          tick();
        }),
      STEP_MS,
    );
  }

  const wallDeltaSec = (Date.now() - wallStart) / 1000;
  const after = await getMetrics(cdp);

  const taskDeltaSec = metric(after, 'TaskDuration') - metric(before, 'TaskDuration');
  const cpuPct = (taskDeltaSec / wallDeltaSec) * 100;

  const report = {
    pluginCount,
    wallDeltaSec: Math.round(wallDeltaSec * 100) / 100,
    taskDurationDeltaSec: Math.round(taskDeltaSec * 1000) / 1000,
    cpuPct: Math.round(cpuPct * 10) / 10,
    scriptDurationDeltaSec: Math.round((metric(after, 'ScriptDuration') - metric(before, 'ScriptDuration')) * 1000) / 1000,
    layoutDurationDeltaSec: Math.round((metric(after, 'LayoutDuration') - metric(before, 'LayoutDuration')) * 1000) / 1000,
    heapUsedMb: Math.round(metric(after, 'JSHeapUsedSize') / 1024 / 1024),
    navigations: navLog.length - navBaseline,
  };
  console.log('[P2-4] Performance-Report:', JSON.stringify(report));

  expect(cpuPct).toBeLessThan(70);
});

import { test, expect, type Page } from '@playwright/test';
import { STUDIO_NAV_COUNT } from './helpers/studioNav';

/**
 * audioMONASTRY – Audio-Engine-/UI-Stresstest (Playwright, headless Chromium)
 * ============================================================================
 * Angepasst an die Web-Audio-Architektur (AudioWorklets statt VST/AAX/CLAP):
 *   1. Boot in Studio (Start-Screen -> App) + Boot-Zeit messen
 *   2. Alle Plugin-Buttons der Toolbar aktivieren (AUTO_AI), danach Hot-Swap (an/aus) unter Play
 *   3. Play/Stop-Zyklen (10x) mit BPM-Rapid (60-250 BPM)
 *   4. 2 x 500 `monk:apply-patterns`-Events mit je 4 Pattern-Slots (A–D, je
 *      8 Kanäle × 16 Steps) = 4000 Pattern-Anwendungen / 32000 Kanal-Pattern-
 *      Writes. Der Listener existiert seit MONK-2026-11-06-001
 *      (`src/core/audio/sequencerPatternApply.ts`) und ruft je Slot
 *      `audioEngine.loadPatterns(patterns, synthNotes, bpm)` – genau den Pfad,
 *      den auch Preset-/Session-Laden benutzt. Die Last ist damit ECHTE
 *      Engine-Arbeit (Sequencer normalisieren, V2-Sink spiegeln, Session-Spiegel
 *      schreiben, Pattern-Listener/UI), nicht nur ein Dispatch.
 *      Beleg im Lauf: `window.__monkPatternApplyStats()` zählt die tatsächlich
 *      angewendeten Slots; der Report führt sie als `patternSlotsApplied`.
 *   5. Heap-Messung (Chromium performance.memory) vor/nach den Runden
 *   6. rAF-FPS-Messung **während** der Last: der Frame-Zähler läuft, bevor der
 *      erste Chunk abgesetzt wird, und wird erst danach ausgelesen. Die Last
 *      wird dafür in Chunks zerlegt, damit der Browser zwischen den Chunks
 *      überhaupt Frames rendern kann (ein einzelnes blockierendes
 *      page.evaluate friert den Main-Thread ein und liefert danach nur die
 *      Idle-Bildrate – genau das war der Messfehler AUDIT P2-005).
 *      Zusätzlich wird im Anschluss die Idle-Bildrate als Referenz gemessen,
 *      damit beide Werte im Report stehen und vergleichbar sind.
 *   7. Fehler-Monitoring: pageerrors MÜSSEN 0 sein; Console-Errors werden
 *      protokolliert (benigne WebSocket-/Signaling-Warnungen gefiltert)
 *
 * WAS DIE LAST IST (AUDIT P2-005, MONK-2026-11-06-001):
 *   `monk:apply-patterns`-CustomEvent-Dispatches in Chunks plus echte
 *   Toolbar-Klicks (Plugin-Hot-Swap). Jedes Event trägt vier Pattern-Slots und
 *   wird vom Client-Listener in vier `audioEngine.loadPatterns`-Aufrufe
 *   übersetzt; die Engine-Arbeit ist also Teil der Last. Zwei Gates sichern das
 *   ab: `patternSlotsApplied` muss der Zahl der Slots im Lastfenster
 *   entsprechen (sonst war der Listener weg), und die Bildrate unter Last muss
 *   nachweislich unter der Idle-Referenz liegen (sonst hat die Last nicht
 *   gewirkt). `loadNote` hält die Einordnung fest.
 *
 * Aufruf:
 *   E2E_BASE_URL=https://hallerbans.de npx playwright test tests/e2e/stress.spec.ts
 *   (lokal: npm run test:stress startet den Dev-Server automatisch)
 */
const PATTERN_ROUNDS = 2;
/** Events je Runde (jedes Event trägt SLOTS_PER_EVENT Pattern-Slots). */
const PATTERN_EVENTS_PER_ROUND = 500;
/** Pattern-Slots A–D je Event – dieselbe Grenze wie `MAX_PATTERN_SLOTS`. */
const SLOTS_PER_EVENT = 4;
/**
 * Events pro Chunk. Nach jedem Chunk ist der Main-Thread wieder frei,
 * rAF kann einen Frame liefern -> der Zähler sieht die Bildrate UNTER der Last.
 * 10 Events = 40 Slot-Anwendungen (320 Kanal-Writes) pro Chunk, klein genug
 * für >= 1 Frame Lücke.
 */
const EVENTS_PER_CHUNK = 10;
/** Plugins, die im Lastfenster umgeschaltet werden (an/aus = 2 Klicks je Plugin). */
const HOT_SWAP_PLUGINS = 5;
const PLAY_STOP_CYCLES = 10;
const BENIGN_CONSOLE = ['Signaling connection failed', 'WebSocket', 'websocket error', 'Failed to load resource'];

/** Ergebnis einer rAF-Fenster-Messung (Bildrate + Jank-Kennzahlen). */
type FpsSample = {
  frames: number;
  durationMs: number;
  fps: number;
  p95GapMs: number;
  maxGapMs: number;
};

/**
 * Frame-Zähler im Seitenkontext starten.
 *
 * Der Zähler hängt an requestAnimationFrame und lebt über mehrere
 * page.evaluate-Aufrufe hinweg in `window.__monkFrameCounter`. Dadurch zählt
 * er JEDEN gerenderten Frame im Messfenster – auch die, die zwischen den
 * Last-Chunks entstehen – statt nur die Frames nach der Last.
 */
async function startFrameCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { frames: 0, start: performance.now(), last: 0, gaps: [] as number[], running: true };
    (window as unknown as { __monkFrameCounter?: typeof state }).__monkFrameCounter = state;
    const loop = (t: number) => {
      if (!state.running) return;
      // Der erste Callback setzt nur den Bezugspunkt (kein Messwert).
      if (state.last > 0) {
        state.frames += 1;
        state.gaps.push(t - state.last);
      }
      state.last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

/** Frame-Zähler stoppen und das Messfenster auswerten. */
async function stopFrameCounter(page: Page): Promise<FpsSample> {
  return page.evaluate(() => {
    const state = (window as unknown as {
      __monkFrameCounter?: { frames: number; start: number; last: number; gaps: number[]; running: boolean };
    }).__monkFrameCounter;
    if (!state) throw new Error('Frame-Zähler nicht gestartet');
    state.running = false;
    const durationMs = Math.max(1, performance.now() - state.start);
    const gaps = state.gaps.slice().sort((a, b) => a - b);
    const quantile = (q: number) =>
      gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]) : 0;
    return {
      frames: state.frames,
      durationMs: Math.round(durationMs),
      fps: Math.round((state.frames / durationMs) * 1000),
      p95GapMs: quantile(0.95),
      maxGapMs: gaps.length ? Math.round(gaps[gaps.length - 1]) : 0,
    };
  });
}

/** Referenzmessung ohne Last (nur zur Einordnung im Report, kein Ersatz für 6.). */
async function measureIdleFps(page: Page, windowMs: number): Promise<FpsSample> {
  await startFrameCounter(page);
  await page.waitForTimeout(windowMs);
  return stopFrameCounter(page);
}

/** Zähler der tatsächlich angewendeten Pattern-Slots (Listener-Beleg). */
type ApplyStats = {
  applied: number;
  events: number;
  rejected: number;
  slotsApplied: number;
  lastBpm: number;
  lastError: string | null;
};

/**
 * MONK-2026-11-06-001: Der Stresstest belegt, dass die Last die Engine
 * erreicht – der Listener (`installSequencerPatternApply`) legt dafür
 * `window.__monkPatternApplyStats()` an. Fehlt der Haken, fehlt der Listener
 * und der Lauf ist wertlos.
 */
async function readApplyStats(page: Page): Promise<ApplyStats> {
  return page.evaluate(() => {
    const fn = (window as unknown as { __monkPatternApplyStats?: () => ApplyStats })
      .__monkPatternApplyStats;
    if (typeof fn !== 'function') {
      throw new Error('Pattern-Listener fehlt: window.__monkPatternApplyStats ist nicht gesetzt');
    }
    return fn();
  });
}

test('Engine-/UI-Stresstest: alle Toolbar-Plugins, 4000 Pattern-Slot-Anwendungen, Play/Stop-Zyklen', async ({ page }) => {
  test.setTimeout(180_000); // Plugin-Last + 4000 Pattern-Slot-Anwendungen brauchen mehr als 30 s.
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !BENIGN_CONSOLE.some((b) => m.text().includes(b))) {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });

  // --- 1) Boot ---
  const t0 = Date.now();
  await page.goto('/');
  await page.getByRole('button', { name: /Studio betreten|audioMONASTRY starten/i }).click();
  await page.waitForSelector('#studio-main', { timeout: 45_000 });
  const bootMs = Date.now() - t0;

  // --- 2) Alle Plugins aktivieren (Klick = AUTO_AI) ---
  // Nur die Plugin-Toolbar-Buttons (nicht Header-/Overlay-Buttons mit
  // aria-pressed, z. B. ZWISCHENSPEICHER).
  const pluginButtons = page.locator('nav[aria-label="Studio-Navigation"] button');
  const pluginCount = await pluginButtons.count();
  for (let i = 0; i < pluginCount; i++) {
    await pluginButtons.nth(i).click({ delay: 8, force: true });
  }
  await page.waitForTimeout(400);

  // --- 3) Play/Stop-Zyklen mit BPM-Rapid ---
  const playBtn = page.getByRole('button', { name: /Wiedergabe starten/i });
  const stopBtn = page.getByRole('button', { name: /Wiedergabe stoppen/i });
  for (let i = 0; i < PLAY_STOP_CYCLES; i++) {
    const bpm = 60 + Math.floor(Math.random() * 190);
    await page.evaluate((b) => {
      window.dispatchEvent(new CustomEvent('monk:apply-patterns', {
        detail: { patterns: { channel1: Array.from({ length: 16 }, () => Math.random() < 0.4) }, bpm: b },
      }));
    }, bpm);
    if (await playBtn.isVisible()) await playBtn.click();
    await page.waitForTimeout(120);
    if (await stopBtn.isVisible()) await stopBtn.click();
  }

  // --- 4) Heap + Engine-Zähler vor der Last ---
  const heapBefore = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0);
  const statsBeforeLoad = await readApplyStats(page);

  // --- 5) 2 x 500 Events mit je 4 Pattern-Slots in Chunks, FPS-Messung PARALLEL ---
  // Jedes Event trägt vier Slots A–D; der Client-Listener übersetzt sie in vier
  // `audioEngine.loadPatterns`-Aufrufe (Engine-Arbeit, kein No-Op-Dispatch).
  // Chunks statt eines blockierenden Durchlaufs: nur so kann der Browser
  // zwischen zwei Last-Paketen Frames rendern und der Zähler sieht die
  // Bildrate UNTER der Last (vorher wurde erst NACH der Last gemessen).
  //
  // Ein Vite-Full-Reload (z. B. fremde Änderung an src/) reißt #studio-main weg
  // und macht das Messfenster wertlos. Das wird erkannt, statt bis zum
  // Test-Timeout auf einen verschwundenen Button zu warten.
  let loadWindowOpen = true;
  let reloadsDuringLoad = 0;
  page.on('framenavigated', (frame) => {
    if (loadWindowOpen && frame === page.mainFrame()) reloadsDuringLoad += 1;
  });
  let hotSwapClicks = 0;
  let hotSwapError = '';
  const CHUNKS_PER_ROUND = PATTERN_EVENTS_PER_ROUND / EVENTS_PER_CHUNK;
  await startFrameCounter(page);
  const loadStart = Date.now();
  for (let round = 0; round < PATTERN_ROUNDS; round++) {
    for (let chunk = 0; chunk < CHUNKS_PER_ROUND; chunk++) {
      await page.evaluate(({ count, slots }) => {
        const tracks = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'];
        for (let i = 0; i < count; i++) {
          const matrices: Record<string, boolean[]>[] = [];
          for (let s = 0; s < slots; s++) {
            const patterns: Record<string, boolean[]> = {};
            for (const t of tracks) patterns[t] = Array.from({ length: 16 }, () => Math.random() < 0.35);
            matrices.push(patterns);
          }
          window.dispatchEvent(new CustomEvent('monk:apply-patterns', {
            detail: { slots: matrices, bpm: 90 + Math.floor(Math.random() * 90) },
          }));
        }
      }, { count: EVENTS_PER_CHUNK, slots: SLOTS_PER_EVENT });
      // Hot-Swap: 5 Plugins im laufenden Betrieb aus-/einschalten. Bewusst
      // innerhalb des Messfensters (ein Plugin je Chunk), damit die echten
      // UI-Klicks zur Last gehören und nicht danach stattfinden. Bounded
      // timeout statt Test-Timeout: ein Reload soll sofort auffallen.
      if (chunk < HOT_SWAP_PLUGINS) {
        try {
          await pluginButtons.nth(chunk).click({ delay: 5, force: true, timeout: 5_000 });
          await page.waitForTimeout(25);
          await pluginButtons.nth(chunk).click({ delay: 5, force: true, timeout: 5_000 });
          hotSwapClicks += 2;
        } catch (e) {
          hotSwapError = e instanceof Error ? e.message.split('\n')[0] : String(e);
          break;
        }
      }
    }
  }
  const loadWallClockMs = Date.now() - loadStart;
  loadWindowOpen = false;
  if (reloadsDuringLoad > 0) {
    throw new Error(
      `Lastfenster ungültig: die Seite wurde ${reloadsDuringLoad}x neu geladen (Dev-Reload/HMR) – FPS-Messung wiederholen.`,
    );
  }
  // Kein stiller Teilausfall: fehlt ein Hot-Swap-Klick, ist die Last nicht die
  // zugesicherte und der Lauf darf nicht als bestanden gelten.
  expect(hotSwapError, `Hot-Swap-Klick fehlgeschlagen: ${hotSwapError}`).toBe('');
  expect(hotSwapClicks, 'Hot-Swap-Klicks vollständig ausgeführt').toBe(HOT_SWAP_PLUGINS * PATTERN_ROUNDS * 2);
  const uiFpsUnderLoad = await stopFrameCounter(page);
  // MONK-2026-11-06-001: Beleg, dass die Last die Engine erreicht hat.
  const statsAfterLoad = await readApplyStats(page);
  const patternSlotsApplied = statsAfterLoad.applied - statsBeforeLoad.applied;
  const patternEventsApplied = statsAfterLoad.events - statsBeforeLoad.events;
  const patternPayloadsRejected = statsAfterLoad.rejected - statsBeforeLoad.rejected;
  const expectedSlots = PATTERN_ROUNDS * PATTERN_EVENTS_PER_ROUND * SLOTS_PER_EVENT;

  // --- 6) Referenz: Bildrate im Idle (NACH der Last, ohne Last) ---
  const uiFpsIdle = await measureIdleFps(page, 1500);

  // --- 7) Heap nach der Last ---
  const heapAfter = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0);

  const fpsDropPct =
    uiFpsIdle.fps > 0 ? Math.round(((uiFpsIdle.fps - uiFpsUnderLoad.fps) / uiFpsIdle.fps) * 100) : 0;

  // --- 8) Ergebnis ---
  const report = {
    baseUrl: page.url(),
    bootMs,
    pluginCount,
    patternEvents: PATTERN_ROUNDS * PATTERN_EVENTS_PER_ROUND,
    patternSlotsPerEvent: SLOTS_PER_EVENT,
    patternSlotsApplied,
    patternSlotsExpected: expectedSlots,
    patternEventsApplied,
    patternPayloadsRejected,
    channelPatternWrites: patternSlotsApplied * 8,
    eventsPerChunk: EVENTS_PER_CHUNK,
    loadChunks: PATTERN_ROUNDS * CHUNKS_PER_ROUND,
    loadWallClockMs,
    hotSwapClicks,
    reloadsDuringLoad,
    playStopCycles: PLAY_STOP_CYCLES,
    heapBeforeMb: Math.round(heapBefore / 1024 / 1024),
    heapAfterMb: Math.round(heapAfter / 1024 / 1024),
    heapDeltaMb: Math.round((heapAfter - heapBefore) / 1024 / 1024),
    // Während der Last gemessen (Chunk-Fenster) – das ist das Gate.
    uiFpsUnderLoad: uiFpsUnderLoad.fps,
    uiFpsUnderLoadFrames: uiFpsUnderLoad.frames,
    uiFpsUnderLoadWindowMs: uiFpsUnderLoad.durationMs,
    uiFrameGapP95Ms: uiFpsUnderLoad.p95GapMs,
    uiFrameGapMaxMs: uiFpsUnderLoad.maxGapMs,
    // Referenzwert ohne Last (Vergleichsbasis für „Last wirkt“).
    uiFpsIdleAfterLoad: uiFpsIdle.fps,
    uiFpsDropPctUnderLoad: fpsDropPct,
    loadNote:
      'Last = monk:apply-patterns-Events (gechunkt, je 4 Pattern-Slots) + echte Toolbar-Klicks. Der Client-Listener (core/audio/sequencerPatternApply) ruft je Slot audioEngine.loadPatterns(patterns, synthNotes, bpm) – die Engine-Arbeit ist Teil der Last (Beleg: patternSlotsApplied).',
    pageErrors,
    consoleErrors,
  };
  console.log('STRESS_REPORT ' + JSON.stringify(report, null, 2));

  // Harte Gates: keine Page-Errors (außer bekannten benignen ML-Worker-Meldungen),
  // Boot < 45 s, Plugins gefunden, FPS-Schwelle (headless Software-Rendering).
  const benignPageErrors = ['Unexpected token \'export\''];
  const realPageErrors = pageErrors.filter((e) => !benignPageErrors.some((b) => e.includes(b)));
  expect(realPageErrors, `Page-Errors: ${pageErrors.join(' | ')}`).toEqual([]);
  // 16-MONK-Ziel: die Navigation fuehrt 16 Plugin-Buttons (frueher 18/17 erwartet).
  // Die Zahl kommt aus dem gepflegten Helfer, damit sie nicht wieder auseinanderlaeuft.
  expect(pluginCount).toBeGreaterThanOrEqual(STUDIO_NAV_COUNT);
  expect(bootMs).toBeLessThan(45_000);
  // MONK-2026-11-06-001: Ohne diesen Beleg wäre die Last wieder nur ein Dispatch.
  expect(
    patternSlotsApplied,
    `Engine hat ${patternSlotsApplied} von ${expectedSlots} Pattern-Slots angewendet (Listener weg?)`,
  ).toBe(expectedSlots);
  expect(patternPayloadsRejected, 'verworfene Pattern-Nutzlasten im Lastfenster').toBe(0);
  const isHeadless = test.info().project.use.headless !== false;
  const fpsMin = isHeadless ? 10 : 20; // Headless rendert ohne GPU → weichere Schwelle
  // Gate auf dem WÄHREND der Last gemessenen Wert. Eine Messung ohne Frames ist
  // kein bestandener Test, sondern eine kaputte Messung.
  expect(uiFpsUnderLoad.frames, 'FPS-Messung unter Last ohne Frames (Fenster zu kurz?)').toBeGreaterThanOrEqual(10);
  expect(
    uiFpsUnderLoad.fps,
    `FPS unter Last: ${uiFpsUnderLoad.fps} (${uiFpsUnderLoad.frames} Frames / ${uiFpsUnderLoad.durationMs} ms, p95-Lücke ${uiFpsUnderLoad.p95GapMs} ms)`,
  ).toBeGreaterThanOrEqual(fpsMin);
  // Idle-Referenz bleibt ebenfalls gegated: bricht sie ein, ist die Ursache
  // nicht die Last, sondern die Seite selbst.
  expect(uiFpsIdle.fps, `FPS im Idle: ${uiFpsIdle.fps} (${uiFpsIdle.frames} Frames)`).toBeGreaterThanOrEqual(fpsMin);
  // Die Last ist jetzt echte Engine-Arbeit und muss sich in der Bildrate zeigen:
  // unter Last nachweislich niedriger als im Idle (sonst hat sie nicht gewirkt).
  expect(
    uiFpsUnderLoad.fps,
    `Last wirkt nicht: unter Last ${uiFpsUnderLoad.fps} FPS vs. Idle ${uiFpsIdle.fps} FPS`,
  ).toBeLessThan(uiFpsIdle.fps);
  // AM-E5-2 (Memory-Pressure-Anteil): kein ungebremstes Heap-Wachstum unter Last.
  expect(report.heapDeltaMb, `Heap-Wachstum: ${report.heapDeltaMb} MB`).toBeLessThan(512);
});

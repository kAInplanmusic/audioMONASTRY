#!/usr/bin/env node
/**
 * AUDIO-UI-GATE (AUDIT-AUDIO-002, UI-Pfad)
 * ========================================
 * Der bestehende `tests/e2e/v2-live.spec.ts` prueft nur Flags
 * (`playing === true`, `v2Connected === true`) und misst KEIN Audio. Dieser Gate
 * geht denselben UI-Weg, misst aber den tatsaechlichen Pegel am Master-Ausgang
 * der App – ueber einen AnalyserNode, der per `addInitScript` in den echten
 * Graphen gehaengt wird (kein Produktionscode wird angefasst).
 *
 * Zweck: stumme Pfade sichtbar machen. Ein Pfad, der "erfolgreich" aussieht,
 * aber nichts hoeren laesst, faellt hier als -inf dBFS auf.
 *
 * Voraussetzung: Dev-Server laeuft auf :8080 (npm run dev).
 * Aufruf: node scripts/audio-ui-gate.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const TH = { silenceDbfsMax: -60, audibleDbfsMin: -50, settleMs: 300, measureMs: 350 };

async function main() {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  // Master-Tap installieren, BEVOR die App laedt: jede Verbindung auf
  // ctx.destination wird zusaetzlich auf einen Analyser gefuehrt.
  await page.addInitScript(() => {
    const origConnect = AudioNode.prototype.connect;
    window.__masterTap = { analyser: null, connects: 0, ctx: null };
    AudioNode.prototype.connect = function patched(dest, ...rest) {
      const result = origConnect.call(this, dest, ...rest);
      try {
        const ctx = this.context;
        const isDestination = ctx && dest && dest === ctx.destination;
        if (isDestination && ctx) {
          if (!ctx.__tapAnalyser) {
            const an = ctx.createAnalyser();
            an.fftSize = 2048;
            origConnect.call(this, an); // originelle Methode, keine Rekursion
            ctx.__tapAnalyser = an;
            window.__masterTap.analyser = an;
            window.__masterTap.ctx = ctx;
          } else {
            origConnect.call(this, ctx.__tapAnalyser);
          }
          window.__masterTap.connects += 1;
        }
      } catch {
        /* Messung darf die App nie stoeren */
      }
      return result;
    };
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(
    () => !!(window.__audioMonastry && window.__audioMonastry.audioEngine),
    null,
    { timeout: 60_000 },
  );
  console.log('App geladen, __audioMonastry.audioEngine vorhanden');

  await page.evaluate(() => window.__audioMonastry.audioEngine.setPlaybackMode('v2'));

  // Studio starten (loest echten AudioContext + Worklet-Load aus).
  //
  // WICHTIG – sonst ist dieser Gate wertlos: `play()` laeuft nur, wenn mixerMONK
  // den PRO-Halter hat (MAIN-Schutz). Ein reiner Klick auf „STUDIO BETRETEN"
  // laesst den Audiographen unverbunden; dann wird nie ein Node an
  // `ctx.destination` gehaengt, der Master-Tap entsteht nicht, und JEDE
  // Pegelmessung ist -inf – was faelschlich wie Stille aussieht.
  await page.getByLabel('audioMONASTRY starten').click();
  await page.getByRole('button', { name: 'mixerMONK Power' }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: /mixerMONK Power/i }).click();
  await page.getByText(/mixerMONK/i).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: /mixerMONK Menü/i }).click();
  await page.waitForFunction(
    () => window.__audioMonastry?.audioEngine?.isMainHolderActive?.() === true,
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1500);
  console.log('Studio gestartet, mixerMONK hat den PRO-Halter');

  const tapInfo = await page.evaluate(() => ({
    hasTap: !!window.__masterTap?.analyser,
    connects: window.__masterTap?.connects ?? 0,
    ctxState: window.__masterTap?.ctx?.state ?? null,
    sampleRate: window.__masterTap?.ctx?.sampleRate ?? null,
  }));
  console.log('Master-Tap:', JSON.stringify(tapInfo));

  const measure = async (ms) =>
    page.evaluate(async (msLocal) => {
      const ctx = window.__masterTap?.ctx;
      const an = window.__masterTap?.analyser;
      if (!an) return { rmsL: 0, rmsR: 0, dbfs: -Infinity, peak: 0, error: 'kein Tap' };
      const buf = new Float32Array(an.fftSize);
      let sum = 0;
      let peak = 0;
      let n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < msLocal) {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          if (Math.abs(v) > peak) peak = Math.abs(v);
          sum += v * v;
          n++;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const rms = Math.sqrt(sum / Math.max(1, n));
      void ctx;
      return { rms, peak, dbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity };
    }, ms);

  const settle = () => page.waitForTimeout(TH.settleMs);
  const results = {};

  await settle();
  results.baselineSilence = await measure(TH.measureMs);

  // Pfad A: Engine-Play (das, was der bestehende Gate nur als Flag prueft)
  await page.evaluate(async () => {
    await window.__audioMonastry.audioEngine.play();
  });
  await settle();
  results.afterPlay = await measure(TH.measureMs);

  // Pfad B: Drum-Trigger direkt
  const drumResults = {};
  for (const kind of ['kick', 'hat', 'snare']) {
    try {
      await page.evaluate((k) => window.__audioMonastry.audioEngine.triggerDrumSynth(k), kind);
      await settle();
      drumResults[kind] = await measure(TH.measureMs);
    } catch (e) {
      drumResults[kind] = { error: String(e).slice(0, 120) };
    }
  }
  results.drums = drumResults;

  // Pfad C: Preview eines synthetisierten Samples
  try {
    await page.evaluate(() => window.__audioMonastry.audioEngine.previewSynthesizedSample({ frequency: 440, decay: 0.3 }));
    await settle();
    results.preview = await measure(TH.measureMs);
  } catch (e) {
    results.preview = { error: String(e).slice(0, 120) };
  }

  // Stop -> Stille
  await page.evaluate(() => window.__audioMonastry.audioEngine.stop());
  await settle();
  results.afterStop = await measure(TH.measureMs);

  const flags = await page.evaluate(() => {
    const e = window.__audioMonastry.audioEngine;
    return { isPlaying: e.isPlaying ?? null, v2Connected: e.v2LiveSink?.isConnected ?? null, mode: e.playbackMode ?? null };
  });

  await browser.close();

  const f = (v) => (v === -Infinity || v === undefined ? '-inf' : Number(v).toFixed(1));
  console.log('\n--- Engine-Flags (das, was der alte Gate geprueft hat) ---');
  console.log('  ' + JSON.stringify(flags));

  console.log('\n--- Gemessener Pegel am Master-Tap (dBFS) ---');
  for (const [k, v] of Object.entries(results)) {
    if (k === 'drums') {
      for (const [dk, dv] of Object.entries(v)) console.log(`  drums.${dk.padEnd(8)} ${f(dv.dbfs)}   peak=${dv.peak ?? '-'}`);
    } else {
      console.log(`  ${k.padEnd(18)} ${f(v.dbfs)}   peak=${v.peak ?? '-'}`);
    }
  }

  const audible = (r) => r && typeof r.dbfs === 'number' && r.dbfs >= TH.audibleDbfsMin;
  const silent = (r) => r && (r.dbfs === -Infinity || r.dbfs <= TH.silenceDbfsMax);
  const checks = [
    ['Baseline ist still', silent(results.baselineSilence)],
    ['Engine-Play erzeugt messbares Audio', audible(results.afterPlay)],
    ['Drum-Trigger kick erzeugt Audio', audible(results.drums.kick)],
    ['Drum-Trigger hat erzeugt Audio', audible(results.drums.hat)],
    ['Preview erzeugt Audio', audible(results.preview)],
    ['Stop fuehrt in Stille', silent(results.afterStop)],
    ['keine pageErrors', pageErrors.length === 0],
  ];
  console.log('\n--- Zusagen ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }
  if (pageErrors.length) console.log('  pageErrors:', pageErrors);

  fs.mkdirSync(path.resolve(__dirname, '../reports'), { recursive: true });
  fs.writeFileSync(
    path.resolve(__dirname, '../reports/audio-ui-gate.json'),
    JSON.stringify({ ts: new Date().toISOString(), base: BASE, thresholds: TH, tap: tapInfo, flags, raw: results, checks: Object.fromEntries(checks), pageErrors }, null, 2),
  );
  console.log('\nRohdaten: reports/audio-ui-gate.json');
  console.log(failed === 0 ? 'UI-GATE: PASS' : `UI-GATE: FAIL (${failed} Zusage(n) verletzt)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('UI-GATE-ABBRUCH:', e.message);
  process.exit(3);
});

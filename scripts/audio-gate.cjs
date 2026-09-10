#!/usr/bin/env node
/**
 * AUDIO-CONTENT-GATE (AUDIT-AUDIO-002/006)
 * ========================================
 * Beweist in einem ECHTEN Browser (headless Chromium), dass der V2-Worklet-Pfad
 * hoerbares Audio erzeugt – statt nur Statuswerte zu pruefen.
 *
 * Gemessen wird am Ausgang des echten `v2-sink-processor` AudioWorkletNode:
 *   1. Stille vor dem Trigger            -> muss praktisch -inf dBFS sein
 *   2. `test-tone` aktiv                 -> muss deutlich ueber der Schwelle liegen
 *   3. `test-tone` aus (nach Ausschwingen) -> zurueck in die Stille
 *   4. echtes dekodiertes Stereo-WAV per `sample-set` + `sample-trigger`
 *      -> messbarer Pegel, LINKER und RECHTER Kanal getrennt geprueft
 *   5. `sample-stop` (nach Ausschwingen) -> zurueck in die Stille
 *
 * Wichtig (in der Machbarkeitsprobe gelernt): der AnalyserNode puffert das alte
 * Signal. Ohne Ausschwing-Verzoegerung wuerde "Stop -> Stille" falsch fehlschlagen.
 *
 * Aufruf:  node scripts/audio-gate.cjs        (exit 0 = alle Zusagen erfuellt)
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const THRESHOLDS = {
  silenceDbfsMax: -60, // Stille gilt als Stille
  toneDbfsMin: -20, // Testton muss klar hoerbar sein
  sampleDbfsMin: -30, // Sample muss klar hoerbar sein
  settleMs: 260, // Ausschwingen nach Zustandswechsel
  measureMs: 320,
};

const WORKLET_FILE = path.resolve(__dirname, '../public/worklets/v2SinkProcessor.js');

/**
 * Deterministisches Stereo-WAV mit UNTERSCHIEDLICHEN Kanalpegeln.
 *
 * Wichtig: links 1 kHz @ 0.5, rechts 440 Hz @ 0.15. Zwei Sinusse mit gleicher
 * Amplitude haben denselben RMS – ein Kanaltrennungs-Test mit gleichen Pegeln
 * kann eine Mono-Kollaps-Kollision nicht erkennen (genau dieser Fehler steckte
 * in der ersten Fassung dieses Gates).
 */
const LEFT_AMPLITUDE = 0.5; // -6 dBFS
const RIGHT_AMPLITUDE = 0.15; // -16.5 dBFS

function buildStereoWav(sampleRate = 48000, seconds = 1.0) {
  const frames = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const l = Math.round(LEFT_AMPLITUDE * 32767 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
    const r = Math.round(RIGHT_AMPLITUDE * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    data.writeInt16LE(l, i * 4);
    data.writeInt16LE(r, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

(async () => {
  if (!fs.existsSync(WORKLET_FILE)) {
    console.error(`FEHLER: Worklet fehlt: ${WORKLET_FILE} – erst 'node build-worklets.mjs' ausfuehren.`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  // Echter kleiner HTTP-Server statt Request-Interception: `audioWorklet.addModule`
  // scheiterte an der Layer-Interception ("Unable to load a worklet's module").
  // Ein echter Origin mit korrektem Content-Type ist der robuste Weg.
  const PUBLIC_DIR = path.resolve(__dirname, '../public');
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/probe.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>audio-gate</body></html>');
      return;
    }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.html' ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/probe.html`);

  const wavBase64 = buildStereoWav().toString('base64');

  const result = await page.evaluate(
    async ({ wavBase64, thresholds }) => {
      const log = [];
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      log.push(`AudioContext state=${ctx.state} sampleRate=${ctx.sampleRate}`);

      await ctx.audioWorklet.addModule('/worklets/v2SinkProcessor.js');
      const node = new AudioWorkletNode(ctx, 'v2-sink-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      log.push(`worklet node: outputs=${node.numberOfOutputs} channels=${node.channelCount}`);

      // Nach dem Worklet: Splitter -> zwei Analyser (L/R getrennt)
      const splitter = ctx.createChannelSplitter(2);
      const aL = ctx.createAnalyser();
      const aR = ctx.createAnalyser();
      aL.fftSize = 2048;
      aR.fftSize = 2048;
      node.connect(splitter);
      splitter.connect(aL, 0);
      splitter.connect(aR, 1);
      node.connect(ctx.destination);

      const measure = async (ms) => {
        const bl = new Float32Array(aL.fftSize);
        const br = new Float32Array(aR.fftSize);
        let sumL = 0;
        let sumR = 0;
        let peakL = 0;
        let peakR = 0;
        let n = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          aL.getFloatTimeDomainData(bl);
          aR.getFloatTimeDomainData(br);
          for (let i = 0; i < bl.length; i++) {
            const vl = bl[i];
            const vr = br[i];
            if (Math.abs(vl) > peakL) peakL = Math.abs(vl);
            if (Math.abs(vr) > peakR) peakR = Math.abs(vr);
            sumL += vl * vl;
            sumR += vr * vr;
            n++;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        const rmsL = Math.sqrt(sumL / Math.max(1, n));
        const rmsR = Math.sqrt(sumR / Math.max(1, n));
        const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
        return { rmsL, rmsR, dbfsL: db(rmsL), dbfsR: db(rmsR), peakL, peakR };
      };

      const settle = () => new Promise((r) => setTimeout(r, thresholds.settleMs));
      const steps = {};

      await settle();
      steps.silenceBefore = await measure(thresholds.measureMs);

      node.port.postMessage({ type: 'test-tone', active: true, freq: 1000, amplitude: 0.5 });
      await settle();
      steps.testTone = await measure(thresholds.measureMs);

      node.port.postMessage({ type: 'test-tone', active: false });
      await settle();
      steps.silenceAfterTone = await measure(thresholds.measureMs);

      // --- echtes dekodiertes Stereo-WAV durch den V2-Engine-Pfad ---
      const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0));
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      log.push(`decoded WAV: ${audioBuffer.numberOfChannels}ch, ${audioBuffer.length} frames, ${audioBuffer.sampleRate} Hz`);
      const left = audioBuffer.getChannelData(0).slice();
      const right = audioBuffer.getChannelData(1).slice();
      const channel = 'channel4';
      node.port.postMessage({ type: 'sample-set', channel, left, right, sourceRate: audioBuffer.sampleRate });
      await settle();
      steps.afterSampleSet = await measure(thresholds.measureMs);

      node.port.postMessage({ type: 'sample-trigger', channel, loop: false, rate: 1, offset: 0 });
      await settle();
      steps.samplePlaying = await measure(thresholds.measureMs);

      node.port.postMessage({ type: 'sample-stop', channel });
      await settle();
      steps.silenceAfterStop = await measure(thresholds.measureMs);

      await ctx.close();
      return { log, steps, sampleFrames: left.length, sampleRate: audioBuffer.sampleRate };
    },
    { wavBase64, thresholds: THRESHOLDS },
  );

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  const f = (v) => (v === -Infinity ? '-inf' : v.toFixed(1));
  console.log('--- Ablauf ---');
  for (const l of result.log) console.log('  ' + l);
  console.log('--- Rohmesswerte (dBFS, RMS je Kanal / Peak) ---');
  const rows = Object.entries(result.steps);
  for (const [name, m] of rows) {
    console.log(
      `  ${name.padEnd(18)} L=${f(m.dbfsL).padStart(6)}  R=${f(m.dbfsR).padStart(6)}  peakL=${m.peakL.toFixed(4)}  peakR=${m.peakR.toFixed(4)}`,
    );
  }

  const s = result.steps;
  const checks = [
    ['Stille vor Trigger', Math.max(s.silenceBefore.dbfsL, s.silenceBefore.dbfsR) <= THRESHOLDS.silenceDbfsMax],
    ['test-tone hoerbar', Math.max(s.testTone.dbfsL, s.testTone.dbfsR) >= THRESHOLDS.toneDbfsMin],
    ['Stille nach test-tone', Math.max(s.silenceAfterTone.dbfsL, s.silenceAfterTone.dbfsR) <= THRESHOLDS.silenceDbfsMax],
    ['sample-set allein bleibt still', Math.max(s.afterSampleSet.dbfsL, s.afterSampleSet.dbfsR) <= THRESHOLDS.silenceDbfsMax],
    ['Sample nach Trigger hoerbar (L)', s.samplePlaying.dbfsL >= THRESHOLDS.sampleDbfsMin],
    ['Sample nach Trigger hoerbar (R)', s.samplePlaying.dbfsR >= THRESHOLDS.sampleDbfsMin],
    ['Kanaele getrennt gespeist (L deutlich lauter als R)', s.samplePlaying.dbfsL - s.samplePlaying.dbfsR >= 6],
    ['Stille nach sample-stop', Math.max(s.silenceAfterStop.dbfsL, s.silenceAfterStop.dbfsR) <= THRESHOLDS.silenceDbfsMax],
    ['keine pageErrors', pageErrors.length === 0],
  ];

  console.log('--- Zusagen ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }
  if (pageErrors.length) console.log('  pageErrors:', pageErrors);

  const report = {
    ts: new Date().toISOString(),
    thresholds: THRESHOLDS,
    raw: s,
    checks: Object.fromEntries(checks),
    pageErrors,
    sampleFrames: result.sampleFrames,
    sampleRate: result.sampleRate,
  };
  fs.mkdirSync(path.resolve(__dirname, '../reports'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '../reports/audio-gate.json'), JSON.stringify(report, null, 2));
  console.log(`\nRohdaten: reports/audio-gate.json`);
  console.log(failed === 0 ? 'GATE: PASS' : `GATE: FAIL (${failed} Zusage(n) verletzt)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('GATE-ABBruch:', e);
  process.exit(3);
});

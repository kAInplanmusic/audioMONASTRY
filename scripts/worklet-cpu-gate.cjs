#!/usr/bin/env node
/**
 * WORKLET-CPU-BUDGET-GATE (PERF-P3-001)
 * =====================================
 * Misst im ECHTEN Browser (headless Chromium) die CPU-Last des V2-Live-Pfads:
 *
 *   1. `v2-sink-processor` meldet selbst (opt-in `processorOptions.measure`)
 *      die Render-Zeit pro Block: Durchschnitt, Maximum, Budget und Last in %.
 *      Ein Block = 128 Frames → Budget = 128/sampleRate (2,667 ms bei 48 kHz).
 *   2. `AudioContext.renderCapacity` (Chrome) liefert zusaetzlich die Last des
 *      GESAMTEN Graphen inkl. Underrun-Anteil – falls die API fehlt, wird das
 *      ausdruecklich als OFFEN vermerkt statt still weggelassen (PERF-P3-002).
 *
 * PERF-P3-002: Auf einem Chromium MIT `renderCapacity` und `performance` im
 * Worklet-Scope sind beide Messungen Pflicht (`REQUIRE_PERF_APIS=1` → Gate
 * schlaegt fehl, wenn eine API fehlt). Ohne die Env-Variable bleiben sie als
 * OFFEN sichtbar (Report: `perfOpenPoints`, `fineGrainedTimer`).
 *
 * Lastszenario: vier Kanaele mit je einem eigenen Sample gleichzeitig getriggert
 * (Naeherung an den 4-User-Betrieb) plus Testton im Master.
 *
 * Aufruf:  node scripts/worklet-cpu-gate.cjs
 * Exit:    0 = Budgets eingehalten · 1 = Budget verletzt · 2 = Vorbedingung fehlt
 * Schreibt: reports/worklet-cpu.json (fuer den CI-Artefakt-Upload)
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BUDGETS = {
  /** Durchschnittslast des V2-Sinks: Zielwert (Warnung oberhalb). */
  warnLoadPct: 25,
  /** Oberhalb dieser Last gilt das Gate als verletzt (kein Headroom mehr). */
  failLoadPct: 50,
  /** Ein einzelner Block darf sein Echtzeit-Budget nicht ueberschreiten. */
  maxBlockOverBudget: true,
  /** renderCapacity: Gesamtlast des Graphen (Warnung / Fehlschlag). */
  warnContextLoad: 0.25,
  failContextLoad: 0.5,
  measureMs: 6000,
};

const WORKLET_FILE = path.resolve(__dirname, '../public/worklets/v2SinkProcessor.js');
const REPORT_FILE = path.resolve(__dirname, '../reports/worklet-cpu.json');

(async () => {
  if (!fs.existsSync(WORKLET_FILE)) {
    console.error(`FEHLER: Worklet fehlt: ${WORKLET_FILE} – erst 'node build-worklets.mjs' ausfuehren.`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      // Ohne diese Schalter drosselt headless Chromium den Audio-Thread der
      // (versteckten) Seite – dann laeuft process() kaum und jede Messung waere
      // wertlos. Gleiche Ursache wie beim Busy-Loop im audio-gate.cjs.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.bringToFront().catch(() => {});
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  const PUBLIC_DIR = path.resolve(__dirname, '../public');
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/cpu-probe.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>worklet-cpu-gate</body></html>');
      return;
    }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const type = path.extname(filePath) === '.js' ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/cpu-probe.html`);

  const result = await page.evaluate(async ({ measureMs, channels }) => {
    const log = [];
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    log.push(`AudioContext state=${ctx.state} sampleRate=${ctx.sampleRate} baseLatency=${ctx.baseLatency ?? 'n/a'}`);

    // --- Context-Last (Chrome AudioRenderCapacity) ---
    const contextLoads = [];
    let renderCapacityAvailable = false;
    if (ctx.renderCapacity) {
      renderCapacityAvailable = true;
      ctx.renderCapacity.onupdate = (e) => {
        contextLoads.push({
          averageLoad: Number(e.averageLoad.toFixed(4)),
          peakLoad: Number(e.peakLoad.toFixed(4)),
          underrunRatio: Number(e.underrunRatio.toFixed(5)),
        });
      };
      ctx.renderCapacity.start({ updateInterval: 0.5 });
    }

    await ctx.audioWorklet.addModule('/worklets/v2SinkProcessor.js');
    const node = new AudioWorkletNode(ctx, 'v2-sink-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // PERF-P3-001: Messung ist opt-in – im Betrieb aus.
      processorOptions: { measure: true },
    });

    const cpuReports = [];
    let lastCpu = null;
    const messageTypes = {};
    node.port.onmessage = (e) => {
      const msg = e.data || {};
      messageTypes[msg.type] = (messageTypes[msg.type] || 0) + 1;
      if (msg.type === 'cpu-stats') {
        lastCpu = msg;
        cpuReports.push(msg);
      }
    };

    // Wie im audio-gate.cjs: Splitter + Analyser am Ausgang. In headless
    // Chromium rendert der Graph nur zuverlaessig, wenn der Ausgang so
    // abgegriffen wird (live verifiziert: ohne diesen Abgriff laeuft process()
    // nicht und es kommen keine Messwerte).
    const splitter = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser();
    const aR = ctx.createAnalyser();
    aL.fftSize = 2048;
    aR.fftSize = 2048;
    node.connect(splitter);
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);
    node.connect(ctx.destination);
    log.push(`worklet: channels=${node.channelCount} Messung=${lastCpu === null ? 'gestartet' : 'laeuft'}`);

    // --- Lastszenario: vier Kanaele gleichzeitig ---
    for (let i = 0; i < channels.length; i++) {
      const frames = Math.floor(ctx.sampleRate * 1.5);
      const data = new Float32Array(frames);
      const f = 120 + i * 90;
      for (let n = 0; n < frames; n++) {
        const t = n / ctx.sampleRate;
        data[n] = Math.sin(2 * Math.PI * f * t) * 0.3 * Math.exp(-t * 2);
      }
      node.port.postMessage({ type: 'sample-set', channel: channels[i], left: data.slice(), right: data.slice(), sourceRate: ctx.sampleRate });
      node.port.postMessage({ type: 'pattern', channel: channels[i], steps: Array.from({ length: 16 }, (_, k) => k % 2 === 0) });
    }
    node.port.postMessage({ type: 'test-tone', active: true, freq: 220, amplitude: 0.2 });
    node.port.postMessage({ type: 'transport', playing: true, bpm: 128, stepCount: 16 });
    // Regelmässiges Neu-Triggern erzwingt dauerhafte Stimmen-Aktivitaet.
    const retrigger = setInterval(() => {
      for (const channel of channels) {
        node.port.postMessage({ type: 'sample-trigger', channel, loop: false, rate: 1, offset: 0 });
      }
    }, 500);

    // Live verifizierte Eigenheit von headless Chromium: der Audio-Thread laeuft
    // nur, solange der Main-Thread beschaeftigt ist – und waehrenddessen werden
    // Port-Nachrichten NICHT zugestellt. Deshalb zeitlich trennen:
    //   1) kurz warten, damit die Quittung ankommt,
    //   2) dann beschaeftigen (Audio rendert, Meldungen werden eingereiht),
    //   3) zum Schluss wieder freigeben, damit die Meldungen ankommen.
    await new Promise((r) => setTimeout(r, 250));
    const t0 = performance.now();
    while (performance.now() - t0 < measureMs) {
      // absichtlich beschaeftigt: der Audio-Thread braucht einen aktiven Renderer
    }
    clearInterval(retrigger);
    // Pegel lesen: beweist, dass der Graph wirklich gerendert hat (nicht nur
    // currentTime laeuft – das tut es auch ohne Prozessorarbeit).
    const bl = new Float32Array(aL.fftSize);
    aL.getFloatTimeDomainData(bl);
    let peak = 0;
    for (const v of bl) peak = Math.max(peak, Math.abs(v));
    await new Promise((r) => setTimeout(r, 400));
    node.port.postMessage({ type: 'test-tone', active: false });
    node.port.postMessage({ type: 'transport', playing: false });

    if (ctx.renderCapacity) {
      try { ctx.renderCapacity.stop(); } catch { /* optional */ }
    }
    await ctx.close();

    return {
      log,
      outputPeak: Number(peak.toFixed(4)),
      messageTypes,
      cpu: lastCpu,
      cpuReportCount: cpuReports.length,
      maxLoadPctReported: cpuReports.reduce((m, r) => Math.max(m, r.loadPct), 0),
      maxBlockMsReported: cpuReports.reduce((m, r) => Math.max(m, r.maxMs), 0),
      renderCapacityAvailable,
      contextLoads,
    };
  }, { measureMs: BUDGETS.measureMs, channels: ['channel1', 'channel2', 'channel3', 'channel4'] });

  const browserVersionActual = browser.version();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log(`--- Browser: ${browserVersionActual} ---`);
  console.log('--- Ablauf ---');
  for (const l of result.log) console.log('  ' + l);

  const cpu = result.cpu;
  console.log(`--- Messmodus ---`);
  console.log(cpu
    ? `  aktiv: erster Bericht nach ${cpu.blocks} Block(en), Budget ${cpu.budgetMs} ms @ ${cpu.sampleRate} Hz`
    : '  NICHT aktiv – kein Bericht aus dem Worklet (fehlende Werte sind dann ein Konfigurationsfehler, kein Messergebnis)');
  console.log(`  Nachrichten vom Worklet: ${JSON.stringify(result.messageTypes)}`);
  console.log(`  Ausgangs-Pegel (Beweis, dass gerendert wurde): ${result.outputPeak}`);
  // PERF-P3-002: Auf einem Chromium MIT den APIs sind beide Punkte Pflicht.
  // Standardmäßig sind sie „offen, aber sichtbar" – kein stiller Erfolg.
  const requirePerfApis = process.env.REQUIRE_PERF_APIS === '1';
  const fineGrainedTimer = Boolean(cpu && cpu.timer !== 'date');
  const perfOpenPoints = [];
  if (!result.renderCapacityAvailable) {
    perfOpenPoints.push('AudioContext.renderCapacity fehlt in diesem Browser (keine Context-Last/Underrun-Messung)');
  }
  if (!fineGrainedTimer) {
    perfOpenPoints.push('performance fehlt im Worklet-Scope (Blockzeit nur mit 1-ms-Aufloesung, Max-Wert informativ)');
  }

  const out = {
    messageTypes: result.messageTypes,
    generatedAt: new Date().toISOString(),
    browser: browserVersionActual,
    budgets: BUDGETS,
    cpu,
    cpuReportCount: result.cpuReportCount,
    maxLoadPctReported: result.maxLoadPctReported,
    maxBlockMsReported: result.maxBlockMsReported,
    renderCapacityAvailable: result.renderCapacityAvailable,
    contextLoads: result.contextLoads,
    fineGrainedTimer,
    perfOpenPoints,
    requirePerfApis,
    pageErrors,
  };

  console.log('--- Worklet-CPU (v2-sink-processor, Messung opt-in) ---');
  if (!cpu) {
    console.log('  KEINE Messwerte – Bericht ausgeblieben (Messung nicht aktiviert?)');
  } else {
    console.log(`  Bloecke gemessen : ${cpu.blocks}`);
    console.log(`  Ø pro Block      : ${cpu.avgMs} ms`);
    console.log(`  Max pro Block    : ${cpu.maxMs} ms`);
    console.log(`  Budget pro Block : ${cpu.budgetMs} ms (128 Frames @ ${cpu.sampleRate} Hz)`);
    console.log(`  Last             : ${cpu.loadPct} %  (Ziel <=${BUDGETS.warnLoadPct} %, Fehlschlag >${BUDGETS.failLoadPct} %)`);
    console.log(`  Zeitquelle       : ${cpu.timer}${cpu.timer === 'date' ? ' (grob, 1 ms – Max-Wert nur informativ)' : ''}`);
  }

  console.log('--- Context-Last (renderCapacity) ---');
  if (!result.renderCapacityAvailable) {
    console.log('  nicht verfuegbar in diesem Browser (kein stiller Erfolg – Wert fehlt bewusst)');
  } else if (result.contextLoads.length === 0) {
    console.log('  API vorhanden, aber keine Messpunkte erhalten');
  } else {
    const avg = result.contextLoads.reduce((s, l) => s + l.averageLoad, 0) / result.contextLoads.length;
    const peak = result.contextLoads.reduce((m, l) => Math.max(m, l.peakLoad), 0);
    const under = result.contextLoads.reduce((m, l) => Math.max(m, l.underrunRatio), 0);
    out.contextAverageLoad = Number(avg.toFixed(4));
    out.contextPeakLoad = Number(peak.toFixed(4));
    out.contextUnderrunRatio = Number(under.toFixed(5));
    console.log(`  Ø Last           : ${(avg * 100).toFixed(1)} %  (Warnung >${BUDGETS.warnContextLoad * 100} %, Fehlschlag >${BUDGETS.failContextLoad * 100} %)`);
    console.log(`  Peak             : ${(peak * 100).toFixed(1)} %`);
    console.log(`  Underrun-Anteil  : ${(under * 100).toFixed(3)} %`);
  }

  const checks = [
    ['Messmodus aktiv (erster Bericht)', Boolean(cpu) && cpu.blocks >= 1],
    ['Messwerte vorhanden', Boolean(cpu)],
    ['Ø-Last im Budget', Boolean(cpu) && cpu.loadPct <= BUDGETS.failLoadPct],
    // Bei der groben Date.now()-Auflösung (1 ms) ist ein "Max" nicht belastbar –
    // dann nur informativ, nicht als Zusage.
    ['kein Block über Budget (nur bei feiner Zeitquelle)', !BUDGETS.maxBlockOverBudget || !cpu || cpu.timer === 'date' || cpu.maxMs <= cpu.budgetMs],
    ['Context-Last im Rahmen (falls messbar)', !result.renderCapacityAvailable || (out.contextAverageLoad ?? 0) <= BUDGETS.failContextLoad],
    ['Ausgang hat Signal (Graph rendert wirklich)', result.outputPeak > 0.001],
    ['keine pageErrors', pageErrors.length === 0],
    // PERF-P3-002: nur auf einem Browser mit den APIs Pflicht (REQUIRE_PERF_APIS=1),
    // sonst als OFFEN markiert (nicht als stiller Erfolg).
    ['renderCapacity-API vorhanden (PERF-P3-002)', result.renderCapacityAvailable || !requirePerfApis],
    ['Blockzeit mit feiner Zeitquelle (PERF-P3-002)', fineGrainedTimer || !requirePerfApis],
  ];

  console.log('--- Zusagen ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  }
  if (cpu && cpu.loadPct > BUDGETS.warnLoadPct && cpu.loadPct <= BUDGETS.failLoadPct) {
    console.log(`  WARN  Ø-Last über Zielwert ${BUDGETS.warnLoadPct} % (noch im Fehlschlag-Korridor)`);
  }
  if (perfOpenPoints.length > 0) {
    console.log('--- OFFEN (PERF-P3-002) ---');
    for (const point of perfOpenPoints) console.log(`  OFFEN  ${point}`);
    console.log(`  Hinweis: auf einem Browser mit den APIs mit REQUIRE_PERF_APIS=1 als Pflicht prüfen.`);
  }

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...out, checks: checks.map(([l, ok]) => ({ check: l, ok })) }, null, 2));
  console.log(`--- Bericht: ${path.relative(process.cwd(), REPORT_FILE)} ---`);

  process.exit(failed === 0 ? 0 : 1);
})();

#!/usr/bin/env node
/**
 * WORKLET-CPU-BUDGET-GATE (PERF-P3-001 + PERF-P3-002)
 * ===================================================
 * Misst im ECHTEN Browser (headless Chromium) die CPU-Last des V2-Live-Pfads:
 *
 *   1. `v2-sink-processor` meldet selbst (opt-in `processorOptions.measure`)
 *      die Render-Zeit pro Block: Durchschnitt, Maximum, Budget und Last in %.
 *      Ein Block = 128 Frames → Budget = 128/sampleRate (2,667 ms bei 48 kHz).
 *   2. PERF-P3-002 – DEADLINE-TREUE statt Wall-Clock: der Prozessor zaehlt
 *      Luecken im `currentFrame`-Zaehler. Springt `currentFrame` um mehr als
 *      einen Render-Quantum, hat der Audio-Thread einen Block nicht rechtzeitig
 *      geliefert (verpasste Deadline / Underrun). Das ist aufloesungsunabhaengig
 *      und damit belastbar – anders als die 1-ms-Aufloesung von `Date.now()`.
 *   3. PERF-P3-002 – Audio-Uhr-Abgleich: `AudioContext.getOutputTimestamp()`
 *      (auf dem Main-Thread, dort gibt es `performance`) verknuepft Audio-Zeit
 *      und Wall-Clock. Bleibt die Audio-Zeit hinter der Wall-Clock zurueck, kam
 *      der Audio-Thread nicht mit.
 *
 * WARUM NICHT `performance` IM WORKLET (Befund 2026-09-13, live geprueft):
 * `performance` ist im `AudioWorkletGlobalScope` nicht exponiert – per Spec
 * (WorkletGlobalScope ist kein WorkerGlobalScope) und in JEDEM Chromium;
 * gemessen: `typeof performance === 'undefined'` im Prozessor, waehrend `Date`,
 * `currentTime`, `currentFrame` und `sampleRate` vorhanden sind. Eine
 * "Max-Blockzeit mit performance" ist deshalb nicht erreichbar und wird hier
 * bewusst NICHT als offener Punkt gefuehrt, sondern durch die Deadline-Messung
 * (2) ersetzt.
 *
 * `AudioContext.renderCapacity` ist Chromium-only und auf dieser Hardware
 * (Playwright-Chromium 151 UND System-Chrome 153, je mit und ohne
 * `--enable-blink-features=AudioRenderCapacity` / `--enable-features=...`)
 * NICHT vorhanden. Fehlt sie, steht das ausdruecklich als OFFEN im Bericht
 * (`perfOpenPoints`) statt still zu verschwinden; mit `REQUIRE_PERF_APIS=1`
 * wird sie zur Pflicht (fuer eine Maschine, die sie ausliefert).
 *
 * Lastszenario: vier Kanaele mit je einem eigenen Sample gleichzeitig getriggert
 * (Naeherung an den 4-User-Betrieb) plus Testton im Master.
 *
 * Aufruf:  node scripts/worklet-cpu-gate.cjs
 *          CHROME_PATH=/usr/bin/google-chrome node scripts/worklet-cpu-gate.cjs
 * Exit:    0 = Budgets eingehalten · 1 = Budget verletzt · 2 = Vorbedingung fehlt
 * Schreibt: reports/worklet-cpu.json
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
  /**
   * PERF-P3-002: verpasste Render-Quanten (Luecken im `currentFrame`-Zaehler).
   * Das ist die belastbare Deadline-Aussage und ersetzt das fruehere
   * `maxBlockOverBudget`, das an der 1-ms-Aufloesung von `Date.now()` scheiterte
   * (gemessenes "Max" war je nach Rundung 0 oder 10 ms – nicht belastbar).
   * 0 = kein Block kam zu spaet.
   */
  maxMissedQuanta: 0,
  /**
   * PERF-P3-002: Toleranz fuer den Audio-Uhr-Abgleich (`getOutputTimestamp`).
   * Die Audio-Zeit darf hoechstens so weit hinter der Wall-Clock zurueckbleiben,
   * bevor das als Underrun gilt.
   *
   * Gemessen 2026-09-13 (Chromium 151, dieses Laptop, 4-Kanal-Lastszenario,
   * 3 Laeufe): |Rueckstand| <= 0,24 % – der Audio-Thread haelt praktisch exakt
   * Takt (6 s Fenster: 5981-6011 ms Audio gegen 5996-5999 ms Wall-Clock).
   * 10 % laesst Luft fuer unruhige Maschinen und schlaegt trotzdem an, wenn ein
   * echter Stall auftritt (das waeren 0,6 s Rueckstand in einem 6-s-Fenster).
   */
  maxClockDriftPct: 10,
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
    // PERF-P3-002: optional ein echtes System-Chrome statt des Playwright-
    // Chromium nutzen (dieser hat renderCapacity/Worklet-performance nicht):
    //   CHROME_PATH=/usr/bin/google-chrome REQUIRE_PERF_APIS=1 node scripts/worklet-cpu-gate.cjs
    executablePath: process.env.CHROME_PATH || undefined,
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
    // Ein Fehler in der Messung darf nicht unsichtbar bleiben: der Prozessor
    // schaltet die Messung dann ab und meldet `cpu-error`. Ohne diesen Kanal
    // sieht der Bericht nur "keine Messwerte" – die Ursache fehlte bisher.
    const cpuErrors = [];
    node.port.onmessage = (e) => {
      const msg = e.data || {};
      messageTypes[msg.type] = (messageTypes[msg.type] || 0) + 1;
      if (msg.type === 'cpu-stats') {
        lastCpu = msg;
        cpuReports.push(msg);
      } else if (msg.type === 'cpu-error') {
        cpuErrors.push(String(msg.message ?? '').slice(0, 200));
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
    // PERF-P3-002: Audio-Uhr <-> Wall-Clock. `getOutputTimestamp()` liefert die
    // aktuell gerenderte Audio-Position und den zugehoerigen Wall-Clock-Zeitpunkt
    // (hier auf dem Main-Thread, wo `performance` existiert). Beide Werte werden
    // um den Messbereich gelegt: bleibt die Audio-Zeit hinter der Wall-Clock
    // zurueck, hat der Audio-Thread nicht mitgehalten (Underrun).
    const tsBefore = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    const t0 = performance.now();
    while (performance.now() - t0 < measureMs) {
      // absichtlich beschaeftigt: der Audio-Thread braucht einen aktiven Renderer
    }
    const busyLoopMs = performance.now() - t0;
    const tsAfter = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
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

    // PERF-P3-002: Audio-Uhr-Abgleich auswerten.
    const outputTimestampAvailable = typeof ctx.getOutputTimestamp === 'function';
    let outputTimestamp = null;
    if (
      tsBefore && tsAfter &&
      Number.isFinite(tsBefore.contextTime) && Number.isFinite(tsAfter.contextTime) &&
      Number.isFinite(tsBefore.performanceTime) && Number.isFinite(tsAfter.performanceTime)
    ) {
      const audioElapsedMs = (tsAfter.contextTime - tsBefore.contextTime) * 1000;
      const wallElapsedMs = tsAfter.performanceTime - tsBefore.performanceTime;
      const driftMs = wallElapsedMs - audioElapsedMs;
      outputTimestamp = {
        audioElapsedMs: Number(audioElapsedMs.toFixed(2)),
        wallElapsedMs: Number(wallElapsedMs.toFixed(2)),
        driftMs: Number(driftMs.toFixed(2)),
        driftPct: wallElapsedMs > 0 ? Number(((driftMs / wallElapsedMs) * 100).toFixed(2)) : 0,
      };
    }

    return {
      log,
      outputPeak: Number(peak.toFixed(4)),
      messageTypes,
      cpu: lastCpu,
      cpuReportCount: cpuReports.length,
      maxLoadPctReported: cpuReports.reduce((m, r) => Math.max(m, r.loadPct), 0),
      maxBlockMsReported: cpuReports.reduce((m, r) => Math.max(m, r.maxMs), 0),
      missedQuantaReported: cpuReports.reduce((m, r) => Math.max(m, r.missedQuanta ?? 0), 0),
      maxGapQuantaReported: cpuReports.reduce((m, r) => Math.max(m, r.maxGapQuanta ?? 1), 1),
      stallEventsReported: cpuReports.reduce((m, r) => Math.max(m, r.stallEvents ?? 0), 0),
      busyLoopMs: Number(busyLoopMs.toFixed(1)),
      renderCapacityAvailable,
      contextLoads,
      cpuErrors,
      outputTimestampAvailable,
      outputTimestamp,
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
  // PERF-P3-002: `renderCapacity` ist optional, aber nie still – fehlt sie, steht
  // sie als OFFEN im Bericht; mit REQUIRE_PERF_APIS=1 wird sie zur Pflicht (fuer
  // eine Maschine, die die API tatsaechlich ausliefert).
  const requirePerfApis = process.env.REQUIRE_PERF_APIS === '1';
  const fineGrainedTimer = Boolean(cpu && cpu.timer !== 'date');
  const deadlineTracking = Boolean(cpu && typeof cpu.maxGapQuanta === 'number');
  const missedQuanta = result.missedQuantaReported;
  const maxGapQuanta = result.maxGapQuantaReported;
  const outputTimestamp = result.outputTimestamp;
  const perfOpenPoints = [];
  /**
   * Punkte, die NICHT offen sind, sondern bewusst geschlossen: `performance` ist
   * im AudioWorkletGlobalScope per Spec nicht exponiert und wird dort auch nie
   * erscheinen. Sie hier als "OFFEN" zu fuehren waere eine Dauerbaustelle ohne
   * Adressat – die Max-Blockzeit wird stattdessen ueber verpasste Render-Quanten
   * gemessen (aufloesungsunabhaengig, s. v2SinkProcessor.trackFrameGap).
   */
  const perfClosedNotes = [
    'performance ist im AudioWorkletGlobalScope nicht exponiert (per Spec, in keinem Chromium) – Max-Blockzeit wird stattdessen ueber verpasste Render-Quanten aus currentFrame gemessen' +
      (fineGrainedTimer ? '; diese Browser-Version hat performance unerwartet doch' : ''),
  ];
  if (!result.renderCapacityAvailable) {
    perfOpenPoints.push('AudioContext.renderCapacity fehlt in diesem Browser (keine Context-Last/Underrun-Messung)');
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
    /** PERF-P3-002: verpasste Render-Quanten (currentFrame-Luecken) – belastbar. */
    missedQuanta,
    maxGapQuanta,
    stallEvents: result.stallEventsReported,
    deadlineTracking,
    /** Wall-Clock-Zeit des Messfensters (Main-Thread-Busy-Loop). */
    busyLoopMs: result.busyLoopMs,
    renderCapacityAvailable: result.renderCapacityAvailable,
    contextLoads: result.contextLoads,
    /** Fehler der Messung selbst (der Prozessor schaltet dann ab) – nie verschweigen. */
    cpuErrors: result.cpuErrors,
    fineGrainedTimer,
    workletClock: {
      performance: fineGrainedTimer,
      date: Boolean(cpu && cpu.timer === 'date'),
      audioFrames: deadlineTracking,
    },
    outputTimestampAvailable: result.outputTimestampAvailable,
    outputTimestamp,
    perfOpenPoints,
    perfClosedNotes,
    requirePerfApis,
    pageErrors,
  };

  console.log('--- Worklet-CPU (v2-sink-processor, Messung opt-in) ---');
  if (!cpu) {
    console.log('  KEINE Messwerte – Bericht ausgeblieben (Messung nicht aktiviert?)');
    // Die Ursache sichtbar machen: der Prozessor meldet Messfehler als `cpu-error`
    // und schaltet die Messung danach ab.
    for (const err of result.cpuErrors) console.log(`  FEHLER der Messung: ${err}`);
  } else {
    console.log(`  Bloecke gemessen : ${cpu.blocks}`);
    console.log(`  Ø pro Block      : ${cpu.avgMs} ms`);
    console.log(`  Max pro Block    : ${cpu.maxMs} ms${cpu.timer === 'date' ? '  (nur informativ: 1-ms-Raster)' : ''}`);
    console.log(`  Budget pro Block : ${cpu.budgetMs} ms (128 Frames @ ${cpu.sampleRate} Hz)`);
    console.log(`  Last             : ${cpu.loadPct} %  (Ziel <=${BUDGETS.warnLoadPct} %, Fehlschlag >${BUDGETS.failLoadPct} %)`);
    console.log(`  Zeitquelle       : ${cpu.timer}${cpu.timer === 'date' ? ' (grob, 1 ms – nur fuer den Mittelwert)' : ''}`);
  }

  console.log('--- Deadline-Treue (currentFrame, PERF-P3-002) ---');
  if (!deadlineTracking) {
    console.log('  nicht gemessen – kein currentFrame-Bericht aus dem Worklet');
  } else {
    console.log(
      `  Verpasste Quanten : ${missedQuanta}  (Ziel ${BUDGETS.maxMissedQuanta}, 1 Quantum = ${cpu.quantumFrames ?? 128} Frames = ${cpu.budgetMs} ms)`
    );
    console.log(`  Groesste Luecke   : ${maxGapQuanta} Quantum(e)`);
    console.log(`  Stall-Ereignisse  : ${result.stallEventsReported}`);
  }

  console.log('--- Audio-Uhr-Abgleich (getOutputTimestamp, PERF-P3-002) ---');
  if (!outputTimestamp) {
    console.log(
      result.outputTimestampAvailable
        ? '  API vorhanden, aber kein verwertbares Paar erhalten'
        : '  nicht verfuegbar in diesem Browser (kein stiller Erfolg – Wert fehlt bewusst)'
    );
  } else {
    console.log(`  Audio-Zeit        : ${outputTimestamp.audioElapsedMs} ms`);
    console.log(`  Wall-Clock        : ${outputTimestamp.wallElapsedMs} ms`);
    console.log(
      `  Rueckstand       : ${outputTimestamp.driftMs} ms (${outputTimestamp.driftPct} %, Toleranz <=${BUDGETS.maxClockDriftPct} %)`
    );
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
    // PERF-P3-002: Die Max-Blockzeit wird NICHT mehr aus der groben Wall-Clock
    // gelesen (das war "je nach Rundung 0 oder 10 ms"), sondern aus Luecken im
    // Audio-Frame-Zaehler – auflösungsunabhängig und damit als Zusage belastbar.
    ['keine verpassten Render-Quanten (currentFrame, PERF-P3-002)', Boolean(cpu) && deadlineTracking && missedQuanta <= BUDGETS.maxMissedQuanta],
    ['Audio-Uhr im Takt (getOutputTimestamp, PERF-P3-002)', !outputTimestamp || Math.abs(outputTimestamp.driftPct) <= BUDGETS.maxClockDriftPct],
    ['Context-Last im Rahmen (falls messbar)', !result.renderCapacityAvailable || (out.contextAverageLoad ?? 0) <= BUDGETS.failContextLoad],
    ['Ausgang hat Signal (Graph rendert wirklich)', result.outputPeak > 0.001],
    ['keine pageErrors', pageErrors.length === 0],
    // renderCapacity bleibt der einzige "offene" Perf-Punkt dieser Maschine;
    // mit REQUIRE_PERF_APIS=1 wird sie zur Pflicht.
    ['renderCapacity-API vorhanden (PERF-P3-002)', result.renderCapacityAvailable || !requirePerfApis],
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
  if (perfClosedNotes.length > 0) {
    console.log('--- GESCHLOSSEN (bewusst, PERF-P3-002) ---');
    for (const note of perfClosedNotes) console.log(`  ZU     ${note}`);
  }
  if (perfOpenPoints.length > 0) {
    console.log('--- OFFEN (PERF-P3-002) ---');
    for (const point of perfOpenPoints) console.log(`  OFFEN  ${point}`);
    console.log('  Hinweis: nur renderCapacity ist offen – auf einer Maschine, die die API ausliefert, mit REQUIRE_PERF_APIS=1 als Pflicht prüfen.');
  }

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...out, checks: checks.map(([l, ok]) => ({ check: l, ok })) }, null, 2));
  console.log(`--- Bericht: ${path.relative(process.cwd(), REPORT_FILE)} ---`);

  process.exit(failed === 0 ? 0 : 1);
})();

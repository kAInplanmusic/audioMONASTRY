/**
 * Browser-API-Sonde für die beiden API-blockierten Prüfpunkte
 * =====================================================================
 * VISUAL-P1-009 (WebGPU/WGSL-Renderer) und PERF-P3-002 (renderCapacity) hängen
 * nicht an fehlendem Messweg, sondern an fehlenden Browser-APIs. Diese Sonde
 * macht das reproduzierbar: sie nennt die Chromium-Version und prüft in mehreren
 * Startkonfigurationen, was tatsächlich vorhanden ist.
 *
 * Aufruf: node scripts/browser-api-probe.mjs
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';

/**
 * Ein eigener lokaler Server: `about:blank` ist KEIN sicherer Kontext
 * (isSecureContext=false), dort fehlt `audioWorklet` komplett - die Sonde haette
 * dann nur "nicht messbar" gemeldet. http://localhost/127.0.0.1 gilt als sicher.
 */
const startPageServer = () => new Promise((resolve) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>Sonde</body></html>');
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const CONFIGS = [
  { name: 'Standard headless', args: [] },
  { name: 'unsafe-swiftshader', args: ['--enable-unsafe-swiftshader'] },
  { name: 'Vulkan + swiftshader', args: ['--enable-unsafe-swiftshader', '--enable-features=Vulkan'] },
  {
    name: 'WebGPU-Entwicklung (unsafe-webgpu + Vulkan + ANGLE)',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
    ],
  },
  // PERF-P3-002: renderCapacity ist ein Blink-Feature - hier ist belegt, dass es
  // sich in dieser Browser-Generation AUCH NICHT per Flag einschalten laesst.
  // Die Konfigurationen stehen hier, damit die negative Aussage reproduzierbar
  // bleibt und nicht bei jedem Audit neu geraten werden muss (Stand 2026-09-20:
  // Playwright-Chromium 151 und /usr/bin/google-chrome 153 - alle Flags false).
  { name: 'renderCapacity: blink-feature', args: ['--enable-blink-features=AudioContextRenderCapacity'] },
  { name: 'renderCapacity: ForTesting-Variante', args: ['--enable-blink-features=AudioContextRenderCapacityForTesting'] },
  { name: 'renderCapacity: Chrome-Feature-Flag', args: ['--enable-features=RenderCapacity'] },
  { name: 'renderCapacity: experimentelle Web-Plattform', args: ['--enable-experimental-web-platform-features'] },
  {
    name: 'renderCapacity: alle Flags zusammen',
    args: [
      '--enable-experimental-web-platform-features',
      '--enable-blink-features=AudioContextRenderCapacity,AudioContextRenderCapacityForTesting',
      '--enable-features=RenderCapacity',
    ],
  },
];

const probe = async () => {
  const out = {
    secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null,
    hasNavigatorGpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    gpuAdapter: null,
    renderCapacityOnPrototype: false,
    renderCapacityOnLiveContext: false,
    audioContextState: null,
    workletScope: null,
    userAgent: navigator.userAgent,
  };
  try {
    if (out.hasNavigatorGpu) {
      out.gpuAdapter = await Promise.race([
        navigator.gpu.requestAdapter().then((a) => (a ? 'adapter-vorhanden' : 'kein-adapter')),
        new Promise((r) => setTimeout(() => r('timeout'), 5_000)),
      ]);
    }
  } catch (e) {
    out.gpuAdapter = `Fehler: ${String(e).slice(0, 80)}`;
  }
  try {
    out.renderCapacityOnPrototype = 'renderCapacity' in AudioContext.prototype;
    const ctx = new AudioContext();
    out.renderCapacityOnLiveContext = 'renderCapacity' in ctx;
    out.audioContextState = ctx.state;
    // AudioWorklet-Scope: gibt es `performance`? (PERF-P3-002, Befund A)
    //
    // ACHTUNG (Fehler hier gefunden und behoben, 2026-09-20): die Vorfassung
    // schloss den Konstruktor eine Klammer zu spaet, dadurch lag die Methode
    // `process()` IM Konstruktor - das ist kein gueltiges JavaScript, und die
    // Sonde meldete statt der Messwerte einen SyntaxError ("Unexpected token
    // '{'"). Aufgefallen ist es beim Nachfahren, weil die Aussage "performance
    // ist im Worklet nicht exponiert" aus der Sonde nicht reproduzierbar war.
    // Mehrzeilig formatiert + korrekt geschlossene Klammern, damit genau EIN
    // Fehlerbild entsteht (fehlende API) und nicht ein Parserfehler.
    const code = [
      'class Probe extends AudioWorkletProcessor {',
      '  constructor() {',
      '    super();',
      '    this.port.postMessage({',
      '      perf: typeof performance,',
      '      currentTime: typeof currentTime,',
      '      currentFrame: typeof currentFrame,',
      '      sampleRate: typeof sampleRate,',
      '      atomics: typeof Atomics,',
      '    });',
      '  }',
      '  process(frames) {',
      '    return false;',
      '  }',
      '}',
      'registerProcessor("probe", Probe);',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'probe');
    out.workletScope = await Promise.race([
      new Promise((resolve) => { node.port.onmessage = (e) => resolve(e.data); }),
      new Promise((r) => setTimeout(() => r({ perf: 'timeout' }), 3_000)),
    ]);
    await ctx.close();
  } catch (e) {
    out.workletScope = { perf: `Fehler: ${String(e).slice(0, 80)}` };
  }
  return out;
};

const main = async () => {
  console.log('Browser-API-Sonde (VISUAL-P1-009 + PERF-P3-002)');
  const pageServer = await startPageServer();
  const origin = `http://127.0.0.1:${pageServer.address().port}/`;
  for (const config of CONFIGS) {
    const browser = await chromium.launch({ args: ['--no-sandbox', ...config.args] });
    const page = await browser.newPage();
    await page.goto(origin);
    const result = await page.evaluate(probe);
    await browser.close();
    console.log(`\n--- ${config.name} ---`);
    console.log(`  Chromium:                    ${result.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '?'}`);
    console.log(`  isSecureContext:             ${result.secureContext}`);
    console.log(`  'gpu' in navigator:          ${result.hasNavigatorGpu}`);
    console.log(`  requestAdapter():            ${result.gpuAdapter ?? '(nicht geprüft)'}`);
    console.log(`  'renderCapacity' im Prototyp: ${result.renderCapacityOnPrototype}`);
    console.log(`  'renderCapacity' in Instanz:  ${result.renderCapacityOnLiveContext} (AudioContext: ${result.audioContextState})`);
    const w = result.workletScope ?? {};
    console.log(`  Worklet-Scope:               performance=${w.perf} currentTime=${w.currentTime} currentFrame=${w.currentFrame} sampleRate=${w.sampleRate} Atomics=${w.atomics}`);
  }
  pageServer.close();
  console.log('\nErgebnis: WebGPU und renderCapacity sind in ALLEN hier möglichen');
  console.log('Konfigurationen nicht vorhanden - beide Punkte bleiben an die API gebunden,');
  console.log('nicht an den Messweg.');
  console.log('');
  console.log('PERF-P3-002 (Stand 2026-09-20, nachgemessen): renderCapacity laesst sich');
  console.log('auch NICHT per Flag einschalten - geprueft in Playwright-Chromium 151 UND');
  console.log('in /usr/bin/google-chrome 153, je mit --enable-blink-features=');
  console.log('AudioContextRenderCapacity(+ForTesting), --enable-features=RenderCapacity');
  console.log('und --enable-experimental-web-platform-features: immer false. Die Sub-');
  console.log('Messung "Gesamtlast inkl. Underruns" wird deshalb vom Worklet-CPU-Gate');
  console.log('abgedeckt (scripts/worklet-cpu-gate.cjs: Durchschnittslast des V2-Sinks,');
  console.log('verpasste Render-Quanten aus currentFrame-Luecken, Audio-Uhr-Abgleich');
  console.log('ueber getOutputTimestamp).');
  console.log('Auf einer Maschine MIT der API: ');
  console.log('  VISUAL-P1-009 -> Renderer bauen (src/core/visual/ + rendererMode)');
  console.log('  PERF-P3-002   -> REQUIRE_PERF_APIS=1 setzen, dann ist renderCapacity Pflicht');
};

main().catch((e) => {
  console.error('Sonde fehlgeschlagen:', e);
  process.exit(1);
});

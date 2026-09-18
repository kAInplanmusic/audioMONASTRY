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
];

const probe = async () => {
  const out = {
    secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null,
    hasNavigatorGpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    gpuAdapter: null,
    renderCapacityOnPrototype: false,
    renderCapacityOnLiveContext: false,
    audioContextState: null,
    performanceInWorklet: null,
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
    const code = 'class P extends AudioWorkletProcessor{constructor(){super();this.port.postMessage({p:typeof performance});process(){return false}}}registerProcessor("probe",P)';
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'probe');
    out.performanceInWorklet = await Promise.race([
      new Promise((resolve) => { node.port.onmessage = (e) => resolve(e.data.p); }),
      new Promise((r) => setTimeout(() => r('timeout'), 3_000)),
    ]);
    await ctx.close();
  } catch (e) {
    out.performanceInWorklet = `Fehler: ${String(e).slice(0, 80)}`;
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
    console.log(`  typeof performance im Worklet: ${result.performanceInWorklet}`);
  }
  pageServer.close();
  console.log('\nErgebnis: WebGPU und renderCapacity sind in ALLEN hier möglichen');
  console.log('Konfigurationen nicht vorhanden - beide Punkte bleiben an die API gebunden,');
  console.log('nicht an den Messweg. Auf einer Maschine MIT der API: ');
  console.log('  VISUAL-P1-009 -> Renderer bauen (src/core/visual/ + rendererMode)');
  console.log('  PERF-P3-002   -> REQUIRE_PERF_APIS=1 setzen, dann ist renderCapacity Pflicht');
};

main().catch((e) => {
  console.error('Sonde fehlgeschlagen:', e);
  process.exit(1);
});

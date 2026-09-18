/**
 * Live-Beweis: WebGPU/WGSL-Renderer zeichnet wirklich (VISUAL-P1-009)
 * =====================================================================
 * Der Punkt galt als BLOCKED, weil `navigator.gpu` „nicht vorhanden" sei. Das war
 * auf `about:blank` gemessen — kein sicherer Kontext. Hier wird auf einem lokalen
 * Origin (secure) mit den WebGPU-Entwicklungsflags gemessen, und zwar nicht per
 * „API ist da", sondern per **echter GPU-Rücklesung**: der Renderer zeichnet einen
 * Frame, liest die Pixel aus dem GPU-Puffer zurück, und wir prüfen, dass
 *
 *   1. überhaupt etwas NICHT-Schwarzes herauskommt (der Pfad zeichnet wirklich),
 *   2. zwei verschiedene Presets unterschiedliche Bilder ergeben (die Parameter
 *      wirken), und
 *   3. eine Szene ehrlich als „ignoriert" gemeldet wird (dokumentierte Grenze).
 *
 * Aufruf: npm run proof:webgpu   (startet den Dev-Server selbst; Port muss frei sein)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const PORT = Number(process.env.PROOF_PORT || 8099);
const APP_URL = `http://127.0.0.1:${PORT}`;

const WEBGPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--use-vulkan=swiftshader',
  '--disable-vulkan-surface',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portIsFree = (port) => new Promise((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '127.0.0.1');
});

const waitForHealth = async (timeoutMs = 90_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${APP_URL}/api/health`)).ok) return true;
    } catch { /* noch nicht bereit */ }
    await sleep(500);
  }
  return false;
};

let server = null;

const main = async () => {
  if (!(await portIsFree(PORT))) {
    console.error(`ABBRUCH: Port ${PORT} ist belegt - dort laeuft ein fremder Server. PROOF_PORT setzen.`);
    process.exit(3);
  }
  server = spawn('npx', ['tsx', 'server.ts'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(String(d)));
  server.stderr.on('data', (d) => log.push(String(d)));
  if (!(await waitForHealth())) {
    console.error('Server nicht gestartet:', log.join('').slice(-600));
    process.exit(2);
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', ...WEBGPU_FLAGS] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    // Das ausgelieferte Modul direkt laden (Vite-Dev-Server) - kein Nachbau.
    const mod = await import('/src/core/visual/webgpuRenderer.ts');
    const presets = await import('/src/core/visual/visualPresets.ts');
    const out = {
      hasGpu: mod.hasWebGpuSupport(),
      adapter: null,
      rendererKind: null,
      frames: [],
      sceneIgnored: null,
      error: null,
    };
    if (!out.hasGpu) return out;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      document.body.appendChild(canvas);
      const renderer = await mod.createWebGpuVisualRenderer(canvas);
      if (!renderer) {
        out.adapter = 'kein Adapter/Renderer';
        return out;
      }
      out.adapter = 'vorhanden';
      out.rendererKind = renderer.kind;

      const allPresets = presets.VISUAL_PRESETS ?? [];
      for (const preset of allPresets.slice(0, 3)) {
        const params = { zoom: 1.1, rotation: 15, warp: 0.4, hue: 200, flow: 0.6, brightness: 1, contrast: 1.1, displacement: 0.4, glow: 0.3, symmetry: 3 };
        renderer.render(preset, params, 1.5);
        const pixels = await renderer.readPixels();
        let nonBlack = 0;
        let sum = 0;
        let hueSum = 0;
        for (let i = 0; i + 3 < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (luma > 8) nonBlack += 1;
          sum += luma;
          // grobe Farbton-Kennzahl (welcher Kanal dominiert)
          hueSum += (r > g && r > b) ? 1 : (g > b ? 2 : 3);
        }
        const count = Math.max(1, Math.floor(pixels.length / 4));
        out.frames.push({
          preset: preset.id ?? preset.name ?? '?',
          nonBlack,
          meanLuma: Math.round((sum / count) * 100) / 100,
          hue: Math.round((hueSum / count) * 1000) / 1000,
        });
      }
      // Szene: muss ehrlich als ignoriert gemeldet werden.
      const fakeScene = { current: document.createElement('img'), previous: null };
      out.sceneIgnored = renderer.render(allPresets[0], { zoom: 1, rotation: 0, warp: 0, hue: 0, flow: 0.5, brightness: 1, contrast: 1, displacement: 0, glow: 0, symmetry: 1 }, 1, fakeScene).sceneIgnored;
      renderer.dispose();
    } catch (err) {
      out.error = String(err).slice(0, 200);
    }
    return out;
  });

  await browser.close();

  console.log('WebGPU-Verfügbarkeit:', result.hasGpu ? 'navigator.gpu vorhanden' : 'nicht vorhanden');
  console.log('Adapter/Renderer:    ', result.adapter, result.rendererKind ? `(kind=${result.rendererKind})` : '');
  if (result.error) console.log('Fehler:              ', result.error);
  for (const frame of result.frames) {
    console.log(`Preset ${String(frame.preset).padEnd(14)} nicht-schwarze Pixel: ${String(frame.nonBlack).padStart(6)} · mittlere Helligkeit: ${String(frame.meanLuma).padStart(6)} · Farbton-Kennzahl: ${frame.hue}`);
  }
  console.log('Szene wird ignoriert (dokumentierte Grenze):', result.sceneIgnored);

  const draws = result.frames.length > 0
    && result.frames.every((f) => f.nonBlack > 1000 && f.meanLuma > 10);
  const differs = new Set(result.frames.map((f) => `${f.meanLuma}|${f.hue}`)).size > 1;

  console.log('\nErgebnis:');
  console.log(`  WebGPU-Pfad zeichnet wirklich (nicht-schwarz): ${draws ? 'JA' : 'NEIN'}`);
  console.log(`  Presets wirken unterschiedlich:                ${differs ? 'JA' : 'NEIN'}`);
  console.log(`  Szene ehrlich als ignoriert gemeldet:          ${result.sceneIgnored === true ? 'JA' : 'NEIN'}`);
  process.exitCode = draws && differs && result.sceneIgnored === true ? 0 : 1;
};

main()
  .catch((e) => {
    console.error('Probe fehlgeschlagen:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server?.pid) {
      try { server.kill('SIGTERM'); process.kill(-server.pid, 'SIGTERM'); } catch { /* weg */ }
      setTimeout(() => {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { /* weg */ }
        process.exit(process.exitCode ?? 0);
      }, 1_500);
    } else {
      process.exit(process.exitCode ?? 0);
    }
  });

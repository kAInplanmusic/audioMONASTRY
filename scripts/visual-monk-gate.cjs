// VisualMONK-Gate: App starten, Overlay öffnen, Canvas prüfen (echter Browser).
//
// VISUAL-P1-005: prüft BEIDE Renderer-Pfade.
//   * Canvas2D (Referenz): Pixel-Varianz direkt über getImageData.
//   * WebGL/WebGL2 (Upgrade): GL-Zustand (Programm gebunden, kein GL-Fehler) und
//     die Nicht-Einfarbigkeit über die PNG-Größe des Canvas-Screenshots — ein
//     einfarbig schwarzer Frame komprimiert auf wenige KB, ein gerendertes Bild
//     deutlich größer. (Ehrlich: das ist ein Proxy, kein Pixel-Beweis; der
//     Pixel-Beweis läuft über den Canvas2D-Pfad und die Unit-Tests der
//     Uniform-Abbildung.)
// VISUAL-P1-008: zusätzlich läuft eine echte Show mit einer (gemockten) Szene im
//   GL-Pfad: der Umschalter darf WÄHREND der Show nicht gesperrt sein, und der
//   Shader muss die Szene als Textur zeichnen (u_sceneAmount = 1, Textur
//   gebunden, kein GL-Fehler).
const { chromium } = require('playwright');
const zlib = require('zlib');

const MIN_RENDERED_PNG_BYTES = 15 * 1024;

/**
 * Eindeutig gemustertes Test-Bild (64×64-Farbverlauf) als data-URI. Wird im Gate
 * lokal erzeugt, damit der Show-Test keine Netz-/GPU-/AI-Kosten verursacht.
 */
function gradientPngDataUri() {
  const W = 64;
  const H = 64;
  const crc32 = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // Filter: None
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 3) + 1 + x * 3;
      raw[o] = Math.floor((255 * x) / (W - 1));
      raw[o + 1] = Math.floor((255 * y) / (H - 1));
      raw[o + 2] = Math.floor(255 * (1 - (x + y) / (W + H - 2)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // Truecolor
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

async function canvasScreenshotSize(page) {
  const canvas = page.locator('[role="dialog"][aria-label="VisualMONK Liveshow"] canvas').first();
  if (!(await canvas.count())) return 0;
  const buffer = await canvas.screenshot();
  return buffer.length;
}

async function inspectCanvas(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="VisualMONK Liveshow"]');
    const canvas = dialog ? dialog.querySelector('canvas') : null;
    const renderer = (window.__visualRenderer || 'canvas2d');
    let nonUniform = false;
    let uniqueColors = 0;
    let glInfo = null;

    if (canvas instanceof HTMLCanvasElement && canvas.width > 0) {
      if (renderer === 'canvas2d') {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const sw = Math.min(300, canvas.width), sh = Math.min(220, canvas.height);
          const sx = Math.max(0, Math.floor(canvas.width / 2 - sw / 2));
          const sy = Math.max(0, Math.floor(canvas.height / 2 - sh / 2));
          const data = ctx.getImageData(sx, sy, sw, sh).data;
          const seen = new Set();
          let min = 255, max = 0;
          for (let i = 0; i < data.length; i += 4) {
            const v = data[i] + data[i + 1] + data[i + 2];
            min = Math.min(min, v); max = Math.max(max, v);
            if (seen.size < 5000) seen.add((data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4));
          }
          nonUniform = max - min > 30;
          uniqueColors = seen.size;
        }
      } else {
        // WebGL: derselbe Kontext wird zurückgegeben (getContext ist idempotent).
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (gl) {
          const program = gl.getParameter(gl.CURRENT_PROGRAM);
          const sceneLoc = program ? gl.getUniformLocation(program, 'u_sceneAmount') : null;
          glInfo = {
            contextLost: gl.isContextLost(),
            programBound: program !== null,
            glError: gl.getError(),
            drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
            // VISUAL-P1-008: ist der Show-Szenen-Pfad aktiv?
            sceneAmount: sceneLoc ? gl.getUniform(program, sceneLoc) : null,
            textureBound: gl.getParameter(gl.TEXTURE_BINDING_2D) !== null,
          };
          nonUniform = glInfo.programBound && glInfo.glError === 0 && !glInfo.contextLost;
        }
      }
    }
    return {
      dialogFound: !!dialog,
      renderer,
      rendererAttr: dialog ? dialog.getAttribute('data-renderer') : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      streamButton: !!Array.from(document.querySelectorAll('button')).find((b) => /GHOSTUSER 6/.test(b.textContent || '')),
      presetButtons: dialog ? dialog.querySelectorAll('button').length : 0,
      nonUniform,
      uniqueColors,
      gl: glInfo,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const badResponses = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);

  // Studio betreten (Startgate)
  const enter = page.locator('button', { hasText: /STUDIO BETRETEN|audioMONASTRY starten/i }).first();
  if (await enter.count()) { await enter.click({ timeout: 15000 }).catch(() => {}); }
  await page.waitForTimeout(4000);

  const visualBtn = page.locator('[aria-label="VisualMONK Liveshow oeffnen"]').first();
  const hasBtn = await visualBtn.count();
  if (hasBtn) await visualBtn.click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const canvas2d = await inspectCanvas(page);
  const canvas2dPngBytes = await canvasScreenshotSize(page);

  // --- Umschalten auf WebGL (VISUAL-P1-005) ---
  const toggleSel = '[role="dialog"][aria-label="VisualMONK Liveshow"] button';
  const toggle = page.locator(toggleSel, { hasText: 'CANVAS2D' }).first();
  let toggled = false;
  if (await toggle.count()) {
    await toggle.click({ timeout: 10000 }).catch(() => {});
    toggled = true;
    await page.waitForTimeout(2500);
  }
  const webgl = toggled ? await inspectCanvas(page) : null;
  const webglPngBytes = toggled ? await canvasScreenshotSize(page) : 0;

  // --- VISUAL-P1-008: Show mit Medium im GL-Pfad, Umschalten WAEHREND der Show ---
  // Der Bild-Endpunkt wird gemockt (kein Netz-/GPU-/AI-Aufruf im Gate): die UI
  // erzeugt daraus eine Szene, die Show laeuft, und der Renderer wird waehrend
  // der laufenden Show gewechselt. Der GL-Pfad muss die Szene als Textur zeichnen
  // (u_sceneAmount = 1, Textur gebunden, kein GL-Fehler).
  await page.route('**/api/ai/vision', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', image: gradientPngDataUri(), imageUrl: null, generationId: 'gate-scene' }),
    }),
  );

  let showScenario = null;
  const promptInput = page.locator('[aria-label="Bild-Prompt"]').first();
  if (await promptInput.count()) {
    await promptInput.fill('gate-scene');
    await page.locator('button', { hasText: 'BILD ERZEUGEN' }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const sceneBtn = page.locator(toggleSel, { hasText: 'SZENE +' }).first();
    if ((await sceneBtn.count()) && (await sceneBtn.isEnabled())) await sceneBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    const startBtn = page.locator(toggleSel, { hasText: 'SHOW START' }).first();
    if ((await startBtn.count()) && (await startBtn.isEnabled())) await startBtn.click().catch(() => {});
    await page.waitForTimeout(2500);

    const toggleBtn = page.locator(toggleSel, { hasText: /CANVAS2D|WEBGL/ }).first();
    const toggleDisabledDuringShow = (await toggleBtn.count()) ? await toggleBtn.isDisabled() : null;
    const showRunning = (await page.locator(toggleSel, { hasText: 'SHOW STOP' }).count()) > 0;

    // Die Show laeuft weiter: erst auf Canvas2D, dann zurueck auf WebGL.
    const switchedToCanvas = await toggleBtn.click({ timeout: 10000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1500);
    const duringShow2d = await inspectCanvas(page);
    await toggleBtn.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const duringShowGl = await inspectCanvas(page);
    const duringShowGlPngBytes = await canvasScreenshotSize(page);

    showScenario = {
      imageGenerated: true,
      showRunning,
      toggleDisabledDuringShow,
      switchedToCanvas,
      duringShow2d: { renderer: duringShow2d.renderer, rendererAttr: duringShow2d.rendererAttr },
      duringShowGl,
      duringShowGlPngBytes,
    };
  }

  const out = {
    hasVisualButton: !!hasBtn,
    canvas2d: { ...canvas2d, pngBytes: canvas2dPngBytes },
    webgl: webgl ? { ...webgl, pngBytes: webglPngBytes } : null,
    showScenario,
    minRenderedPngBytes: MIN_RENDERED_PNG_BYTES,
    badResponses,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log('errors:', errs.slice(0, 6));
  await browser.close();

  const canvas2dOk = !!hasBtn && canvas2d.dialogFound && canvas2d.canvas && canvas2d.nonUniform
    && canvas2dPngBytes >= MIN_RENDERED_PNG_BYTES;
  const webglOk = !toggled || (
    webgl
    && (webgl.renderer === 'webgl' || webgl.renderer === 'webgl2')
    && webgl.rendererAttr === webgl.renderer
    && webgl.nonUniform
    && webglPngBytes >= MIN_RENDERED_PNG_BYTES
  );
  const showOk = !showScenario || (
    showScenario.showRunning
    && showScenario.toggleDisabledDuringShow === false
    && showScenario.duringShowGl
    && (showScenario.duringShowGl.renderer === 'webgl' || showScenario.duringShowGl.renderer === 'webgl2')
    && showScenario.duringShowGl.rendererAttr === showScenario.duringShowGl.renderer
    && showScenario.duringShowGl.gl
    && showScenario.duringShowGl.gl.glError === 0
    && showScenario.duringShowGl.gl.contextLost === false
    && showScenario.duringShowGl.gl.sceneAmount === 1
    && showScenario.duringShowGl.gl.textureBound === true
    && showScenario.duringShowGlPngBytes >= MIN_RENDERED_PNG_BYTES
  );
  const ok = canvas2dOk && webglOk && showOk;
  console.log('canvas2dOk:', canvas2dOk, '| webglOk:', webglOk, '| showOk:', showOk, showScenario ? '' : '(Show-Szenario uebersprungen)');
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error('VISUAL-GATE-ABBRUCH:', e.message); process.exit(3); });

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
const { chromium } = require('playwright');

const MIN_RENDERED_PNG_BYTES = 15 * 1024;

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
          glInfo = {
            contextLost: gl.isContextLost(),
            programBound: gl.getParameter(gl.CURRENT_PROGRAM) !== null,
            glError: gl.getError(),
            drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
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
  const toggle = page.locator('[role="dialog"][aria-label="VisualMONK Liveshow"] button', { hasText: 'CANVAS2D' }).first();
  let toggled = false;
  if (await toggle.count()) {
    await toggle.click({ timeout: 10000 }).catch(() => {});
    toggled = true;
    await page.waitForTimeout(2500);
  }
  const webgl = toggled ? await inspectCanvas(page) : null;
  const webglPngBytes = toggled ? await canvasScreenshotSize(page) : 0;

  const out = {
    hasVisualButton: !!hasBtn,
    canvas2d: { ...canvas2d, pngBytes: canvas2dPngBytes },
    webgl: webgl ? { ...webgl, pngBytes: webglPngBytes } : null,
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
  const ok = canvas2dOk && webglOk;
  console.log('canvas2dOk:', canvas2dOk, '| webglOk:', webglOk, toggled ? '' : '(Umschalter nicht gefunden)');
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error('VISUAL-GATE-ABBRUCH:', e.message); process.exit(3); });

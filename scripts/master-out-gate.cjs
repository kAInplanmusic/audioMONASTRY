// Master-Out-Gate (2 echte Browser): Studio als Host + /master-out als Listener.
// Beweist, dass der Listener einen echten Audio-Track des Main-Streams bekommt.
const { chromium } = require('playwright');

const BASE = process.env.GATE_URL || 'http://localhost:8080';

const MEDIA_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--no-sandbox',
];

(async () => {
  const browserA = await chromium.launch({ args: MEDIA_ARGS });
  const browserB = await chromium.launch({ args: MEDIA_ARGS });
  const errors = [];

  const host = await browserA.newPage({ viewport: { width: 1440, height: 900 } });
  host.on('pageerror', (e) => errors.push('host: ' + String(e).slice(0, 160)));
  await host.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await host.evaluate(() => window.__audioMonastry?.audioEngine?.setPlaybackMode?.('v2')).catch(() => {});
  await host.getByLabel('audioMONASTRY starten').click();
  await host.getByRole('button', { name: 'mixerMONK Power' }).waitFor({ state: 'visible', timeout: 30000 });
  await host.getByRole('button', { name: /mixerMONK Power/i }).click();
  await host.getByRole('button', { name: /mixerMONK Menü/i }).click();
  await host.waitForFunction(() => window.__audioMonastry?.audioEngine?.isMainHolderActive?.() === true, null, { timeout: 25000 }).catch(() => {});
  // Echten Ton in den V2-Pfad geben, damit der Main-Stream nicht stumm ist.
  await host.evaluate(async () => {
    try { await window.__audioMonastry?.audioEngine?.play?.(); } catch {}
    try { await window.__audioMonastry?.audioEngine?.playV2TestTone?.(440, 0.25); } catch {}
  });
  await host.waitForTimeout(4000);
  const hostInfo = await host.evaluate(() => ({
    holder: window.__audioMonastry?.audioEngine?.isMainHolderActive?.() === true,
    tap: !!window.__masterTap?.analyser,
  }));

  const listener = await browserB.newPage({ viewport: { width: 1280, height: 720 } });
  listener.on('pageerror', (e) => errors.push('listener: ' + String(e).slice(0, 160)));
  await listener.goto(`${BASE}/master-out`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await listener.getByRole('button', { name: /Main-Ausgabe aktivieren/i }).click().catch(() => {});

  // Dem Host Zeit geben, den Main-Stream an den Listener zu schicken.
  await listener.waitForTimeout(15000);

  const result = await listener.evaluate(async () => {
    const audio = document.querySelector('audio');
    const tracks = audio && audio.srcObject ? audio.srcObject.getAudioTracks().map((t) => ({ kind: t.kind, state: t.readyState })) : [];
    let rms = null;
    try {
      if (audio && audio.srcObject) {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(audio.srcObject);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        await new Promise((r) => setTimeout(r, 600));
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        await ctx.close();
      }
    } catch { /* Messung optional */ }
    return {
      hasAudioEl: !!audio,
      trackCount: tracks.length,
      tracks,
      paused: audio ? audio.paused : null,
      rms,
      bodyHead: (document.body.innerText || '').slice(0, 80),
    };
  });

  console.log(JSON.stringify({ host: hostInfo, listener: result, errors: errors.slice(0, 5) }, null, 2));
  await browserA.close();
  await browserB.close();
  const ok = result.trackCount > 0 && result.paused === false && errors.length === 0;
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error('MASTER-OUT-GATE-ABBRUCH:', e.message); process.exit(3); });

// Machbarkeitsprobe: Laeuft Web Audio in headless Chromium messbar?
// Ohne diese Probe waere ein "Audio-Inhalts-Gate" von Anfang an eine Behauptung.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  await page.goto('about:blank');

  const result = await page.evaluate(async () => {
    const out = { steps: [] };
    try {
      const ctx = new AudioContext();
      out.steps.push(`AudioContext created, state=${ctx.state}`);
      if (ctx.state === 'suspended') {
        await ctx.resume();
        out.steps.push(`after resume state=${ctx.state}`);
      }

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1000;
      const gain = ctx.createGain();
      gain.gain.value = 0.5; // -6 dBFS
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      osc.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      osc.start();
      out.steps.push('oscillator started -> gain(0.5) -> analyser -> destination');

      // Stille-Messung VOR dem Start des Nutzsignals ist hier nicht moeglich
      // (der Oszillator laeuft schon) – deshalb zuerst mit gain=0 messen.
      const measure = async (ms) => {
        const buf = new Float32Array(analyser.fftSize);
        let peak = 0;
        let sumSq = 0;
        let n = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          analyser.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i];
            if (Math.abs(v) > peak) peak = Math.abs(v);
            sumSq += v * v;
            n++;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        const rms = Math.sqrt(sumSq / Math.max(1, n));
        return {
          rms,
          rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
          peak,
          peakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        };
      };

      gain.gain.value = 0;
      out.silent = await measure(400);
      out.steps.push(`silent: rms=${out.silent.rms.toFixed(6)} (${out.silent.rmsDbfs.toFixed(1)} dBFS)`);

      gain.gain.value = 0.5;
      out.playing = await measure(600);
      out.steps.push(`playing: rms=${out.playing.rms.toFixed(6)} (${out.playing.rmsDbfs.toFixed(1)} dBFS), peak=${out.playing.peak.toFixed(4)}`);

      gain.gain.value = 0;
      out.afterStop = await measure(400);
      out.steps.push(`afterStop: rms=${out.afterStop.rms.toFixed(6)} (${out.afterStop.rmsDbfs === -Infinity ? '-inf' : out.afterStop.rmsDbfs.toFixed(1)} dBFS)`);

      out.sampleRate = ctx.sampleRate;
      out.baseLatency = ctx.baseLatency ?? null;
      await ctx.close();
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = String(e).slice(0, 300);
    }
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('pageErrors:', errors.length ? errors : 'keine');
  await browser.close();
})().catch((e) => {
  console.error('PROBE FEHLGESCHLAGEN:', e.message);
  process.exit(1);
});

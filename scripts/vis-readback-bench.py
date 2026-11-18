#!/usr/bin/env python3
"""
audioMONASTRY · vis: Wo gehen die ~27 ms des Frame-Auslesens hin?
=================================================================
Ergaenzt `vis-frame-bench.py` (das gezeigt hat: Rendern ~0,4 ms, toDataURL ~27 ms, Qualitaet egal, toBlob langsamer).
Misst je 1080p/1440p, Mittelwert ueber N Frames, in ms:
  readpixels_sync   gl.readPixels in einen Uint8Array (synchron)
  pbo_issue/_fence/_get   WebGL2: readPixels in PIXEL_PACK_BUFFER + Fence, getBufferSubData erst nach dem Fence
  jpeg_from_raw     reine JPEG-Kodierung der Rohpixel (OffscreenCanvas.convertToBlob), ohne GPU-Zugriff
  raw_transfer_rgba / raw_transfer_i420   Uebertragung roher Pixel als TypedArray ueber CDP (Python-Roundtrip)
  cdp_screenshot    Page.captureScreenshot (jpeg, optimizeForSpeed) nach einem Frame
  todataurl_roundtrip   heutiger Pfad zum Vergleich
Laeuft neben `visual_renderer.py` auf der GPU-Maschine; Chromium-Argumente ueber AI_VIS_CHROMIUM_ARGS.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import statistics
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import visual_renderer as vr  # noqa: E402

RESULTS = Path(os.environ.get('VIS_RESULTS', str(HERE / 'results')))
TAG = os.environ.get('VIS_BENCH_TAG', 'run')
FRAMES = int(os.environ.get('VIS_BENCH_FRAMES', '30'))
FEATURES = {'rms': 0.5, 'bass': 0.6, 'mid': 0.4, 'high': 0.3, 'beat': 0.0, 'flux': 0.3, 'centroid': 0.4}

IN_PAGE = """
async ([f, i, mode]) => {
  const v = window.__vis, c = document.getElementById('stage'), gl = c.getContext('webgl2');
  const W = c.width, H = c.height, out = {};
  const now = () => performance.now();
  const raw = new Uint8Array(W * H * 4);
  if (mode === 'sync') {
    v.frame(f, i, 0);
    let t = now(); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw); out.readpixels_sync = now() - t;
    const img = new ImageData(new Uint8ClampedArray(raw.buffer), W, H);
    const oc = new OffscreenCanvas(W, H), ctx = oc.getContext('2d');
    ctx.putImageData(img, 0, 0);
    t = now(); await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 }); out.jpeg_from_raw = now() - t;
  } else if (mode === 'pbo') {
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    v.frame(f, i, 0);
    let t = now(); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); out.pbo_issue = now() - t;
    t = now();
    await new Promise((resolve) => { const poll = () => { const s = gl.clientWaitSync(sync, 0, 0);
      if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED) resolve(); else setTimeout(poll, 0); }; poll(); });
    out.pbo_fence = now() - t;
    t = now(); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw); out.pbo_get = now() - t;
    gl.deleteSync(sync); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.deleteBuffer(pbo);
  } else if (mode === 'rgba') {
    v.frame(f, i, 0); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw); return raw;
  } else if (mode === 'i420') {
    v.frame(f, i, 0); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw); return raw.subarray(0, (W * H * 3) >> 1);
  } else if (mode === 'render') {
    v.frame(f, i, 0);
  }
  return out;
}
"""


def mean(values):
    return round(statistics.fmean(values), 2) if values else None


def run(resolution):
    cfg = vr.validate_config({'resolution': resolution, 'fps': 30, 'effects': 'auto', 'scenes': scenes()})
    browser = vr.SceneBrowser(cfg)
    browser.start()
    page = browser._page  # noqa: SLF001
    out = {'renderer': browser.renderer}
    index = 0
    try:
        for _ in range(8):
            browser.frame(FEATURES, index)
            index += 1
        sample = {}
        for mode in ('sync', 'pbo'):
            rows = []
            for _ in range(FRAMES):
                rows.append(page.evaluate(IN_PAGE, [FEATURES, index, mode]))
                index += 1
            for key in rows[0]:
                sample[key] = mean([r[key] for r in rows])
        out.update(sample)

        for mode in ('rgba', 'i420'):
            wall = []
            for _ in range(FRAMES):
                t0 = time.perf_counter()
                data = page.evaluate(IN_PAGE, [FEATURES, index, mode])
                wall.append((time.perf_counter() - t0) * 1000)
                index += 1
            out['raw_transfer_' + mode] = mean(wall)
            out['raw_transfer_%s_bytes' % mode] = len(data) if hasattr(data, '__len__') else None

        wall = []
        for _ in range(FRAMES):
            t0 = time.perf_counter()
            browser.frame(FEATURES, index)
            wall.append((time.perf_counter() - t0) * 1000)
            index += 1
        out['todataurl_roundtrip'] = mean(wall)

        cdp = page.context.new_cdp_session(page)
        wall = []
        for _ in range(FRAMES):
            page.evaluate(IN_PAGE, [FEATURES, index, 'render'])
            index += 1
            t0 = time.perf_counter()
            cdp.send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 80, 'optimizeForSpeed': True, 'fromSurface': True})
            wall.append((time.perf_counter() - t0) * 1000)
        out['cdp_screenshot'] = mean(wall)
    finally:
        browser.close()
    return out


def scenes():
    listing = HERE / 'media.json'
    if not listing.exists():
        return []
    return [{'id': e['id'], 'kind': e['kind'], 'src': e['url'], 'durationS': 6, 'label': e['id']}
            for e in json.loads(listing.read_text())]


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    report = {'tag': TAG, 'frames': FRAMES, 'chromium_args': os.environ.get('AI_VIS_CHROMIUM_ARGS', '')}
    for resolution in ('1080p', '1440p'):
        try:
            report[resolution] = run(resolution)
        except Exception as exc:  # noqa: BLE001
            report[resolution] = {'error': type(exc).__name__ + ': ' + str(exc)[:300]}
    (RESULTS / ('readback-bench-%s.json' % TAG)).write_text(json.dumps(report, indent=2) + '\n')
    print('READBACK %s %s' % (TAG, json.dumps(report)))


if __name__ == '__main__':
    main()

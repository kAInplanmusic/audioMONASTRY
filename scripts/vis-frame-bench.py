#!/usr/bin/env python3
"""
audioMONASTRY · vis: Frame-Pfad vermessen (Render / Auslesen / Kodieren / Uebertragung)
=====================================================================================
Laeuft neben `visual_renderer.py` (und optional `media.json`) auf der GPU-Maschine, wie `vis-gpu-selftest.py`.
Vergleicht fuer 1080p und 1440p:
  A  heutiger Pfad  : frame() mit toDataURL, Q 0.88   (Referenz)
  B  gleiche Qualitaet kleiner: toDataURL Q 0.70 / 0.60
  P  Aufteilung     : gl.finish() getrennt von toDataURL (profile)
  C  burst()        : toBlob asynchron, Kodieren ueberlappt mit dem naechsten Render (Q 0.80 / 0.70)
Ergebnis: $VIS_RESULTS/frame-bench.json und frame-bench.txt (ms je Frame, Mittel und p95).
Kein Netzwerk ausser dem Laden der in media.json genannten https-Links (wie im Betrieb).
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
FRAMES = int(os.environ.get('VIS_BENCH_FRAMES', '90'))
WARMUP = 10
FEATURES = {'rms': 0.5, 'bass': 0.6, 'mid': 0.4, 'high': 0.3, 'beat': 0.0, 'flux': 0.3, 'centroid': 0.4}


def scenes():
    listing = HERE / 'media.json'
    if not listing.exists():
        return []
    return [{'id': e['id'], 'kind': e['kind'], 'src': e['url'], 'durationS': 6, 'label': e['id']}
            for e in json.loads(listing.read_text())]


def stats(values):
    values = sorted(values)
    return {'mean_ms': round(statistics.fmean(values), 2), 'p95_ms': round(values[int(len(values) * 0.95) - 1], 2),
            'max_fps_mean': round(1000 / statistics.fmean(values), 1)}


def run(resolution):
    cfg = vr.validate_config({'resolution': resolution, 'fps': 30, 'effects': 'auto', 'scenes': scenes()})
    browser = vr.SceneBrowser(cfg)
    browser.start()
    page = browser._page  # noqa: SLF001  (Messskript darf die Seite direkt ansprechen)
    out = {'renderer': browser.renderer, 'loaded_scenes': browser.loaded_scenes}
    try:
        index = 0
        for _ in range(WARMUP):
            browser.frame(FEATURES, index)
            index += 1

        def timed(quality):
            nonlocal index
            browser.quality = quality
            wall, payload = [], []
            for _ in range(FRAMES):
                t0 = time.perf_counter()
                _, jpeg = browser.frame(FEATURES, index)
                wall.append((time.perf_counter() - t0) * 1000)
                payload.append(len(jpeg))
                index += 1
            return {**stats(wall), 'jpeg_kb_mean': round(statistics.fmean(payload) / 1024, 1)}

        out['A_todataurl_q88'] = timed(0.88)
        out['B_todataurl_q70'] = timed(0.70)
        out['B_todataurl_q60'] = timed(0.60)

        render, encode, wall = [], [], []
        for _ in range(FRAMES):
            t0 = time.perf_counter()
            result = page.evaluate('([f, i]) => window.__vis.frame(f, i, 0.88, true)', [FEATURES, index])
            wall.append((time.perf_counter() - t0) * 1000)
            render.append(result['timing']['renderMs'])
            encode.append(result['timing']['encodeMs'])
            index += 1
        out['P_split_q88'] = {'render_gpu_ms': stats(render), 'tojpeg_ms': stats(encode), 'roundtrip_ms': stats(wall)}

        for quality in (0.80, 0.70):
            per_frame, count = [], 30
            for _ in range(max(1, FRAMES // count)):
                t0 = time.perf_counter()
                result = page.evaluate('([f, i, n, q]) => window.__vis.burst(f, i, n, q)', [FEATURES, index, count, quality])
                total = (time.perf_counter() - t0) * 1000
                per_frame.append(total / count)
                index += count
            out['C_burst_q%d' % round(quality * 100)] = {
                **stats(per_frame), 'in_page_render_ms_per_frame': round(result['renderMs'] / count, 2),
                'in_page_total_ms_per_frame': round(result['totalMs'] / count, 2),
                'jpeg_kb_mean': round(sum(len(j) for j in result['jpegs']) * 0.75 / count / 1024, 1)}
    finally:
        browser.close()
    return out


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    report = {'frames': FRAMES, 'chromium_args': os.environ.get('AI_VIS_CHROMIUM_ARGS', '')}
    for resolution in ('1080p', '1440p'):
        try:
            report[resolution] = run(resolution)
        except Exception as exc:  # noqa: BLE001
            report[resolution] = {'error': type(exc).__name__ + ': ' + str(exc)[:300]}
    (RESULTS / 'frame-bench.json').write_text(json.dumps(report, indent=2) + '\n')
    lines = []
    for resolution in ('1080p', '1440p'):
        lines.append('== %s ==' % resolution)
        for name, value in report[resolution].items():
            lines.append('  %-18s %s' % (name, json.dumps(value)))
    (RESULTS / 'frame-bench.txt').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()

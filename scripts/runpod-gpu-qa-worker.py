"""Isolated QA-only serverless entrypoint; executes the production inference handler."""
import time
import traceback
import torch
import runpod
import registry
import runpod_worker as worker

ROLES = {}
for role, spec in registry.read_manifest()['roles'].items():
    for model in spec['models']:
        ROLES.setdefault(model, role)



def handler(job):
    model = job.get('input', {}).get('model')
    if model not in ROLES:
        return {'qaError': 'model outside the fixed QA selection'}
    if not torch.cuda.is_available():
        return {'qaError': 'CUDA unavailable; CPU fallback is not a GPU pass'}
    torch.cuda.reset_peak_memory_stats()
    worker.manager.configure(registry.load_manifest(ROLES[model]))
    start = time.monotonic()
    traces=[]
    original=worker.manager.infer
    def traced_infer(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except Exception:
            traces.append(traceback.format_exc()[-6000:])
            raise
    worker.manager.infer=traced_infer
    try:
        output = worker.handler(job)
    finally:
        worker.manager.infer=original
    render = None
    if job.get('input', {}).get('input', {}).get('qaRenderProbe'):
        import subprocess
        import tempfile
        from pathlib import Path
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory(prefix='render-qa-') as folder:
            with sync_playwright() as browser_api:
                browser=browser_api.chromium.launch(headless=True, args=['--no-sandbox'])
                page=browser.new_page(viewport={'width':640,'height':360})
                page.set_content('<html><body style="background:#123456"><h1>audioMONASTRY render probe</h1></body></html>')
                png=page.screenshot()
                browser.close()
                if not png.startswith(b'\x89PNG'):
                    raise RuntimeError('Chromium did not render a PNG')
            target=Path(folder)/'probe.mp4'
            result=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i',
                'testsrc2=size=640x360:rate=24','-t','1','-c:v','h264_nvenc','-y',str(target)],
                capture_output=True,text=True,timeout=60)
            if result.returncode or not target.exists() or target.stat().st_size<100:
                raise RuntimeError('Real NVENC encode failed: '+result.stderr[-1000:])
            render={'chromiumPngBytes':len(png),'nvencMp4Bytes':target.stat().st_size,'passed':True}
    torch.cuda.synchronize()
    return {'qa': {'model': model, 'role': ROLES[model],
                   'gpu': torch.cuda.get_device_name(0), 'torch': torch.__version__,
                   'cudaRuntime': torch.version.cuda, 'cudaAvailable': True,
                   'peakAllocatedBytes': torch.cuda.max_memory_allocated(),
                   'peakReservedBytes': torch.cuda.max_memory_reserved(),
                   'render': render, 'errorTracebacks': traces, 'wallSeconds': round(time.monotonic()-start, 3)},
            'inference': output}


runpod.serverless.start({'handler': handler})

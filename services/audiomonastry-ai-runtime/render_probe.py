"""Fixed Chromium -> PNG -> hardware H.264 proof; no external URLs or commands."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def run():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as api:
        browser = api.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page(viewport={'width':640,'height':360})
            page.set_content('<html><body style="background:#161626;color:#ffa826">'
                             '<h1>audioMONASTRY</h1><p>Production render proof</p></body></html>')
            png = page.screenshot()
        finally:
            browser.close()
    if not png.startswith(b'\x89PNG\r\n\x1a\n'):
        raise RuntimeError('CHROMIUM_RENDER_FAILED')
    with tempfile.TemporaryDirectory(prefix='audiomonastry-render-proof-') as directory:
        source, target = Path(directory)/'frame.png', Path(directory)/'render.mp4'
        source.write_bytes(png)
        result = subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-loop','1',
            '-framerate','24','-i',str(source),'-t','1','-c:v','h264_nvenc','-pix_fmt','yuv420p',
            '-an','-y',str(target)],capture_output=True,timeout=60)
        if result.returncode or not target.exists() or target.stat().st_size < 100:
            raise RuntimeError('NVENC_ENCODE_FAILED')
        probe = subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries',
            'stream=codec_name,width,height,nb_frames','-of','json',str(target)],
            capture_output=True,timeout=15)
        streams = json.loads(probe.stdout).get('streams',[]) if probe.returncode == 0 else []
        if len(streams) != 1 or any(str(streams[0].get(key)) != str(value) for key,value in
                {'codec_name':'h264','width':640,'height':360,'nb_frames':24}.items()):
            raise RuntimeError('NVENC_OUTPUT_INVALID')
        return {'passed':True, 'chromiumPngBytes':len(png),
            'chromiumPngSha256':hashlib.sha256(png).hexdigest(),
            'nvencMp4Bytes':target.stat().st_size,
            'nvencMp4Sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
            'encoder':'h264_nvenc','codec':'h264','width':640,'height':360,'frames':24}
